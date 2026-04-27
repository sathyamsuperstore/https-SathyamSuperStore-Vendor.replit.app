import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { Order } from "@/context/AppContext";
import { StatusBadge } from "./StatusBadge";

interface Props {
  order: Order;
  vendorCode?: string;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export function OrderCard({ order, vendorCode }: Props) {
  const router = useRouter();
  const isOverdue =
    order.status !== "delivered" &&
    order.status !== "cancelled" &&
    new Date(order.expectedDelivery) < new Date();

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push({ pathname: "/order/[id]", params: { id: order.id } })}
      activeOpacity={0.7}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.orderNum}>{order.orderNumber}</Text>
          <Text style={styles.supplier}>{order.supplierName}</Text>
          {vendorCode ? (
            // Tappable vendor code: jumps to the Latest Purchases tab with
            // the search field pre-filled to this VendorCode, so the user
            // can immediately see purchase history for the same vendor.
            // Wrapped in its own TouchableOpacity so press-events are
            // captured here and don't bubble up to open the order detail.
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation?.();
                router.push({
                  pathname: "/(tabs)/latest-purchases",
                  params: { search: vendorCode },
                });
              }}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              activeOpacity={0.6}
            >
              <Text style={styles.vendorCodeLink}>
                Code: {vendorCode}{" "}
                <Feather name="external-link" size={10} color={Colors.primary} />
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <StatusBadge status={order.status} size="sm" />
      </View>
      <View style={styles.divider} />
      <View style={styles.footer}>
        <View style={styles.footerItem}>
          <Feather name="package" size={13} color={Colors.textMuted} />
          <Text style={styles.footerText}>{order.items.length} item{order.items.length !== 1 ? "s" : ""}</Text>
        </View>
        <View style={styles.footerItem}>
          <Feather
            name="calendar"
            size={13}
            color={isOverdue ? Colors.danger : Colors.textMuted}
          />
          <Text style={[styles.footerText, isOverdue && styles.overdueText]}>
            {isOverdue ? "Overdue · " : ""}{formatDate(order.expectedDelivery)}
          </Text>
        </View>
        <Text style={styles.amount}>{formatCurrency(order.totalAmount)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
      android: { elevation: 2 },
    }),
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  headerLeft: { flex: 1, marginRight: 8 },
  orderNum: { fontSize: 15, fontWeight: "700", color: Colors.text, marginBottom: 2 },
  supplier: { fontSize: 13, color: Colors.textSecondary },
  vendorCode: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  // Same size/spacing as vendorCode but in primary color so it visually
  // reads as a tappable link to the Latest Purchases tab.
  vendorCodeLink: {
    fontSize: 11,
    color: Colors.primary,
    marginTop: 2,
    fontWeight: "600",
  },
  divider: { height: 1, backgroundColor: Colors.border, marginBottom: 12 },
  footer: { flexDirection: "row", alignItems: "center", gap: 12 },
  footerItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  footerText: { fontSize: 12, color: Colors.textMuted },
  overdueText: { color: Colors.danger },
  amount: { marginLeft: "auto" as any, fontSize: 15, fontWeight: "700", color: Colors.primary },
});
