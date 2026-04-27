import React, { useState, useMemo, useRef } from "react";
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
  "VendorPayment",
  "PromoMRP",
  "NoBatches",
  "Offer Price",
  "SoldQnty",
  "Weight",
  "ITaxPer1",
  "Sort No",
  "Stock",
  "PromoPrice",
  "LQty",
  "MRP",
  "RodeoMRP",
  "SP",
  "RodeoSP",
  "Cost",
  "Tax",
  "CESS",
  "MRP Margin",
  "Customer Margin",
  "Shop Margin",
  "MRPDiff",
]);

// Per-column display widths for the horizontally scrollable table. Wider
// columns are reserved for free-text fields that frequently overflow
// (Item Description, Product Name, Vendor); narrow columns for short
// numerics. Falls back to 90 for anything not listed.
const COL_WIDTHS: Record<string, number> = {
  VendorPayment: 110,
  PromoMRP: 90,
  PromoCode: 100,
  NoBatches: 90,
  Vendor: 140,
  "Offer Price": 90,
  "Item No": 90,
  BrandCode: 90,
  CategoryCode: 110,
  "Item Description": 220,
  "Offer End Date": 110,
  SoldQnty: 90,
  Weight: 80,
  GidNo: 80,
  GRNDate: 100,
  InvoiceDate: 110,
  VendorCode: 100,
  "Product Name": 180,
  ITaxPer1: 80,
  "Sort No": 80,
  Stock: 70,
  "New Item Date": 110,
  PromoPrice: 90,
  PromoEndDate: 110,
  LQty: 70,
  MRP: 80,
  RodeoMRP: 90,
  SP: 70,
  RodeoSP: 80,
  Cost: 80,
  Tax: 70,
  CESS: 70,
  "MRP Margin": 100,
  "Customer Margin": 120,
  "Shop Margin": 100,
  MRPDiff: 80,
  LatestPO: 100,
  Batch: 100,
  "Uni Promo": 100,
};

function colWidth(field: string): number {
  return COL_WIDTHS[field] ?? 90;
}

// Fields a user is likely to know to search by. Sort No included so
// numeric IDs work via substring match (e.g. "12" matches "12" / "112").
const SEARCH_FIELDS = [
  "GidNo",
  "Sort No",
  "Item No",
  "Product Name",
  "Item Description",
  "Vendor",
  "VendorCode",
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
  const { latestPurchases, saveLatestPurchasesBatch, clearLatestPurchases } = useApp();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

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
    return latestPurchases.filter((r) =>
      SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q))
    );
  }, [latestPurchases, search]);

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
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: "base64" as any,
        });
        if (!base64 || base64.length === 0) {
          throw new Error("Could not read file content. Make sure the file is a valid Excel file.");
        }
        workbook = XLSX.read(base64, { type: "base64" });
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
      const sortNoKey = fieldKeys["Sort No"];
      if (!gidNoKey || !sortNoKey) {
        setErrors([
          `Missing required columns. Expected "GidNo" and "Sort No". Found: ${Object.keys(firstRow).join(", ")}`,
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
          localErrors.push(`Row ${i + 2}: missing GidNo / Sort No`);
          continue;
        }
        // Dedupe by (GidNo, Sort No) — first occurrence wins, mirrors the
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
          "No valid rows found. Make sure GidNo and Sort No are filled.",
          ...localErrors,
        ]);
        setLoading(false);
        return;
      }

      // Sort by GidNo (numeric-aware so "9" sorts before "10"), then Sort No.
      // For Sort No we prefer a true numeric compare when both sides parse,
      // and otherwise fall back to a numeric-aware string compare so mixed
      // values (e.g. "12A" vs "12B") still order intuitively instead of
      // collapsing to 0.
      parsed.sort((a, b) => {
        const aGid = String(a["GidNo"] ?? "");
        const bGid = String(b["GidNo"] ?? "");
        const cmp = aGid.localeCompare(bGid, undefined, { numeric: true, sensitivity: "base" });
        if (cmp !== 0) return cmp;
        const aSortRaw = a["Sort No"];
        const bSortRaw = b["Sort No"];
        const aSortNum = Number(aSortRaw);
        const bSortNum = Number(bSortRaw);
        const aIsNum = Number.isFinite(aSortNum) && String(aSortRaw).trim() !== "";
        const bIsNum = Number.isFinite(bSortNum) && String(bSortRaw).trim() !== "";
        if (aIsNum && bIsNum) return aSortNum - bSortNum;
        return String(aSortRaw ?? "").localeCompare(String(bSortRaw ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
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
            <Text style={styles.mono}>Sort No</Text>. Imported data is stored independently of
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
                placeholder="Search GidNo, Sort No, Item No, Vendor…"
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
                {LATEST_PURCHASES_FIELDS.map((f) => {
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
                        key={`${row["GidNo"] ?? ""}-${row["Sort No"] ?? ""}-${i}`}
                        style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                      >
                        {LATEST_PURCHASES_FIELDS.map((f) => {
                          const numeric = NUMERIC_FIELDS.has(f);
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
                              ]}
                              numberOfLines={1}
                            >
                              {formatCell(f, row[f])}
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
          <View style={styles.emptyHint}>
            <Feather name="info" size={14} color={Colors.textMuted} />
            <Text style={styles.emptyHintText}>
              Pick an Excel file to load the Latest Purchases table.
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
});
