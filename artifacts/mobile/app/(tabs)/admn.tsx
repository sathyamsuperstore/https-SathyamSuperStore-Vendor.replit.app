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
    rodeoItems,
    rasiItems,
    clearAllSuppliers,
    clearAllAppUsers,
    clearPromoBatch,
    clearMrpBatch,
    clearLatestPurchases,
    clearAllOrders,
    clearLastSupplyDates,
    clearRodeoItems,
    clearRasiItems,
    setDataDownloadTimeNow,
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
      key: "last-supply-date",
      label: "LastSupplyDate",
      count: lastSupplyDates.length,
      onConfirm: clearLastSupplyDates,
      confirmTitle: "Delete All Last Supply Dates?",
      confirmMessage: (n) =>
        `Remove all ${n} last-supply-date row${n === 1 ? "" : "s"}? This cannot be undone.`,
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
      label: "LatestPurchases",
      count: latestPurchases.length,
      onConfirm: clearLatestPurchases,
      confirmTitle: "Delete All Latest Purchases?",
      confirmMessage: (n) =>
        `Remove all ${n} purchase row${n === 1 ? "" : "s"}? This cannot be undone.`,
    },
    {
      key: "orders",
      label: "Place Orders",
      count: orders.length,
      onConfirm: clearAllOrders,
      confirmTitle: "Delete All Orders?",
      confirmMessage: (n) =>
        `Remove all ${n} order${n === 1 ? "" : "s"}? This cannot be undone.`,
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
      key: "rodeo-items",
      label: "RodeoItems",
      count: rodeoItems.length,
      onConfirm: clearRodeoItems,
      confirmTitle: "Delete All RodeoItems?",
      confirmMessage: (n) =>
        `Remove all ${n} RodeoItem${n === 1 ? "" : "s"}? This cannot be undone.`,
    },
    {
      key: "rasi-items",
      label: "Rasi Items",
      count: rasiItems.length,
      onConfirm: clearRasiItems,
      confirmTitle: "Delete All Rasi Items?",
      confirmMessage: (n) =>
        `Remove all ${n} Rasi item${n === 1 ? "" : "s"}? This cannot be undone.`,
    },
  ];

  // Stack into 2-column rows. With 7 items the last row has a
  // single button — render an invisible spacer so widths line up.
  function chunk2<T>(arr: T[]): (T | null)[][] {
    const out: (T | null)[][] = [];
    for (let i = 0; i < arr.length; i += 2) {
      const a = arr[i];
      const b = i + 1 < arr.length ? arr[i + 1] : null;
      out.push([a, b]);
    }
    return out;
  }
  const rows: (DangerButton | null)[][] = chunk2(buttons);

  // Excel Import shortcuts. Each button opens the exact same importer the
  // user would normally reach from its own tab — Suppliers / Users /
  // Place Order have dedicated /import routes, while Promo / MRP /
  // Latest Purchases run their importer inline on the tab itself, so we
  // route to the tab and the user taps "Choose Excel File" there.
  type ImportButton = { key: string; label: string; route: string };
  const importButtons: ImportButton[] = [
    { key: "suppliers", label: "Suppliers", route: "/supplier/import" },
    { key: "users", label: "Users", route: "/user/import" },
    {
      key: "last-supply-date",
      label: "LastSupplyDate",
      route: "/(tabs)/last-supply-date",
    },
    { key: "mrp", label: "MRP", route: "/(tabs)/mrp" },
    {
      key: "latest-purchases",
      label: "LatestPurchases",
      route: "/(tabs)/latest-purchases",
    },
    { key: "orders", label: "Place Orders", route: "/order/import" },
    { key: "promo", label: "Promo", route: "/(tabs)/promo" },
    { key: "rodeo-items", label: "RodeoItems", route: "/rodeo/import" },
    { key: "rasi-items", label: "Rasi Items", route: "/(tabs)/rasi-items" },
    // "DownloadTime" doesn't import a workbook — it just stamps the
    // current wall-clock time as the latest data snapshot, then opens
    // the Data Download Time tab so the user can see the new value.
    // Routed through a sentinel route so the click handler below can
    // intercept and call setDataDownloadTimeNow() instead of pushing.
    { key: "download-time", label: "DownloadTime", route: "__download_time__" },
  ];
  const importRows: (ImportButton | null)[][] = chunk2(importButtons);

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
              {row.map((b, ci) => {
                if (!b) {
                  return <View key={`spacer-${ri}-${ci}`} style={styles.dangerBtnSpacer} />;
                }
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
        <Text style={styles.sectionTitle}>Settings</Text>
        <Text style={styles.sectionSub}>
          Edit the store identity (name, address, GST, FSSAI, contact
          numbers) used across the app.
        </Text>
        <TouchableOpacity
          style={styles.importBtn}
          onPress={() => {
            Haptics.selectionAsync();
            router.push("/company-details" as any);
          }}
          activeOpacity={0.85}
        >
          <Feather name="briefcase" size={16} color={Colors.primary} />
          <Text style={styles.importBtnText} numberOfLines={1}>
            Company Details
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.importBtn, { marginTop: 8 }]}
          onPress={() => {
            Haptics.selectionAsync();
            router.push("/company-details-r" as any);
          }}
          activeOpacity={0.85}
        >
          <Feather name="briefcase" size={16} color={Colors.primary} />
          <Text style={styles.importBtnText} numberOfLines={1}>
            CompanyR Details
          </Text>
        </TouchableOpacity>
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
              {row.map((b, ci) => {
                if (!b) {
                  return <View key={`spacer-${ri}-${ci}`} style={styles.dangerBtnSpacer} />;
                }
                return (
                  <TouchableOpacity
                    key={b.key}
                    style={styles.importBtn}
                    onPress={async () => {
                      Haptics.selectionAsync();
                      // Sentinel route used by the DownloadTime button —
                      // it isn't a real importer, it just stamps the
                      // current time and jumps to the Data Download
                      // Time tab so the user sees the new value.
                      if (b.route === "__download_time__") {
                        try {
                          await setDataDownloadTimeNow();
                        } catch (e: any) {
                          Alert.alert(
                            "Couldn't Save",
                            e?.message ?? "Unknown error",
                          );
                          return;
                        }
                        router.push("/(tabs)/data-download-time");
                        return;
                      }
                      router.push(b.route as any);
                    }}
                    activeOpacity={0.85}
                  >
                    <Feather name="upload" size={16} color={Colors.primary} />
                    <Text style={styles.importBtnText} numberOfLines={1}>
                      {b.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
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
  dangerBtnSpacer: { flex: 1 },
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
