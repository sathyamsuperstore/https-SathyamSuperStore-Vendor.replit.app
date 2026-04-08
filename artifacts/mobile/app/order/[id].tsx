import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
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
  const { orders, updateOrderStatus, deleteOrder } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [selectedBrand, setSelectedBrand] = useState<string>("all");

  const order = useMemo(() => orders.find((o) => o.id === id), [orders, id]);

  const itemBrands = useMemo(() => {
    if (!order) return [];
    const set = new Set<string>();
    order.items.forEach((item) => { if (item.brand) set.add(item.brand); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [order]);

  const visibleItems = useMemo(() => {
    if (!order) return [];
    if (selectedBrand === "all") return order.items;
    return order.items.filter((item) => item.brand === selectedBrand);
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
            <TouchableOpacity onPress={handleDelete} style={{ padding: 8 }}>
              <Feather name="trash-2" size={18} color={Colors.danger} />
            </TouchableOpacity>
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
                    <Text style={styles.itemName}>{item.name}</Text>
                    {item.brand ? (
                      <Text style={styles.itemBrand}>{item.brand}</Text>
                    ) : null}
                    <Text style={styles.itemMeta}>
                      {item.quantity} {item.unit} × {formatCurrency(item.unitPrice)}
                    </Text>
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
  itemName: { fontSize: 14, fontWeight: "600", color: Colors.text, marginBottom: 2 },
  itemBrand: { fontSize: 11, color: Colors.primary, fontWeight: "600", marginBottom: 3 },
  itemMeta: { fontSize: 12, color: Colors.textMuted },
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
