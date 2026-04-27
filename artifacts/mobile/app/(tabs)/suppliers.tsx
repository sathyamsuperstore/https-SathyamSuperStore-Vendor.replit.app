import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { useApp, isSupplierIncomplete } from "@/context/AppContext";
import { SupplierCard } from "@/components/SupplierCard";
import { EmptyState } from "@/components/EmptyState";

export default function SuppliersScreen() {
  const { suppliers, orders } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Optional filter — when on, only show suppliers that are missing both
  // phone AND email (the placeholder shape the bulk import action creates).
  // Off by default so the tab still behaves as before for existing users.
  const [needsDetailsOnly, setNeedsDetailsOnly] = useState(false);

  const orderCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    orders.forEach((o) => {
      map[o.supplierId] = (map[o.supplierId] ?? 0) + 1;
    });
    return map;
  }, [orders]);

  // Compute the count once over the full supplier list so the chip badge
  // stays accurate regardless of the filter state.
  const incompleteCount = useMemo(
    () => suppliers.reduce((n, s) => (isSupplierIncomplete(s) ? n + 1 : n), 0),
    [suppliers]
  );

  const visibleSuppliers = useMemo(() => {
    if (!needsDetailsOnly) return suppliers;
    return suppliers.filter(isSupplierIncomplete);
  }, [suppliers, needsDetailsOnly]);

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;
  // Auto-clear the filter when the last placeholder gets fixed. Without this,
  // the user would land on an "All caught up" empty state with the filter
  // still toggled on — fine, but they'd have to tap the chip again to see
  // their full supplier list. Resetting it here makes the moment-of-success
  // transition seamless.
  useEffect(() => {
    if (needsDetailsOnly && incompleteCount === 0) {
      setNeedsDetailsOnly(false);
    }
  }, [needsDetailsOnly, incompleteCount]);
  // Show the chip only when there's something to act on. We additionally show
  // it while the filter is on so the user can always see/toggle the active
  // state (the auto-clear effect above will flip it off once the count hits
  // zero, at which point the chip naturally disappears too).
  const showFilterChip = incompleteCount > 0 || needsDetailsOnly;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Suppliers</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.importBtn}
            onPress={() => router.push("/supplier/import")}
          >
            <Feather name="upload" size={17} color={Colors.primary} />
            <Text style={styles.importBtnText}>Import</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => router.push("/supplier/new")}
          >
            <Feather name="plus" size={20} color={Colors.textInverse} />
          </TouchableOpacity>
        </View>
      </View>

      {showFilterChip && (
        <View style={styles.filterRow}>
          <TouchableOpacity
            style={[
              styles.filterChip,
              needsDetailsOnly && styles.filterChipActive,
            ]}
            onPress={() => setNeedsDetailsOnly((v) => !v)}
            activeOpacity={0.7}
            accessibilityLabel={
              needsDetailsOnly
                ? "Show all suppliers"
                : "Show only suppliers that need details"
            }
          >
            <Feather
              name="alert-circle"
              size={12}
              color={needsDetailsOnly ? Colors.textInverse : Colors.warning}
            />
            <Text
              style={[
                styles.filterChipText,
                needsDetailsOnly && styles.filterChipTextActive,
              ]}
            >
              Needs details
            </Text>
            <View
              style={[
                styles.filterChipBadge,
                needsDetailsOnly && styles.filterChipBadgeActive,
              ]}
            >
              <Text
                style={[
                  styles.filterChipBadgeText,
                  needsDetailsOnly && styles.filterChipBadgeTextActive,
                ]}
              >
                {incompleteCount}
              </Text>
            </View>
          </TouchableOpacity>
          {needsDetailsOnly && (
            <Text style={styles.filterCountLabel}>
              Showing {visibleSuppliers.length} of {suppliers.length}
            </Text>
          )}
        </View>
      )}

      <FlatList
        data={visibleSuppliers}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SupplierCard supplier={item} orderCount={orderCountMap[item.id] ?? 0} />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
          visibleSuppliers.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          needsDetailsOnly ? (
            <EmptyState
              icon="check-circle"
              title="All caught up"
              subtitle="No suppliers are missing contact details."
            />
          ) : (
            <EmptyState
              icon="users"
              title="No suppliers yet"
              subtitle="Tap the + button to add your first supplier"
            />
          )
        }
        showsVerticalScrollIndicator={false}
      />
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
    paddingBottom: 16,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  importBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10,
    backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: Colors.primary + "40",
  },
  importBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexWrap: "wrap",
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: Colors.warningLight,
    borderWidth: 1,
    borderColor: Colors.warning + "40",
  },
  filterChipActive: {
    backgroundColor: Colors.warning,
    borderColor: Colors.warning,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.warning,
  },
  filterChipTextActive: { color: Colors.textInverse },
  filterChipBadge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: Colors.warning + "30",
    alignItems: "center",
    justifyContent: "center",
  },
  filterChipBadgeActive: { backgroundColor: Colors.textInverse + "33" },
  filterChipBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    color: Colors.warning,
  },
  filterChipBadgeTextActive: { color: Colors.textInverse },
  filterCountLabel: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  list: { paddingHorizontal: 20 },
  listEmpty: { flex: 1 },
});
