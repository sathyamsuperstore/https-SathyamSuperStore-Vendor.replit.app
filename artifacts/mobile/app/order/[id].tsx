import React, { useMemo, useState, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Platform,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as XLSX from "xlsx-js-style";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Colors } from "@/constants/colors";
import { useApp, OrderStatus } from "@/context/AppContext";
import { StatusBadge } from "@/components/StatusBadge";

const STATUS_FLOW: { status: OrderStatus; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { status: "confirmed", label: "Confirm Order", icon: "check" },
  { status: "shipped", label: "Mark as Shipped", icon: "truck" },
  { status: "delivered", label: "Mark as Delivered", icon: "package" },
];

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { orders, updateOrderStatus, deleteOrder, updateOrder } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [selectedBrand, setSelectedBrand] = useState<string>("all");
  const [downloading, setDownloading] = useState(false);
  const [newStockQtyEdits, setNewStockQtyEdits] = useState<Record<string, string>>({});

  const order = useMemo(() => orders.find((o) => o.id === id), [orders, id]);

  const itemBrands = useMemo(() => {
    if (!order) return [];
    const set = new Set<string>();
    order.items.forEach((item) => { if (item.brand) set.add(item.brand); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [order]);

  const visibleItems = useMemo(() => {
    if (!order) return [];
    const base = selectedBrand === "all" ? order.items : order.items.filter((item) => item.brand === selectedBrand);
    return [...base].sort((a, b) => {
      if (a.sortNo != null && b.sortNo != null) return a.sortNo - b.sortNo;
      if (a.sortNo != null) return -1;
      if (b.sortNo != null) return 1;
      return 0;
    });
  }, [order, selectedBrand]);

  const visibleTotal = useMemo(
    () => visibleItems.reduce((s, item) => s + item.quantity * item.unitPrice, 0),
    [visibleItems]
  );

  if (!order) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Order not found</Text>
      </View>
    );
  }

  const nextStatus = useMemo(() => {
    if (order.status === "pending") return STATUS_FLOW[0];
    if (order.status === "confirmed") return STATUS_FLOW[1];
    if (order.status === "shipped") return STATUS_FLOW[2];
    return null;
  }, [order.status]);

  function handleStatusUpdate() {
    if (!nextStatus) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    updateOrderStatus(order.id, nextStatus.status);
  }

  function handleCancel() {
    Alert.alert("Cancel Order", "Are you sure you want to cancel this order?", [
      { text: "No", style: "cancel" },
      {
        text: "Cancel Order",
        style: "destructive",
        onPress: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          updateOrderStatus(order.id, "cancelled");
        },
      },
    ]);
  }

  async function handleExport() {
    if (!order || visibleItems.length === 0) return;
    try {
      setDownloading(true);
      const colHeader = ["Item Description", "Brand", "UOM", "MRP", "Stock", "Min", "Order Qty"];
      const dataRows = visibleItems.map((item) => {
        const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
        return [
          desc,
          item.brand ?? "",
          item.unit,
          item.unitPrice,
          item.stock ?? "",
          item.min ?? "",
          item.quantity,
        ];
      });
      const orderDate = new Date(order.createdAt).toLocaleDateString("en-IN");
      const sheetData: (string | number)[][] = [
        ["Sathyam Super Store",                                              "", "", "", "", "ORDER FORM"],
        ["2A,Mettupalayam Road, Cheran Nagar",                               "", "", "", "", ""],
        ["Coimbatore-641029",                                                "", "", "", "", ""],
        ["98431-44868",                                                      "", "", "", "", ""],
        ["Whatsapp: 97881-44868",                                            "", "", "", "", ""],
        ["Accounts: 97868-64868",                                            "", "", "", "", ""],
        ["GST# :  33ADFFS5244N1ZR",                                         "", "", "", "", ""],
        ["***ORDER FORM MUST BE ATTACHED WITH INVOICE DURING DELIVERY ***",  "", "", "", "", ""],
        ["", "", "", "", "", ""],
        colHeader,
        ...dataRows,
        ["", "", "", "", "", ""],
        [`Supplier : ${order.supplierName}`, "", "", "", "", ""],
        [`Order Date : ${orderDate}`,        "", "", "", "", ""],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [
        { wch: 45 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
      ];
      // wrapText on Row 8 (delivery notice)
      if (ws["A8"]) {
        ws["A8"].s = { alignment: { wrapText: true, vertical: "top" } };
      }
      // wrapText on A10 ("Item Description" column header)
      if (ws["A10"]) {
        ws["A10"].s = { alignment: { wrapText: true, vertical: "top" } };
      }
      // Apply wrapText + thin borders to all item data rows (rows 11 onward)
      const dataStartRow = 11;
      const thinBorder = {
        top:    { style: "thin", color: { rgb: "000000" } },
        bottom: { style: "thin", color: { rgb: "000000" } },
        left:   { style: "thin", color: { rgb: "000000" } },
        right:  { style: "thin", color: { rgb: "000000" } },
      };
      for (let i = 0; i < dataRows.length; i++) {
        const row = dataStartRow + i;
        for (const col of ["A", "B", "C", "D", "E", "F", "G"]) {
          const cellRef = `${col}${row}`;
          if (ws[cellRef]) {
            ws[cellRef].s = col === "A"
              ? { alignment: { wrapText: true, vertical: "top" }, border: thinBorder }
              : { border: thinBorder };
          }
        }
      }
      ws["!pageSetup"] = {
        paperSize: 9,
        orientation: "portrait",
        fitToWidth: 1,
        fitToHeight: 0,
      };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Order");
      // "Rows to repeat at top" — row 10 (column header row) prints on every page
      if (!wb.Workbook) wb.Workbook = {} as any;
      if (!wb.Workbook.Names) wb.Workbook.Names = [];
      wb.Workbook.Names.push({
        Sheet: 0,
        Name: "_xlnm.Print_Titles",
        Ref: "Order!$10:$10",
      });
      const fileName = `${order.orderNumber.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.xlsx`;
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
            dialogTitle: "Export Order",
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

  function saveNewStockQty(itemId: string, value: string) {
    if (!order) return;
    const parsed = parseFloat(value);
    const qty = isNaN(parsed) || value.trim() === "" ? undefined : parsed;
    updateOrder(order.id, {
      items: order.items.map((it) =>
        it.id === itemId ? { ...it, newStockQty: qty } : it
      ),
    });
  }

  function handleDelete() {
    Alert.alert("Delete Order", "This action cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteOrder(order.id);
          router.back();
        },
      },
    ]);
  }

  const isOverdue =
    order.status !== "delivered" &&
    order.status !== "cancelled" &&
    new Date(order.expectedDelivery) < new Date();

  return (
    <>
      <Stack.Screen
        options={{
          title: order.orderNumber,
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <TouchableOpacity
                onPress={handleExport}
                disabled={downloading}
                style={{ padding: 8 }}
              >
                {downloading ? (
                  <ActivityIndicator size="small" color={Colors.success} />
                ) : (
                  <Feather name="download" size={18} color={Colors.success} />
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={handleDelete} style={{ padding: 8 }}>
                <Feather name="trash-2" size={18} color={Colors.danger} />
              </TouchableOpacity>
            </View>
          ),
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topCard}>
          <View style={styles.topCardHeader}>
            <View>
              <Text style={styles.orderNum}>{order.orderNumber}</Text>
              <Text style={styles.supplier}>{order.supplierName}</Text>
            </View>
            <StatusBadge status={order.status} />
          </View>
          <Text style={styles.amount}>{formatCurrency(order.totalAmount)}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Timeline</Text>
          <View style={styles.infoGrid}>
            <View style={styles.infoItem}>
              <Text style={styles.infoLabel}>Created</Text>
              <Text style={styles.infoValue}>{formatDate(order.createdAt)}</Text>
            </View>
            <View style={styles.infoItem}>
              <Text style={styles.infoLabel}>Expected Delivery</Text>
              <Text style={[styles.infoValue, isOverdue && styles.overdueText]}>
                {isOverdue ? "⚠ " : ""}{formatDate(order.expectedDelivery)}
              </Text>
            </View>
            {order.syncDate ? (
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Sync Date</Text>
                <Text style={styles.infoValue}>{formatDate(order.syncDate)}</Text>
              </View>
            ) : null}
            {order.beat ? (
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Beat</Text>
                <Text style={styles.infoValue}>{order.beat}</Text>
              </View>
            ) : null}
            <View style={styles.infoItem}>
              <Text style={styles.infoLabel}>Last Updated</Text>
              <Text style={styles.infoValue}>{formatDate(order.updatedAt)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { marginBottom: 0 }]}>Items</Text>
            <Text style={styles.itemCount}>{visibleItems.length} of {order.items.length}</Text>
          </View>

          {/* Brand filter bar — shown only when order has branded items */}
          {itemBrands.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.brandPills}
              style={styles.brandPillsScroll}
            >
              <TouchableOpacity
                style={[styles.brandPill, selectedBrand === "all" && styles.brandPillActive]}
                onPress={() => setSelectedBrand("all")}
              >
                <Text style={[styles.brandPillText, selectedBrand === "all" && styles.brandPillTextActive]}>
                  All
                </Text>
              </TouchableOpacity>
              {itemBrands.map((brand) => {
                const isActive = selectedBrand === brand;
                const count = order.items.filter((i) => i.brand === brand).length;
                return (
                  <TouchableOpacity
                    key={brand}
                    style={[styles.brandPill, isActive && styles.brandPillActive]}
                    onPress={() => setSelectedBrand(isActive ? "all" : brand)}
                  >
                    <Feather name="tag" size={11} color={isActive ? Colors.textInverse : Colors.textMuted} />
                    <Text style={[styles.brandPillText, isActive && styles.brandPillTextActive]}>
                      {brand}
                    </Text>
                    <Text style={[styles.brandPillCount, isActive && styles.brandPillCountActive]}>
                      {count}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.itemsCard}>
            {visibleItems.map((item, idx) => (
              <View key={item.id}>
                {idx > 0 && <View style={styles.itemDivider} />}
                <View style={styles.itemRow}>
                  <View style={styles.itemInfo}>
                    {item.sortNo != null ? (
                      <Text style={styles.itemSortNo}>#{item.sortNo}</Text>
                    ) : null}
                    <Text style={styles.itemName}>{item.name}</Text>
                    {item.brand ? (
                      <Text style={styles.itemBrand}>{item.brand}</Text>
                    ) : null}
                    <Text style={styles.itemMeta}>
                      {item.quantity} {item.unit} × {formatCurrency(item.unitPrice)}
                      {item.stock != null ? `  ·  Stock: ${item.stock}` : ""}
                      {item.min != null ? `  ·  Min: ${item.min}` : ""}
                    </Text>
                    <View style={styles.newStockRow}>
                      <Text style={styles.newStockLabel}>New Stock Qty:</Text>
                      <TextInput
                        style={styles.newStockInput}
                        value={newStockQtyEdits[item.id] ?? (item.newStockQty != null ? String(item.newStockQty) : "")}
                        onChangeText={(v) =>
                          setNewStockQtyEdits((prev) => ({ ...prev, [item.id]: v }))
                        }
                        onBlur={() => {
                          const val = newStockQtyEdits[item.id];
                          if (val !== undefined) saveNewStockQty(item.id, val);
                        }}
                        placeholder="—"
                        placeholderTextColor={Colors.textMuted}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                      />
                    </View>
                  </View>
                  <Text style={styles.itemTotal}>
                    {formatCurrency(item.quantity * item.unitPrice)}
                  </Text>
                </View>
              </View>
            ))}
            <View style={styles.itemDivider} />
            <View style={styles.itemRow}>
              <Text style={styles.totalLabel}>
                {selectedBrand === "all" ? "Total" : `${selectedBrand} Total`}
              </Text>
              <Text style={styles.totalValue}>{formatCurrency(visibleTotal)}</Text>
            </View>
          </View>
        </View>

        {order.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <View style={styles.notesCard}>
              <Text style={styles.notesText}>{order.notes}</Text>
            </View>
          </View>
        ) : null}

        {order.status !== "delivered" && order.status !== "cancelled" && (
          <View style={styles.actions}>
            {nextStatus && (
              <TouchableOpacity style={styles.primaryAction} onPress={handleStatusUpdate}>
                <Feather name={nextStatus.icon} size={18} color={Colors.textInverse} />
                <Text style={styles.primaryActionText}>{nextStatus.label}</Text>
              </TouchableOpacity>
            )}
            {order.status !== "cancelled" && (
              <TouchableOpacity style={styles.cancelAction} onPress={handleCancel}>
                <Text style={styles.cancelActionText}>Cancel Order</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16, color: Colors.textSecondary },
  topCard: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
  topCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  orderNum: { fontSize: 18, fontWeight: "800", color: Colors.textInverse, marginBottom: 4 },
  supplier: { fontSize: 14, color: "rgba(255,255,255,0.7)" },
  amount: { fontSize: 32, fontWeight: "800", color: Colors.textInverse },
  section: { marginBottom: 20 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: Colors.text, marginBottom: 12 },
  itemCount: { fontSize: 12, color: Colors.textMuted, fontWeight: "500" },
  brandPillsScroll: { marginBottom: 10 },
  brandPills: { gap: 6, paddingRight: 4 },
  brandPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  brandPillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  brandPillText: { fontSize: 12, fontWeight: "600", color: Colors.textSecondary },
  brandPillTextActive: { color: Colors.textInverse },
  brandPillCount: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.textMuted,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  brandPillCountActive: { color: Colors.textInverse, backgroundColor: "rgba(255,255,255,0.25)" },
  infoGrid: { gap: 12 },
  infoItem: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  infoLabel: { fontSize: 12, color: Colors.textMuted, marginBottom: 4, fontWeight: "500" },
  infoValue: { fontSize: 15, color: Colors.text, fontWeight: "600" },
  overdueText: { color: Colors.danger },
  itemsCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  itemRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 },
  itemInfo: { flex: 1, marginRight: 12 },
  itemSortNo: { fontSize: 10, fontWeight: "700", color: Colors.textMuted, marginBottom: 1 },
  itemName: { fontSize: 14, fontWeight: "600", color: Colors.text, marginBottom: 2 },
  itemBrand: { fontSize: 11, color: Colors.primary, fontWeight: "600", marginBottom: 3 },
  itemMeta: { fontSize: 12, color: Colors.textMuted },
  newStockRow: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 8 },
  newStockLabel: { fontSize: 11, fontWeight: "600", color: Colors.textSecondary },
  newStockInput: {
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    borderBottomWidth: 1.5,
    borderBottomColor: Colors.primary,
    paddingVertical: 2,
    minWidth: 60,
    maxWidth: 100,
  },
  itemTotal: { fontSize: 14, fontWeight: "700", color: Colors.text },
  itemDivider: { height: 1, backgroundColor: Colors.border },
  totalLabel: { fontSize: 15, fontWeight: "700", color: Colors.text },
  totalValue: { fontSize: 17, fontWeight: "800", color: Colors.primary },
  notesCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  notesText: { fontSize: 14, color: Colors.textSecondary, lineHeight: 21 },
  actions: { gap: 12, marginTop: 8 },
  primaryAction: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryActionText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
  cancelAction: {
    backgroundColor: Colors.dangerLight,
    borderRadius: 14,
    padding: 16,
    alignItems: "center",
  },
  cancelActionText: { fontSize: 16, fontWeight: "700", color: Colors.danger },
});
