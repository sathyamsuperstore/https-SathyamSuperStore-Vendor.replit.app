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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as XLSX from "xlsx";
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
          <View style={loginStyles.logoCircle}>
            <Feather name="package" size={32} color={Colors.primary} />
          </View>
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

  const vendorOrders = useMemo(() => {
    if (!currentUser) return [];
    if (!currentUser.vendorCode) return [];
    const mySupplier = suppliers.find(
      (s) => s.vendorCode.toUpperCase() === currentUser.vendorCode.toUpperCase()
    );
    if (!mySupplier) return [];
    return orders.filter((o) => o.supplierId === mySupplier.id);
  }, [orders, suppliers, currentUser]);

  const filtered = useMemo(() => {
    if (activeFilter === "all") return vendorOrders;
    return vendorOrders.filter((o) => o.status === activeFilter);
  }, [vendorOrders, activeFilter]);

  const totalValue = useMemo(() => vendorOrders.reduce((s, o) => s + o.totalAmount, 0), [vendorOrders]);
  const pendingCount = useMemo(() => vendorOrders.filter((o) => o.status === "pending").length, [vendorOrders]);

  async function handleDownload() {
    if (vendorOrders.length === 0) {
      Alert.alert("No Orders", "There are no orders to download.");
      return;
    }
    setDownloading(true);
    try {
      const rows: Record<string, unknown>[] = [];
      for (const order of vendorOrders) {
        for (const item of order.items) {
          const itemNo = item.name.includes(" - ") ? item.name.split(" - ")[0] : "";
          const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
          rows.push({
            "Order No": order.orderNumber,
            "Order Date": formatDate(order.createdAt),
            "Vendor Code": currentUser?.vendorCode ?? "",
            "Vendor Name": currentUser?.vendorName ?? "",
            "Status": STATUS_COLORS[order.status].label,
            "Item No": itemNo,
            "Item Description": desc,
            "UOM": item.unit,
            "MRP": item.unitPrice,
            "Order Qty": item.quantity,
            "Amount": item.quantity * item.unitPrice,
          });
        }
      }

      const ws = XLSX.utils.json_to_sheet(rows);
      const colWidths = [
        { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 12 },
        { wch: 10 }, { wch: 32 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
      ];
      ws["!cols"] = colWidths;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "My Orders");

      const fileName = `orders_${currentUser?.vendorCode ?? "vendor"}_${Date.now()}.xlsx`;

      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
        const blob = new Blob([wbout], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: "base64" as any });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Download Orders",
            UTI: "com.microsoft.excel.xlsx",
          });
        } else {
          Alert.alert("Download saved", `File saved to: ${fileUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Download Failed", e?.message ?? "Unknown error");
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
          renderItem={({ item }) => <VendorOrderCard order={item} />}
        />
      )}
    </View>
  );
}

function VendorOrderCard({ order }: { order: Order }) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS_COLORS[order.status];

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
          <View style={cardStyles.tableHeader}>
            <Text style={[cardStyles.th, { flex: 3 }]}>Item</Text>
            <Text style={[cardStyles.th, cardStyles.right]}>Qty</Text>
            <Text style={[cardStyles.th, cardStyles.right]}>UOM</Text>
            <Text style={[cardStyles.th, cardStyles.right]}>MRP</Text>
          </View>
          {order.items.map((item, i) => {
            const itemNo = item.name.includes(" - ") ? item.name.split(" - ")[0] : "";
            const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
            return (
              <View key={item.id} style={[cardStyles.tableRow, i % 2 === 0 && cardStyles.rowAlt]}>
                <View style={{ flex: 3 }}>
                  {itemNo ? <Text style={cardStyles.itemNo}>{itemNo}</Text> : null}
                  <Text style={cardStyles.td}>{desc}</Text>
                </View>
                <Text style={[cardStyles.td, cardStyles.right]}>{item.quantity}</Text>
                <Text style={[cardStyles.td, cardStyles.right]}>{item.unit}</Text>
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
  logoWrap: { alignItems: "center", gap: 8 },
  logoCircle: {
    width: 80, height: 80, borderRadius: 20,
    backgroundColor: Colors.primaryMuted, alignItems: "center", justifyContent: "center",
  },
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
});
