import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as XLSX from "xlsx";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, OrderStatus } from "@/context/AppContext";
import { OrderCard } from "@/components/OrderCard";
import { EmptyState } from "@/components/EmptyState";

const STATUS_FILTERS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

export default function OrdersScreen() {
  const { orders, clearAllOrders } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [activeBrand, setActiveBrand] = useState<string>("all");
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const statusFiltered = useMemo(() => {
    if (activeFilter === "all") return orders;
    return orders.filter((o) => o.status === activeFilter);
  }, [orders, activeFilter]);

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    statusFiltered.forEach((o) =>
      o.items.forEach((item) => {
        if (item.brand) set.add(item.brand);
      })
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [statusFiltered]);

  const filtered = useMemo(() => {
    if (activeBrand === "all") return statusFiltered;
    return statusFiltered.filter((o) =>
      o.items.some((item) => item.brand === activeBrand)
    );
  }, [statusFiltered, activeBrand]);

  function brandOrderCount(brand: string): number {
    return statusFiltered.filter((o) =>
      o.items.some((item) => item.brand === brand)
    ).length;
  }

  async function handleExport() {
    if (filtered.length === 0) {
      Alert.alert("Nothing to Export", "No orders match the current filters.");
      return;
    }
    try {
      setDownloading(true);
      const colHeader = ["Order Date", "Supplier", "Item Description", "Brand", "UOM", "MRP", "Order Qty"];
      const dataRows: (string | number)[][] = [];
      for (const order of filtered) {
        for (const item of order.items) {
          const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
          dataRows.push([
            new Date(order.createdAt).toLocaleDateString("en-IN"),
            order.supplierName,
            desc,
            item.brand ?? "",
            item.unit,
            item.unitPrice,
            item.quantity,
          ]);
        }
      }
      const sheetData: (string | number)[][] = [
        ["",                                                                     "", "", "ORDER FORM",  "", "", "Sathyam Super Store"],
        ["GST# :  33ADFFS5244N1ZR",                                              "", "", "",            "", "", "2A,Mettupalayam Road, Cheran Nagar"],
        ["ORDER FORM MUST BE ATTACHED WITH INVOICE DURING DELIVERY ***",         "", "", "",            "", "", "Coimbatore-641029"],
        ["",                                                                     "", "", "",            "", "", "98431-44868"],
        ["",                                                                     "", "", "",            "", "", "Whatsapp: 97881-44868"],
        ["",                                                                     "", "", "",            "", "", "Accounts: 97868-64868"],
        ["", "", "", "", "", "", ""],
        colHeader,
        ...dataRows,
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [
        { wch: 55 }, { wch: 22 }, { wch: 32 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 10 },
      ];
      // wrapText on Column C (Item Description) — data starts at row 9 (7 header + 1 colHeader)
      const dataStartRow = 9;
      for (let i = 0; i < dataRows.length; i++) {
        const cellRef = `C${dataStartRow + i}`;
        if (ws[cellRef]) {
          ws[cellRef].s = { alignment: { wrapText: true, vertical: "top" } };
        }
      }
      ws["!pageSetup"] = {
        orientation: "portrait",
        fitToWidth: 1,
        fitToHeight: 0,
      };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Orders");
      const fileName = `orders_export_${Date.now()}.xlsx`;
      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
        const blob = new Blob([wbout], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { bookType: "xlsx", type: "base64", cellStyles: true });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: "base64" as any });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export Orders",
            UTI: "com.microsoft.excel.xlsx",
          });
        } else {
          Alert.alert("Export saved", `File saved to: ${fileUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Export Failed", e?.message ?? "Unknown error");
    } finally {
      setDownloading(false);
    }
  }

  function handleClearAll() {
    if (orders.length === 0) return;
    Alert.alert(
      "Remove All Orders",
      `This will permanently delete all ${orders.length} order${orders.length !== 1 ? "s" : ""}. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove All",
          style: "destructive",
          onPress: () => {
            clearAllOrders();
            setActiveFilter("all");
            setActiveBrand("all");
          },
        },
      ]
    );
  }

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const brandActive = activeBrand !== "all";

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Orders</Text>
        <View style={styles.headerActions}>
          {orders.length > 0 && (
            <TouchableOpacity style={styles.clearAllBtn} onPress={handleClearAll}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.exportBtn}
            onPress={handleExport}
            disabled={downloading || filtered.length === 0}
          >
            {downloading ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <Feather name="download" size={17} color={filtered.length === 0 ? Colors.textMuted : Colors.primary} />
            )}
            <Text style={[styles.exportBtnText, filtered.length === 0 && styles.exportBtnTextDisabled]}>
              Export
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.importBtn}
            onPress={() => router.push("/order/import")}
          >
            <Feather name="upload" size={17} color={Colors.primary} />
            <Text style={styles.importBtnText}>Import</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => router.push("/order/new")}
          >
            <Feather name="plus" size={20} color={Colors.textInverse} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Status + Brand filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
        style={styles.filtersScroll}
      >
        {STATUS_FILTERS.map((f) => {
          const count =
            f.key === "all"
              ? orders.length
              : orders.filter((o) => o.status === f.key).length;
          const isActive = activeFilter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              style={[styles.filter, isActive && styles.filterActive]}
              onPress={() => { setActiveFilter(f.key); setActiveBrand("all"); }}
            >
              <Text style={[styles.filterText, isActive && styles.filterTextActive]}>
                {f.label}
              </Text>
              <View style={[styles.filterCount, isActive && styles.filterCountActive]}>
                <Text style={[styles.filterCountText, isActive && styles.filterCountTextActive]}>
                  {count}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}

      </ScrollView>

      {/* Brand filter row — always visible below status pills */}
      <TouchableOpacity
        style={[styles.brandBar, brandActive && styles.brandBarActive]}
        onPress={() => setShowBrandModal(true)}
        activeOpacity={0.75}
      >
        <Feather
          name="tag"
          size={14}
          color={brandActive ? Colors.textInverse : Colors.textSecondary}
        />
        <Text
          style={[styles.brandBarText, brandActive && styles.brandBarTextActive]}
          numberOfLines={1}
        >
          {brandActive ? `Brand: ${activeBrand}` : "Filter by Brand"}
        </Text>
        {brandActive ? (
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); setActiveBrand("all"); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="x-circle" size={15} color={Colors.textInverse} />
          </TouchableOpacity>
        ) : (
          <Feather name="chevron-down" size={14} color={Colors.textMuted} />
        )}
      </TouchableOpacity>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <OrderCard order={item} />}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
          filtered.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="file-text"
            title="No orders found"
            subtitle={
              brandActive
                ? `No orders with brand "${activeBrand}"`
                : activeFilter === "all"
                ? "Tap the + button to create your first order"
                : `No ${activeFilter} orders at the moment`
            }
          />
        }
        showsVerticalScrollIndicator={false}
      />

      {/* Brand filter modal */}
      <Modal
        visible={showBrandModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBrandModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowBrandModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter by Brand</Text>
            {brandActive && (
              <TouchableOpacity
                onPress={() => { setActiveBrand("all"); setShowBrandModal(false); }}
              >
                <Text style={styles.modalClear}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>

          {allBrands.length === 0 ? (
            <View style={styles.noBrands}>
              <Feather name="tag" size={32} color={Colors.textMuted} />
              <Text style={styles.noBrandsTitle}>No Brands Yet</Text>
              <Text style={styles.noBrandsSub}>
                Import orders with a Brand column to filter by brand.
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.brandList}>
              <TouchableOpacity
                style={[styles.brandRow, activeBrand === "all" && styles.brandRowActive]}
                onPress={() => { setActiveBrand("all"); setShowBrandModal(false); }}
              >
                <Text style={[styles.brandName, activeBrand === "all" && styles.brandNameActive]}>
                  All Brands
                </Text>
                <Text style={styles.brandCount}>{statusFiltered.length} orders</Text>
                {activeBrand === "all" && (
                  <Feather name="check" size={16} color={Colors.primary} />
                )}
              </TouchableOpacity>
              {allBrands.map((brand) => {
                const isActive = activeBrand === brand;
                const count = brandOrderCount(brand);
                return (
                  <TouchableOpacity
                    key={brand}
                    style={[styles.brandRow, isActive && styles.brandRowActive]}
                    onPress={() => { setActiveBrand(brand); setShowBrandModal(false); }}
                  >
                    <View style={styles.brandDot} />
                    <Text style={[styles.brandName, isActive && styles.brandNameActive]}>
                      {brand}
                    </Text>
                    <Text style={styles.brandCount}>{count} order{count !== 1 ? "s" : ""}</Text>
                    {isActive && <Feather name="check" size={16} color={Colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  clearAllBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: Colors.dangerLight,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.successLight ?? "#DCFCE7",
    borderWidth: 1,
    borderColor: Colors.success ? Colors.success + "40" : "#16A34A40",
  },
  exportBtnText: { fontSize: 14, fontWeight: "700", color: Colors.success ?? "#16A34A" },
  exportBtnTextDisabled: { color: Colors.textMuted },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  importBtnText: { fontSize: 14, fontWeight: "700", color: Colors.primary },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  filtersScroll: { maxHeight: 52 },
  filters: { paddingHorizontal: 20, paddingVertical: 8, gap: 8 },
  filter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 6,
  },
  filterActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  filterTextActive: { color: Colors.textInverse },
  filterCount: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  filterCountActive: { backgroundColor: "rgba(255,255,255,0.25)" },
  filterCountText: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  filterCountTextActive: { color: Colors.textInverse },
  brandBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  brandBarActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  brandBarText: { flex: 1, fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  brandBarTextActive: { color: Colors.textInverse },
  list: { paddingHorizontal: 20, paddingTop: 8 },
  listEmpty: { flex: 1 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    maxHeight: "70%",
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: "center",
    marginBottom: 16,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: Colors.text },
  modalClear: { fontSize: 14, fontWeight: "700", color: Colors.danger },
  noBrands: {
    alignItems: "center",
    padding: 40,
    gap: 10,
  },
  noBrandsTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  noBrandsSub: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  brandList: { paddingHorizontal: 20 },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  brandRowActive: { backgroundColor: Colors.primaryMuted + "80" },
  brandDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.warning,
  },
  brandName: { flex: 1, fontSize: 15, fontWeight: "600", color: Colors.text },
  brandNameActive: { color: Colors.primary },
  brandCount: { fontSize: 12, color: Colors.textMuted, marginRight: 4 },
});
