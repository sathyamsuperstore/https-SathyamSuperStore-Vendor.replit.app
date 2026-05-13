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

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  // Show up to 2 decimals, strip trailing zeros for clean display.
  return Number(n)
    .toFixed(2)
    .replace(/\.?0+$/, "");
}

export default function RodeoItemsScreen() {
  const { rodeoItems, clearRodeoItems } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rodeoItems.filter((it) => {
      if (activeOnly && !it.active) return false;
      if (!q) return true;
      return (
        it.productName.toLowerCase().includes(q) ||
        it.barCode.toLowerCase().includes(q) ||
        it.itemCode.toLowerCase().includes(q) ||
        String(it.productId ?? "").includes(q) ||
        String(it.skuId ?? "").includes(q)
      );
    });
  }, [rodeoItems, search, activeOnly]);

  const activeCount = useMemo(
    () => rodeoItems.filter((i) => i.active).length,
    [rodeoItems],
  );

  function handleClear() {
    if (rodeoItems.length === 0) return;
    const msg = `Remove all ${rodeoItems.length} RodeoItem${rodeoItems.length === 1 ? "" : "s"}? This cannot be undone.`;
    const run = async () => {
      try {
        await clearRodeoItems();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        Alert.alert("Couldn't Delete", e?.message ?? "Unknown error");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete All RodeoItems?\n\n${msg}`)) void run();
    } else {
      Alert.alert("Delete All RodeoItems?", msg, [
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
            <Text style={styles.greeting}>Catalogue</Text>
            <Text style={styles.title}>RodeoItems</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => router.push("/rodeo/import")}
              activeOpacity={0.85}
            >
              <Feather name="upload" size={16} color={Colors.primary} />
              <Text style={styles.iconBtnText}>Import</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.iconBtn,
                styles.iconBtnDanger,
                rodeoItems.length === 0 && styles.iconBtnDisabled,
              ]}
              onPress={handleClear}
              disabled={rodeoItems.length === 0}
              activeOpacity={0.85}
            >
              <Feather
                name="trash-2"
                size={16}
                color={
                  rodeoItems.length === 0 ? Colors.textMuted : Colors.danger
                }
              />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{rodeoItems.length}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: Colors.success }]}>
              {activeCount}
            </Text>
            <Text style={styles.statLabel}>Active</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: Colors.warning }]}>
              {rodeoItems.length - activeCount}
            </Text>
            <Text style={styles.statLabel}>Inactive</Text>
          </View>
        </View>

        {rodeoItems.length === 0 ? (
          <View style={styles.emptyCard}>
            <Feather name="inbox" size={32} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No RodeoItems yet</Text>
            <Text style={styles.emptyHint}>
              Import an Excel sheet to populate the table.
            </Text>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => router.push("/rodeo/import")}
              activeOpacity={0.85}
            >
              <Feather name="upload" size={16} color={Colors.textInverse} />
              <Text style={styles.primaryBtnText}>Choose Excel File</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.searchRow}>
              <View style={styles.searchWrap}>
                <Feather name="search" size={14} color={Colors.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search name, code, barcode, ID…"
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
              <TouchableOpacity
                style={[
                  styles.toggleChip,
                  activeOnly && styles.toggleChipActive,
                ]}
                onPress={() => setActiveOnly((v) => !v)}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.toggleChipText,
                    activeOnly && styles.toggleChipTextActive,
                  ]}
                >
                  Active only
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.resultCount}>
              Showing {filtered.length} of {rodeoItems.length}
            </Text>

            <View style={styles.tableCard}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                contentContainerStyle={{ minWidth: "100%" }}
              >
                <View>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.th, { width: 80 }]}>Prod Id</Text>
                    <Text style={[styles.th, { width: 80 }]}>SKU Id</Text>
                    <Text style={[styles.th, { width: 220 }]}>Product Name</Text>
                    <Text style={[styles.th, { width: 130 }]}>Bar Code</Text>
                    <Text style={[styles.th, { width: 110 }]}>Item Code</Text>
                    <Text style={[styles.th, { width: 60 }]}>GST</Text>
                    <Text style={[styles.th, { width: 80 }]}>MRP</Text>
                    <Text style={[styles.th, { width: 90 }]}>Purchase</Text>
                    <Text style={[styles.th, { width: 80 }]}>Selling</Text>
                    <Text style={[styles.th, { width: 80 }]}>Offer</Text>
                    <Text style={[styles.th, { width: 100 }]}>Offer Start</Text>
                    <Text style={[styles.th, { width: 100 }]}>Offer End</Text>
                    <Text style={[styles.th, { width: 60 }]}>Active</Text>
                  </View>
                  {filtered.map((it, i) => (
                    <View
                      key={i}
                      style={[
                        styles.tableRow,
                        i % 2 === 0 && styles.tableRowAlt,
                      ]}
                    >
                      <Text
                        style={[styles.td, { width: 80 }]}
                        numberOfLines={1}
                      >
                        {it.productId ?? "—"}
                      </Text>
                      <Text
                        style={[styles.td, { width: 80 }]}
                        numberOfLines={1}
                      >
                        {it.skuId ?? "—"}
                      </Text>
                      <Text
                        style={[styles.td, styles.tdName, { width: 220 }]}
                        numberOfLines={2}
                      >
                        {it.productName}
                      </Text>
                      <Text
                        style={[styles.td, { width: 130 }]}
                        numberOfLines={1}
                      >
                        {it.barCode || "—"}
                      </Text>
                      <Text
                        style={[styles.td, { width: 110 }]}
                        numberOfLines={1}
                      >
                        {it.itemCode || "—"}
                      </Text>
                      <Text
                        style={[styles.td, { width: 60 }]}
                        numberOfLines={1}
                      >
                        {it.gst === null ? "—" : `${fmtNum(it.gst)}%`}
                      </Text>
                      <Text
                        style={[styles.td, { width: 80 }]}
                        numberOfLines={1}
                      >
                        {fmtNum(it.mrp)}
                      </Text>
                      <Text
                        style={[styles.td, { width: 90 }]}
                        numberOfLines={1}
                      >
                        {fmtNum(it.purchasePrice)}
                      </Text>
                      <Text
                        style={[styles.td, { width: 80 }]}
                        numberOfLines={1}
                      >
                        {fmtNum(it.sellingPrice)}
                      </Text>
                      <Text
                        style={[styles.td, { width: 80 }]}
                        numberOfLines={1}
                      >
                        {fmtNum(it.offerPrice)}
                      </Text>
                      <Text
                        style={[styles.td, { width: 100 }]}
                        numberOfLines={1}
                      >
                        {it.offerStartDate || "—"}
                      </Text>
                      <Text
                        style={[styles.td, { width: 100 }]}
                        numberOfLines={1}
                      >
                        {it.offerEndDate || "—"}
                      </Text>
                      <View style={{ width: 60, alignItems: "flex-start" }}>
                        <View
                          style={[
                            styles.statusPill,
                            it.active
                              ? styles.statusPillOk
                              : styles.statusPillWarn,
                          ]}
                        >
                          <Text
                            style={[
                              styles.statusPillText,
                              it.active
                                ? { color: Colors.success }
                                : { color: Colors.warning },
                            ]}
                          >
                            {it.active ? "Yes" : "No"}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))}
                  {filtered.length === 0 && (
                    <View style={styles.tableEmpty}>
                      <Text style={styles.tableEmptyText}>
                        No rows match your filter.
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
    fontSize: 20,
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
  toggleChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  toggleChipActive: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary,
  },
  toggleChipText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  toggleChipTextActive: { color: Colors.primary },
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
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    alignItems: "center",
  },
  statusPillOk: { backgroundColor: Colors.successLight },
  statusPillWarn: { backgroundColor: Colors.warningLight },
  statusPillText: { fontSize: 10, fontWeight: "700" },
  tableEmpty: { padding: 24, alignItems: "center" },
  tableEmptyText: { fontSize: 13, color: Colors.textMuted },
});
