import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  ActivityIndicator,
  Image,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as XLSX from "xlsx-js-style";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, Order, OrderStatus } from "@/context/AppContext";

const STATUS_COLORS: Record<OrderStatus, { bg: string; text: string; label: string }> = {
  pending:   { bg: "#FEF3C7", text: "#92400E", label: "Pending" },
  confirmed: { bg: "#DBEAFE", text: "#1E40AF", label: "Confirmed" },
  shipped:   { bg: "#EDE9FE", text: "#5B21B6", label: "Shipped" },
  delivered: { bg: "#D1FAE5", text: "#065F46", label: "Delivered" },
  cancelled: { bg: "#FEE2E2", text: "#991B1B", label: "Cancelled" },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

export default function VendorPortalScreen() {
  const { currentUser, login, logout, orders, suppliers } = useApp();
  const insets = useSafeAreaInsets();
  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  if (!currentUser) {
    return <LoginForm topPt={topPt} />;
  }

  return <OrdersView topPt={topPt} />;
}

function LoginForm({ topPt }: { topPt: number }) {
  const { login } = useApp();
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function handleLogin() {
    if (!userId.trim() || !password.trim()) {
      setError("Please enter your User ID and Password.");
      return;
    }
    setLoading(true);
    setError("");
    setTimeout(() => {
      const result = login(userId, password);
      if (!result.success) {
        setError(result.error ?? "Login failed.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setLoading(false);
    }, 300);
  }

  return (
    <View style={[loginStyles.container, { paddingTop: topPt }]}>
      <ScrollView
        contentContainerStyle={loginStyles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={loginStyles.logoWrap}>
          <Image
            source={require("../../assets/images/logo.png")}
            style={loginStyles.logoImage}
            resizeMode="contain"
          />
          <Text style={loginStyles.appName}>Sathyam Super Store</Text>
          <Text style={loginStyles.portalLabel}>Vendor Portal</Text>
        </View>

        <View style={loginStyles.card}>
          <Text style={loginStyles.cardTitle}>Sign In</Text>
          <Text style={loginStyles.cardSubtitle}>Access your orders with your vendor credentials</Text>

          <View style={loginStyles.field}>
            <Text style={loginStyles.fieldLabel}>User ID</Text>
            <View style={loginStyles.inputWrap}>
              <Feather name="user" size={16} color={Colors.textMuted} style={loginStyles.inputIcon} />
              <TextInput
                style={loginStyles.input}
                value={userId}
                onChangeText={(v) => { setUserId(v); setError(""); }}
                placeholder="Enter your User ID"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>
          </View>

          <View style={loginStyles.field}>
            <Text style={loginStyles.fieldLabel}>Password</Text>
            <View style={loginStyles.inputWrap}>
              <Feather name="lock" size={16} color={Colors.textMuted} style={loginStyles.inputIcon} />
              <TextInput
                style={[loginStyles.input, { flex: 1 }]}
                value={password}
                onChangeText={(v) => { setPassword(v); setError(""); }}
                placeholder="Enter your password"
                placeholderTextColor={Colors.textMuted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
              <TouchableOpacity onPress={() => setShowPassword((v) => !v)} style={loginStyles.eyeBtn}>
                <Feather name={showPassword ? "eye-off" : "eye"} size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>

          {!!error && (
            <View style={loginStyles.errorRow}>
              <Feather name="alert-circle" size={14} color={Colors.danger} />
              <Text style={loginStyles.errorText}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[loginStyles.loginBtn, loading && { opacity: 0.7 }]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color={Colors.textInverse} size="small" />
            ) : (
              <>
                <Feather name="log-in" size={18} color={Colors.textInverse} />
                <Text style={loginStyles.loginBtnText}>Sign In</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <Text style={loginStyles.hint}>
          Contact your administrator if you don't have login credentials.
        </Text>
      </ScrollView>
    </View>
  );
}

function OrdersView({ topPt }: { topPt: number }) {
  const { currentUser, logout, orders, suppliers } = useApp();
  const insets = useSafeAreaInsets();
  const [downloading, setDownloading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [showStock, setShowStock] = useState(false);
  const [activeBrand, setActiveBrand] = useState<string>("all");
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");

  const vendorOrders = useMemo(() => {
    if (!currentUser) return [];
    if (currentUser.userType === "Manager" || currentUser.userType === "Admin") return orders;

    // Build a list of candidate vendor codes to try:
    // 1. The explicit vendorCode field
    // 2. The userId itself (in case vendorCode was left blank or they're the same)
    const candidates = [currentUser.vendorCode, currentUser.userId]
      .map((c) => c?.trim().toUpperCase())
      .filter(Boolean) as string[];

    if (candidates.length === 0) return [];

    // Exact match first
    let mySupplier = suppliers.find((s) =>
      candidates.includes(s.vendorCode.toUpperCase())
    );

    // Substring fallback: e.g. userId "V01V00013" contains vendorCode "V00013"
    if (!mySupplier) {
      mySupplier = suppliers.find((s) =>
        candidates.some((c) => c.includes(s.vendorCode.toUpperCase()))
      );
    }

    if (mySupplier) {
      return orders.filter((o) => o.supplierId === mySupplier!.id);
    }

    // Final fallback: match orders where supplierName looks like a vendor code
    // and any candidate contains it, OR the supplierName contains any candidate.
    // e.g. supplierName="V00013", candidate="V01V00013" → "V01V00013".includes("V00013") ✓
    // e.g. supplierName="ABC Corp V00013", candidate="V00013" → "ABC CORP V00013".includes("V00013") ✓
    return orders.filter((o) => {
      const sn = o.supplierName.toUpperCase();
      return candidates.some(
        (c) =>
          sn.includes(c) ||           // supplierName contains candidate
          c.includes(sn) ||           // candidate contains supplierName (e.g. userId contains code)
          o.supplierId === c          // supplierId stored as vendorCode (old imports)
      );
    });
  }, [orders, suppliers, currentUser]);

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    vendorOrders.forEach((o) => o.items.forEach((item) => { if (item.brand) set.add(item.brand); }));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [vendorOrders]);

  const statusFiltered = useMemo(() => {
    if (activeFilter === "all") return vendorOrders;
    return vendorOrders.filter((o) => o.status === activeFilter);
  }, [vendorOrders, activeFilter]);

  const filtered = useMemo(() => {
    if (activeBrand === "all") return statusFiltered;
    return statusFiltered.filter((o) => o.items.some((item) => item.brand === activeBrand));
  }, [statusFiltered, activeBrand]);

  function brandOrderCount(brand: string) {
    return statusFiltered.filter((o) => o.items.some((item) => item.brand === brand)).length;
  }

  const brandActive = activeBrand !== "all";

  const totalValue = useMemo(() => vendorOrders.reduce((s, o) => s + o.totalAmount, 0), [vendorOrders]);
  const pendingCount = useMemo(() => vendorOrders.filter((o) => o.status === "pending").length, [vendorOrders]);

  async function handleDownload() {
    if (vendorOrders.length === 0) {
      Alert.alert("No Orders", "There are no orders to download.");
      return;
    }
    setDownloading(true);
    try {
      const colHeader = showStock
        ? ["Item Description", "Brand", "UOM", "MRP", "Order Qty"]
        : ["Item Description", "Brand", "UOM", "MRP", "Stock", "Order Qty"];
      const dataRows: (string | number)[][] = [];
      for (const order of filtered) {
        const exportItems = brandActive
          ? order.items.filter((item) => item.brand === activeBrand)
          : order.items;
        for (const item of exportItems) {
          const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
          if (showStock) {
            dataRows.push([desc, item.brand ?? "", item.unit, item.unitPrice, item.quantity]);
          } else {
            dataRows.push([desc, item.brand ?? "", item.unit, item.unitPrice, item.stock ?? "", item.quantity]);
          }
        }
      }
      const supplierName = vendorOrders.length > 0 ? vendorOrders[0].supplierName : (currentUser?.vendorName ?? "");
      const exportDate = new Date().toLocaleDateString("en-IN");
      // When showStock is ON the Stock column is omitted from the export (5 cols), otherwise 6 cols
      const pad = showStock ? ["", "", "", "", ""] : ["", "", "", "", "", ""];
      const sheetData: (string | number)[][] = [
        ["Sathyam Super Store",                                                  "", "ORDER FORM",  ...pad.slice(3)],
        ["2A,Mettupalayam Road, Cheran Nagar",                                   ...pad.slice(1)],
        ["Coimbatore-641029",                                                    ...pad.slice(1)],
        ["98431-44868",                                                          ...pad.slice(1)],
        ["Whatsapp: 97881-44868",                                                ...pad.slice(1)],
        ["Accounts: 97868-64868",                                                ...pad.slice(1)],
        ["GST# : 33ADFFS5244N1ZR",                                               ...pad.slice(1)],
        ["***ORDER FORM MUST BE ATTACHED WITH INVOICE DURING DELIVERY ***",      ...pad.slice(1)],
        pad,
        colHeader,
        ...dataRows,
        pad,
        [`Supplier : ${supplierName}`,  ...pad.slice(1)],
        [`Order Date : ${exportDate}`,  ...pad.slice(1)],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = showStock
        ? [{ wch: 32 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 10 }]
        : [{ wch: 32 }, { wch: 16 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
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

      const fileName = `orders_${currentUser?.vendorCode ?? "vendor"}_${Date.now()}.xlsx`;

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

  function confirmLogout() {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: logout },
    ]);
  }

  const STATUS_FILTERS: { key: OrderStatus | "all"; label: string }[] = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "confirmed", label: "Confirmed" },
    { key: "shipped", label: "Shipped" },
    { key: "delivered", label: "Delivered" },
    { key: "cancelled", label: "Cancelled" },
  ];

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>My Orders</Text>
          <View style={styles.userBadge}>
            <Feather name="user" size={11} color={Colors.primary} />
            <Text style={styles.userBadgeText}>{currentUser?.userId}</Text>
            {currentUser?.vendorCode ? (
              <Text style={styles.vendorCodeBadge}>{currentUser.vendorCode}</Text>
            ) : null}
          </View>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[styles.downloadBtn, downloading && { opacity: 0.6 }]}
            onPress={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <Feather name="download" size={17} color={Colors.primary} />
            )}
            <Text style={styles.downloadBtnText}>{downloading ? "..." : "Export"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.logoutBtn} onPress={confirmLogout}>
            <Feather name="log-out" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {vendorOrders.length > 0 && (
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{vendorOrders.length}</Text>
            <Text style={styles.statLabel}>Total Orders</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{pendingCount}</Text>
            <Text style={styles.statLabel}>Pending</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{formatCurrency(totalValue)}</Text>
            <Text style={styles.statLabel}>Total Value</Text>
          </View>
        </View>
      )}

      {vendorOrders.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {STATUS_FILTERS.map((f) => (
            <TouchableOpacity
              key={f.key}
              style={[styles.filterChip, activeFilter === f.key && styles.filterChipActive]}
              onPress={() => setActiveFilter(f.key)}
            >
              <Text style={[styles.filterChipText, activeFilter === f.key && styles.filterChipTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {vendorOrders.length > 0 && (
        <TouchableOpacity
          style={[styles.brandBar, brandActive && styles.brandBarActive]}
          onPress={() => { setBrandSearch(""); setShowBrandModal(true); }}
          activeOpacity={0.75}
        >
          <Feather name="tag" size={14} color={brandActive ? Colors.textInverse : Colors.textSecondary} />
          <Text style={[styles.brandBarText, brandActive && styles.brandBarTextActive]} numberOfLines={1}>
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
      )}

      {!currentUser?.vendorCode ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <Feather name="alert-circle" size={36} color={Colors.textMuted} />
          </View>
          <Text style={styles.emptyTitle}>No Vendor Code Linked</Text>
          <Text style={styles.emptySubtitle}>
            Your account doesn't have a vendor code. Contact your administrator.
          </Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <Feather name="inbox" size={36} color={Colors.textMuted} />
          </View>
          <Text style={styles.emptyTitle}>
            {vendorOrders.length === 0 ? "No Orders Yet" : "No Orders Found"}
          </Text>
          <Text style={styles.emptySubtitle}>
            {vendorOrders.length === 0
              ? `No orders have been placed for vendor code ${currentUser?.vendorCode}.`
              : "No orders match the selected filter."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(o) => o.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <VendorOrderCard
              order={item}
              showStock={showStock}
              onToggleStock={() => setShowStock((v) => !v)}
            />
          )}
        />
      )}

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
              <TouchableOpacity onPress={() => { setActiveBrand("all"); setShowBrandModal(false); }}>
                <Text style={styles.modalClear}>Clear</Text>
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
              <Text style={styles.noBrandsSub}>Import orders with a Brand column to filter by brand.</Text>
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
                        style={[styles.brandRow, !brandActive && styles.brandRowActive]}
                        onPress={() => { setActiveBrand("all"); setShowBrandModal(false); }}
                      >
                        <Text style={[styles.brandName, !brandActive && styles.brandNameActive]}>All Brands</Text>
                        <Text style={styles.brandCount}>{statusFiltered.length} order{statusFiltered.length !== 1 ? "s" : ""}</Text>
                        {!brandActive && <Feather name="check" size={16} color={Colors.primary} />}
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
                        const isActive = activeBrand === brand;
                        const count = brandOrderCount(brand);
                        return (
                          <TouchableOpacity
                            key={brand}
                            style={[styles.brandRow, isActive && styles.brandRowActive]}
                            onPress={() => { setActiveBrand(brand); setShowBrandModal(false); }}
                          >
                            <View style={styles.brandDot} />
                            <Text style={[styles.brandName, isActive && styles.brandNameActive]}>{brand}</Text>
                            <Text style={styles.brandCount}>{count} order{count !== 1 ? "s" : ""}</Text>
                            {isActive && <Feather name="check" size={16} color={Colors.primary} />}
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </>
                );
              })()}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const ALL_STATUSES: OrderStatus[] = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

function VendorOrderCard({
  order,
  showStock,
  onToggleStock,
}: {
  order: Order;
  showStock: boolean;
  onToggleStock: () => void;
}) {
  const { updateOrderStatus, updateOrder } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [modifyMode, setModifyMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [editedQtys, setEditedQtys] = useState<Record<string, string>>({});
  const status = STATUS_COLORS[order.status];

  function handleStatusChange(newStatus: OrderStatus) {
    if (newStatus === order.status) return;
    Alert.alert(
      "Update Status",
      `Change status to "${STATUS_COLORS[newStatus].label}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update",
          onPress: () => {
            updateOrderStatus(order.id, newStatus);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ]
    );
  }

  function enterModifyMode() {
    const qtys: Record<string, string> = {};
    order.items.forEach((i) => { qtys[i.id] = String(i.quantity); });
    setCheckedIds(new Set(order.items.map((i) => i.id)));
    setEditedQtys(qtys);
    setModifyMode(true);
  }

  function cancelModify() {
    setModifyMode(false);
    setCheckedIds(new Set());
    setEditedQtys({});
  }

  function toggleItem(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function saveModify() {
    const newItems = order.items
      .filter((i) => checkedIds.has(i.id))
      .map((i) => {
        const parsed = parseFloat(editedQtys[i.id] ?? "");
        const qty = !isNaN(parsed) && parsed > 0 ? parsed : i.quantity;
        return { ...i, quantity: qty };
      });
    if (newItems.length === 0) {
      if (Platform.OS === "web") {
        window.alert("At least one item must remain in the order.");
      } else {
        Alert.alert("Cannot Save", "At least one item must remain in the order.");
      }
      return;
    }
    const newTotal = newItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
    updateOrder(order.id, { items: newItems, totalAmount: newTotal });
    setModifyMode(false);
    setCheckedIds(new Set());
    setEditedQtys({});
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  return (
    <View style={cardStyles.card}>
      <TouchableOpacity style={cardStyles.header} onPress={() => setExpanded((e) => !e)} activeOpacity={0.7}>
        <View style={cardStyles.headerLeft}>
          <Text style={cardStyles.orderNo}>{order.orderNumber}</Text>
          <Text style={cardStyles.date}>{formatDate(order.createdAt)}</Text>
        </View>
        <View style={cardStyles.headerRight}>
          <View style={[cardStyles.statusBadge, { backgroundColor: status.bg }]}>
            <Text style={[cardStyles.statusText, { color: status.text }]}>{status.label}</Text>
          </View>
          <Feather name={expanded ? "chevron-up" : "chevron-down"} size={16} color={Colors.textMuted} />
        </View>
      </TouchableOpacity>

      <View style={cardStyles.summary}>
        <View style={cardStyles.summaryLeft}>
          <Feather name="package" size={13} color={Colors.textMuted} />
          <Text style={cardStyles.summaryText}>{order.items.length} item{order.items.length !== 1 ? "s" : ""}</Text>
        </View>
        <Text style={cardStyles.amount}>{formatCurrency(order.totalAmount)}</Text>
      </View>

      {expanded && (
        <View style={cardStyles.itemsSection}>
          <View style={cardStyles.statusSection}>
            <Text style={cardStyles.statusSectionLabel}>Update Status</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cardStyles.statusOptions}>
              {ALL_STATUSES.map((s) => {
                const sc = STATUS_COLORS[s];
                const isActive = order.status === s;
                return (
                  <TouchableOpacity
                    key={s}
                    style={[
                      cardStyles.statusOption,
                      { borderColor: isActive ? sc.text : Colors.border },
                      isActive && { backgroundColor: sc.bg },
                    ]}
                    onPress={() => handleStatusChange(s)}
                    activeOpacity={0.7}
                  >
                    {isActive && (
                      <Feather name="check" size={11} color={sc.text} />
                    )}
                    <Text style={[cardStyles.statusOptionText, { color: isActive ? sc.text : Colors.textSecondary }, isActive && { fontWeight: "800" }]}>
                      {sc.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* Modify / Save / Cancel toolbar */}
          {!modifyMode ? (
            <TouchableOpacity style={cardStyles.modifyBtn} onPress={enterModifyMode} activeOpacity={0.8}>
              <Feather name="edit-2" size={14} color={Colors.primary} />
              <Text style={cardStyles.modifyBtnText}>Modify</Text>
            </TouchableOpacity>
          ) : (
            <View style={cardStyles.modifyToolbar}>
              <Text style={cardStyles.modifyHint}>
                {checkedIds.size} of {order.items.length} selected
              </Text>
              <View style={cardStyles.modifyActions}>
                <TouchableOpacity style={cardStyles.cancelModifyBtn} onPress={cancelModify} activeOpacity={0.8}>
                  <Text style={cardStyles.cancelModifyText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={cardStyles.saveModifyBtn} onPress={saveModify} activeOpacity={0.8}>
                  <Feather name="save" size={14} color={Colors.textInverse} />
                  <Text style={cardStyles.saveModifyText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Items table */}
          <View style={cardStyles.stockToggleRow}>
            <TouchableOpacity
              style={[cardStyles.stockToggleBtn, showStock && cardStyles.stockToggleBtnOn]}
              onPress={onToggleStock}
              activeOpacity={0.75}
            >
              <Feather
                name={showStock ? "eye" : "eye-off"}
                size={13}
                color={showStock ? Colors.primary : Colors.textMuted}
              />
              <Text style={[cardStyles.stockToggleText, showStock && cardStyles.stockToggleTextOn]}>
                Hide Stock
              </Text>
            </TouchableOpacity>
          </View>
          <View style={cardStyles.tableHeader}>
            {modifyMode && <View style={{ width: 32 }} />}
            <Text style={[cardStyles.th, { flex: 3 }]}>Item</Text>
            <Text style={[cardStyles.th, cardStyles.right]}>Qty</Text>
            <Text style={[cardStyles.th, cardStyles.right]}>UOM</Text>
            {showStock && <Text style={[cardStyles.th, cardStyles.right]}>Stock</Text>}
            <Text style={[cardStyles.th, cardStyles.right]}>MRP</Text>
          </View>
          {order.items.map((item, i) => {
            const itemNo = item.name.includes(" - ") ? item.name.split(" - ")[0] : "";
            const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
            const isChecked = checkedIds.has(item.id);
            return (
              <View
                key={item.id}
                style={[
                  cardStyles.tableRow,
                  i % 2 === 0 && cardStyles.rowAlt,
                  modifyMode && !isChecked && cardStyles.rowUnchecked,
                ]}
              >
                {modifyMode && (
                  <TouchableOpacity
                    style={cardStyles.checkboxCol}
                    onPress={() => toggleItem(item.id)}
                    activeOpacity={0.7}
                  >
                    <Feather
                      name={isChecked ? "check-square" : "square"}
                      size={18}
                      color={isChecked ? Colors.primary : Colors.textMuted}
                    />
                  </TouchableOpacity>
                )}
                <View style={{ flex: 3 }}>
                  {itemNo ? <Text style={cardStyles.itemNo}>{itemNo}</Text> : null}
                  <Text style={[cardStyles.td, modifyMode && !isChecked && cardStyles.tdStrike]}>{desc}</Text>
                </View>
                {modifyMode ? (
                  <TextInput
                    style={[cardStyles.td, cardStyles.qtyInput, !isChecked && { opacity: 0.4 }]}
                    value={editedQtys[item.id] ?? String(item.quantity)}
                    onChangeText={(v) => setEditedQtys((prev) => ({ ...prev, [item.id]: v }))}
                    keyboardType="numeric"
                    selectTextOnFocus
                    editable={isChecked}
                  />
                ) : (
                  <Text style={[cardStyles.td, cardStyles.right]}>{item.quantity}</Text>
                )}
                <Text style={[cardStyles.td, cardStyles.right]}>{item.unit}</Text>
                {showStock && (
                  <Text style={[cardStyles.td, cardStyles.right]}>
                    {item.stock != null && item.stock !== undefined ? item.stock : "—"}
                  </Text>
                )}
                <Text style={[cardStyles.td, cardStyles.right, cardStyles.price]}>
                  {formatCurrency(item.unitPrice)}
                </Text>
              </View>
            );
          })}
          {order.notes ? (
            <View style={cardStyles.notes}>
              <Feather name="info" size={12} color={Colors.textMuted} />
              <Text style={cardStyles.notesText} numberOfLines={2}>{order.notes}</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const loginStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { flexGrow: 1, padding: 24, justifyContent: "center", gap: 24 },
  logoWrap: { alignItems: "center", gap: 6 },
  logoImage: { width: 100, height: 100 },
  appName: { fontSize: 20, fontWeight: "800", color: Colors.text },
  portalLabel: { fontSize: 13, color: Colors.textMuted, fontWeight: "500" },
  card: {
    backgroundColor: Colors.surface, borderRadius: 20, padding: 24,
    borderWidth: 1, borderColor: Colors.border, gap: 16,
  },
  cardTitle: { fontSize: 20, fontWeight: "800", color: Colors.text },
  cardSubtitle: { fontSize: 13, color: Colors.textMuted, marginTop: -8 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "700", color: Colors.text },
  inputWrap: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.surfaceSecondary, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 14,
  },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, paddingVertical: 13, fontSize: 15, color: Colors.text },
  eyeBtn: { padding: 6 },
  errorRow: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: Colors.dangerLight, borderRadius: 8, padding: 10,
  },
  errorText: { fontSize: 13, color: Colors.danger, flex: 1 },
  loginBtn: {
    backgroundColor: Colors.primary, borderRadius: 14, padding: 16,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
  },
  loginBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
  hint: { fontSize: 12, color: Colors.textMuted, textAlign: "center" },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12,
  },
  title: { fontSize: 24, fontWeight: "800", color: Colors.text },
  userBadge: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  userBadgeText: { fontSize: 12, color: Colors.primary, fontWeight: "600" },
  vendorCodeBadge: {
    fontSize: 10, fontWeight: "800", color: Colors.textInverse,
    backgroundColor: Colors.primary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  downloadBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 10, backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: Colors.primary + "40",
  },
  downloadBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  logoutBtn: { padding: 8 },
  statsRow: {
    flexDirection: "row", backgroundColor: Colors.surface, borderRadius: 14,
    marginHorizontal: 20, padding: 14, borderWidth: 1, borderColor: Colors.border, marginBottom: 12,
  },
  statItem: { flex: 1, alignItems: "center" },
  statValue: { fontSize: 15, fontWeight: "800", color: Colors.text },
  statLabel: { fontSize: 10, color: Colors.textMuted, fontWeight: "500", marginTop: 2 },
  statDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 4 },
  filterRow: { paddingHorizontal: 20, gap: 8, paddingBottom: 12 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  filterChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterChipText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  filterChipTextActive: { color: Colors.textInverse },
  list: { padding: 20, gap: 12, paddingBottom: 100 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
  emptyIcon: {
    width: 72, height: 72, borderRadius: 18,
    backgroundColor: Colors.surfaceSecondary, alignItems: "center", justifyContent: "center",
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, textAlign: "center" },
  emptySubtitle: { fontSize: 14, color: Colors.textMuted, textAlign: "center", lineHeight: 20 },
  brandBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 20, marginBottom: 8,
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 12, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  brandBarActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  brandBarText: { flex: 1, fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  brandBarTextActive: { color: Colors.textInverse },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  modalSheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 12, maxHeight: "70%",
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border,
    alignSelf: "center", marginBottom: 16,
  },
  modalHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 20, marginBottom: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: Colors.text },
  modalClear: { fontSize: 14, fontWeight: "700", color: Colors.danger },
  brandSearchWrap: {
    flexDirection: "row", alignItems: "center", gap: 10,
    marginHorizontal: 20, marginBottom: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
  },
  brandSearchInput: { flex: 1, fontSize: 14, color: Colors.text, paddingVertical: 0 },
  noBrands: { alignItems: "center", padding: 40, gap: 10 },
  noBrandsTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  noBrandsSub: { fontSize: 13, color: Colors.textMuted, textAlign: "center", lineHeight: 18 },
  brandList: { paddingHorizontal: 20 },
  brandRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  brandRowActive: { backgroundColor: Colors.primaryMuted + "80" },
  brandDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.warning },
  brandName: { flex: 1, fontSize: 15, fontWeight: "600", color: Colors.text },
  brandNameActive: { color: Colors.primary },
  brandCount: { fontSize: 12, color: Colors.textMuted, marginRight: 4 },
});

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: 14, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerLeft: { gap: 2 },
  orderNo: { fontSize: 14, fontWeight: "800", color: Colors.text },
  date: { fontSize: 11, color: Colors.textMuted },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusText: { fontSize: 11, fontWeight: "700" },
  summary: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingVertical: 10,
  },
  summaryLeft: { flexDirection: "row", alignItems: "center", gap: 5 },
  summaryText: { fontSize: 12, color: Colors.textMuted },
  amount: { fontSize: 14, fontWeight: "700", color: Colors.primary },
  itemsSection: { borderTopWidth: 1, borderTopColor: Colors.border },
  statusSection: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
    backgroundColor: Colors.surfaceSecondary,
  },
  statusSectionLabel: { fontSize: 11, fontWeight: "700", color: Colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 },
  statusOptions: { gap: 6, paddingVertical: 2 },
  statusOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1.5,
    backgroundColor: Colors.surface,
  },
  statusOptionText: { fontSize: 12, fontWeight: "600" },
  tableHeader: {
    flexDirection: "row", backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  tableRow: {
    flexDirection: "row", paddingHorizontal: 14, paddingVertical: 9,
    borderTopWidth: 1, borderTopColor: Colors.borderLight,
  },
  rowAlt: { backgroundColor: Colors.background },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  td: { fontSize: 12, color: Colors.text },
  itemNo: { fontSize: 10, color: Colors.textMuted, marginBottom: 2 },
  right: { flex: 1, textAlign: "right" },
  price: { color: Colors.primary, fontWeight: "700" },
  notes: {
    flexDirection: "row", gap: 6, padding: 12,
    backgroundColor: Colors.surfaceSecondary, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  notesText: { fontSize: 11, color: Colors.textMuted, flex: 1 },
  modifyBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    margin: 12, paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 10, borderWidth: 1.5, borderColor: Colors.primary,
    backgroundColor: Colors.primaryMuted, alignSelf: "flex-start",
  },
  modifyBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  modifyToolbar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginHorizontal: 12, marginVertical: 10,
  },
  modifyHint: { fontSize: 12, color: Colors.textMuted, fontWeight: "600" },
  modifyActions: { flexDirection: "row", gap: 8 },
  cancelModifyBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  cancelModifyText: { fontSize: 13, fontWeight: "700", color: Colors.textSecondary },
  saveModifyBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  saveModifyText: { fontSize: 13, fontWeight: "700", color: Colors.textInverse },
  checkboxCol: { width: 32, alignItems: "center", justifyContent: "center" },
  rowUnchecked: { opacity: 0.4 },
  tdStrike: { textDecorationLine: "line-through" },
  qtyInput: {
    flex: 1, textAlign: "right", borderBottomWidth: 1.5, borderBottomColor: Colors.primary,
    paddingVertical: 2, paddingHorizontal: 4, minWidth: 40, color: Colors.text,
  },
  stockToggleRow: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2,
  },
  stockToggleBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
    borderWidth: 1.5, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  stockToggleBtnOn: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryMuted,
  },
  stockToggleText: { fontSize: 12, fontWeight: "600", color: Colors.textMuted },
  stockToggleTextOn: { color: Colors.primary },
});
