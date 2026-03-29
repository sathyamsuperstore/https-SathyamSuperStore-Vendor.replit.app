import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Colors } from "@/constants/colors";
import { OrderStatus } from "@/context/AppContext";

const STATUS_CONFIG: Record<OrderStatus, { label: string; color: string; bg: string }> = {
  pending: { label: "Pending", color: Colors.statusPending, bg: Colors.statusPendingBg },
  confirmed: { label: "Confirmed", color: Colors.statusConfirmed, bg: Colors.statusConfirmedBg },
  shipped: { label: "Shipped", color: Colors.statusShipped, bg: Colors.statusShippedBg },
  delivered: { label: "Delivered", color: Colors.statusDelivered, bg: Colors.statusDeliveredBg },
  cancelled: { label: "Cancelled", color: Colors.statusCancelled, bg: Colors.statusCancelledBg },
};

interface Props {
  status: OrderStatus;
  size?: "sm" | "md";
}

export function StatusBadge({ status, size = "md" }: Props) {
  const config = STATUS_CONFIG[status];
  const isSmall = size === "sm";

  return (
    <View style={[styles.badge, { backgroundColor: config.bg }, isSmall && styles.badgeSm]}>
      <View style={[styles.dot, { backgroundColor: config.color }]} />
      <Text style={[styles.label, { color: config.color }, isSmall && styles.labelSm]}>
        {config.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    gap: 5,
  },
  badgeSm: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
  },
  labelSm: {
    fontSize: 11,
  },
});
