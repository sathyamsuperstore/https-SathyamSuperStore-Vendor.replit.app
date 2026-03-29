import React, { useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  TouchableOpacity,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { useApp } from "@/context/AppContext";
import { StatCard } from "@/components/StatCard";
import { OrderCard } from "@/components/OrderCard";
import { StatusBadge } from "@/components/StatusBadge";
import { OrderStatus } from "@/context/AppContext";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

export default function DashboardScreen() {
  const { orders, suppliers } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const stats = useMemo(() => {
    const pending = orders.filter((o) => o.status === "pending").length;
    const inProgress = orders.filter((o) => o.status === "confirmed" || o.status === "shipped").length;
    const delivered = orders.filter((o) => o.status === "delivered").length;
    const total = orders.reduce((sum, o) => sum + o.totalAmount, 0);
    const overdue = orders.filter(
      (o) =>
        o.status !== "delivered" &&
        o.status !== "cancelled" &&
        new Date(o.expectedDelivery) < new Date()
    ).length;
    return { pending, inProgress, delivered, total, overdue };
  }, [orders]);

  const recentOrders = useMemo(() => orders.slice(0, 4), [orders]);

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: topPt + 16, paddingBottom: insets.bottom + 100 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>Good morning</Text>
          <Text style={styles.title}>Dashboard</Text>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => router.push("/order/new")}
        >
          <Feather name="plus" size={20} color={Colors.textInverse} />
        </TouchableOpacity>
      </View>

      {stats.overdue > 0 && (
        <View style={styles.alert}>
          <Feather name="alert-circle" size={16} color={Colors.danger} />
          <Text style={styles.alertText}>
            {stats.overdue} order{stats.overdue > 1 ? "s are" : " is"} overdue
          </Text>
        </View>
      )}

      <View style={styles.statsGrid}>
        <View style={styles.statsRow}>
          <StatCard
            label="Total Value"
            value={formatCurrency(stats.total)}
            icon="trending-up"
            color={Colors.primary}
            bg={Colors.primaryMuted}
          />
          <StatCard
            label="Suppliers"
            value={suppliers.length}
            icon="users"
            color={Colors.accent}
            bg={Colors.accentLight}
          />
        </View>
        <View style={styles.statsRow}>
          <StatCard
            label="Pending"
            value={stats.pending}
            icon="clock"
            color={Colors.statusPending}
            bg={Colors.statusPendingBg}
          />
          <StatCard
            label="In Transit"
            value={stats.inProgress}
            icon="truck"
            color={Colors.statusShipped}
            bg={Colors.statusShippedBg}
          />
          <StatCard
            label="Delivered"
            value={stats.delivered}
            icon="check-circle"
            color={Colors.statusDelivered}
            bg={Colors.statusDeliveredBg}
          />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent Orders</Text>
          <TouchableOpacity onPress={() => router.push("/(tabs)/orders")}>
            <Text style={styles.seeAll}>See all</Text>
          </TouchableOpacity>
        </View>
        {recentOrders.map((order) => (
          <OrderCard key={order.id} order={order} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: 20 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 20,
  },
  greeting: { fontSize: 13, color: Colors.textMuted, marginBottom: 2 },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  alert: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.dangerLight,
    borderRadius: 10,
    padding: 12,
    gap: 8,
    marginBottom: 16,
  },
  alertText: { fontSize: 13, color: Colors.danger, fontWeight: "600" },
  statsGrid: { gap: 10, marginBottom: 24 },
  statsRow: { flexDirection: "row", gap: 10 },
  section: { marginBottom: 16 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  seeAll: { fontSize: 14, color: Colors.primaryLight, fontWeight: "600" },
});
