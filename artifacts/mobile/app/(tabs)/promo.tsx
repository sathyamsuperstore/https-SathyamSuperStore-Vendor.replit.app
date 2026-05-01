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
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import {
  useApp,
  PromoEntry,
  PROMO_FIELDS,
  showStorageErrorAlert,
} from "@/context/AppContext";

// Columns the importer should attempt to coerce to a number. Anything
// outside this set (Item No, BatchNo, Brand, Category, Item Description)
// stays as the original string so leading zeros and free-text values
// survive the round trip through Excel.
const NUMERIC_FIELDS = new Set<string>([
  "NoofBatches",
  "SP",
  "SoldQty",
  "PromotionPrice",
  "Latest MRP",
  "MRP",
]);

// Date columns. Excel surfaces these as JS Date objects (cellDates:true),
// raw serial numbers (e.g. 45123 for 2023-07-12), or already-formatted
// strings — none of which render usefully if we just String()-stringify
// them. Normalised to "DD/MM/YYYY".
const DATE_FIELDS = new Set<string>(["PromotionToDate", "Promo Create Date"]);

// Columns that NoofBatches-style values should display as integers, even
// though they're stored as numbers (it's an integer field per the
// schema). Other numeric fields use 2dp.
const INTEGER_FIELDS = new Set<string>(["NoofBatches"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Coerce a raw Excel date cell into a stable "DD/MM/YYYY" display
// string. Same logic used by the Latest Purchases tab — anything we
// can't parse falls through to its original string so we never
// silently destroy user data.
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
      const day = parseInt(m1[1], 10);
      const mon = parseInt(m1[2], 10);
      let yr = parseInt(m1[3], 10);
      if (yr < 100) yr += 2000;
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const yr = parseInt(m2[1], 10);
      const mon = parseInt(m2[2], 10);
      const day = parseInt(m2[3], 10);
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    return s;
  }
  return String(v);
}

// Per-column display widths for the horizontally scrollable table. Wider
// columns are reserved for free-text fields that overflow (Item
// Description, Brand, Category); narrow columns for short numerics and
// dates. Falls back to 90 for anything not listed.
const COL_WIDTHS: Record<string, number> = {
  PromotionToDate: 120,
  Category: 130,
  "Item No": 90,
  Brand: 140,
  NoofBatches: 90,
  "Item Description": 240,
  SP: 80,
  SoldQty: 90,
  PromotionPrice: 110,
  "Promo Create Date": 130,
  "Latest MRP": 100,
  MRP: 80,
  BatchNo: 110,
  VendorCode: 110,
  VendorName: 180,
};

function colWidth(field: string): number {
  return COL_WIDTHS[field] ?? 90;
}

// Fields a user is most likely to search by. Numeric fields are
// excluded so a stray "10" doesn't match every row with a price ending
// in 10.
const SEARCH_FIELDS = [
  "Item No",
  "BatchNo",
  "Brand",
  "Category",
  "Item Description",
  "VendorCode",
  "VendorName",
];

function formatCell(field: string, value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    if (INTEGER_FIELDS.has(field) || Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }
  return String(value);
}

export default function PromoScreen() {
  const { promoEntries, savePromoBatch, clearPromoBatch } = useApp();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  // Import progress: 0-100 with a human-readable phase label. Same
  // pattern as the MRP import — the parsing loop yields to the event
  // loop in chunks so the bar can actually paint while we work.
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string>("");

  // Refs + guard for syncing horizontal scroll between the (sticky)
  // table header and the rows below it. Without the guard each
  // scrollTo would re-fire its sibling's onScroll handler and create
  // a feedback loop.
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
    if (!q) return promoEntries;
    return promoEntries.filter((r) =>
      SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q))
    );
  }, [promoEntries, search]);

  function yieldToUI(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }

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
          xhr.onerror = () => {
            fetch(asset.uri)
              .then((r) => r.arrayBuffer())
              .then(resolve)
              .catch(reject);
          };
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
          throw new Error("Could not read file content. Make sure the file is a valid Excel file.");
        }
        setProgress(25);
        setProgressLabel("Reading workbook…");
        await yieldToUI();
        workbook = XLSX.read(base64, { type: "base64", cellDates: true });
      }

      setProgress(40);
      setProgressLabel("Extracting rows…");
      await yieldToUI();

      const sheetName =
        workbook.SheetNames.find(
          (n) => n.toLowerCase().replace(/\s+/g, "") === "promo" ||
                 n.toLowerCase().replace(/\s+/g, "") === "promotionmaster"
        ) ?? workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      // Case- and whitespace-insensitive header lookup, matches the
      // MRP and Latest Purchases tabs.
      const firstRow = raw[0];
      const keyMap: Record<string, string> = {};
      for (const k of Object.keys(firstRow)) {
        keyMap[k.toLowerCase().replace(/\s+/g, "")] = k;
      }
      const fieldKeys: Record<string, string | undefined> = {};
      for (const field of PROMO_FIELDS) {
        fieldKeys[field] = keyMap[field.toLowerCase().replace(/\s+/g, "")];
      }

      const itemNoKey = fieldKeys["Item No"];
      const batchNoKey = fieldKeys["BatchNo"];
      if (!itemNoKey || !batchNoKey) {
        setErrors([
          `Missing required columns. Expected "Item No" and "BatchNo". Found: ${Object.keys(firstRow).join(", ")}`,
        ]);
        setLoading(false);
        return;
      }

      // Walk the rows in chunks so we can drive the progress bar
      // through the parsing phase. Aim for ~25 progress updates
      // regardless of file size.
      const seenPair = new Set<string>();
      const parsed: PromoEntry[] = [];
      const localErrors: string[] = [];
      const chunkSize = Math.max(50, Math.ceil(raw.length / 25));
      const PARSE_FROM = 40;
      const PARSE_TO = 90;
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const itemNo = String(r[itemNoKey] ?? "").trim();
        const batchNo = String(r[batchNoKey] ?? "").trim();
        if (!itemNo || !batchNo) {
          localErrors.push(`Row ${i + 2}: missing Item No / BatchNo`);
        } else {
          // Dedupe by (Item No, BatchNo) — first occurrence wins,
          // matches the MRP tab's (ItemNo, MRP) dedupe behavior.
          const key = `${itemNo.toUpperCase()}|${batchNo.toUpperCase()}`;
          if (!seenPair.has(key)) {
            seenPair.add(key);
            const entry: PromoEntry = {};
            for (const field of PROMO_FIELDS) {
              const sourceKey = fieldKeys[field];
              if (!sourceKey) {
                entry[field] = "";
                continue;
              }
              const v = r[sourceKey];
              if (DATE_FIELDS.has(field)) {
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
          "No valid rows found. Make sure Item No and BatchNo are filled.",
          ...localErrors,
        ]);
        setLoading(false);
        return;
      }

      setProgress(92);
      setProgressLabel("Sorting entries…");
      await yieldToUI();
      // Sort by Item No, then BatchNo — so duplicates of the same
      // item group together visually.
      parsed.sort((a, b) => {
        const ai = String(a["Item No"] ?? "");
        const bi = String(b["Item No"] ?? "");
        const c = ai.localeCompare(bi, undefined, { numeric: true, sensitivity: "base" });
        if (c !== 0) return c;
        const ab = String(a["BatchNo"] ?? "");
        const bb = String(b["BatchNo"] ?? "");
        return ab.localeCompare(bb, undefined, { numeric: true, sensitivity: "base" });
      });

      setProgress(95);
      setProgressLabel("Saving…");
      await yieldToUI();
      try {
        await savePromoBatch(parsed);
      } catch {
        showStorageErrorAlert();
        setLoading(false);
        return;
      }
      setProgress(100);
      setProgressLabel("Done");
      setStatusMsg(
        `Imported ${parsed.length} promo entr${parsed.length !== 1 ? "ies" : "y"} from "${asset.name}".`
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
    if (promoEntries.length === 0) return;
    const msg = `Remove all ${promoEntries.length} promo entries? This cannot be undone.`;
    const doClear = async () => {
      try {
        await clearPromoBatch();
        setStatusMsg(null);
        setErrors([]);
        setSearch("");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        showStorageErrorAlert("Couldn't Clear");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(msg)) doClear();
    } else {
      Alert.alert("Delete All Promo Entries?", msg, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doClear },
      ]);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Promo</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import Promo</Text>
          <Text style={styles.cardSub}>
            Excel file with the promotion-master layout. Required columns:{" "}
            <Text style={styles.mono}>Item No</Text> and{" "}
            <Text style={styles.mono}>BatchNo</Text>. Each (Item No, BatchNo)
            pair is a unique row.
          </Text>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.pickBtn, loading && { opacity: 0.6 }]}
              onPress={pickAndImport}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <Feather name="upload" size={16} color={Colors.primary} />
              )}
              <Text style={styles.pickBtnText}>
                {loading
                  ? "Importing…"
                  : promoEntries.length > 0
                    ? "Re-Import"
                    : "Excel"}
              </Text>
            </TouchableOpacity>
            {promoEntries.length > 0 && (
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={handleClear}
              >
                <Feather name="trash-2" size={16} color={Colors.danger} />
                <Text style={styles.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            )}
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

        {statusMsg && (
          <View style={styles.successBox}>
            <Feather name="check-circle" size={16} color={Colors.success ?? "#16A34A"} />
            <Text style={styles.successText}>{statusMsg}</Text>
          </View>
        )}

        {promoEntries.length > 0 && (
          <>
            <View style={styles.searchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search Item No, BatchNo, Brand, Vendor…"
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
                {filtered.length} of {promoEntries.length} entr
                {promoEntries.length !== 1 ? "ies" : "y"}
              </Text>
            </View>

            <View style={styles.stickyHeaderWrap}>
              <ScrollView
                ref={headerScrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                onScroll={onHeaderScroll}
                scrollEventThrottle={16}
              >
                <View style={styles.tableHead}>
                  {PROMO_FIELDS.map((f) => {
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
            </View>

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
                      <Text style={styles.noRowsText}>
                        {search.trim().length > 0
                          ? `No items match "${search}"`
                          : "No items"}
                      </Text>
                    </View>
                  ) : (
                    filtered.map((row, i) => (
                      <View
                        key={`${row["Item No"] ?? ""}-${row["BatchNo"] ?? ""}-${i}`}
                        style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                      >
                        {PROMO_FIELDS.map((f) => {
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
          </>
        )}

        {promoEntries.length === 0 && !loading && (
          <View style={styles.emptyHint}>
            <Feather name="info" size={14} color={Colors.textMuted} />
            <Text style={styles.emptyHintText}>
              Pick an Excel file to load the Promo table.
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
  // Pill-style action buttons that match the Orders tab: compact,
  // colored background tinted toward the action's role (blue =
  // primary action, red = destructive), thin colored border, bold
  // 13pt label.
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pickBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  pickBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.dangerLight,
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  deleteBtnText: { fontSize: 13, fontWeight: "700", color: Colors.danger },
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
  stickyHeaderWrap: {
    backgroundColor: Colors.surface ?? "#fff",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: Colors.border,
    overflow: "hidden",
  },
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
