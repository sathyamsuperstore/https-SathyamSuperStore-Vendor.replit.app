import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp } from "@/context/AppContext";

function fmtAmount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function VendorPaymentsScreen() {
  const { vendorPayments, clearVendorPayments } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  // Per user spec: search matches VendorCode and VendorName only.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vendorPayments;
    return vendorPayments.filter(
      (vp) =>
        vp.vendorCode.toLowerCase().includes(q) ||
        vp.vendorName.toLowerCase().includes(q),
    );
  }, [vendorPayments, search]);

  const totalPaid = useMemo(
    () =>
      vendorPayments.reduce(
        (sum, vp) => sum + (vp.supplierPayment ?? 0),
        0,
      ),
    [vendorPayments],
  );
  const uniqueVendors = useMemo(
    () => new Set(vendorPayments.map((vp) => vp.vendorCode)).size,
    [vendorPayments],
  );

  function handleClear() {
    if (vendorPayments.length === 0) return;
    const msg = `Remove all ${vendorPayments.length} Vendor Payment${vendorPayments.length === 1 ? "" : "s"}? This cannot be undone.`;
    const run = async () => {
      try {
        await clearVendorPayments();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        Alert.alert("Couldn't Delete", e?.message ?? "Unknown error");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete All Vendor Payments?\n\n${msg}`)) void run();
    } else {
      Alert.alert("Delete All Vendor Payments?", msg, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void run() },
      ]);
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.content,
          { paddingTop: topPt + 16, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>Ledger</Text>
            <Text style={styles.title}>Vendor Payments</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => router.push("/vendor-payments/import")}
              activeOpacity={0.85}
            >
              <Feather name="upload" size={16} color={Colors.primary} />
              <Text style={styles.iconBtnText}>Excel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() =>
                router.push("/vendor-payments/import?format=csv")
              }
              activeOpacity={0.85}
            >
              <Feather name="file-text" size={16} color={Colors.primary} />
              <Text style={styles.iconBtnText}>CSV</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.iconBtn,
                styles.iconBtnDanger,
                vendorPayments.length === 0 && styles.iconBtnDisabled,
              ]}
              onPress={handleClear}
              disabled={vendorPayments.length === 0}
              activeOpacity={0.85}
            >
              <Feather
                name="trash-2"
                size={16}
                color={
                  vendorPayments.length === 0
                    ? Colors.textMuted
                    : Colors.danger
                }
              />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{vendorPayments.length}</Text>
            <Text style={styles.statLabel}>Rows</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: Colors.primary }]}>
              {uniqueVendors}
            </Text>
            <Text style={styles.statLabel}>Vendors</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: Colors.success }]}>
              {fmtAmount(totalPaid)}
            </Text>
            <Text style={styles.statLabel}>Total Paid</Text>
          </View>
        </View>

        {vendorPayments.length === 0 ? (
          <View style={styles.emptyCard}>
            <Feather name="inbox" size={32} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No Vendor Payments yet</Text>
            <Text style={styles.emptyHint}>
              Import an Excel sheet to populate the ledger.
            </Text>
            <View style={styles.emptyActions}>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => router.push("/vendor-payments/import")}
                activeOpacity={0.85}
              >
                <Feather name="upload" size={16} color={Colors.textInverse} />
                <Text style={styles.primaryBtnText}>Import Excel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() =>
                  router.push("/vendor-payments/import?format=csv")
                }
                activeOpacity={0.85}
              >
                <Feather name="file-text" size={16} color={Colors.primary} />
                <Text style={styles.secondaryBtnText}>Import CSV</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            <View style={styles.searchRow}>
              <View style={styles.searchWrap}>
                <Feather name="search" size={14} color={Colors.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search VendorCode or VendorName…"
                  placeholderTextColor={Colors.textMuted}
                  value={search}
                  onChangeText={setSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => setSearch("")}>
                    <Feather name="x" size={14} color={Colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <Text style={styles.resultCount}>
              Showing {filtered.length} of {vendorPayments.length}
            </Text>

            <View style={styles.tableCard}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                contentContainerStyle={{ minWidth: "100%" }}
              >
                <View>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.th, { width: 100 }]}>GidNo</Text>
                    <Text style={[styles.th, { width: 100 }]}>VendorCode</Text>
                    <Text style={[styles.th, { width: 220 }]}>VendorName</Text>
                    <Text style={[styles.th, { width: 130 }]}>InvoiceNo</Text>
                    <Text style={[styles.th, { width: 100 }]}>GRNDate</Text>
                    <Text style={[styles.th, { width: 100 }]}>InvoiceDate</Text>
                    <Text style={[styles.th, { width: 110 }]}>TranNo</Text>
                    <Text style={[styles.th, { width: 110, textAlign: "right" }]}>
                      Supplier Payment
                    </Text>
                    <Text style={[styles.th, { width: 100 }]}>PaymentDate</Text>
                  </View>
                  {filtered.map((vp, i) => (
                    <View
                      key={`${vp.gidNo}-${i}`}
                      style={[
                        styles.tableRow,
                        i % 2 === 0 && styles.tableRowAlt,
                      ]}
                    >
                      <Text
                        style={[styles.td, { width: 100 }]}
                        numberOfLines={1}
                      >
                        {vp.gidNo}
                      </Text>
                      <Text
                        style={[styles.td, { width: 100 }]}
                        numberOfLines={1}
                      >
                        {vp.vendorCode}
                      </Text>
                      <Text
                        style={[styles.td, styles.tdName, { width: 220 }]}
                        numberOfLines={2}
                      >
                        {vp.vendorName}
                      </Text>
                      <Text
                        style={[styles.td, { width: 130 }]}
                        numberOfLines={1}
                      >
                        {vp.invoiceNo}
                      </Text>
                      <Text
                        style={[styles.td, { width: 100 }]}
                        numberOfLines={1}
                      >
                        {vp.grnDate || "—"}
                      </Text>
                      <Text
                        style={[styles.td, { width: 100 }]}
                        numberOfLines={1}
                      >
                        {vp.invoiceDate || "—"}
                      </Text>
                      <Text
                        style={[styles.td, { width: 110 }]}
                        numberOfLines={1}
                      >
                        {vp.tranNo || "—"}
                      </Text>
                      <Text
                        style={[
                          styles.td,
                          { width: 110, textAlign: "right", fontWeight: "700" },
                        ]}
                        numberOfLines={1}
                      >
                        {fmtAmount(vp.supplierPayment)}
                      </Text>
                      <Text
                        style={[styles.td, { width: 100 }]}
                        numberOfLines={1}
                      >
                        {vp.paymentDate || "—"}
                      </Text>
                    </View>
                  ))}
                  {filtered.length === 0 && (
                    <View style={styles.tableEmpty}>
                      <Text style={styles.tableEmptyText}>
                        No rows match your search.
                      </Text>
                    </View>
                  )}
                </View>
              </ScrollView>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: 16, gap: 14 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  headerActions: { flexDirection: "row", gap: 8 },
  greeting: { fontSize: 13, color: Colors.textMuted, marginBottom: 2 },
  title: { fontSize: 26, fontWeight: "800", color: Colors.text },
  iconBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primary + "12",
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  iconBtnText: { fontSize: 12, fontWeight: "700", color: Colors.primary },
  iconBtnDanger: {
    backgroundColor: Colors.dangerLight,
    borderColor: Colors.danger + "30",
    paddingHorizontal: 10,
  },
  iconBtnDisabled: {
    backgroundColor: Colors.background,
    borderColor: Colors.border,
  },
  statsRow: { flexDirection: "row", gap: 10 },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 12,
    alignItems: "center",
  },
  statValue: {
    fontSize: 18,
    fontWeight: "800",
    color: Colors.text,
    marginBottom: 2,
  },
  statLabel: { fontSize: 11, color: Colors.textMuted, fontWeight: "600" },
  emptyCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 28,
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  emptyHint: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    marginBottom: 8,
  },
  emptyActions: { flexDirection: "row", gap: 10 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.textInverse,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.primary + "12",
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.primary,
  },
  searchRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  searchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 13, color: Colors.text, padding: 0 },
  resultCount: { fontSize: 11, color: Colors.textMuted, fontWeight: "600" },
  tableCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    gap: 8,
  },
  tableRowAlt: { backgroundColor: Colors.background },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  td: { fontSize: 12, color: Colors.text },
  tdName: { fontWeight: "600" },
  tableEmpty: { padding: 24, alignItems: "center" },
  tableEmptyText: { fontSize: 13, color: Colors.textMuted },
});
