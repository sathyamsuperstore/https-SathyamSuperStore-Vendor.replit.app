import React, { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as XLSX from "xlsx-js-style";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, OrderStatus, Order, OrderItem } from "@/context/AppContext";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";

const STATUS_FILTERS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

function calcTotal(items: OrderItem[]): number {
  return items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
}

function StockUpdCard({
  order,
  activeBrands,
  itemSearch,
  negStockOnly,
  showNotes,
  onSave,
}: {
  order: Order;
  activeBrands: string[];
  itemSearch: string;
  negStockOnly: boolean;
  showNotes: boolean;
  onSave: (id: string, items: OrderItem[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({});
  const [nsqEdits, setNsqEdits] = useState<Record<string, string>>({});
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});

  const sortedItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    const brandFiltered =
      activeBrands.length === 0
        ? order.items
        : order.items.filter((it) => it.brand != null && activeBrands.includes(it.brand));
    let base = q
      ? brandFiltered.filter((it) => {
          const desc = it.name.includes(" - ")
            ? it.name.split(" - ").slice(1).join(" - ")
            : it.name;
          return desc.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
        })
      : brandFiltered;
    if (negStockOnly) {
      base = base.filter((it) => it.stock != null && it.stock < 0);
    }
    return [...base].sort((a, b) => {
      const ba = (a.brand ?? "").toLowerCase();
      const bb = (b.brand ?? "").toLowerCase();
      if (ba < bb) return -1;
      if (ba > bb) return 1;
      if (a.sortNo != null && b.sortNo != null) return b.sortNo - a.sortNo;
      if (a.sortNo != null) return -1;
      if (b.sortNo != null) return 1;
      return 0;
    });
  }, [order.items, activeBrands, itemSearch, negStockOnly]);

  const dirty =
    Object.keys(qtyEdits).some((k) => qtyEdits[k] !== String(order.items.find((i) => i.id === k)?.quantity ?? "")) ||
    Object.keys(nsqEdits).length > 0 ||
    Object.keys(noteEdits).length > 0;

  function handleSave() {
    const updated = order.items.map((item) => {
      const qStr = qtyEdits[item.id];
      const nStr = nsqEdits[item.id];
      const noteStr = noteEdits[item.id];
      const qty =
        qStr !== undefined
          ? isNaN(parseFloat(qStr)) || qStr.trim() === ""
            ? item.quantity
            : parseFloat(qStr)
          : item.quantity;
      const nsq =
        nStr !== undefined
          ? isNaN(parseFloat(nStr)) || nStr.trim() === ""
            ? undefined
            : parseFloat(nStr)
          : item.newStockQty;
      const notes =
        noteStr !== undefined
          ? noteStr.trim() === ""
            ? undefined
            : noteStr.trim()
          : item.notes;
      return { ...item, quantity: qty, newStockQty: nsq, notes };
    });
    onSave(order.id, updated);
    setQtyEdits({});
    setNsqEdits({});
    setNoteEdits({});
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  return (
    <View style={cardSt.card}>
      <TouchableOpacity
        style={cardSt.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.75}
      >
        <View style={{ flex: 1 }}>
          <Text style={cardSt.supplier} numberOfLines={1}>{order.supplierName}</Text>
          <Text style={cardSt.orderNo}>
            {order.orderNumber}  ·  {sortedItems.length}{activeBrands.length > 0 ? ` of ${order.items.length}` : ""} items
          </Text>
        </View>
        <StatusBadge status={order.status} />
        <Feather
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color={Colors.textMuted}
          style={{ marginLeft: 8 }}
        />
      </TouchableOpacity>

      {expanded && (
        <View style={cardSt.body}>
          {/* Table header */}
          <View style={cardSt.tableHeader}>
            <Text style={[cardSt.th, { width: 32 }]}>S.No</Text>
            <Text style={[cardSt.th, { flex: 1 }]}>Item Description</Text>
          </View>

          {sortedItems.map((item, idx) => {
            const desc = item.name.includes(" - ")
              ? item.name.split(" - ").slice(1).join(" - ")
              : item.name;
            const qtyVal = qtyEdits[item.id] ?? String(item.quantity);
            const nsqVal = nsqEdits[item.id] ?? (item.newStockQty != null ? String(item.newStockQty) : "");
            const noteVal = noteEdits[item.id] ?? (item.notes ?? "");
            return (
              <View
                key={item.id}
                style={[cardSt.tableRow, idx % 2 === 0 && cardSt.rowAlt]}
              >
                {/* Top: S.No + full-width item info */}
                <View style={cardSt.itemTopRow}>
                  <Text style={cardSt.sortNoCell}>
                    {item.sortNo ?? "—"}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={cardSt.itemName}>{desc}</Text>
                    {item.brand ? (
                      <Text style={cardSt.itemBrand}>{item.brand}</Text>
                    ) : null}
                    <Text style={cardSt.itemMeta}>
                      {item.unit}  ·  MRP {item.unitPrice}
                      {item.stock != null ? `  ·  Stk ${item.stock}` : ""}
                      {item.min != null ? `  ·  Min ${item.min}` : ""}
                    </Text>
                    {item.notes ? (
                      <Text style={cardSt.itemNotes}>📝 {item.notes}</Text>
                    ) : null}
                  </View>
                </View>
                {/* Bottom: inputs with labels */}
                <View style={cardSt.inputRow}>
                  <View style={cardSt.inputGroup}>
                    <Text style={cardSt.inputLabel}>Ord Qty</Text>
                    <TextInput
                      style={cardSt.qtyInput}
                      value={qtyVal}
                      onChangeText={(v) =>
                        setQtyEdits((prev) => ({ ...prev, [item.id]: v }))
                      }
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                  </View>
                  <View style={cardSt.inputGroup}>
                    <Text style={cardSt.inputLabel}>New Stock</Text>
                    <TextInput
                      style={cardSt.qtyInput}
                      value={nsqVal}
                      onChangeText={(v) =>
                        setNsqEdits((prev) => ({ ...prev, [item.id]: v }))
                      }
                      placeholder="—"
                      placeholderTextColor={Colors.textMuted}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                  </View>
                </View>
                {showNotes && (
                  <View style={cardSt.notesInputRow}>
                    <Text style={cardSt.inputLabel}>Notes</Text>
                    <TextInput
                      style={cardSt.notesInput}
                      value={noteVal}
                      onChangeText={(v) =>
                        setNoteEdits((prev) => ({ ...prev, [item.id]: v }))
                      }
                      placeholder="Add note..."
                      placeholderTextColor={Colors.textMuted}
                      multiline
                    />
                  </View>
                )}
              </View>
            );
          })}

          <TouchableOpacity
            style={[cardSt.saveBtn, !dirty && cardSt.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!dirty}
            activeOpacity={0.8}
          >
            <Feather name="save" size={15} color={dirty ? Colors.textInverse : Colors.textMuted} />
            <Text style={[cardSt.saveBtnText, !dirty && cardSt.saveBtnTextDisabled]}>
              Save Changes
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const cardSt = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
  },
  supplier: { fontSize: 15, fontWeight: "700", color: Colors.text },
  orderNo: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  body: { borderTopWidth: 1, borderTopColor: Colors.border },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
  },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  right: { textAlign: "right" },
  tableRow: {
    flexDirection: "column",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  rowAlt: { backgroundColor: Colors.surfaceSecondary + "60" },
  td: { fontSize: 13, color: Colors.text },
  itemTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  sortNoCell: {
    width: 28,
    textAlign: "center",
    fontSize: 11,
    color: Colors.textMuted,
    paddingTop: 2,
  },
  itemName: { fontSize: 13, fontWeight: "600", color: Colors.text },
  itemBrand: { fontSize: 11, fontWeight: "600", color: Colors.primary, marginTop: 1 },
  itemMeta: { fontSize: 17, color: Colors.textMuted, marginTop: 1 },
  itemNotes: { fontSize: 13, color: Colors.textSecondary, fontStyle: "italic", marginTop: 3 },
  notesInputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingLeft: 34,
    paddingRight: 4,
  },
  notesInput: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 32,
    backgroundColor: Colors.surface,
  },
  inputRow: {
    flexDirection: "row",
    gap: 10,
    paddingLeft: 34,
  },
  inputGroup: {
    flex: 1,
    gap: 4,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  qtyInput: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "right",
    borderWidth: 1.5,
    borderColor: Colors.primary,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    margin: 12,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  saveBtnDisabled: { backgroundColor: Colors.surfaceSecondary, borderWidth: 1, borderColor: Colors.border },
  saveBtnText: { fontSize: 14, fontWeight: "700", color: Colors.textInverse },
  saveBtnTextDisabled: { color: Colors.textMuted },
});

export default function StockUpdScreen() {
  const { orders, clearAllOrders, suppliers, updateOrder } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [activeBrands, setActiveBrands] = useState<string[]>([]);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [negStockOnly, setNegStockOnly] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
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
    const q = itemSearch.trim().toLowerCase();
    let result = statusFiltered.filter((o) => {
      const brandOk =
        activeBrands.length === 0 ||
        o.items.some((it) => it.brand != null && activeBrands.includes(it.brand));
      if (!brandOk) return false;
      if (!q) return true;
      return o.items.some((it) => {
        const desc = it.name.includes(" - ")
          ? it.name.split(" - ").slice(1).join(" - ")
          : it.name;
        return desc.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
      });
    });
    if (negStockOnly) {
      result = result.filter((o) => {
        const brandSubset =
          activeBrands.length === 0
            ? o.items
            : o.items.filter((it) => it.brand != null && activeBrands.includes(it.brand));
        const searchSubset = q
          ? brandSubset.filter((it) => {
              const desc = it.name.includes(" - ")
                ? it.name.split(" - ").slice(1).join(" - ")
                : it.name;
              return desc.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
            })
          : brandSubset;
        return searchSubset.some((it) => it.stock != null && it.stock < 0);
      });
    }
    return result;
  }, [statusFiltered, activeBrands, itemSearch, negStockOnly]);

  function toggleBrand(brand: string) {
    setActiveBrands((prev) =>
      prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]
    );
  }

  function brandOrderCount(brand: string): number {
    return statusFiltered.filter((o) =>
      o.items.some((item) => item.brand === brand)
    ).length;
  }

  async function handleExport() {
    try {
      setDownloading(true);
      const colHeader = ["Item No", "Item Description", "UOM", "MRP", "Stock", "Order Qty", "New Stock Qty", "Notes"];
      const dataRows: (string | number)[][] = [];
      const suppliersWithData = new Set<string>();
      for (const order of filtered) {
        const exportItems = activeBrands.length > 0
          ? order.items.filter((it) => it.brand != null && activeBrands.includes(it.brand))
          : order.items;
        for (const item of exportItems) {
          if (item.newStockQty == null) continue;
          const itemNo = item.name.includes(" - ") ? item.name.split(" - ")[0] : "";
          const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
          dataRows.push([
            itemNo,
            desc,
            item.unit,
            item.unitPrice,
            item.stock ?? "",
            item.quantity,
            item.newStockQty,
            item.notes ?? "",
          ]);
          suppliersWithData.add(order.supplierName);
        }
      }
      if (dataRows.length === 0) {
        Alert.alert("Nothing to Export", "No items have a New Stock Qty value yet.");
        setDownloading(false);
        return;
      }
      const uniqueSuppliers = [...suppliersWithData].sort().join(", ");
      const exportDate = new Date().toLocaleDateString("en-IN");
      const sheetData: (string | number)[][] = [
        ["Sathyam Super Store",                                                  "", "ORDER FORM",  "", "", "", "", ""],
        ["2A,Mettupalayam Road, Cheran Nagar",                                   "", "",            "", "", "", "", ""],
        ["Coimbatore-641029",                                                    "", "",            "", "", "", "", ""],
        ["98431-44868",                                                          "", "",            "", "", "", "", ""],
        ["Whatsapp: 97881-44868",                                                "", "",            "", "", "", "", ""],
        ["Accounts: 97868-64868",                                                "", "",            "", "", "", "", ""],
        ["GST# : 33ADFFS5244N1ZR",                                               "", "",            "", "", "", "", ""],
        ["***ORDER FORM MUST BE ATTACHED WITH INVOICE DURING DELIVERY ***",      "", "",            "", "", "", "", ""],
        ["", "", "", "", "", "", "", ""],
        colHeader,
        ...dataRows,
        ["", "", "", "", "", "", "", ""],
        [`Supplier : ${uniqueSuppliers}`,  "", "", "", "", "", "", ""],
        [`Order Date : ${exportDate}`,     "", "", "", "", "", "", ""],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [
        { wch: 14 }, { wch: 32 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 20 },
      ];
      const dataStartRow = 11;
      for (let i = 0; i < dataRows.length; i++) {
        const cellRefB = `B${dataStartRow + i}`;
        if (ws[cellRefB]) {
          ws[cellRefB].s = { alignment: { wrapText: true, vertical: "top" } };
        }
      }
      ws["!pageSetup"] = {
        paperSize: 9,
        orientation: "portrait",
        fitToWidth: 1,
        fitToHeight: 0,
        scale: 100,
      };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "StockUpd");
      const fileName = `stockupd_export_${Date.now()}.xlsx`;
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
            dialogTitle: "Export StockUpd",
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
    const msg = `This will permanently delete all ${orders.length} order${orders.length !== 1 ? "s" : ""}. This cannot be undone.`;
    if (Platform.OS === "web") {
      if (window.confirm(`Remove All Orders\n\n${msg}`)) {
        clearAllOrders();
        setActiveFilter("all");
        setActiveBrands([]);
      }
      return;
    }
    Alert.alert(
      "Remove All Orders",
      msg,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove All",
          style: "destructive",
          onPress: () => {
            clearAllOrders();
            setActiveFilter("all");
            setActiveBrands([]);
          },
        },
      ]
    );
  }

  const handleSaveOrder = useCallback(
    (orderId: string, items: OrderItem[]) => {
      updateOrder(orderId, { items, totalAmount: calcTotal(items) });
    },
    [updateOrder]
  );

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const brandActive = activeBrands.length > 0;
  const brandBarLabel = activeBrands.length === 0
    ? "All Brands"
    : activeBrands.length === 1
    ? "1 Brand"
    : `${activeBrands.length} Brands`;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>StockUpd</Text>
        <View style={styles.headerActions}>
          {orders.length > 0 && (
            <TouchableOpacity style={styles.clearAllBtn} onPress={handleClearAll}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.exportBtn}
            onPress={handleExport}
            disabled={downloading}
          >
            {downloading ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <Feather name="download" size={17} color={Colors.primary} />
            )}
            <Text style={styles.exportBtnText}>
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
            style={styles.driveBtn}
            onPress={() => router.push("/drive-import")}
          >
            <Feather name="hard-drive" size={17} color="#1a73e8" />
            <Text style={styles.driveBtnText}>DriveImport</Text>
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
              onPress={() => { setActiveFilter(f.key); setActiveBrands([]); }}
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

      {/* Brand filter row */}
      <TouchableOpacity
        style={[styles.brandBar, brandActive && styles.brandBarActive]}
        onPress={() => { setBrandSearch(""); setShowBrandModal(true); }}
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
          {brandBarLabel}
        </Text>
        {brandActive ? (
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); setActiveBrands([]); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="x-circle" size={15} color={Colors.textInverse} />
          </TouchableOpacity>
        ) : (
          <Feather name="chevron-down" size={14} color={Colors.textMuted} />
        )}
      </TouchableOpacity>

      {/* Negative Stock Only toggle */}
      <TouchableOpacity
        style={[styles.negStockToggle, negStockOnly && styles.negStockToggleActive]}
        onPress={() => setNegStockOnly((v) => !v)}
        activeOpacity={0.75}
      >
        <Feather
          name="trending-down"
          size={14}
          color={negStockOnly ? Colors.textInverse : Colors.textSecondary}
        />
        <Text style={[styles.negStockToggleText, negStockOnly && styles.negStockToggleTextActive]}>
          Neg. Stock Only
        </Text>
        {negStockOnly && (
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); setNegStockOnly(false); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="x-circle" size={15} color={Colors.textInverse} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>

      {/* Show Notes toggle */}
      <TouchableOpacity
        style={[styles.negStockToggle, showNotes && styles.negStockToggleActive]}
        onPress={() => setShowNotes((v) => !v)}
        activeOpacity={0.75}
      >
        <Feather
          name="edit-3"
          size={14}
          color={showNotes ? Colors.textInverse : Colors.textSecondary}
        />
        <Text style={[styles.negStockToggleText, showNotes && styles.negStockToggleTextActive]}>
          {showNotes ? "Hide Notes" : "Show Notes"}
        </Text>
      </TouchableOpacity>

      {/* Item description search bar */}
      <View style={[styles.itemSearchBar, itemSearch.length > 0 && styles.itemSearchBarActive]}>
        <Feather name="search" size={14} color={itemSearch.length > 0 ? Colors.primary : Colors.textMuted} />
        <TextInput
          style={styles.itemSearchInput}
          value={itemSearch}
          onChangeText={setItemSearch}
          placeholder="Search by Item Description…"
          placeholderTextColor={Colors.textMuted}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {itemSearch.length > 0 && Platform.OS !== "ios" && (
          <TouchableOpacity onPress={() => setItemSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Feather name="x" size={14} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <StockUpdCard order={item} activeBrands={activeBrands} itemSearch={itemSearch} negStockOnly={negStockOnly} showNotes={showNotes} onSave={handleSaveOrder} />
        )}
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
                ? `No orders match the selected brand${activeBrands.length !== 1 ? "s" : ""}`
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
              <TouchableOpacity onPress={() => setActiveBrands([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allBrands.length > 0 && (
            <View style={styles.brandSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.brandSearchInput}
                value={brandSearch}
                onChangeText={setBrandSearch}
                placeholder="Search brands…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {brandSearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity onPress={() => setBrandSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allBrands.length === 0 ? (
            <View style={styles.noBrands}>
              <Feather name="tag" size={32} color={Colors.textMuted} />
              <Text style={styles.noBrandsTitle}>No Brands Yet</Text>
              <Text style={styles.noBrandsSub}>
                Import orders with a Brand column to filter by brand.
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.brandList} keyboardShouldPersistTaps="handled">
              {(() => {
                const q = brandSearch.trim().toLowerCase();
                const visibleBrands = q ? allBrands.filter((b) => b.toLowerCase().includes(q)) : allBrands;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[styles.brandRow, activeBrands.length === 0 && styles.brandRowActive]}
                        onPress={() => setActiveBrands([])}
                      >
                        <Text style={[styles.brandName, activeBrands.length === 0 && styles.brandNameActive]}>
                          All Brands
                        </Text>
                        <Text style={styles.brandCount}>{statusFiltered.length} orders</Text>
                        {activeBrands.length === 0 && <Feather name="check" size={16} color={Colors.primary} />}
                      </TouchableOpacity>
                    )}
                    {visibleBrands.length === 0 ? (
                      <View style={styles.noBrands}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noBrandsTitle}>No match</Text>
                        <Text style={styles.noBrandsSub}>No brands found for "{brandSearch}"</Text>
                      </View>
                    ) : (
                      visibleBrands.map((brand) => {
                        const isSelected = activeBrands.includes(brand);
                        const count = brandOrderCount(brand);
                        return (
                          <TouchableOpacity
                            key={brand}
                            style={[styles.brandRow, isSelected && styles.brandRowActive]}
                            onPress={() => toggleBrand(brand)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <Text style={[styles.brandName, isSelected && styles.brandNameActive]}>
                              {brand}
                            </Text>
                            <Text style={styles.brandCount}>{count} order{count !== 1 ? "s" : ""}</Text>
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </>
                );
              })()}
            </ScrollView>
          )}

          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => setShowBrandModal(false)}
          >
            <Text style={styles.modalDoneBtnText}>
              {activeBrands.length === 0 ? "Close" : `Apply (${activeBrands.length} selected)`}
            </Text>
          </TouchableOpacity>
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
  driveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#e8f0fe",
    borderWidth: 1,
    borderColor: "#1a73e830",
  },
  driveBtnText: { fontSize: 14, fontWeight: "700", color: "#1a73e8" },
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
  itemSearchBar: {
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
  itemSearchBarActive: {
    borderColor: Colors.primary,
  },
  itemSearchInput: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.text,
    paddingVertical: 0,
  },
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
  modalDoneBtn: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  modalDoneBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
  brandSearchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  brandSearchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.text,
    paddingVertical: 0,
  },
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
  negStockToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  negStockToggleActive: {
    backgroundColor: Colors.danger,
    borderColor: Colors.danger,
  },
  negStockToggleText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  negStockToggleTextActive: {
    color: Colors.textInverse,
  },
});
