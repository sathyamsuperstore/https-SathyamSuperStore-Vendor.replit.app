import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
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
import { useApp } from "@/context/AppContext";

interface MrpRow {
  itemNo: string;
  mrp: number;
  matched: boolean;
  oldMrp?: number;
}

export default function MrpScreen() {
  const { orders, applyMrpUpdates } = useApp();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<MrpRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [appliedSummary, setAppliedSummary] = useState<string | null>(null);

  const matchedItemNoSet = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) {
      for (const it of o.items) {
        if (it.name.includes(" - ")) {
          set.add(it.name.split(" - ")[0].trim().toUpperCase());
        }
      }
    }
    return set;
  }, [orders]);

  const itemNoToOldMrp = useMemo(() => {
    const map: Record<string, number> = {};
    for (const o of orders) {
      for (const it of o.items) {
        if (it.name.includes(" - ")) {
          const k = it.name.split(" - ")[0].trim().toUpperCase();
          if (map[k] == null) map[k] = it.unitPrice;
        }
      }
    }
    return map;
  }, [orders]);

  const matchedCount = rows.filter((r) => r.matched).length;
  const unmatchedCount = rows.length - matchedCount;
  const changedCount = rows.filter(
    (r) => r.matched && r.oldMrp != null && r.oldMrp !== r.mrp
  ).length;

  async function pickAndParse() {
    try {
      setLoading(true);
      setErrors([]);
      setRows([]);
      setFileName(null);
      setAppliedSummary(null);

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
      setFileName(asset.name);

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

      // Prefer "MRPBatch" sheet if present, else first sheet
      let sheetName = workbook.SheetNames.find((n) => n.toLowerCase() === "mrpbatch") ?? workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      // Tolerant column name matching (case-insensitive, trim)
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

      const seen = new Set<string>();
      const parsed: MrpRow[] = [];
      const localErrors: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const itemNo = String(r[itemNoKey] ?? "").trim();
        const mrpStr = String(r[mrpKey] ?? "").trim();
        if (!itemNo) continue;
        const mrp = parseFloat(mrpStr);
        if (isNaN(mrp) || mrp < 0) {
          localErrors.push(`Row ${i + 2}: invalid MRP "${mrpStr}" for ItemNo ${itemNo}`);
          continue;
        }
        const upper = itemNo.toUpperCase();
        if (seen.has(upper)) continue;
        seen.add(upper);
        const matched = matchedItemNoSet.has(upper);
        parsed.push({
          itemNo,
          mrp,
          matched,
          oldMrp: matched ? itemNoToOldMrp[upper] : undefined,
        });
      }

      if (parsed.length === 0) {
        setErrors(["No valid rows found. Make sure ItemNo and MRP are filled.", ...localErrors]);
        setLoading(false);
        return;
      }

      // Sort: matched-with-changes first, then matched-no-change, then unmatched
      parsed.sort((a, b) => {
        const aRank = a.matched ? (a.oldMrp !== a.mrp ? 0 : 1) : 2;
        const bRank = b.matched ? (b.oldMrp !== b.mrp ? 0 : 1) : 2;
        if (aRank !== bRank) return aRank - bRank;
        return a.itemNo.localeCompare(b.itemNo);
      });

      setRows(parsed);
      if (localErrors.length > 0) setErrors(localErrors);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to parse file"]);
    } finally {
      setLoading(false);
    }
  }

  function handleApply() {
    if (rows.length === 0) return;
    if (changedCount === 0) {
      const msg = "No matching items in Orders need an MRP change.";
      if (Platform.OS === "web") window.alert(msg);
      else Alert.alert("Nothing to Update", msg);
      return;
    }
    const confirmMsg = `Update MRP for ${changedCount} item${changedCount !== 1 ? "s" : ""} across orders. This will recalculate order totals. Continue?`;
    const doApply = () => {
      try {
        setApplying(true);
        const map: Record<string, number> = {};
        for (const r of rows) map[r.itemNo] = r.mrp;
        const res = applyMrpUpdates(map);
        const summary = `Updated ${res.itemsUpdated} item${res.itemsUpdated !== 1 ? "s" : ""} across ${res.ordersUpdated} order${res.ordersUpdated !== 1 ? "s" : ""}.`;
        setAppliedSummary(summary);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        Alert.alert("Update Failed", e?.message ?? "Unknown error");
      } finally {
        setApplying(false);
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(confirmMsg)) doApply();
      return;
    }
    Alert.alert("Apply MRP Updates", confirmMsg, [
      { text: "Cancel", style: "cancel" },
      { text: "Apply", onPress: doApply },
    ]);
  }

  function handleClear() {
    setRows([]);
    setFileName(null);
    setErrors([]);
    setAppliedSummary(null);
  }

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>MRP</Text>
        {rows.length > 0 && (
          <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
            <Feather name="x" size={16} color={Colors.danger} />
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        )}
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
            <Text style={styles.mono}>MRP</Text>. Each ItemNo is matched to items in your Orders by item number; matching items get the new MRP and order totals are recalculated.
          </Text>

          <TouchableOpacity
            style={[styles.pickBtn, loading && { opacity: 0.6 }]}
            onPress={pickAndParse}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color={Colors.textInverse} />
            ) : (
              <Feather name="upload" size={18} color={Colors.textInverse} />
            )}
            <Text style={styles.pickBtnText}>{loading ? "Reading file..." : "Choose Excel File"}</Text>
          </TouchableOpacity>

          {fileName && (
            <View style={styles.fileRow}>
              <Feather name="file" size={14} color={Colors.textMuted} />
              <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
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

        {appliedSummary && (
          <View style={styles.successBox}>
            <Feather name="check-circle" size={16} color={Colors.success ?? "#16A34A"} />
            <Text style={styles.successText}>{appliedSummary}</Text>
          </View>
        )}

        {rows.length > 0 && (
          <>
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statNum}>{rows.length}</Text>
                <Text style={styles.statLabel}>Rows</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNum, { color: Colors.success ?? "#16A34A" }]}>{matchedCount}</Text>
                <Text style={styles.statLabel}>Matched</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNum, { color: Colors.danger }]}>{unmatchedCount}</Text>
                <Text style={styles.statLabel}>Unmatched</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNum, { color: Colors.primary }]}>{changedCount}</Text>
                <Text style={styles.statLabel}>To Update</Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.applyBtn, (applying || changedCount === 0) && { opacity: 0.5 }]}
              onPress={handleApply}
              disabled={applying || changedCount === 0}
            >
              {applying ? (
                <ActivityIndicator size="small" color={Colors.textInverse} />
              ) : (
                <Feather name="check" size={18} color={Colors.textInverse} />
              )}
              <Text style={styles.applyBtnText}>
                {applying ? "Applying..." : changedCount === 0 ? "No Changes to Apply" : `Apply ${changedCount} MRP Update${changedCount !== 1 ? "s" : ""}`}
              </Text>
            </TouchableOpacity>

            <View style={styles.tableCard}>
              <View style={styles.tableHead}>
                <Text style={[styles.th, { flex: 2 }]}>ItemNo</Text>
                <Text style={[styles.th, { flex: 1.2, textAlign: "right" }]}>Old MRP</Text>
                <Text style={[styles.th, { flex: 1.2, textAlign: "right" }]}>New MRP</Text>
                <Text style={[styles.th, { width: 70, textAlign: "center" }]}>Status</Text>
              </View>
              {rows.map((r, i) => {
                const changed = r.matched && r.oldMrp != null && r.oldMrp !== r.mrp;
                return (
                  <View
                    key={`${r.itemNo}-${i}`}
                    style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                  >
                    <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>{r.itemNo}</Text>
                    <Text style={[styles.td, { flex: 1.2, textAlign: "right" }]}>
                      {r.matched && r.oldMrp != null ? r.oldMrp.toFixed(2) : "—"}
                    </Text>
                    <Text style={[styles.td, { flex: 1.2, textAlign: "right", fontWeight: changed ? "700" : "400", color: changed ? Colors.primary : Colors.text }]}>
                      {r.mrp.toFixed(2)}
                    </Text>
                    <View style={{ width: 70, alignItems: "center" }}>
                      {!r.matched ? (
                        <Text style={[styles.badge, { backgroundColor: "#fef2f2", color: Colors.danger }]}>No match</Text>
                      ) : changed ? (
                        <Text style={[styles.badge, { backgroundColor: "#eff6ff", color: Colors.primary }]}>Update</Text>
                      ) : (
                        <Text style={[styles.badge, { backgroundColor: "#f1f5f9", color: Colors.textMuted }]}>Same</Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {rows.length === 0 && !loading && (
          <View style={styles.emptyHint}>
            <Feather name="info" size={14} color={Colors.textMuted} />
            <Text style={styles.emptyHintText}>
              Pick an Excel file to preview MRP changes before applying.
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
  clearBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca",
  },
  clearBtnText: { color: Colors.danger, fontWeight: "700", fontSize: 13 },
  body: { padding: 16, gap: 14 },
  card: {
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 12, padding: 16, gap: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  cardSub: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  mono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontWeight: "600", color: Colors.text },
  pickBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.primary, paddingVertical: 12, borderRadius: 10,
  },
  pickBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 15 },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  fileName: { flex: 1, fontSize: 13, color: Colors.textSecondary },
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
  statsRow: { flexDirection: "row", gap: 8 },
  statBox: {
    flex: 1, backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 10, padding: 12, alignItems: "center",
    borderWidth: 1, borderColor: Colors.border,
  },
  statNum: { fontSize: 20, fontWeight: "800", color: Colors.text },
  statLabel: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  applyBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.success ?? "#16A34A", paddingVertical: 14, borderRadius: 10,
  },
  applyBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 15 },
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
  badge: {
    fontSize: 10, fontWeight: "700",
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: "hidden",
  },
  emptyHint: {
    flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center",
    padding: 12,
  },
  emptyHintText: { fontSize: 12, color: Colors.textMuted },
});
