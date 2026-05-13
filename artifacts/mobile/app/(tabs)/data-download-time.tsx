import React from "react";
import {
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, showStorageErrorAlert } from "@/context/AppContext";

// Data Download Time tab — single-field "snapshot freshness" view.
//
// The timestamp itself is owned by AppContext (`dataDownloadTime`)
// and is written by exactly two callers:
//   1. The Admin tab's "DownloadTime" Excel-Import button
//      (manual override; jumps here right after).
//   2. The Promo importer once a sheet has been parsed and saved
//      (auto-stamp; also jumps here so the user sees the new time).
// This screen exposes the same "stamp now" action so a user who
// lands here directly can refresh the time without backtracking.
export default function DataDownloadTimeScreen() {
  const { dataDownloadTime, setDataDownloadTimeNow, clearDataDownloadTime } =
    useApp();
  const insets = useSafeAreaInsets();
  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  // Long, human-readable rendering — date AND time, in the device's
  // local zone. We deliberately use the user's locale so different
  // regions don't see each other's date order (DD/MM vs MM/DD).
  const formatted = dataDownloadTime
    ? new Date(dataDownloadTime).toLocaleString(undefined, {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  async function onStampNow() {
    try {
      await setDataDownloadTimeNow();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      showStorageErrorAlert();
    }
  }

  function onClearAsk() {
    const run = async () => {
      try {
        await clearDataDownloadTime();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        showStorageErrorAlert();
      }
    };
    const msg =
      "Remove the recorded last-data-download timestamp? You can stamp a new one any time.";
    if (Platform.OS === "web") {
      if (window.confirm(msg)) run();
    } else {
      Alert.alert("Clear Last Data Download Time?", msg, [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: run },
      ]);
    }
  }

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
            <Text style={styles.greeting}>Snapshot freshness</Text>
            <Text style={styles.title}>Data Download Time</Text>
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Last Data Download Time</Text>
        {formatted ? (
          <Text style={styles.fieldValue}>{formatted}</Text>
        ) : (
          <Text style={styles.fieldValueEmpty}>
            Not recorded yet. Tap "Stamp Now" or import a Promo sheet to set it.
          </Text>
        )}
        <Text style={styles.fieldHint}>
          This is the wall-clock time the upstream data snapshot was last
          refreshed. Shown on the Dashboard so everyone knows how fresh the
          numbers they're looking at really are.
        </Text>

        <View style={styles.row}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={onStampNow}
            activeOpacity={0.85}
          >
            <Feather name="refresh-ccw" size={16} color={Colors.textInverse} />
            <Text style={styles.primaryBtnText}>Stamp Now</Text>
          </TouchableOpacity>
          {dataDownloadTime ? (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={onClearAsk}
              activeOpacity={0.85}
            >
              <Feather name="trash-2" size={16} color={Colors.danger} />
              <Text style={styles.secondaryBtnText}>Clear</Text>
            </TouchableOpacity>
          ) : null}
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
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fieldValue: { fontSize: 22, fontWeight: "800", color: Colors.text },
  fieldValueEmpty: {
    fontSize: 14,
    color: Colors.textMuted,
    fontStyle: "italic",
  },
  fieldHint: {
    fontSize: 12,
    color: Colors.textMuted,
    lineHeight: 16,
    marginTop: 4,
  },
  row: { flexDirection: "row", gap: 10, marginTop: 12 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    flex: 1,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.textInverse,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.dangerLight,
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.danger,
  },
});
