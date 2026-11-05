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
  Modal,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
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

type SortField = "vendorName" | "vendorCode" | "latestInvoiceDate";

// ---------------------------------------------------------------------------
// Date helpers (mirrors the coercion logic used in latest-purchases.tsx)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Inverse of formatDDMMYYYY — accepts DD/MM/YYYY, DD-MM-YYYY (incl.
// 2-digit years) and ISO YYYY-MM-DD. Returns null if the string isn't
// a valid calendar date so the date-range filter can simply skip
// rows whose stored date is unparseable rather than throwing.
function ddmmyyyyToDate(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  const m1 = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m1) {
    let y = parseInt(m1[3], 10);
    if (y < 100) y += y >= 50 ? 1900 : 2000;
    const d = new Date(y, parseInt(m1[2], 10) - 1, parseInt(m1[1], 10));
    return d.getFullYear() === y && d.getMonth() === parseInt(m1[2], 10) - 1 && d.getDate() === parseInt(m1[1], 10)
      ? d
      : null;
  }
  const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) {
    const d = new Date(parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, parseInt(m2[3], 10));
    return d.getFullYear() === parseInt(m2[1], 10) && d.getMonth() === parseInt(m2[2], 10) - 1 && d.getDate() === parseInt(m2[3], 10)
      ? d
      : null;
  }
  return null;
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

const SORT_FIELDS: { key: SortField; label: string }[] = [
  { key: "vendorName", label: "Vendor" },
  { key: "vendorCode", label: "Code" },
  { key: "latestInvoiceDate", label: "Date" },
];

export default function LastSupplyDateScreen() {
  const { lastSupplyDates, saveLastSupplyDateBatch, clearLastSupplyDates } =
    useApp();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string>("");
  const [sortField, setSortField] = useState<SortField>("vendorName");
  const [sortAsc, setSortAsc] = useState(true);

  // Date-range filter (From/To) for Latest Invoice Date
  const [dateFrom, setDateFrom] = useState<Date | null>(null);
  const [dateTo, setDateTo] = useState<Date | null>(null);
  const [showDateModal, setShowDateModal] = useState(false);
  const [dateFromDraft, setDateFromDraft] = useState<Date>(() => startOfDay(new Date()));
  const [dateToDraft, setDateToDraft] = useState<Date>(() => startOfDay(new Date()));
  const [showDateFromPicker, setShowDateFromPicker] = useState(false);
  const [showDateToPicker, setShowDateToPicker] = useState(false);
  const [dateRangeError, setDateRangeError] = useState<string | null>(null);

  const dateRangeActive = dateFrom != null && dateTo != null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let result = q
      ? lastSupplyDates.filter(
          (e) =>
            e.vendorName.toLowerCase().includes(q) ||
            e.vendorCode.toLowerCase().includes(q) ||
            e.latestInvoiceDate.includes(q)
        )
      : [...lastSupplyDates];

    if (dateRangeActive) {
      const fromMs = dateFrom!.getTime();
      const toMs = dateTo!.getTime();
      result = result.filter((e) => {
        const d = ddmmyyyyToDate(e.latestInvoiceDate);
        if (!d) return false;
        const ms = startOfDay(d).getTime();
        return ms >= fromMs && ms <= toMs;
      });
    }

    result.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "vendorName":
          cmp = a.vendorName.localeCompare(b.vendorName, undefined, {
            sensitivity: "base",
          });
          break;
        case "vendorCode":
          cmp = a.vendorCode.localeCompare(b.vendorCode, undefined, {
            sensitivity: "base",
          });
          break;
        case "latestInvoiceDate": {
          const da = a.latestInvoiceDate
            ? new Date(
                parseInt(a.latestInvoiceDate.split("/")[2]),
                parseInt(a.latestInvoiceDate.split("/")[1]) - 1,
                parseInt(a.latestInvoiceDate.split("/")[0])
              ).getTime()
            : 0;
          const db = b.latestInvoiceDate
            ? new Date(
                parseInt(b.latestInvoiceDate.split("/")[2]),
                parseInt(b.latestInvoiceDate.split("/")[1]) - 1,
                parseInt(b.latestInvoiceDate.split("/")[0])
              ).getTime()
            : 0;
          cmp = da - db;
          break;
        }
      }
      return sortAsc ? cmp : -cmp;
    });
    return result;
  }, [lastSupplyDates, search, sortField, sortAsc, dateRangeActive, dateFrom, dateTo]);

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
      // Chain to the next step in the import sequence: LastSupplyDate
      // → MRP. Brief pause lets the 100% bar render before we navigate.
      setLoading(false);
      setTimeout(() => {
        router.replace("/(tabs)/mrp");
      }, 400);
      return;
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

            <View style={styles.sortRow}>
              <Text style={styles.sortLabel}>Sort by</Text>
              {SORT_FIELDS.map((f) => (
                <TouchableOpacity
                  key={f.key}
                  style={[
                    styles.sortChip,
                    sortField === f.key && styles.sortChipActive,
                  ]}
                  onPress={() => {
                    if (sortField === f.key) {
                      setSortAsc((v) => !v);
                    } else {
                      setSortField(f.key);
                      setSortAsc(true);
                    }
                  }}
                >
                  <Text
                    style={[
                      styles.sortChipText,
                      sortField === f.key && styles.sortChipTextActive,
                    ]}
                  >
                    {f.label}
                  </Text>
                  {sortField === f.key && (
                    <Feather
                      name={sortAsc ? "arrow-up" : "arrow-down"}
                      size={12}
                      color={sortField === f.key ? Colors.primary : Colors.textMuted}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </View>

            {/* Date-range filter row */}
            <View style={styles.dateFilterRow}>
              <TouchableOpacity
                style={[styles.dateFilterBtn, dateRangeActive && styles.dateFilterBtnActive]}
                onPress={() => {
                  setShowDateModal(true);
                  setDateRangeError(null);
                }}
              >
                <Feather name="calendar" size={14} color={dateRangeActive ? Colors.primary : Colors.textSecondary} />
                <Text style={[styles.dateFilterBtnText, dateRangeActive && styles.dateFilterBtnTextActive]}>
                  {dateRangeActive
                    ? `${formatDDMMYYYY(dateFrom!)} – ${formatDDMMYYYY(dateTo!)}`
                    : "Date Range"}
                </Text>
                {dateRangeActive && (
                  <TouchableOpacity
                    onPress={() => {
                      setDateFrom(null);
                      setDateTo(null);
                      setDateRangeError(null);
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Feather name="x" size={14} color={Colors.primary} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
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
                <Text style={[styles.th, { flex: 4 }]}>Vendor Name</Text>
                <Text style={[styles.th, { flex: 1.5 }]}>Code</Text>
                <Text style={[styles.th, { flex: 2, textAlign: "right" }]}>
                  Latest Invoice Date
                </Text>
                <Text style={[styles.th, { flex: 1.2, textAlign: "center" }]}>
                  Action
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
                      style={[styles.td, { flex: 4 }]}
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
                    <View style={{ flex: 1.2, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 4, paddingVertical: 10 }}>
                      <TouchableOpacity
                        style={styles.payBtn}
                        onPress={(e) => {
                          e.stopPropagation?.();
                          router.push({
                            pathname: "/vendor-payments",
                            params: { vendor: r.vendorName },
                          });
                        }}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        activeOpacity={0.8}
                      >
                        <Feather name="credit-card" size={10} color="#fff" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.stkBtn}
                        onPress={(e) => {
                          e.stopPropagation?.();
                          router.push({
                            pathname: "/(tabs)/stockupd",
                            params: { vendor: r.vendorName },
                          });
                        }}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        activeOpacity={0.8}
                      >
                        <Feather name="box" size={10} color={Colors.primary} />
                      </TouchableOpacity>
                    </View>
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

      {/* Date-Range Picker Modal */}
      <Modal
        visible={showDateModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDateModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowDateModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Date Range</Text>
            <TouchableOpacity
              onPress={() => {
                const today = startOfDay(new Date());
                setDateFromDraft(today);
                setDateToDraft(today);
                setDateFrom(null);
                setDateTo(null);
                setShowDateFromPicker(false);
                setShowDateToPicker(false);
                setDateRangeError(null);
              }}
            >
              <Text style={styles.modalClear}>Clear</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.dateRangeWrap}>
            <View style={styles.dateRangeField}>
              <Text style={styles.dateRangeLabel}>From</Text>
              <TouchableOpacity
                style={styles.dateRangeButton}
                onPress={() => {
                  setShowDateToPicker(false);
                  setShowDateFromPicker((v) => !v);
                  setDateRangeError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(dateFromDraft)}
                </Text>
              </TouchableOpacity>
              {showDateFromPicker && (
                <DateTimePicker
                  value={dateFromDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    if (Platform.OS !== "ios") setShowDateFromPicker(false);
                    if (selected) {
                      setDateFromDraft(startOfDay(selected));
                      setDateRangeError(null);
                    }
                  }}
                />
              )}
            </View>
            <View style={styles.dateRangeField}>
              <Text style={styles.dateRangeLabel}>To</Text>
              <TouchableOpacity
                style={styles.dateRangeButton}
                onPress={() => {
                  setShowDateFromPicker(false);
                  setShowDateToPicker((v) => !v);
                  setDateRangeError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(dateToDraft)}
                </Text>
              </TouchableOpacity>
              {showDateToPicker && (
                <DateTimePicker
                  value={dateToDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    if (Platform.OS !== "ios") setShowDateToPicker(false);
                    if (selected) {
                      setDateToDraft(startOfDay(selected));
                      setDateRangeError(null);
                    }
                  }}
                />
              )}
            </View>
          </View>

          {dateRangeError && (
            <View style={styles.dateErrorWrap}>
              <Feather name="alert-circle" size={14} color={Colors.danger} />
              <Text style={styles.dateErrorText}>{dateRangeError}</Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => {
              const from = startOfDay(dateFromDraft);
              const to = startOfDay(dateToDraft);
              if (from.getTime() > to.getTime()) {
                setDateRangeError("From date can't be after To date.");
                return;
              }
              setDateFrom(from);
              setDateTo(to);
              setDateRangeError(null);
              setShowDateModal(false);
              setShowDateFromPicker(false);
              setShowDateToPicker(false);
            }}
          >
            <Text style={styles.modalDoneText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </Modal>
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
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  sortLabel: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  sortChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: Colors.surface ?? "#fff",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sortChipActive: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary + "40",
  },
  sortChipText: { fontSize: 11, fontWeight: "600", color: Colors.textSecondary },
  sortChipTextActive: { color: Colors.primary, fontWeight: "700" },
  statsRow: { paddingHorizontal: 4 },
  statText: { fontSize: 12, color: Colors.textMuted },
  payBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.danger,
  },
  stkBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
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

  // Date-filter row
  dateFilterRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4, marginBottom: 4 },
  dateFilterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface ?? "#fff",
  },
  dateFilterBtnActive: {
    borderColor: Colors.primary + "40",
    backgroundColor: Colors.primaryMuted,
  },
  dateFilterBtnText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  dateFilterBtnTextActive: { color: Colors.primary },

  // Date-range modal (mirrors stockupd.tsx)
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    maxHeight: "70%",
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: "center",
    marginBottom: 8,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: Colors.text },
  modalClear: { fontSize: 14, fontWeight: "700", color: Colors.danger },
  dateRangeWrap: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  dateRangeField: { flex: 1 },
  dateRangeLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  dateRangeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  dateRangeButtonText: { fontSize: 15, fontWeight: "600", color: Colors.text },
  dateErrorWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  dateErrorText: { fontSize: 13, color: Colors.danger, fontWeight: "600" },
  modalDoneBtn: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  modalDoneText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
});
