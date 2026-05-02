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
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { useApp, MrpEntry, showStorageErrorAlert } from "@/context/AppContext";

export default function MrpScreen() {
  const { mrpEntries, saveMrpBatch, clearMrpBatch } = useApp();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  // Import progress: 0-100 with a human-readable phase label. The bar is
  // rendered while `loading` is true so the user sees real activity even
  // for large files (parsing thousands of rows can take a few seconds).
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string>("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mrpEntries;
    return mrpEntries.filter((e) => e.itemNo.toLowerCase().includes(q));
  }, [mrpEntries, search]);

  // Yield control back to the event loop so React can paint a state
  // change before the next chunk of synchronous work runs. Without this
  // helper, all our setProgress() calls during a tight loop would be
  // batched and the user would see the bar jump from 0 to 100.
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
        workbook.SheetNames.find((n) => n.toLowerCase() === "mrpbatch") ?? workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      const firstRow = raw[0];
      const keyMap: Record<string, string> = {};
      for (const k of Object.keys(firstRow)) {
        keyMap[k.toLowerCase().replace(/\s+/g, "")] = k;
      }
      const itemNoKey = keyMap["itemno"];
      const mrpKey = keyMap["mrp"];
      if (!itemNoKey || !mrpKey) {
        setErrors([
          `Missing required columns. Expected "ItemNo" and "MRP". Found: ${Object.keys(firstRow).join(", ")}`,
        ]);
        setLoading(false);
        return;
      }

      // Walk the rows in chunks so we can drive the progress bar through
      // the parsing phase. Without yielding, even 10k rows finish too
      // quickly to repaint, but for very large sheets this gives the
      // user clear feedback that something is happening.
      const seenPair = new Set<string>();
      const parsed: MrpEntry[] = [];
      const localErrors: string[] = [];
      // Aim for ~25 progress updates across the parsing phase regardless
      // of file size — frequent enough to feel smooth, rare enough to
      // not dominate parse time.
      const chunkSize = Math.max(50, Math.ceil(raw.length / 25));
      const PARSE_FROM = 40;
      const PARSE_TO = 90;
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const itemNo = String(r[itemNoKey] ?? "").trim();
        const mrpStr = String(r[mrpKey] ?? "").trim();
        if (itemNo) {
          const mrp = parseFloat(mrpStr);
          if (isNaN(mrp) || mrp < 0) {
            localErrors.push(`Row ${i + 2}: invalid MRP "${mrpStr}" for ItemNo ${itemNo}`);
          } else {
            const key = `${itemNo.toUpperCase()}|${mrp}`;
            if (!seenPair.has(key)) {
              seenPair.add(key);
              parsed.push({ itemNo, mrp });
            }
          }
        }
        // Update + yield at chunk boundaries (and on the final row).
        if ((i + 1) % chunkSize === 0 || i === raw.length - 1) {
          const ratio = (i + 1) / raw.length;
          setProgress(Math.round(PARSE_FROM + (PARSE_TO - PARSE_FROM) * ratio));
          setProgressLabel(`Parsing rows ${i + 1} of ${raw.length}…`);
          await yieldToUI();
        }
      }

      if (parsed.length === 0) {
        setErrors(["No valid rows found. Make sure ItemNo and MRP are filled.", ...localErrors]);
        setLoading(false);
        return;
      }

      setProgress(92);
      setProgressLabel("Sorting entries…");
      await yieldToUI();
      parsed.sort((a, b) => a.itemNo.localeCompare(b.itemNo, undefined, { sensitivity: "base" }));

      setProgress(95);
      setProgressLabel("Saving…");
      await yieldToUI();
      try {
        await saveMrpBatch(parsed);
      } catch {
        // Storage failures (e.g. phone out of space) get the standard
        // friendly alert instead of being lumped into the parser error list,
        // which would otherwise show a raw exception like "QuotaExceededError".
        showStorageErrorAlert();
        setLoading(false);
        return;
      }
      setProgress(100);
      setProgressLabel("Done");
      setStatusMsg(`Imported ${parsed.length} MRP entr${parsed.length !== 1 ? "ies" : "y"} from "${asset.name}".`);
      if (localErrors.length > 0) setErrors(localErrors);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Switch to the Latest Purchases tab so the user immediately sees
      // the freshly-imported MRP data in context. Brief pause lets the
      // 100% bar render before we navigate away.
      setLoading(false);
      setTimeout(() => {
        router.push("/(tabs)/stock?view=purchases");
      }, 400);
      return;
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to import file"]);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    if (mrpEntries.length === 0) return;
    const msg = `Remove all ${mrpEntries.length} MRP entries? This cannot be undone.`;
    const doClear = async () => {
      try {
        await clearMrpBatch();
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
    Alert.alert("Clear MRP", msg, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => void doClear() },
    ]);
  }

  async function handleExport() {
    if (mrpEntries.length === 0) return;
    try {
      setDownloading(true);
      const data: (string | number)[][] = [
        ["ItemNo", "MRP"],
        ...mrpEntries.map((e) => [e.itemNo, e.mrp]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = [{ wch: 18 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "MRPBatch");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Sathyam Super Store - ${_ts}.xlsx`;
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
            dialogTitle: "Export MRPBatch",
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
        <Text style={styles.title}>MRP</Text>
        <View style={styles.headerActions}>
          {mrpEntries.length > 0 && (
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
          <Text style={styles.cardTitle}>Import MRPBatch</Text>
          <Text style={styles.cardSub}>
            Excel file with columns <Text style={styles.mono}>ItemNo</Text> and{" "}
            <Text style={styles.mono}>MRP</Text>. Imported data is stored independently of the Orders table.
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
                {loading ? "Importing…" : mrpEntries.length > 0 ? "Re-Import (Replace)" : "Choose Excel File"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.deleteBtn, mrpEntries.length === 0 && { opacity: 0.4 }]}
              onPress={handleClear}
              disabled={mrpEntries.length === 0}
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

        {mrpEntries.length > 0 && (
          <>
            <View style={styles.searchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search by Item No…"
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
                {filtered.length} of {mrpEntries.length} entr{mrpEntries.length !== 1 ? "ies" : "y"}
              </Text>
            </View>

            <View style={styles.tableCard}>
              <View style={styles.tableHead}>
                <Text style={[styles.th, { flex: 2 }]}>ItemNo</Text>
                <Text style={[styles.th, { flex: 1.2, textAlign: "right" }]}>MRP</Text>
              </View>
              {filtered.length === 0 ? (
                <View style={styles.noRows}>
                  <Feather name="search" size={24} color={Colors.textMuted} />
                  <Text style={styles.noRowsText}>No items match "{search}"</Text>
                </View>
              ) : (
                filtered.map((r, i) => (
                  <View
                    key={`${r.itemNo}-${i}`}
                    style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                  >
                    <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>{r.itemNo}</Text>
                    <Text style={[styles.td, { flex: 1.2, textAlign: "right", fontWeight: "600" }]}>
                      {r.mrp.toFixed(2)}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}

        {mrpEntries.length === 0 && !loading && (
          <View style={styles.emptyHint}>
            <Feather name="info" size={14} color={Colors.textMuted} />
            <Text style={styles.emptyHintText}>
              Pick an Excel file to load the MRP table.
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
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted, textTransform: "uppercase" },
  tableRow: {
    flexDirection: "row", paddingHorizontal: 12, paddingVertical: 10, alignItems: "center",
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  rowAlt: { backgroundColor: Colors.background },
  td: { fontSize: 13, color: Colors.text },
  noRows: { padding: 24, alignItems: "center", gap: 6 },
  noRowsText: { fontSize: 13, color: Colors.textMuted },
  emptyHint: {
    flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center",
    padding: 12,
  },
  emptyHintText: { fontSize: 12, color: Colors.textMuted },
});
