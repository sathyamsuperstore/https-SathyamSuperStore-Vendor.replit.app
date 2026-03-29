import React, { useMemo } from "react";
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
import { useApp } from "@/context/AppContext";
import { SupplierCard } from "@/components/SupplierCard";
import { EmptyState } from "@/components/EmptyState";

export default function SuppliersScreen() {
  const { suppliers, orders } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const orderCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    orders.forEach((o) => {
      map[o.supplierId] = (map[o.supplierId] ?? 0) + 1;
    });
    return map;
  }, [orders]);

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Suppliers</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => router.push("/supplier/new")}
        >
          <Feather name="plus" size={20} color={Colors.textInverse} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={suppliers}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SupplierCard supplier={item} orderCount={orderCountMap[item.id] ?? 0} />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
          suppliers.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="users"
            title="No suppliers yet"
            subtitle="Tap the + button to add your first supplier"
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
    paddingBottom: 16,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { paddingHorizontal: 20 },
  listEmpty: { flex: 1 },
});
