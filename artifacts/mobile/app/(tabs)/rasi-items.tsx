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
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, RasiItem, showStorageErrorAlert } from "@/context/AppContext";

// Excel column spec — single source of truth for header matching, in-app
// table column order, and the exporter. Header lookup is case- and
// whitespace-insensitive (see normalize() below).
type ColType = "text" | "decimal";
const COLUMNS: {
  key: keyof RasiItem;
  header: string;     // canonical Excel header
  aliases: string[];  // alternate header spellings, normalized
  type: ColType;
  width: number;      // px — used by the table view + xlsx column widths
}[] = [
  { key: "code",      header: "code",      aliases: ["code"],                   type: "text",    width: 90 },
  { key: "item",      header: "item",      aliases: ["item", "itemname", "description"], type: "text", width: 220 },
  { key: "igroup",    header: "igroup",    aliases: ["igroup", "group"],        type: "text",    width: 120 },
  { key: "unit",      header: "unit",      aliases: ["unit", "uom"],            type: "text",    width: 70 },
  { key: "godown",    header: "godown",    aliases: ["godown"],                 type: "text",    width: 110 },
  { key: "mrp",       header: "mrp",       aliases: ["mrp"],                    type: "decimal", width: 80 },
  { key: "wrate",     header: "wrate",     aliases: ["wrate", "wholesalerate"], type: "decimal", width: 80 },
  { key: "srate",     header: "srate",     aliases: ["srate", "sellingrate"],   type: "decimal", width: 80 },
  { key: "brand",     header: "Brand",     aliases: ["brand"],                  type: "text",    width: 120 },
  { key: "unitsPer",  header: "UNITSPER",  aliases: ["unitsper", "unitper"],    type: "decimal", width: 90 },
  { key: "mulFactor", header: "MULFACTOR", aliases: ["mulfactor", "multiplier"], type: "decimal", width: 100 },
];

const REQUIRED_KEYS: (keyof RasiItem)[] = ["code", "item"];

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

export default function RasiItemsScreen() {
  const { rasiItems, saveRasiItems, clearRasiItems } = useApp();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string>("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rasiItems;
    return rasiItems.filter(
      (e) =>
        e.code.toLowerCase().includes(q) ||
        e.item.toLowerCase().includes(q) ||
        e.brand.toLowerCase().includes(q),
    );
  }, [rasiItems, search]);

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
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
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
        workbook = XLSX.read(base64, { type: "base64" });
      }

      setProgress(40);
      setProgressLabel("Extracting rows…");
      await yieldToUI();

      const sheetName =
        workbook.SheetNames.find((n) => normalize(n) === "rasiitems") ?? workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      // Build a map of normalized header -> original header so we can look
      // up each spec column regardless of how it's spelled in the sheet.
      const firstRow = raw[0];
      const keyMap: Record<string, string> = {};
      for (const k of Object.keys(firstRow)) {
        keyMap[normalize(k)] = k;
      }

      // Resolve each spec column to whichever original header matched
      // first (canonical or alias). Track which required ones are missing.
      const resolvedHeader: Partial<Record<keyof RasiItem, string>> = {};
      const missing: string[] = [];
      for (const c of COLUMNS) {
        const tryKeys = [normalize(c.header), ...c.aliases.map(normalize)];
        const hit = tryKeys.find((k) => keyMap[k] !== undefined);
        if (hit) {
          resolvedHeader[c.key] = keyMap[hit];
        } else if (REQUIRED_KEYS.includes(c.key)) {
          missing.push(c.header);
        }
      }
      if (missing.length > 0) {
        setErrors([
          `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(
            ", ",
          )}. Found: ${Object.keys(firstRow).join(", ")}`,
        ]);
        setLoading(false);
        return;
      }

      const seenCodes = new Set<string>();
      const parsed: RasiItem[] = [];
      const localErrors: string[] = [];
      const chunkSize = Math.max(50, Math.ceil(raw.length / 25));
      const PARSE_FROM = 40;
      const PARSE_TO = 90;

      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const code = String(r[resolvedHeader.code!] ?? "").trim();
        const item = String(r[resolvedHeader.item!] ?? "").trim();
        if (!code) continue;
        if (!item) {
          localErrors.push(`Row ${i + 2}: blank item description for code ${code}`);
        }
        if (seenCodes.has(code.toUpperCase())) {
          // First-write-wins — keep the original row, skip duplicates.
          continue;
        }
        seenCodes.add(code.toUpperCase());

        const numAt = (key: keyof RasiItem): number => {
          const h = resolvedHeader[key];
          if (!h) return 0;
          const v = String(r[h] ?? "").trim();
          if (v === "") return 0;
          const n = parseFloat(v);
          if (isNaN(n)) {
            localErrors.push(`Row ${i + 2}: invalid ${String(key)} "${v}" for code ${code}`);
            return 0;
          }
          return n;
        };
        const textAt = (key: keyof RasiItem): string => {
          const h = resolvedHeader[key];
          if (!h) return "";
          return String(r[h] ?? "").trim();
        };

        parsed.push({
          code,
          item,
          igroup: textAt("igroup"),
          unit: textAt("unit"),
          godown: textAt("godown"),
          mrp: numAt("mrp"),
          wrate: numAt("wrate"),
          srate: numAt("srate"),
          brand: textAt("brand"),
          unitsPer: numAt("unitsPer"),
          mulFactor: numAt("mulFactor"),
        });

        if ((i + 1) % chunkSize === 0 || i === raw.length - 1) {
          const ratio = (i + 1) / raw.length;
          setProgress(Math.round(PARSE_FROM + (PARSE_TO - PARSE_FROM) * ratio));
          setProgressLabel(`Parsing rows ${i + 1} of ${raw.length}…`);
          await yieldToUI();
        }
      }

      if (parsed.length === 0) {
        setErrors(["No valid rows found. Make sure code and item are filled.", ...localErrors]);
        setLoading(false);
        return;
      }

      setProgress(92);
      setProgressLabel("Sorting entries…");
      await yieldToUI();
      parsed.sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: "base", numeric: true }));

      setProgress(95);
      setProgressLabel("Saving…");
      await yieldToUI();
      try {
        await saveRasiItems(parsed);
      } catch {
        showStorageErrorAlert();
        setLoading(false);
        return;
      }
      setProgress(100);
      setProgressLabel("Done");
      setStatusMsg(
        `Imported ${parsed.length} Rasi item${parsed.length !== 1 ? "s" : ""} from "${asset.name}".`,
      );
      if (localErrors.length > 0) setErrors(localErrors);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLoading(false);
      return;
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to import file"]);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    if (rasiItems.length === 0) return;
    const msg = `Remove all ${rasiItems.length} Rasi item rows? This cannot be undone.`;
    const doClear = async () => {
      try {
        await clearRasiItems();
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
    Alert.alert("Clear Rasi Items", msg, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => void doClear() },
    ]);
  }

  async function handleExport() {
    if (rasiItems.length === 0) return;
    try {
      setDownloading(true);
      const header = COLUMNS.map((c) => c.header);
      const data: (string | number)[][] = [
        header,
        ...rasiItems.map((r) =>
          COLUMNS.map((c) => {
            const v = r[c.key];
            return c.type === "decimal" ? Number(v ?? 0) : String(v ?? "");
          }),
        ),
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = COLUMNS.map((c) => ({ wch: Math.max(8, Math.round(c.width / 7)) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "RasiItems");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Rasi Items - ${_ts}.xlsx`;
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
            dialogTitle: "Export Rasi Items",
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
  const tableWidth = COLUMNS.reduce((s, c) => s + c.width, 0);

  function renderCell(r: RasiItem, c: (typeof COLUMNS)[number]) {
    const v = r[c.key];
    const text = c.type === "decimal" ? Number(v ?? 0).toFixed(2) : String(v ?? "");
    return (
      <Text
        key={c.key}
        style={[
          styles.td,
          { width: c.width },
          c.type === "decimal" && { textAlign: "right", fontWeight: "600" },
        ]}
        numberOfLines={1}
      >
        {text}
      </Text>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Rasi Items</Text>
        <View style={styles.headerActions}>
          {rasiItems.length > 0 && (
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

      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import Rasi Items</Text>
          <Text style={styles.cardSub}>
            Excel file with columns{" "}
            {COLUMNS.map((c, i) => (
              <Text key={c.key}>
                <Text style={styles.mono}>{c.header}</Text>
                {i < COLUMNS.length - 1 ? ", " : ""}
              </Text>
            ))}
            . Header matching is case- and whitespace-insensitive. Only{" "}
            <Text style={styles.mono}>code</Text> and{" "}
            <Text style={styles.mono}>item</Text> are required.
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
                {loading ? "Importing…" : rasiItems.length > 0 ? "Re-Import (Replace)" : "Choose Excel File"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.deleteBtn, rasiItems.length === 0 && { opacity: 0.4 }]}
              onPress={handleClear}
              disabled={rasiItems.length === 0}
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

        {errors.length > 0 && (
          <View style={styles.errorBox}>
            <Feather name="alert-triangle" size={16} color={Colors.danger} />
            <View style={{ flex: 1 }}>
              {errors.map((e, i) => (
                <Text key={i} style={styles.errorText}>{e}</Text>
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

        {rasiItems.length > 0 && (
          <>
            <View style={styles.searchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search by code, item or brand…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {search.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity onPress={() => setSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.statsRow}>
              <Text style={styles.statText}>
                {filtered.length} of {rasiItems.length} item{rasiItems.length !== 1 ? "s" : ""}
              </Text>
            </View>

            <View style={styles.tableCard}>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View style={{ width: tableWidth }}>
                  <View style={styles.tableHead}>
                    {COLUMNS.map((c) => (
                      <Text
                        key={c.key}
                        style={[
                          styles.th,
                          { width: c.width },
                          c.type === "decimal" && { textAlign: "right" },
                        ]}
                        numberOfLines={1}
                      >
                        {c.header}
                      </Text>
                    ))}
                  </View>
                  {filtered.length === 0 ? (
                    <View style={styles.noRows}>
                      <Feather name="search" size={24} color={Colors.textMuted} />
                      <Text style={styles.noRowsText}>No items match "{search}"</Text>
                    </View>
                  ) : (
                    filtered.map((r, i) => (
                      <View
                        key={`${r.code}-${i}`}
                        style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                      >
                        {COLUMNS.map((c) => renderCell(r, c))}
                      </View>
                    ))
                  )}
                </View>
              </ScrollView>
            </View>
          </>
        )}

        {rasiItems.length === 0 && !loading && (
          <View style={styles.emptyHint}>
            <Feather name="info" size={14} color={Colors.textMuted} />
            <Text style={styles.emptyHintText}>
              Pick an Excel file to load the Rasi Items table.
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
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  exportBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: Colors.primaryLight ?? "#E0EAFF",
    borderWidth: 1, borderColor: Colors.primary + "40",
  },
  exportBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  clearBtn: {
    width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca",
  },
  body: { padding: 16, gap: 14 },
  card: {
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 12, padding: 16, gap: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  cardSub: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  mono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontWeight: "600", color: Colors.text },
  actionRow: { flexDirection: "row", gap: 8 },
  pickBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.primary, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10,
  },
  pickBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 15 },
  deleteBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: Colors.danger, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10,
  },
  deleteBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 14 },
  progressWrap: { gap: 6 },
  progressLabelRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  progressLabelText: {
    fontSize: 12, fontWeight: "600", color: Colors.textSecondary, flex: 1, marginRight: 8,
  },
  progressPercentText: {
    fontSize: 12, fontWeight: "800", color: Colors.primary, fontVariant: ["tabular-nums"],
  },
  progressTrack: { height: 8, backgroundColor: Colors.border, borderRadius: 999, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: Colors.primary, borderRadius: 999 },
  errorBox: {
    flexDirection: "row", gap: 10, padding: 12,
    backgroundColor: "#fef2f2", borderRadius: 10,
    borderWidth: 1, borderColor: "#fecaca",
  },
  errorText: { color: Colors.danger, fontSize: 13, lineHeight: 18 },
  successBox: {
    flexDirection: "row", gap: 10, padding: 12, alignItems: "center",
    backgroundColor: "#f0fdf4", borderRadius: 10,
    borderWidth: 1, borderColor: "#bbf7d0",
  },
  successText: { color: Colors.success ?? "#16A34A", fontWeight: "600", fontSize: 13, flex: 1 },
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text, padding: 0 },
  statsRow: { paddingHorizontal: 4 },
  statText: { fontSize: 12, color: Colors.textMuted },
  tableCard: {
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 12, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.border,
  },
  tableHead: {
    flexDirection: "row", paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: Colors.background, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  th: {
    fontSize: 11, fontWeight: "700", color: Colors.textMuted,
    textTransform: "uppercase", paddingRight: 8,
  },
  tableRow: {
    flexDirection: "row", paddingHorizontal: 12, paddingVertical: 10, alignItems: "center",
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  rowAlt: { backgroundColor: Colors.background },
  td: { fontSize: 13, color: Colors.text, paddingRight: 8 },
  noRows: { padding: 24, alignItems: "center", gap: 6 },
  noRowsText: { fontSize: 13, color: Colors.textMuted },
  emptyHint: {
    flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", padding: 12,
  },
  emptyHintText: { fontSize: 12, color: Colors.textMuted },
});
