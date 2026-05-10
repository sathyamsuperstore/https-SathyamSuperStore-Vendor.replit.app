import React, { useEffect } from "react";
import {
  Alert,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { useApp } from "@/context/AppContext";

type DangerButton = {
  key: string;
  label: string;
  count: number;
  onConfirm: () => Promise<void>;
  confirmTitle: string;
  confirmMessage: (count: number) => string;
};

export default function AdmnHubScreen() {
  const {
    currentUser,
    suppliers,
    appUsers,
    promoEntries,
    mrpEntries,
    latestPurchases,
    orders,
    lastSupplyDates,
    clearAllSuppliers,
    clearAllAppUsers,
    clearPromoBatch,
    clearMrpBatch,
    clearLatestPurchases,
    clearAllOrders,
    clearLastSupplyDates,
  } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const isAllowed =
    !!currentUser &&
    (currentUser.userType === "Admin" ||
      currentUser.userType === "Manager" ||
      currentUser.userType === "Staff");

  useEffect(() => {
    if (!isAllowed) {
      router.replace("/(tabs)");
    }
  }, [isAllowed, router]);

  if (!isAllowed) return null;

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  // Confirmation prompt that works on both web (window.confirm) and
  // native (Alert.alert). Mirrors the pattern used by the per-tab
  // delete buttons we're replicating here.
  function confirmAndRun(
    title: string,
    message: string,
    onConfirm: () => Promise<void>
  ) {
    const run = async () => {
      try {
        await onConfirm();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        Alert.alert("Couldn't Delete", e?.message ?? "Unknown error");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(message)) run();
    } else {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: run },
      ]);
    }
  }

  const buttons: DangerButton[] = [
    {
      key: "suppliers",
      label: "Suppliers",
      count: suppliers.length,
      onConfirm: clearAllSuppliers,
      confirmTitle: "Delete All Suppliers?",
      confirmMessage: (n) =>
        `Remove all ${n} supplier${n === 1 ? "" : "s"}? This cannot be undone.`,
    },
    {
      key: "users",
      label: "Users",
      count: appUsers.length,
      onConfirm: clearAllAppUsers,
      confirmTitle: "Delete All Users?",
      confirmMessage: (n) =>
        `Remove all ${n} user${n === 1 ? "" : "s"}? This cannot be undone.`,
    },
    {
      key: "promo",
      label: "Promo",
      count: promoEntries.length,
      onConfirm: clearPromoBatch,
      confirmTitle: "Delete All Promo Entries?",
      confirmMessage: (n) =>
        `Remove all ${n} promo entr${n === 1 ? "y" : "ies"}? This cannot be undone.`,
    },
    {
      key: "mrp",
      label: "MRP",
      count: mrpEntries.length,
      onConfirm: clearMrpBatch,
      confirmTitle: "Delete All MRP Entries?",
      confirmMessage: (n) =>
        `Remove all ${n} MRP entr${n === 1 ? "y" : "ies"}? This cannot be undone.`,
    },
    {
      key: "latest-purchases",
      label: "Latest Purchases",
      count: latestPurchases.length,
      onConfirm: clearLatestPurchases,
      confirmTitle: "Delete All Latest Purchases?",
      confirmMessage: (n) =>
        `Remove all ${n} purchase row${n === 1 ? "" : "s"}? This cannot be undone.`,
    },
    {
      key: "orders",
      label: "Place Order",
      count: orders.length,
      onConfirm: clearAllOrders,
      confirmTitle: "Delete All Orders?",
      confirmMessage: (n) =>
        `Remove all ${n} order${n === 1 ? "" : "s"}? This cannot be undone.`,
    },
  ];

  // Stack the 6 buttons into 2 rows of 3 so the grid stays balanced
  // regardless of label length.
  const rows: DangerButton[][] = [buttons.slice(0, 3), buttons.slice(3, 6)];

  // Excel Import shortcuts. Each button opens the exact same importer the
  // user would normally reach from its own tab — Suppliers / Users /
  // Place Order have dedicated /import routes, while Promo / MRP /
  // Latest Purchases run their importer inline on the tab itself, so we
  // route to the tab and the user taps "Choose Excel File" there.
  type ImportButton = { key: string; label: string; route: string };
  const importButtons: ImportButton[] = [
    { key: "suppliers", label: "Suppliers", route: "/supplier/import" },
    { key: "users", label: "Users", route: "/user/import" },
    { key: "promo", label: "Promo", route: "/(tabs)/promo" },
    { key: "mrp", label: "MRP", route: "/(tabs)/mrp" },
    {
      key: "latest-purchases",
      label: "Latest Purchases",
      route: "/(tabs)/latest-purchases",
    },
    { key: "orders", label: "Place Order", route: "/order/import" },
  ];
  const importRows: ImportButton[][] = [
    importButtons.slice(0, 3),
    importButtons.slice(3, 6),
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: topPt + 16, paddingBottom: insets.bottom + 100 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Image
            source={require("../../assets/images/logo.png")}
            style={styles.headerLogo}
            resizeMode="contain"
          />
          <View>
            <Text style={styles.greeting}>Admin only</Text>
            <Text style={styles.title}>Admn</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Delete All</Text>
        <Text style={styles.sectionSub}>
          Wipe an entire table at once. Each button is disabled when its
          table is already empty. This cannot be undone.
        </Text>

        <View style={styles.grid}>
          {rows.map((row, ri) => (
            <View key={ri} style={styles.gridRow}>
              {row.map((b) => {
                const disabled = b.count === 0;
                return (
                  <TouchableOpacity
                    key={b.key}
                    style={[
                      styles.dangerBtn,
                      disabled && styles.dangerBtnDisabled,
                    ]}
                    onPress={() =>
                      confirmAndRun(
                        b.confirmTitle,
                        b.confirmMessage(b.count),
                        b.onConfirm
                      )
                    }
                    disabled={disabled}
                    activeOpacity={0.85}
                  >
                    <Feather
                      name="trash-2"
                      size={16}
                      color={disabled ? Colors.textMuted : Colors.danger}
                    />
                    <Text
                      style={[
                        styles.dangerBtnText,
                        disabled && styles.dangerBtnTextDisabled,
                      ]}
                      numberOfLines={1}
                    >
                      {b.label}
                    </Text>
                    <Text
                      style={[
                        styles.dangerBtnCount,
                        disabled && styles.dangerBtnTextDisabled,
                      ]}
                    >
                      {b.count}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>
      </View>

      <View style={[styles.section, { marginTop: 16 }]}>
        <Text style={styles.sectionTitle}>Excel Import</Text>
        <Text style={styles.sectionSub}>
          Open the importer for each table. Importing replaces or merges
          existing rows depending on the table — review the prompts on the
          target screen before confirming.
        </Text>

        <View style={styles.grid}>
          {importRows.map((row, ri) => (
            <View key={ri} style={styles.gridRow}>
              {row.map((b) => (
                <TouchableOpacity
                  key={b.key}
                  style={styles.importBtn}
                  onPress={() => {
                    Haptics.selectionAsync();
                    router.push(b.route as any);
                  }}
                  activeOpacity={0.85}
                >
                  <Feather name="upload" size={16} color={Colors.primary} />
                  <Text style={styles.importBtnText} numberOfLines={1}>
                    {b.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </View>
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
    alignItems: "center",
    marginBottom: 20,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerLogo: { width: 48, height: 48 },
  greeting: { fontSize: 13, color: Colors.textMuted, marginBottom: 2 },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  section: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 8,
  },
  sectionTitle: { fontSize: 18, fontWeight: "800", color: Colors.text },
  sectionSub: {
    fontSize: 12,
    color: Colors.textMuted,
    marginBottom: 8,
    lineHeight: 16,
  },
  grid: { gap: 10 },
  gridRow: { flexDirection: "row", gap: 10 },
  dangerBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.dangerLight,
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  dangerBtnDisabled: {
    backgroundColor: Colors.background,
    borderColor: Colors.border,
  },
  dangerBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.danger,
    flexShrink: 1,
  },
  dangerBtnCount: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.danger,
    opacity: 0.7,
  },
  dangerBtnTextDisabled: { color: Colors.textMuted },
  importBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.primary + "12",
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  importBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.primary,
    flexShrink: 1,
  },
});
