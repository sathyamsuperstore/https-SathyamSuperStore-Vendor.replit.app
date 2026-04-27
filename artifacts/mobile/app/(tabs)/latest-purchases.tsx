import React, { useState, useMemo, useRef, useEffect } from "react";
import { useLocalSearchParams } from "expo-router";
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
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import {
  useApp,
  LatestPurchaseEntry,
  LATEST_PURCHASES_FIELDS,
  showStorageErrorAlert,
} from "@/context/AppContext";

// Columns to attempt numeric parsing on at import time. Anything else
// (dates, IDs like GidNo / Item No / VendorCode, free-text fields) is
// kept as the original string so leading zeros and date formats survive.
const NUMERIC_FIELDS = new Set<string>([
  "SortNo",
  "Purchase Qty",
  "Free Qty",
  "NetCost",
  "MRP",
  "Tax",
  "Weight",
]);

// Columns the source spreadsheet stores as date types. Excel surfaces these
// either as JS Date objects (when read with cellDates:true) or as raw
// serial numbers (e.g. 45123 for 2023-07-12), neither of which renders
// usefully if we just String()-stringify them. Normalised to "DD/MM/YYYY".
const DATE_FIELDS = new Set<string>(["GidDate", "DODate", "CreatedDate"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Coerce a raw Excel date cell into a stable "DD/MM/YYYY" display string.
// Accepts: JS Date (cellDates:true path), Excel serial number (Lotus
// 1-2-3 epoch via the canonical 25569 offset), or strings already formatted
// as DD/MM/YYYY, DD-MM-YYYY, or ISO YYYY-MM-DD. Anything unparseable falls
// back to the original string so we never silently destroy user data.
function coerceDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : formatDDMMYYYY(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial → ms since epoch. 25569 = days between 1899-12-30
    // (Excel's effective epoch including the 1900 leap-year bug) and
    // 1970-01-01 (Unix epoch).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? String(v) : formatDDMMYYYY(d);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return "";
    // DD/MM/YYYY or DD-MM-YYYY (also handles 2-digit years).
    const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m1) {
      const day = parseInt(m1[1], 10);
      const mon = parseInt(m1[2], 10);
      let yr = parseInt(m1[3], 10);
      if (yr < 100) yr += 2000;
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    // ISO YYYY-MM-DD (or YYYY-MM-DDTHH:mm:ss).
    const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const yr = parseInt(m2[1], 10);
      const mon = parseInt(m2[2], 10);
      const day = parseInt(m2[3], 10);
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    // Last resort: native Date parser (handles "Jul 12, 2023" etc.).
    const d = new Date(s);
    if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    return s;
  }
  return String(v);
}

// Per-column display widths for the horizontally scrollable table. Wider
// columns are reserved for free-text fields that frequently overflow
// (Item Description, Brand, Category); narrow columns for short numerics
// and date IDs. Falls back to 90 for anything not listed.
const COL_WIDTHS: Record<string, number> = {
  GidNo: 90,
  SortNo: 80,
  VendorCode: 100,
  GidDate: 110,
  DONo: 100,
  DODate: 110,
  CreatedDate: 120,
  "Item No": 90,
  "Item Description": 240,
  "Purchase Qty": 100,
  "Free Qty": 80,
  NetCost: 90,
  MRP: 80,
  Tax: 70,
  Category: 130,
  Weight: 80,
  Brand: 140,
  // Synthetic display-only column: vendor name resolved from the
  // Suppliers tab via VendorCode. Wide enough for typical store names.
  "Vendor Name": 180,
};

function colWidth(field: string): number {
  return COL_WIDTHS[field] ?? 90;
}

// Synthetic column rendered between VendorCode and the rest. Not part
// of LATEST_PURCHASES_FIELDS — that constant is the import/export
// schema and must stay in sync with the source spreadsheet.
const VENDOR_NAME_COL = "Vendor Name";

// Build the on-screen column order by inserting the synthetic
// "Vendor Name" column immediately after "VendorCode".
function buildDisplayColumns(fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    out.push(f);
    if (f === "VendorCode") out.push(VENDOR_NAME_COL);
  }
  return out;
}

// Fields a user is likely to know to search by. SortNo included so
// numeric IDs work via substring match (e.g. "12" matches "12" / "112").
// Vendor name is searchable via a separate code path (it lives on
// the supplier record, not on the purchase row itself).
const SEARCH_FIELDS = [
  "GidNo",
  "SortNo",
  "VendorCode",
  "DONo",
  "Item No",
  "Item Description",
  "Category",
  "Brand",
];

function formatCell(field: string, value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    // Keep integers integer-looking, prices/margins to 2dp. Avoids
    // showing "12.000000001" style noise from floating-point parses.
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }
  return String(value);
}

export default function LatestPurchasesScreen() {
  const { latestPurchases, saveLatestPurchasesBatch, clearLatestPurchases, suppliers } = useApp();

  // VendorCode (uppercased, trimmed) → supplier name. Built once per
  // suppliers change so each row's vendor-name lookup is O(1).
  const vendorNameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suppliers) {
      const code = (s.vendorCode ?? "").trim().toUpperCase();
      if (code) m.set(code, (s.name ?? "").trim());
    }
    return m;
  }, [suppliers]);

  // Resolve a row's vendor name; "Unlisted" if the VendorCode is not
  // present in the Suppliers tab. Empty/missing VendorCode also reads as
  // "Unlisted" so the column is never blank.
  const vendorNameFor = (code: unknown): string => {
    const k = String(code ?? "").trim().toUpperCase();
    if (!k) return "Unlisted";
    const name = vendorNameByCode.get(k);
    return name && name.length > 0 ? name : "Unlisted";
  };

  // Display columns = canonical schema + the synthetic "Vendor Name"
  // column inserted right after VendorCode.
  const displayColumns = useMemo(
    () => buildDisplayColumns(LATEST_PURCHASES_FIELDS),
    []
  );
  const insets = useSafeAreaInsets();
  // Optional URL param: when navigated to from the Orders tab via a tap
  // on a VendorCode chip, the search box gets pre-filled with that code.
  const params = useLocalSearchParams<{ search?: string }>();

  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Consume the `search` URL param on entry. Each distinct param value is
  // applied at most once via consumedSearchParam so a tab-bar revisit (the
  // URL still carries the same `?search=...`) doesn't keep re-overriding
  // the user's edits. A new VendorCode tap from Orders updates the param
  // to a different value and triggers a fresh consume.
  const consumedSearchParam = useRef<string | null>(null);
  useEffect(() => {
    const incoming = typeof params.search === "string" ? params.search.trim() : "";
    if (incoming.length > 0 && consumedSearchParam.current !== incoming) {
      setSearch(incoming);
      consumedSearchParam.current = incoming;
    }
  }, [params.search]);

  // Refs + guard for syncing horizontal scroll between the (sticky) table
  // header and the rows below it. The guard prevents a feedback loop where
  // each scrollTo would re-fire its sibling's onScroll handler.
  const headerScrollRef = useRef<ScrollView>(null);
  const rowsScrollRef = useRef<ScrollView>(null);
  const isSyncingScroll = useRef(false);

  const onHeaderScroll = (e: any) => {
    if (isSyncingScroll.current) {
      isSyncingScroll.current = false;
      return;
    }
    const x = e.nativeEvent.contentOffset.x;
    isSyncingScroll.current = true;
    rowsScrollRef.current?.scrollTo({ x, animated: false });
  };

  const onRowsScroll = (e: any) => {
    if (isSyncingScroll.current) {
      isSyncingScroll.current = false;
      return;
    }
    const x = e.nativeEvent.contentOffset.x;
    isSyncingScroll.current = true;
    headerScrollRef.current?.scrollTo({ x, animated: false });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return latestPurchases;
    return latestPurchases.filter((r) => {
      if (SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q))) {
        return true;
      }
      // Also match against the resolved vendor name so users can find
      // rows by typing the supplier name even though it isn't stored
      // on the purchase row itself.
      return vendorNameFor(r["VendorCode"]).toLowerCase().includes(q);
    });
  }, [latestPurchases, search, vendorNameByCode]);

  async function pickAndImport() {
    try {
      setLoading(true);
      setErrors([]);
      setStatusMsg(null);

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
      await new Promise((r) => setTimeout(r, 50));

      let workbook: XLSX.WorkBook;
      if (Platform.OS === "web") {
        const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", asset.uri, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => resolve(xhr.response as ArrayBuffer);
          xhr.onerror = () => {
            fetch(asset.uri)
              .then((r) => r.arrayBuffer())
              .then(resolve)
              .catch(reject);
          };
          xhr.send();
        });
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array", cellDates: true });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: "base64" as any,
        });
        if (!base64 || base64.length === 0) {
          throw new Error("Could not read file content. Make sure the file is a valid Excel file.");
        }
        workbook = XLSX.read(base64, { type: "base64", cellDates: true });
      }

      const sheetName =
        workbook.SheetNames.find((n) => n.toLowerCase() === "latestpurchases") ??
        workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      // Case- and whitespace-insensitive header lookup, matches MRP behavior.
      const firstRow = raw[0];
      const keyMap: Record<string, string> = {};
      for (const k of Object.keys(firstRow)) {
        keyMap[k.toLowerCase().replace(/\s+/g, "")] = k;
      }
      const fieldKeys: Record<string, string | undefined> = {};
      for (const field of LATEST_PURCHASES_FIELDS) {
        fieldKeys[field] = keyMap[field.toLowerCase().replace(/\s+/g, "")];
      }

      const gidNoKey = fieldKeys["GidNo"];
      const sortNoKey = fieldKeys["SortNo"];
      if (!gidNoKey || !sortNoKey) {
        setErrors([
          `Missing required columns. Expected "GidNo" and "SortNo". Found: ${Object.keys(firstRow).join(", ")}`,
        ]);
        setLoading(false);
        return;
      }

      const seenPair = new Set<string>();
      const parsed: LatestPurchaseEntry[] = [];
      const localErrors: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const gid = String(r[gidNoKey] ?? "").trim();
        const sortRaw = String(r[sortNoKey] ?? "").trim();
        if (!gid || !sortRaw) {
          localErrors.push(`Row ${i + 2}: missing GidNo / SortNo`);
          continue;
        }
        // Dedupe by (GidNo, SortNo) — first occurrence wins, mirrors the
        // MRP tab's (ItemNo, MRP) dedupe behavior.
        const key = `${gid.toUpperCase()}|${sortRaw}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);

        const entry: LatestPurchaseEntry = {};
        for (const field of LATEST_PURCHASES_FIELDS) {
          const sourceKey = fieldKeys[field];
          if (!sourceKey) {
            entry[field] = "";
            continue;
          }
          const v = r[sourceKey];
          if (DATE_FIELDS.has(field)) {
            // Pass the raw cell value (Date / number / string) so the
            // coercer can pick the right branch — String()-stringifying
            // first would lose Date objects and Excel serial numbers.
            entry[field] = coerceDate(v);
            continue;
          }
          const str = v === undefined || v === null ? "" : String(v);
          if (NUMERIC_FIELDS.has(field) && str.trim() !== "") {
            const n = parseFloat(str);
            entry[field] = isNaN(n) ? str : n;
          } else {
            entry[field] = str;
          }
        }
        parsed.push(entry);
      }

      if (parsed.length === 0) {
        setErrors([
          "No valid rows found. Make sure GidNo and SortNo are filled.",
          ...localErrors,
        ]);
        setLoading(false);
        return;
      }

      // Sort priority (per user request):
      //   1. DODate descending (newest delivery order first)
      //   2. VendorCode ascending
      //   3. Brand ascending
      //   4. Category ascending
      // DODate at this point is the normalized "DD/MM/YYYY" string from
      // coerceDate. We turn it into a sortable YYYYMMDD integer; missing
      // or unparseable dates sort to the end regardless of direction so
      // they don't pollute the top.
      const dateKey = (s: unknown): number => {
        const m = String(s ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return -1;
        return parseInt(m[3] + m[2] + m[1], 10);
      };
      const textCmp = (a: unknown, b: unknown): number =>
        String(a ?? "").localeCompare(String(b ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      parsed.sort((a, b) => {
        const aD = dateKey(a["DODate"]);
        const bD = dateKey(b["DODate"]);
        // Push missing/unparseable DODate rows to the bottom in both
        // directions so they don't claim the top of a descending sort.
        if (aD === -1 && bD !== -1) return 1;
        if (bD === -1 && aD !== -1) return -1;
        if (aD !== bD) return bD - aD; // descending
        const v = textCmp(a["VendorCode"], b["VendorCode"]);
        if (v !== 0) return v;
        const br = textCmp(a["Brand"], b["Brand"]);
        if (br !== 0) return br;
        return textCmp(a["Category"], b["Category"]);
      });

      try {
        await saveLatestPurchasesBatch(parsed);
      } catch {
        // Storage failures (e.g. phone out of space) get the standard
        // friendly alert instead of being lumped into the parser error
        // list, which would show a raw exception like "QuotaExceededError".
        showStorageErrorAlert();
        setLoading(false);
        return;
      }
      setStatusMsg(
        `Imported ${parsed.length} row${parsed.length !== 1 ? "s" : ""} from "${asset.name}".`
      );
      if (localErrors.length > 0) setErrors(localErrors);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to import file"]);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    if (latestPurchases.length === 0) return;
    const msg = `Remove all ${latestPurchases.length} Latest Purchases rows? This cannot be undone.`;
    const doClear = async () => {
      try {
        await clearLatestPurchases();
        setStatusMsg(null);
        setErrors([]);
        setSearch("");
      } catch {
        showStorageErrorAlert();
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(msg)) void doClear();
      return;
    }
    Alert.alert("Clear Latest Purchases", msg, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => void doClear() },
    ]);
  }

  async function handleExport() {
    if (latestPurchases.length === 0) return;
    try {
      setDownloading(true);
      // Header row + one row per entry, columns in canonical field order.
      const data: (string | number)[][] = [
        [...LATEST_PURCHASES_FIELDS],
        ...latestPurchases.map((e) =>
          LATEST_PURCHASES_FIELDS.map((f) => {
            const v = e[f];
            if (v === undefined || v === null) return "";
            return v as string | number;
          })
        ),
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = LATEST_PURCHASES_FIELDS.map((f) => ({
        wch: Math.max(10, Math.floor(colWidth(f) / 8)),
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "LatestPurchases");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Sathyam Super Store - Latest Purchases - ${_ts}.xlsx`;
      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
        const blob = new Blob([wbout], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { bookType: "xlsx", type: "base64", cellStyles: true });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: "base64" as any });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export Latest Purchases",
            UTI: "com.microsoft.excel.xlsx",
          });
        } else {
          Alert.alert("Export saved", `File saved to: ${fileUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Export Failed", e?.message ?? "Unknown error");
    } finally {
      setDownloading(false);
    }
  }

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Latest Purchases</Text>
        <View style={styles.headerActions}>
          {latestPurchases.length > 0 && (
            <>
              <TouchableOpacity
                style={styles.exportBtn}
                onPress={handleExport}
                disabled={downloading}
              >
                {downloading ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Feather name="download" size={16} color={Colors.primary} />
                )}
                <Text style={styles.exportBtnText}>Export</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
                <Feather name="trash-2" size={15} color={Colors.danger} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/*
        Layout strategy:
        - The body is a single vertical ScrollView so the import card scrolls
          out of view when reviewing the table.
        - The table header is rendered as its own direct child of the outer
          ScrollView at a STABLE index, so we can pass `stickyHeaderIndices`
          and have it pin to the top during vertical scrolling.
        - The header (sticky) and rows are two separate horizontal
          ScrollViews; their horizontal positions are kept in sync via
          onScroll handlers above. This is the standard React Native pattern
          for a sticky header on a horizontally scrollable wide table.
        - Sections that are conditional in content (errors / status / data
          area) still render an outer wrapper View so the sticky index
          (5 = table header) stays stable across re-renders.
      */}
      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
        ]}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={latestPurchases.length > 0 ? [5] : undefined}
      >
        {/* 0: import card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import Latest Purchases</Text>
          <Text style={styles.cardSub}>
            Excel file with the wide purchase-history layout. Required columns:{" "}
            <Text style={styles.mono}>GidNo</Text> and{" "}
            <Text style={styles.mono}>SortNo</Text>. Imported data is stored independently of
            Orders and MRP.
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
                  ? "Reading file..."
                  : latestPurchases.length > 0
                    ? "Re-Import (Replace)"
                    : "Choose Excel File"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.deleteBtn, latestPurchases.length === 0 && { opacity: 0.4 }]}
              onPress={handleClear}
              disabled={latestPurchases.length === 0}
            >
              <Feather name="trash-2" size={18} color={Colors.textInverse} />
              <Text style={styles.deleteBtnText}>Delete All</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 1: errors box (always rendered, content conditional) */}
        <View>
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
        </View>

        {/* 2: status (success) box */}
        <View>
          {statusMsg && (
            <View style={styles.successBox}>
              <Feather name="check-circle" size={16} color={Colors.success ?? "#16A34A"} />
              <Text style={styles.successText}>{statusMsg}</Text>
            </View>
          )}
        </View>

        {/* 3: search wrap */}
        <View>
          {latestPurchases.length > 0 && (
            <View style={styles.searchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search GidNo, SortNo, Item No, Brand…"
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
          )}
        </View>

        {/* 4: stats row */}
        <View>
          {latestPurchases.length > 0 && (
            <View style={styles.statsRow}>
              <Text style={styles.statText}>
                {filtered.length} of {latestPurchases.length} entr
                {latestPurchases.length !== 1 ? "ies" : "y"}
              </Text>
            </View>
          )}
        </View>

        {/* 5: STICKY table header — opaque background so rows scroll under it cleanly */}
        <View style={styles.stickyHeaderWrap}>
          {latestPurchases.length > 0 && (
            <ScrollView
              ref={headerScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              onScroll={onHeaderScroll}
              scrollEventThrottle={16}
              style={styles.headerScroll}
            >
              <View style={styles.tableHead}>
                {displayColumns.map((f) => {
                  const numeric = NUMERIC_FIELDS.has(f);
                  return (
                    <Text
                      key={f}
                      style={[
                        styles.th,
                        { width: colWidth(f), textAlign: numeric ? "right" : "left" },
                      ]}
                      numberOfLines={1}
                    >
                      {f}
                    </Text>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </View>

        {/* 6: table rows */}
        <View>
          {latestPurchases.length > 0 && (
            <View style={styles.tableRowsCard}>
              <ScrollView
                ref={rowsScrollRef}
                horizontal
                showsHorizontalScrollIndicator
                onScroll={onRowsScroll}
                scrollEventThrottle={16}
              >
                <View>
                  {filtered.length === 0 ? (
                    <View style={styles.noRows}>
                      <Feather name="search" size={24} color={Colors.textMuted} />
                      <Text style={styles.noRowsText}>No items match "{search}"</Text>
                    </View>
                  ) : (
                    filtered.map((row, i) => (
                      <View
                        key={`${row["GidNo"] ?? ""}-${row["SortNo"] ?? ""}-${i}`}
                        style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                      >
                        {displayColumns.map((f) => {
                          const numeric = NUMERIC_FIELDS.has(f);
                          // The synthetic vendor-name column reads from
                          // the suppliers lookup, not from the row.
                          const isVendorName = f === VENDOR_NAME_COL;
                          const cellText = isVendorName
                            ? vendorNameFor(row["VendorCode"])
                            : formatCell(f, row[f]);
                          const isUnlisted = isVendorName && cellText === "Unlisted";
                          return (
                            <Text
                              key={f}
                              style={[
                                styles.td,
                                {
                                  width: colWidth(f),
                                  textAlign: numeric ? "right" : "left",
                                  fontWeight: numeric ? "600" : "400",
                                },
                                // Mute unlisted vendors so a populated
                                // store doesn't visually drown the
                                // legitimate matches.
                                isUnlisted && { color: Colors.textMuted, fontStyle: "italic" },
                              ]}
                              numberOfLines={1}
                            >
                              {cellText}
                            </Text>
                          );
                        })}
                      </View>
                    ))
                  )}
                </View>
              </ScrollView>
            </View>
          )}
        </View>

        {latestPurchases.length === 0 && !loading && (
          <>
            {/* If a search filter arrived via the VendorCode link from the
                Orders tab but there's no purchase data yet, surface that
                fact so the user understands the link worked and the
                filter will apply once they import a file. */}
            {search.trim().length > 0 && (
              <View style={styles.linkedQueuedBox}>
                <Feather name="link" size={14} color={Colors.primary} />
                <Text style={styles.linkedQueuedText}>
                  Search filter <Text style={styles.linkedQueuedCode}>{search}</Text> is set.
                  It will apply once you import a Latest Purchases file.
                </Text>
              </View>
            )}
            <View style={styles.emptyHint}>
              <Feather name="info" size={14} color={Colors.textMuted} />
              <Text style={styles.emptyHintText}>
                Pick an Excel file to load the Latest Purchases table.
              </Text>
            </View>
          </>
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
  title: { fontSize: 24, fontWeight: "800", color: Colors.text },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primaryLight ?? "#E0EAFF",
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  exportBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  clearBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fecaca",
  },
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
  successText: { color: Colors.success ?? "#16A34A", fontWeight: "600", fontSize: 13, flex: 1 },
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
  // Wrapper for the sticky header. Opaque background prevents data rows
  // from showing through as they scroll underneath the pinned header.
  // Rounded top corners + matched border to visually attach to the rows
  // card below it.
  stickyHeaderWrap: {
    backgroundColor: Colors.surface ?? "#fff",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  headerScroll: {},
  // Rows portion of the table (header lives in stickyHeaderWrap above).
  tableRowsCard: {
    backgroundColor: Colors.surface ?? "#fff",
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  tableHead: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
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
    gap: 8,
  },
  rowAlt: { backgroundColor: Colors.background },
  td: { fontSize: 12, color: Colors.text },
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
  // Notice shown in the empty-data state when a search filter was set via
  // the VendorCode link from the Orders tab. Helps the user understand
  // the navigation worked even though there's nothing to filter yet.
  linkedQueuedBox: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    backgroundColor: Colors.surface,
    borderColor: Colors.primary,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 4,
  },
  linkedQueuedText: { flex: 1, fontSize: 12, color: Colors.text, lineHeight: 18 },
  linkedQueuedCode: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontWeight: "700" },
});
