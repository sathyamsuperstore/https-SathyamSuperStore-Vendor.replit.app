import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as XLSX from "xlsx-js-style";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import {
  useApp,
  LastSupplyDateEntry,
  showStorageErrorAlert,
} from "@/context/AppContext";

// ---------------------------------------------------------------------------
// Date helpers (mirrors the coercion logic used in latest-purchases.tsx)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Coerce whatever Excel hands us for a date cell into a DD/MM/YYYY string.
// Accepts: JS Date, Excel serial number, DD/MM/YYYY, DD-MM-YYYY, ISO YYYY-MM-DD.
function coerceDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : formatDDMMYYYY(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? String(v) : formatDDMMYYYY(d);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return "";
    const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m1) {
      let yr = parseInt(m1[3], 10);
      if (yr < 100) yr += 2000;
      const d = new Date(yr, parseInt(m1[2], 10) - 1, parseInt(m1[1], 10));
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const d = new Date(
        parseInt(m2[1], 10),
        parseInt(m2[2], 10) - 1,
        parseInt(m2[3], 10)
      );
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    return s;
  }
  return String(v);
}

function yieldToUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Column header aliases accepted at import time.
// Whitespace-insensitive matching is applied before this table is consulted.
// ---------------------------------------------------------------------------
const VENDOR_NAME_ALIASES = new Set([
  "vendorname",
  "vendor name",
  "suppliername",
  "supplier name",
  "name",
]);
const VENDOR_CODE_ALIASES = new Set([
  "vendorcode",
  "vendor code",
  "suppliercode",
  "supplier code",
  "code",
]);
const DATE_ALIASES = new Set([
  "latestinvoicedate",
  "latest invoice date",
  "invoicedate",
  "invoice date",
  "lastdate",
  "last date",
  "lastsupplydate",
  "last supply date",
  "date",
]);

export default function LastSupplyDateScreen() {
  const { lastSupplyDates, saveLastSupplyDateBatch, clearLastSupplyDates } =
    useApp();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string>("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lastSupplyDates;
    return lastSupplyDates.filter(
      (e) =>
        e.vendorName.toLowerCase().includes(q) ||
        e.vendorCode.toLowerCase().includes(q) ||
        e.latestInvoiceDate.includes(q)
    );
  }, [lastSupplyDates, search]);

  // -------------------------------------------------------------------------
  // Excel import
  // -------------------------------------------------------------------------
  async function pickAndImport() {
    try {
      setLoading(true);
      setErrors([]);
      setStatusMsg(null);
      setProgress(0);
      setProgressLabel("");

      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel",
          "application/octet-stream",
          "*/*",
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        setLoading(false);
        return;
      }

      const asset = result.assets[0];
      setProgress(5);
      setProgressLabel("Opening file…");
      await yieldToUI();

      let workbook: XLSX.WorkBook;
      if (Platform.OS === "web") {
        const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", asset.uri, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => resolve(xhr.response as ArrayBuffer);
          xhr.onerror = () =>
            fetch(asset.uri)
              .then((r) => r.arrayBuffer())
              .then(resolve)
              .catch(reject);
          xhr.send();
        });
        setProgress(25);
        setProgressLabel("Reading workbook…");
        await yieldToUI();
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array", cellDates: true });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: "base64" as any,
        });
        if (!base64 || base64.length === 0) {
          throw new Error("Could not read file content. Make sure it is a valid Excel file.");
        }
        setProgress(25);
        setProgressLabel("Reading workbook…");
        await yieldToUI();
        workbook = XLSX.read(base64, { type: "base64", cellDates: true });
      }

      setProgress(40);
      setProgressLabel("Extracting rows…");
      await yieldToUI();

      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      // Build a normalised key → original-header map
      const firstRow = raw[0];
      const keyMap: Record<string, string> = {};
      for (const k of Object.keys(firstRow)) {
        keyMap[k.trim().toLowerCase().replace(/\s+/g, " ")] = k;
      }

      // Resolve column headers
      const vendorNameKey = Object.keys(keyMap).find((k) =>
        VENDOR_NAME_ALIASES.has(k)
      );
      const vendorCodeKey = Object.keys(keyMap).find((k) =>
        VENDOR_CODE_ALIASES.has(k)
      );
      const dateKey = Object.keys(keyMap).find((k) => DATE_ALIASES.has(k));

      const missing: string[] = [];
      if (!vendorNameKey) missing.push("VendorName");
      if (!vendorCodeKey) missing.push("VendorCode");
      if (!dateKey) missing.push("Latest Invoice Date");
      if (missing.length > 0) {
        setErrors([
          `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
            `Found: ${Object.keys(firstRow).join(", ")}`,
        ]);
        setLoading(false);
        return;
      }

      const vnCol = keyMap[vendorNameKey!];
      const vcCol = keyMap[vendorCodeKey!];
      const dtCol = keyMap[dateKey!];

      const parsed: LastSupplyDateEntry[] = [];
      const localErrors: string[] = [];
      const chunkSize = Math.max(50, Math.ceil(raw.length / 25));
      const PARSE_FROM = 40;
      const PARSE_TO = 90;

      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const vendorName = String(r[vnCol] ?? "").trim();
        const vendorCode = String(r[vcCol] ?? "").trim();
        const latestInvoiceDate = coerceDate(r[dtCol]);

        if (!vendorName && !vendorCode) {
          // Skip completely empty rows silently
        } else if (!vendorCode) {
          localErrors.push(`Row ${i + 2}: missing VendorCode (VendorName: "${vendorName}")`);
        } else {
          parsed.push({ vendorName, vendorCode, latestInvoiceDate });
        }

        if ((i + 1) % chunkSize === 0 || i === raw.length - 1) {
          const ratio = (i + 1) / raw.length;
          setProgress(Math.round(PARSE_FROM + (PARSE_TO - PARSE_FROM) * ratio));
          setProgressLabel(`Parsing rows ${i + 1} of ${raw.length}…`);
          await yieldToUI();
        }
      }

      if (parsed.length === 0) {
        setErrors([
          "No valid rows found. Make sure VendorName, VendorCode, and Latest Invoice Date are filled.",
          ...localErrors,
        ]);
        setLoading(false);
        return;
      }

      setProgress(95);
      setProgressLabel("Saving…");
      await yieldToUI();

      try {
        await saveLastSupplyDateBatch(parsed);
      } catch {
        showStorageErrorAlert();
        setLoading(false);
        return;
      }

      setProgress(100);
      setProgressLabel("Done");
      setStatusMsg(
        `Imported ${parsed.length} row${parsed.length !== 1 ? "s" : ""} from "${asset.name}".`
      );
      if (localErrors.length > 0) setErrors(localErrors);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLoading(false);
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to import file"]);
    } finally {
      setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Delete All
  // -------------------------------------------------------------------------
  function handleClear() {
    if (lastSupplyDates.length === 0) return;
    const msg = `Remove all ${lastSupplyDates.length} entr${lastSupplyDates.length === 1 ? "y" : "ies"}? This cannot be undone.`;
    const doClear = async () => {
      try {
        await clearLastSupplyDates();
        setStatusMsg(null);
        setErrors([]);
        setSearch("");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        showStorageErrorAlert("Couldn't Clear");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(msg)) void doClear();
      return;
    }
    Alert.alert("Delete All Entries?", msg, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void doClear() },
    ]);
  }

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>LastSupplyDate</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Import card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import Last Supply Dates</Text>
          <Text style={styles.cardSub}>
            Excel file with columns{" "}
            <Text style={styles.mono}>VendorName</Text>,{" "}
            <Text style={styles.mono}>VendorCode</Text>, and{" "}
            <Text style={styles.mono}>Latest Invoice Date</Text>. Existing
            records are replaced on each import.
          </Text>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.pickBtn, loading && { opacity: 0.6 }, { flex: 1 }]}
              onPress={pickAndImport}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color={Colors.textInverse} />
              ) : (
                <Feather name="upload" size={18} color={Colors.textInverse} />
              )}
              <Text style={styles.pickBtnText}>
                {loading
                  ? "Importing…"
                  : lastSupplyDates.length > 0
                  ? "Re-Import (Replace)"
                  : "Choose Excel File"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.deleteBtn,
                lastSupplyDates.length === 0 && { opacity: 0.4 },
              ]}
              onPress={handleClear}
              disabled={lastSupplyDates.length === 0}
            >
              <Feather name="trash-2" size={18} color={Colors.textInverse} />
              <Text style={styles.deleteBtnText}>Delete All</Text>
            </TouchableOpacity>
          </View>

          {loading && (
            <View style={styles.progressWrap}>
              <View style={styles.progressLabelRow}>
                <Text style={styles.progressLabelText} numberOfLines={1}>
                  {progressLabel || "Starting…"}
                </Text>
                <Text style={styles.progressPercentText}>{progress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.max(0, Math.min(100, progress))}%` },
                  ]}
                />
              </View>
            </View>
          )}
        </View>

        {/* Error box */}
        {errors.length > 0 && (
          <View style={styles.errorBox}>
            <Feather name="alert-triangle" size={16} color={Colors.danger} />
            <View style={{ flex: 1 }}>
              {errors.map((e, i) => (
                <Text key={i} style={styles.errorText}>
                  {e}
                </Text>
              ))}
            </View>
          </View>
        )}

        {/* Success box */}
        {statusMsg && (
          <View style={styles.successBox}>
            <Feather
              name="check-circle"
              size={16}
              color={Colors.success ?? "#16A34A"}
            />
            <Text style={styles.successText}>{statusMsg}</Text>
          </View>
        )}

        {/* Table */}
        {lastSupplyDates.length > 0 && (
          <>
            <View style={styles.searchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search vendor name, code or date…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {search.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity
                  onPress={() => setSearch("")}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.statsRow}>
              <Text style={styles.statText}>
                {filtered.length} of {lastSupplyDates.length} entr
                {lastSupplyDates.length !== 1 ? "ies" : "y"}
              </Text>
            </View>

            <View style={styles.tableCard}>
              {/* Header */}
              <View style={styles.tableHead}>
                <Text style={[styles.th, { flex: 2.5 }]}>Vendor Name</Text>
                <Text style={[styles.th, { flex: 1.5 }]}>Code</Text>
                <Text style={[styles.th, { flex: 2, textAlign: "right" }]}>
                  Latest Invoice Date
                </Text>
              </View>

              {filtered.length === 0 ? (
                <View style={styles.noRows}>
                  <Feather name="search" size={24} color={Colors.textMuted} />
                  <Text style={styles.noRowsText}>
                    No entries match "{search}"
                  </Text>
                </View>
              ) : (
                filtered.map((r, i) => (
                  <View
                    key={`${r.vendorCode}-${i}`}
                    style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                  >
                    <Text
                      style={[styles.td, { flex: 2.5 }]}
                      numberOfLines={1}
                    >
                      {r.vendorName || "—"}
                    </Text>
                    <Text
                      style={[styles.td, { flex: 1.5, fontWeight: "600" }]}
                      numberOfLines={1}
                    >
                      {r.vendorCode}
                    </Text>
                    <Text
                      style={[styles.td, { flex: 2, textAlign: "right" }]}
                      numberOfLines={1}
                    >
                      {r.latestInvoiceDate || "—"}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}

        {lastSupplyDates.length === 0 && !loading && (
          <View style={styles.emptyHint}>
            <Feather name="info" size={14} color={Colors.textMuted} />
            <Text style={styles.emptyHintText}>
              Pick an Excel file to load the Last Supply Date table.
            </Text>
          </View>
        )}
      </ScrollView>
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
    paddingBottom: 8,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  body: { padding: 16, gap: 14 },
  card: {
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 12,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  cardSub: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  mono: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontWeight: "600",
    color: Colors.text,
  },
  actionRow: { flexDirection: "row", gap: 8 },
  pickBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  pickBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 15 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: Colors.danger,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  deleteBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 14 },
  progressWrap: { gap: 6 },
  progressLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  progressLabelText: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
    flex: 1,
    marginRight: 8,
  },
  progressPercentText: {
    fontSize: 12,
    fontWeight: "800",
    color: Colors.primary,
    fontVariant: ["tabular-nums"],
  },
  progressTrack: {
    height: 8,
    backgroundColor: Colors.border,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: Colors.primary,
    borderRadius: 999,
  },
  errorBox: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#fecaca",
  },
  errorText: { color: Colors.danger, fontSize: 13, lineHeight: 18 },
  successBox: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    alignItems: "center",
    backgroundColor: "#f0fdf4",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#bbf7d0",
  },
  successText: {
    color: Colors.success ?? "#16A34A",
    fontWeight: "600",
    fontSize: 13,
    flex: 1,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text, padding: 0 },
  statsRow: { paddingHorizontal: 4 },
  statText: { fontSize: 12, color: Colors.textMuted },
  tableCard: {
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tableHead: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  th: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
  },
  tableRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowAlt: { backgroundColor: Colors.background },
  td: { fontSize: 13, color: Colors.text },
  noRows: { padding: 24, alignItems: "center", gap: 6 },
  noRowsText: { fontSize: 13, color: Colors.textMuted },
  emptyHint: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
  },
  emptyHintText: { fontSize: 12, color: Colors.textMuted },
});
