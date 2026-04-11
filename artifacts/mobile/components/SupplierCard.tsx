import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { Supplier } from "@/context/AppContext";

interface Props {
  supplier: Supplier;
  orderCount: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  Grocery: "#3B82F6",
  "Raw Materials": "#10B981",
  Packaging: "#8B5CF6",
  Logistics: "#F59E0B",
  Services: "#EF4444",
  Other: "#64748B",
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();
}

export function SupplierCard({ supplier, orderCount }: Props) {
  const router = useRouter();
  const color = CATEGORY_COLORS[supplier.category] ?? CATEGORY_COLORS.Other;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push({ pathname: "/supplier/[id]", params: { id: supplier.id } })}
      activeOpacity={0.7}
    >
      <View style={[styles.avatar, { backgroundColor: color + "20" }]}>
        <Text style={[styles.initials, { color }]}>{getInitials(supplier.name)}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name}>{supplier.name}</Text>
        <Text style={styles.contact}>{supplier.contactName}</Text>
        <View style={styles.meta}>
          <View style={[styles.categoryBadge, { backgroundColor: color + "15" }]}>
            <Text style={[styles.categoryText, { color }]}>{supplier.category}</Text>
          </View>
          {supplier.vendorCode ? (
            <View style={styles.codeBadge}>
              <Feather name="tag" size={11} color={Colors.textMuted} />
              <Text style={styles.codeText}>{supplier.vendorCode}</Text>
            </View>
          ) : null}
          <View style={styles.ordersBadge}>
            <Feather name="file-text" size={11} color={Colors.textMuted} />
            <Text style={styles.ordersText}>{orderCount} order{orderCount !== 1 ? "s" : ""}</Text>
          </View>
        </View>
      </View>
      <Feather name="chevron-right" size={18} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
      android: { elevation: 2 },
    }),
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  initials: { fontSize: 16, fontWeight: "800" },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: "700", color: Colors.text, marginBottom: 2 },
  contact: { fontSize: 13, color: Colors.textSecondary, marginBottom: 6 },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  categoryBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  categoryText: { fontSize: 11, fontWeight: "600" },
  codeBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  codeText: { fontSize: 11, color: Colors.textMuted },
  ordersBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  ordersText: { fontSize: 11, color: Colors.textMuted },
});
