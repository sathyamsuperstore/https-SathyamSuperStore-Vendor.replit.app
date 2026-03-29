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

  const order = useMemo(() => orders.find((o) => o.id === id), [orders, id]);

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
            <View style={styles.infoItem}>
              <Text style={styles.infoLabel}>Last Updated</Text>
              <Text style={styles.infoValue}>{formatDate(order.updatedAt)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Items</Text>
          <View style={styles.itemsCard}>
            {order.items.map((item, idx) => (
              <View key={item.id}>
                {idx > 0 && <View style={styles.itemDivider} />}
                <View style={styles.itemRow}>
                  <View style={styles.itemInfo}>
                    <Text style={styles.itemName}>{item.name}</Text>
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
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>{formatCurrency(order.totalAmount)}</Text>
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
  sectionTitle: { fontSize: 16, fontWeight: "700", color: Colors.text, marginBottom: 12 },
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
  itemName: { fontSize: 14, fontWeight: "600", color: Colors.text, marginBottom: 3 },
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
