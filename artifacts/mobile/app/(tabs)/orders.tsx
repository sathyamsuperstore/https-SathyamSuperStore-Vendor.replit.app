import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
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
  const { orders } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [activeBrand, setActiveBrand] = useState<string>("all");

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    orders.forEach((o) =>
      o.items.forEach((item) => {
        if (item.brand) set.add(item.brand);
      })
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [orders]);

  const statusFiltered = useMemo(() => {
    if (activeFilter === "all") return orders;
    return orders.filter((o) => o.status === activeFilter);
  }, [orders, activeFilter]);

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

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const hasBrands = allBrands.length > 0;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Orders</Text>
        <View style={styles.headerActions}>
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

      {/* Status filter row */}
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
              onPress={() => setActiveFilter(f.key)}
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

      {/* Brand filter row — only shown when brands exist */}
      {hasBrands && (
        <View style={styles.brandRow}>
          <Feather name="tag" size={13} color={Colors.textMuted} style={styles.brandIcon} />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.brandFilters}
          >
            <TouchableOpacity
              style={[styles.brandChip, activeBrand === "all" && styles.brandChipActive]}
              onPress={() => setActiveBrand("all")}
            >
              <Text style={[styles.brandChipText, activeBrand === "all" && styles.brandChipTextActive]}>
                All Brands
              </Text>
            </TouchableOpacity>
            {allBrands.map((brand) => {
              const count = brandOrderCount(brand);
              const isActive = activeBrand === brand;
              return (
                <TouchableOpacity
                  key={brand}
                  style={[styles.brandChip, isActive && styles.brandChipActive]}
                  onPress={() => setActiveBrand(isActive ? "all" : brand)}
                >
                  <Text style={[styles.brandChipText, isActive && styles.brandChipTextActive]}>
                    {brand}
                  </Text>
                  <View style={[styles.brandCount, isActive && styles.brandCountActive]}>
                    <Text style={[styles.brandCountText, isActive && styles.brandCountTextActive]}>
                      {count}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

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
              activeBrand !== "all"
                ? `No orders with brand "${activeBrand}"`
                : activeFilter === "all"
                ? "Tap the + button to create your first order"
                : `No ${activeFilter} orders at the moment`
            }
          />
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
    paddingBottom: 8,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
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
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 20,
    marginBottom: 4,
  },
  brandIcon: { marginRight: 6, marginTop: 1 },
  brandFilters: { paddingRight: 20, paddingVertical: 4, gap: 6 },
  brandChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 5,
  },
  brandChipActive: {
    backgroundColor: Colors.warning + "22",
    borderColor: Colors.warning,
  },
  brandChipText: { fontSize: 12, fontWeight: "600", color: Colors.textSecondary },
  brandChipTextActive: { color: Colors.warning },
  brandCount: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  brandCountActive: { backgroundColor: Colors.warning + "33" },
  brandCountText: { fontSize: 10, fontWeight: "700", color: Colors.textMuted },
  brandCountTextActive: { color: Colors.warning },
  list: { paddingHorizontal: 20, paddingTop: 8 },
  listEmpty: { flex: 1 },
});
