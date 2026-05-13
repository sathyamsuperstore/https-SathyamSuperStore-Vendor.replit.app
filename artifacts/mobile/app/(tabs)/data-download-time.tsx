import React, { useState } from "react";
import {
  ActivityIndicator,
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
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as XLSX from "xlsx-js-style";
import { Colors } from "@/constants/colors";
import { useApp, showStorageErrorAlert } from "@/context/AppContext";

// Data Download Time tab — single-field "snapshot freshness" view.
//
// The timestamp itself is owned by AppContext (`dataDownloadTime`)
// and is set in three ways:
//   1. The Admin tab's "DownloadTime" Excel-Import button stamps
//      the current time and jumps here.
//   2. The Promo importer auto-stamps after a successful import.
//   3. This screen's "Import from Excel" button reads the timestamp
//      from cell A1 of the first sheet of an .xlsx file the user
//      picks — that is the canonical "real" snapshot time supplied
//      by the upstream system.

// Read cell A1 of the first sheet and convert it into a Unix ms
// timestamp. Accepts a Date object (the common case when xlsx is
// read with cellDates:true), a numeric Excel date serial, or a
// human-readable string (we try Date.parse first, then a couple of
// common DD/MM/YYYY formats so Indian-style sheets still work).
function parseTimestampCell(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number") {
    // Excel serial date: days since 1899-12-30 (Lotus quirk-aware).
    // Anything below ~20000 (= year 1954) is almost certainly NOT a
    // date — bail out so we don't translate "0" into 1899.
    if (value < 20000) return null;
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    // ISO-ish strings (YYYY-MM-DD, with or without time) parse cleanly.
    const direct = Date.parse(s);
    if (Number.isFinite(direct)) return direct;
    // DD/MM/YYYY [HH:MM[:SS]] — common in Indian export sheets.
    const m = s.match(
      /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (m) {
      const dd = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10) - 1;
      let yy = parseInt(m[3], 10);
      if (yy < 100) yy += 2000;
      const hh = m[4] ? parseInt(m[4], 10) : 0;
      const mi = m[5] ? parseInt(m[5], 10) : 0;
      const ss = m[6] ? parseInt(m[6], 10) : 0;
      const t = new Date(yy, mm, dd, hh, mi, ss).getTime();
      return Number.isFinite(t) ? t : null;
    }
    return null;
  }
  return null;
}

export default function DataDownloadTimeScreen() {
  const { dataDownloadTime, setDataDownloadTimeValue, clearDataDownloadTime } =
    useApp();
  const insets = useSafeAreaInsets();
  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const [busy, setBusy] = useState(false);

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

  function notify(title: string, message?: string) {
    if (Platform.OS === "web") {
      window.alert(message ? `${title}\n\n${message}` : title);
    } else {
      Alert.alert(title, message);
    }
  }

  async function onImportFromExcel() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel",
          "*/*",
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      setBusy(true);
      const asset = result.assets[0];
      let workbook: XLSX.WorkBook;
      // cellDates:true makes xlsx hand us real Date objects for any
      // date-formatted cell — that's the common, easy path. Numbers
      // and strings still flow through parseTimestampCell as a
      // safety net for sheets that omit the date format.
      if (Platform.OS === "web") {
        const resp = await fetch(asset.uri);
        const arrayBuffer = await resp.arrayBuffer();
        workbook = XLSX.read(new Uint8Array(arrayBuffer), {
          type: "array",
          cellDates: true,
        });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        workbook = XLSX.read(base64, { type: "base64", cellDates: true });
      }

      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        notify("Empty workbook", "The picked file has no sheets.");
        return;
      }
      const sheet = workbook.Sheets[sheetName];
      // We only care about the very first cell. Pull it as raw value
      // (not formatted text) so we get the underlying Date / number
      // and can convert it ourselves with full precision.
      const cellA1 = sheet?.["A1"];
      const raw = cellA1?.v;
      const ms = parseTimestampCell(raw);
      if (ms == null) {
        notify(
          "Couldn't read timestamp",
          "Cell A1 of the first sheet must contain a date+time value (e.g. 2026-05-13 14:30 or an Excel date cell).",
        );
        return;
      }

      try {
        await setDataDownloadTimeValue(ms);
      } catch {
        showStorageErrorAlert();
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      notify(
        "Last Data Download Time updated",
        new Date(ms).toLocaleString(undefined, {
          weekday: "short",
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    } catch (e: any) {
      notify("Import failed", e?.message ?? "Unknown error");
    } finally {
      setBusy(false);
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
      "Remove the recorded last-data-download timestamp? You can import a new one any time.";
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
            Not recorded yet. Tap "Stamp Now" to import the timestamp from an Excel file.
          </Text>
        )}
        <Text style={styles.fieldHint}>
          The timestamp is read from cell A1 of the first sheet of the
          workbook you pick. Cell A1 should be a date+time value (an Excel
          date cell, an ISO string like "2026-05-13 14:30", or DD/MM/YYYY).
          Shown on the Dashboard so everyone knows how fresh the numbers
          they're looking at really are.
        </Text>

        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.primaryBtnDisabled]}
            onPress={onImportFromExcel}
            disabled={busy}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={Colors.textInverse} size="small" />
            ) : (
              <Feather name="upload" size={16} color={Colors.textInverse} />
            )}
            <Text style={styles.primaryBtnText}>
              {busy ? "Importing…" : "Stamp Now"}
            </Text>
          </TouchableOpacity>
          {dataDownloadTime ? (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={onClearAsk}
              disabled={busy}
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
  primaryBtnDisabled: { opacity: 0.6 },
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
