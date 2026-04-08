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
  const { orders, clearAllOrders } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [activeBrand, setActiveBrand] = useState<string>("all");
  const [showBrandModal, setShowBrandModal] = useState(false);

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
            style={[styles.filterBtn, brandActive && styles.filterBtnActive]}
            onPress={() => setShowBrandModal(true)}
          >
            <Feather
              name="sliders"
              size={16}
              color={brandActive ? Colors.textInverse : Colors.primary}
            />
            {brandActive && (
              <Text style={styles.filterBtnText} numberOfLines={1}>
                {activeBrand}
              </Text>
            )}
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

      {/* Status filter pills */}
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

      {/* Active brand indicator strip */}
      {brandActive && (
        <View style={styles.activeBrandStrip}>
          <Feather name="tag" size={12} color={Colors.warning} />
          <Text style={styles.activeBrandLabel}>Brand: {activeBrand}</Text>
          <TouchableOpacity onPress={() => setActiveBrand("all")} style={styles.clearBrand}>
            <Feather name="x" size={13} color={Colors.warning} />
          </TouchableOpacity>
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
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
    maxWidth: 120,
  },
  filterBtnActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textInverse,
    flexShrink: 1,
  },
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
  activeBrandStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 20,
    marginBottom: 6,
    backgroundColor: Colors.warning + "18",
    borderWidth: 1,
    borderColor: Colors.warning + "50",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  activeBrandLabel: { flex: 1, fontSize: 12, fontWeight: "600", color: Colors.warning },
  clearBrand: { padding: 2 },
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
