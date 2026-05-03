import React, { useState, useMemo } from "react";
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
import {
  useApp,
  OrderStatus,
  showStorageErrorAlert,
  collapseToCanonical,
  normalizeFilterKey,
} from "@/context/AppContext";
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
  const { orders, clearAllOrders, suppliers } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [activeBrands, setActiveBrands] = useState<string[]>([]);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [downloading, setDownloading] = useState(false);

  const statusFiltered = useMemo(() => {
    if (activeFilter === "all") return orders;
    return orders.filter((o) => o.status === activeFilter);
  }, [orders, activeFilter]);

  // Collapse near-duplicate spellings ("Acme", "acme", "Acme ") into one filter
  // entry so the modal stays scannable as the supplier list grows. The canonical
  // spelling shown is the most common one across the visible orders.
  const allBrands = useMemo(() => {
    const raws: string[] = [];
    statusFiltered.forEach((o) =>
      o.items.forEach((item) => raws.push(item.brand ?? ""))
    );
    return collapseToCanonical(raws);
  }, [statusFiltered]);

  const allCategories = useMemo(() => {
    const raws: string[] = [];
    statusFiltered.forEach((o) =>
      o.items.forEach((item) => raws.push(item.category ?? ""))
    );
    return collapseToCanonical(raws);
  }, [statusFiltered]);

  // Compare active filter values to item values via their normalized keys so
  // selecting "Acme" still matches items stored as "acme" or "Acme ".
  const activeBrandKeys = useMemo(
    () => new Set(activeBrands.map((b) => normalizeFilterKey(b))),
    [activeBrands]
  );
  const activeCategoryKeys = useMemo(
    () => new Set(activeCategories.map((c) => normalizeFilterKey(c))),
    [activeCategories]
  );

  const filtered = useMemo(() => {
    let base = statusFiltered;
    if (activeBrandKeys.size > 0) {
      base = base.filter((o) =>
        o.items.some(
          (item) =>
            item.brand != null &&
            activeBrandKeys.has(normalizeFilterKey(item.brand))
        )
      );
    }
    if (activeCategoryKeys.size > 0) {
      base = base.filter((o) =>
        o.items.some(
          (item) =>
            item.category != null &&
            activeCategoryKeys.has(normalizeFilterKey(item.category))
        )
      );
    }
    // Sort by items count descending so the largest orders surface
    // first, with supplier name as a stable tiebreaker for orders
    // that have the same number of items.
    return [...base].sort((a, b) => {
      const diff = (b.items?.length ?? 0) - (a.items?.length ?? 0);
      if (diff !== 0) return diff;
      return (a.supplierName ?? "").localeCompare(
        b.supplierName ?? "",
        undefined,
        { sensitivity: "base" }
      );
    });
  }, [statusFiltered, activeBrandKeys, activeCategoryKeys]);

  function toggleBrand(brand: string) {
    const key = normalizeFilterKey(brand);
    setActiveBrands((prev) => {
      const without = prev.filter((b) => normalizeFilterKey(b) !== key);
      return without.length === prev.length ? [...prev, brand] : without;
    });
  }

  function brandOrderCount(brand: string): number {
    const key = normalizeFilterKey(brand);
    return statusFiltered.filter((o) =>
      o.items.some(
        (item) => item.brand != null && normalizeFilterKey(item.brand) === key
      )
    ).length;
  }

  function toggleCategory(cat: string) {
    const key = normalizeFilterKey(cat);
    setActiveCategories((prev) => {
      const without = prev.filter((c) => normalizeFilterKey(c) !== key);
      return without.length === prev.length ? [...prev, cat] : without;
    });
  }

  function categoryOrderCount(cat: string): number {
    const key = normalizeFilterKey(cat);
    return statusFiltered.filter((o) =>
      o.items.some(
        (item) =>
          item.category != null && normalizeFilterKey(item.category) === key
      )
    ).length;
  }

  async function handleExport() {
    if (filtered.length === 0) {
      Alert.alert("Nothing to Export", "No orders match the current filters.");
      return;
    }
    try {
      setDownloading(true);
      const colHeader = ["Item Description", "Brand", "Category", "UOM", "MRP", "Stock", "Min", "Order Qty", "Notes"];
      const dataRows: (string | number)[][] = [];
      for (const order of filtered) {
        let exportItems = order.items;
        if (activeBrandKeys.size > 0) {
          exportItems = exportItems.filter(
            (it) =>
              it.brand != null &&
              activeBrandKeys.has(normalizeFilterKey(it.brand))
          );
        }
        if (activeCategoryKeys.size > 0) {
          exportItems = exportItems.filter(
            (it) =>
              it.category != null &&
              activeCategoryKeys.has(normalizeFilterKey(it.category))
          );
        }
        for (const item of exportItems) {
          const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
          dataRows.push([
            desc,
            item.brand ?? "",
            item.category ?? "",
            item.unit,
            item.unitPrice,
            item.stock ?? "",
            item.min ?? "",
            item.quantity,
            item.notes ?? "",
          ]);
        }
      }
      const uniqueSuppliers = [...new Set(filtered.map((o) => o.supplierName))].join(", ");
      const exportDate = new Date().toLocaleDateString("en-IN");
      // Collect every distinct source-file create date across the exported
      // orders. With the bulk export merging multiple orders into one sheet,
      // there could be 0, 1, or many — show "various" if more than one.
      const fileCreatedDates = [
        ...new Set(
          filtered
            .map((o) => o.fileCreatedDate)
            .filter((d): d is string => !!d)
            .map((d) => new Date(d).toLocaleDateString("en-IN"))
        ),
      ];
      const fileCreatedFooter: (string | number)[][] =
        fileCreatedDates.length === 0
          ? []
          : fileCreatedDates.length === 1
            ? [[`File Created Date : ${fileCreatedDates[0]}`, "", "", "", "", "", "", "", ""]]
            : [
                [
                  `File Created Dates : ${fileCreatedDates.join(", ")}`,
                  "", "", "", "", "", "", "", "",
                ],
              ];
      const sheetData: (string | number)[][] = [
        ["Sathyam Super Store",                                                  "", "ORDER FORM",  "", "", "", "", "", ""],
        ["2A,Mettupalayam Road, Cheran Nagar",                                   "", "",            "", "", "", "", "", ""],
        ["Coimbatore-641029",                                                    "", "",            "", "", "", "", "", ""],
        ["98431-44868",                                                          "", "",            "", "", "", "", "", ""],
        ["Whatsapp: 97881-44868",                                                "", "",            "", "", "", "", "", ""],
        ["Accounts: 97868-64868",                                                "", "",            "", "", "", "", "", ""],
        ["GST# : 33ADFFS5244N1ZR",                                               "", "",            "", "", "", "", "", ""],
        ["***ORDER FORM MUST BE ATTACHED WITH INVOICE DURING DELIVERY ***",      "", "",            "", "", "", "", "", ""],
        ["", "", "", "", "", "", "", "", ""],
        colHeader,
        ...dataRows,
        ["", "", "", "", "", "", "", "", ""],
        [`Supplier : ${uniqueSuppliers}`,  "", "", "", "", "", "", "", ""],
        [`Order Date : ${exportDate}`,     "", "", "", "", "", "", "", ""],
        ...fileCreatedFooter,
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [
        { wch: 32 }, { wch: 16 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 },
      ];
      // wrapText on Column A (Item Description) — data starts at row 11 (9 header + 1 colHeader)
      const dataStartRow = 11;
      for (let i = 0; i < dataRows.length; i++) {
        const cellRef = `A${dataStartRow + i}`;
        if (ws[cellRef]) {
          ws[cellRef].s = { alignment: { wrapText: true, vertical: "top" } };
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
      XLSX.utils.book_append_sheet(wb, ws, "Orders");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Sathyam Super Store - ${_ts}.xlsx`;
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

  async function doClearAll() {
    try {
      await clearAllOrders();
      setActiveFilter("all");
      setActiveBrands([]);
      setActiveCategories([]);
    } catch {
      showStorageErrorAlert();
    }
  }

  function handleClearAll() {
    if (orders.length === 0) return;
    const msg = `This will permanently delete all ${orders.length} order${orders.length !== 1 ? "s" : ""}. This cannot be undone.`;
    if (Platform.OS === "web") {
      if (window.confirm(`Remove All Orders\n\n${msg}`)) {
        void doClearAll();
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
            void doClearAll();
          },
        },
      ]
    );
  }

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const brandActive = activeBrands.length > 0;
  const brandBarLabel = activeBrands.length === 0
    ? "All Brands"
    : activeBrands.length === 1
    ? "1 Brand"
    : `${activeBrands.length} Brands`;
  const categoryActive = activeCategories.length > 0;
  const categoryBarLabel = activeCategories.length === 0
    ? "All Categories"
    : activeCategories.length === 1
    ? "1 Category"
    : `${activeCategories.length} Categories`;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Orders</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => router.push("/order/new")}
        >
          <Feather name="plus" size={20} color={Colors.textInverse} />
        </TouchableOpacity>
      </View>
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={styles.exportBtn}
          onPress={handleExport}
          disabled={downloading || filtered.length === 0}
        >
          {downloading ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <Feather name="download" size={16} color={filtered.length === 0 ? Colors.textMuted : Colors.success ?? Colors.primary} />
          )}
          <Text style={[styles.exportBtnText, filtered.length === 0 && styles.exportBtnTextDisabled]}>
            Export
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.importBtn}
          onPress={() => router.push("/order/import")}
        >
          <Feather name="upload" size={16} color={Colors.primary} />
          <Text style={styles.importBtnText}>Excel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.txtBtn}
          onPress={() => router.push("/order/import?format=txt")}
        >
          <Feather name="file-text" size={16} color={Colors.accent} />
          <Text style={styles.txtBtnText}>TXT</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.driveBtn}
          onPress={() => router.push("/drive-import")}
        >
          <Feather name="hard-drive" size={16} color="#1a73e8" />
          <Text style={styles.driveBtnText}>Drive</Text>
        </TouchableOpacity>
        {orders.length > 0 && (
          <TouchableOpacity style={styles.clearAllBtn} onPress={handleClearAll}>
            <Feather name="trash-2" size={16} color={Colors.danger} />
            <Text style={styles.clearAllBtnText}>Delete</Text>
          </TouchableOpacity>
        )}
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
              onPress={() => { setActiveFilter(f.key); setActiveBrands([]); setActiveCategories([]); }}
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

      {/* Brand + Category filter row — always visible below status pills */}
      <View style={styles.filterBarsRow}>
        <TouchableOpacity
          style={[styles.brandBar, styles.filterBarHalf, brandActive && styles.brandBarActive]}
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
        <TouchableOpacity
          style={[styles.brandBar, styles.filterBarHalf, categoryActive && styles.brandBarActive]}
          onPress={() => { setCategorySearch(""); setShowCategoryModal(true); }}
          activeOpacity={0.75}
        >
          <Feather
            name="folder"
            size={14}
            color={categoryActive ? Colors.textInverse : Colors.textSecondary}
          />
          <Text
            style={[styles.brandBarText, categoryActive && styles.brandBarTextActive]}
            numberOfLines={1}
          >
            {categoryBarLabel}
          </Text>
          {categoryActive ? (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); setActiveCategories([]); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          ) : (
            <Feather name="chevron-down" size={14} color={Colors.textMuted} />
          )}
        </TouchableOpacity>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const vendorCode = suppliers.find((s) => s.id === item.supplierId)?.vendorCode ?? "";
          return <OrderCard order={item} vendorCode={vendorCode} />;
        }}
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
              brandActive && categoryActive
                ? "No orders match the selected brands and categories"
                : brandActive
                ? `No orders match the selected brand${activeBrands.length !== 1 ? "s" : ""}`
                : categoryActive
                ? `No orders match the selected categor${activeCategories.length !== 1 ? "ies" : "y"}`
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
                        const isSelected = activeBrandKeys.has(normalizeFilterKey(brand));
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

      {/* Category filter modal */}
      <Modal
        visible={showCategoryModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCategoryModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowCategoryModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter by Category</Text>
            {categoryActive && (
              <TouchableOpacity onPress={() => setActiveCategories([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allCategories.length > 0 && (
            <View style={styles.brandSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.brandSearchInput}
                value={categorySearch}
                onChangeText={setCategorySearch}
                placeholder="Search categories…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {categorySearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity onPress={() => setCategorySearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allCategories.length === 0 ? (
            <View style={styles.noBrands}>
              <Feather name="folder" size={32} color={Colors.textMuted} />
              <Text style={styles.noBrandsTitle}>No Categories Yet</Text>
              <Text style={styles.noBrandsSub}>
                Import orders with a Category column to filter by category.
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.brandList} keyboardShouldPersistTaps="handled">
              {(() => {
                const q = categorySearch.trim().toLowerCase();
                const visibleCategories = q ? allCategories.filter((c) => c.toLowerCase().includes(q)) : allCategories;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[styles.brandRow, activeCategories.length === 0 && styles.brandRowActive]}
                        onPress={() => setActiveCategories([])}
                      >
                        <Text style={[styles.brandName, activeCategories.length === 0 && styles.brandNameActive]}>
                          All Categories
                        </Text>
                        <Text style={styles.brandCount}>{statusFiltered.length} orders</Text>
                        {activeCategories.length === 0 && <Feather name="check" size={16} color={Colors.primary} />}
                      </TouchableOpacity>
                    )}
                    {visibleCategories.length === 0 ? (
                      <View style={styles.noBrands}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noBrandsTitle}>No match</Text>
                        <Text style={styles.noBrandsSub}>No categories found for "{categorySearch}"</Text>
                      </View>
                    ) : (
                      visibleCategories.map((cat) => {
                        const isSelected = activeCategoryKeys.has(normalizeFilterKey(cat));
                        const count = categoryOrderCount(cat);
                        return (
                          <TouchableOpacity
                            key={cat}
                            style={[styles.brandRow, isSelected && styles.brandRowActive]}
                            onPress={() => toggleCategory(cat)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <Text style={[styles.brandName, isSelected && styles.brandNameActive]}>
                              {cat}
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
            onPress={() => setShowCategoryModal(false)}
          >
            <Text style={styles.modalDoneBtnText}>
              {activeCategories.length === 0 ? "Close" : `Apply (${activeCategories.length} selected)`}
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
    paddingBottom: 4,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 8,
  },
  clearAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.dangerLight,
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  clearAllBtnText: { fontSize: 13, fontWeight: "700", color: Colors.danger },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.successLight ?? "#DCFCE7",
    borderWidth: 1,
    borderColor: Colors.success ? Colors.success + "40" : "#16A34A40",
  },
  exportBtnText: { fontSize: 13, fontWeight: "700", color: Colors.success ?? "#16A34A" },
  exportBtnTextDisabled: { color: Colors.textMuted },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  importBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  txtBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: (Colors.accent ?? "#0EA5A4") + "1A",
    borderWidth: 1,
    borderColor: (Colors.accent ?? "#0EA5A4") + "30",
  },
  txtBtnText: { fontSize: 13, fontWeight: "700", color: Colors.accent ?? "#0EA5A4" },
  driveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#e8f0fe",
    borderWidth: 1,
    borderColor: "#1a73e830",
  },
  driveBtnText: { fontSize: 13, fontWeight: "700", color: "#1a73e8" },
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
  filterBarsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  filterBarHalf: {
    flex: 1,
    marginHorizontal: 0,
    marginBottom: 0,
  },
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
});
