import React, { useState } from "react";
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
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as XLSX from "xlsx-js-style";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, type DailyStockItem } from "@/context/AppContext";

// Excel columns that map to DailyStockItem fields.
const ALL_COLS = [
  "CategoryCode",
  "SubCategoryCode",
  "VendorCode",
  "BrandCode",
  "InventoryCode",
  "Weight",
  "Desc",
  "Stock",
  "AutoPOAllowed",
  "LAPVendorC",
  "LAPVendorN",
  "Physical Stock",
] as const;

// Only Desc is required — every other column may be blank.
const REQUIRED_COLS = ["Desc"] as const;

function normHeader(h: string): string {
  return h.replace(/\s+/g, " ").trim().toLowerCase();
}

function buildHeaderMap(row: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const k of Object.keys(row)) {
    map.set(normHeader(k), k);
  }
  return map;
}

function getCell(
  row: Record<string, unknown>,
  headerMap: Map<string, string>,
  col: string,
): unknown {
  const original = headerMap.get(normHeader(col));
  if (original === undefined) return undefined;
  return row[original];
}

function parseDecimal(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).replace(/[,₹\s%]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function parseBool(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "t" || s === "1";
}

export default function ImportDailyStockScreen() {
  const { dailyStockItems, saveDailyStockBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<DailyStockItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saveDone, setSaveDone] = useState(0);
  const [saveTotal, setSaveTotal] = useState(0);

  async function pickAndParse() {
    try {
      setLoading(true);
      setErrors([]);
      setParsed([]);
      setFileName(null);

      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel",
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
        workbook = XLSX.read(new Uint8Array(arrayBuffer), {
          type: "array",
          cellDates: true,
          // Reduce heap usage on large files — we don't need formatted
          // text or number-format strings for any DailyStock column.
          cellText: false,
          cellNF: false,
        });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: "base64" as any,
        });
        workbook = XLSX.read(base64, {
          type: "base64",
          cellDates: true,
          cellText: false,
          cellNF: false,
        });
      }

      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        setErrors(["Workbook has no sheets."]);
        setLoading(false);
        return;
      }
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      if (rows.length === 0) {
        setErrors(["File is empty or has no data rows."]);
        setLoading(false);
        return;
      }

      const headerMap = buildHeaderMap(rows[0]);
      const missing = REQUIRED_COLS.filter((c) => !headerMap.has(normHeader(c)));
      if (missing.length > 0) {
        setErrors([`Missing required columns: ${missing.join(", ")}`]);
        setLoading(false);
        return;
      }

      const rowErrors: string[] = [];
      const items: DailyStockItem[] = [];

      rows.forEach((row, i) => {
        const desc = parseText(getCell(row, headerMap, "Desc"));
        if (!desc) {
          rowErrors.push(`Row ${i + 2}: Desc is required — skipped.`);
          return;
        }
        items.push({
          categoryCode: parseText(getCell(row, headerMap, "CategoryCode")),
          subCategoryCode: parseText(getCell(row, headerMap, "SubCategoryCode")),
          vendorCode: parseText(getCell(row, headerMap, "VendorCode")),
          brandCode: parseText(getCell(row, headerMap, "BrandCode")),
          inventoryCode: parseText(getCell(row, headerMap, "InventoryCode")),
          weight: parseDecimal(getCell(row, headerMap, "Weight")),
          desc,
          stock: parseDecimal(getCell(row, headerMap, "Stock")),
          autoPOAllowed: parseBool(getCell(row, headerMap, "AutoPOAllowed")),
          lapVendorC: parseText(getCell(row, headerMap, "LAPVendorC")),
          lapVendorN: parseText(getCell(row, headerMap, "LAPVendorN")),
          physicalStock: parseDecimal(getCell(row, headerMap, "Physical Stock")),
        });
      });

      if (items.length === 0 && rowErrors.length > 0) {
        setErrors(rowErrors);
        setLoading(false);
        return;
      }
      if (rowErrors.length > 0) setErrors(rowErrors);
      setParsed(items);
    } catch (e: any) {
      setErrors([`Failed to parse file: ${e?.message ?? String(e)}`]);
    } finally {
      setLoading(false);
    }
  }

  function handleImport() {
    if (parsed.length === 0) return;

    const existing = dailyStockItems.length;
    const doImport = async () => {
      try {
        const expectedBatches =
          Platform.OS === "web" ? Math.max(1, Math.ceil(parsed.length / 200)) : 1;
        setSaveDone(0);
        setSaveTotal(expectedBatches);
        await saveDailyStockBatch(parsed, (done, total) => {
          setSaveDone(done);
          setSaveTotal(total);
        });
        setSaveDone(0);
        setSaveTotal(0);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const msg = `${parsed.length} DailyStock row${parsed.length !== 1 ? "s" : ""} imported successfully.`;
        const goNext = () => router.replace("/(tabs)");
        if (Platform.OS === "web") {
          window.alert(`Import Complete\n\n${msg}`);
          goNext();
        } else {
          Alert.alert("Import Complete", msg, [{ text: "OK", onPress: goNext }]);
        }
      } catch (e: any) {
        setSaveDone(0);
        setSaveTotal(0);
        const detail = e?.message ?? String(e);
        const title = "Couldn't Save DailyStock";
        const body = `Import failed after parsing ${parsed.length.toLocaleString()} row${parsed.length === 1 ? "" : "s"}.\n\n${detail}\n\nIf your phone is low on storage, free a few hundred MB and try again.`;
        if (Platform.OS === "web") {
          window.alert(`${title}\n\n${body}`);
        } else {
          Alert.alert(title, body);
        }
      }
    };

    if (existing > 0) {
      const msg = `Importing will replace all ${existing} existing DailyStock row${existing !== 1 ? "s" : ""} with the ${parsed.length} row${parsed.length !== 1 ? "s" : ""} from this file.\n\nContinue?`;
      if (Platform.OS === "web") {
        if (window.confirm(`Replace Existing DailyStock?\n\n${msg}`)) void doImport();
      } else {
        Alert.alert("Replace Existing DailyStock?", msg, [
          { text: "Cancel", style: "cancel" },
          { text: "Replace", style: "destructive", onPress: () => void doImport() },
        ]);
      }
    } else {
      void doImport();
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: "Import DailyStock", headerBackTitle: "Back" }} />
      <View
        style={[
          styles.container,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) },
        ]}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={[styles.dropZone, !!fileName && styles.dropZoneSuccess]}
            onPress={pickAndParse}
            activeOpacity={0.7}
          >
            {loading ? (
              <ActivityIndicator color={Colors.primary} size="large" />
            ) : fileName ? (
              <>
                <View style={styles.fileIconWrap}>
                  <Feather name="file-text" size={28} color={Colors.accent} />
                </View>
                <Text style={styles.fileName}>{fileName}</Text>
                <Text style={styles.fileHint}>Tap to pick a different file</Text>
              </>
            ) : (
              <>
                <View style={styles.fileIconWrap}>
                  <Feather name="upload" size={28} color={Colors.primary} />
                </View>
                <Text style={styles.dropTitle}>Tap to select Excel file</Text>
                <Text style={styles.dropHint}>Imports DailyStock from .xlsx or .xls</Text>
                <View style={styles.colList}>
                  {ALL_COLS.map((c) => {
                    const required = (REQUIRED_COLS as readonly string[]).includes(c);
                    return (
                      <View
                        key={c}
                        style={[styles.colChip, required && styles.colChipRequired]}
                      >
                        <Text
                          style={[
                            styles.colChipText,
                            required && styles.colChipTextRequired,
                          ]}
                        >
                          {c}
                        </Text>
                        {required && <Text style={styles.reqStar}>*</Text>}
                      </View>
                    );
                  })}
                </View>
                <Text style={styles.reqNote}>* Required column</Text>
              </>
            )}
          </TouchableOpacity>

          {errors.length > 0 && (
            <View style={styles.errorCard}>
              <Feather name="alert-circle" size={16} color={Colors.danger} />
              <View style={{ flex: 1 }}>
                {errors.map((e, i) => (
                  <Text key={i} style={styles.errorText}>
                    {e}
                  </Text>
                ))}
              </View>
            </View>
          )}

          {parsed.length > 0 && (
            <>
              <View style={styles.summaryRow}>
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{parsed.length}</Text>
                  <Text style={styles.summaryLabel}>New Rows</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryValue, { color: Colors.warning }]}>
                    {dailyStockItems.length}
                  </Text>
                  <Text style={styles.summaryLabel}>Will Replace</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryValue, { color: Colors.success }]}>
                    {parsed.filter((p) => p.autoPOAllowed).length}
                  </Text>
                  <Text style={styles.summaryLabel}>AutoPO</Text>
                </View>
              </View>

              <View style={styles.previewCard}>
                <Text style={styles.previewTitle}>
                  Preview ({parsed.length} row{parsed.length !== 1 ? "s" : ""})
                </Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.th, { width: 90 }]}>InvCode</Text>
                  <Text style={[styles.th, { flex: 1 }]}>Desc</Text>
                  <Text style={[styles.th, { width: 60 }]}>Stock</Text>
                  <Text style={[styles.th, { width: 52 }]}>AutoPO</Text>
                </View>
                {parsed.slice(0, 200).map((item, i) => (
                  <View
                    key={i}
                    style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}
                  >
                    <Text style={[styles.td, { width: 90 }]} numberOfLines={1}>
                      {item.inventoryCode || "—"}
                    </Text>
                    <Text style={[styles.td, { flex: 1 }]} numberOfLines={1}>
                      {item.desc}
                    </Text>
                    <Text style={[styles.td, { width: 60 }]} numberOfLines={1}>
                      {item.stock ?? "—"}
                    </Text>
                    <View
                      style={[
                        styles.statusPill,
                        item.autoPOAllowed ? styles.statusPillOk : styles.statusPillWarn,
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusPillText,
                          item.autoPOAllowed
                            ? { color: Colors.success }
                            : { color: Colors.warning },
                        ]}
                      >
                        {item.autoPOAllowed ? "Yes" : "No"}
                      </Text>
                    </View>
                  </View>
                ))}
                {parsed.length > 200 && (
                  <Text style={styles.previewMore}>
                    + {parsed.length - 200} more row
                    {parsed.length - 200 !== 1 ? "s" : ""} (preview limited)
                  </Text>
                )}
              </View>
            </>
          )}
        </ScrollView>

        {parsed.length > 0 && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
            {saveTotal > 0 ? (
              <View style={styles.progressWrap}>
                <View style={styles.progressHeader}>
                  <ActivityIndicator color={Colors.primary} size="small" />
                  <Text style={styles.progressLabel}>
                    Saving{" "}
                    {Math.min(
                      Math.round((saveDone / Math.max(1, saveTotal)) * parsed.length),
                      parsed.length,
                    ).toLocaleString()}{" "}
                    of {parsed.length.toLocaleString()} rows…
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.round(
                          (saveDone / Math.max(1, saveTotal)) * 100,
                        )}%`,
                      },
                    ]}
                  />
                </View>
                <Text style={styles.progressHint}>
                  Batch {saveDone} of {saveTotal} · please keep the app open
                </Text>
              </View>
            ) : (
              <TouchableOpacity style={styles.importBtn} onPress={handleImport}>
                <Feather name="download" size={18} color={Colors.textInverse} />
                <Text style={styles.importBtnText}>
                  Import {parsed.length} row{parsed.length !== 1 ? "s" : ""}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, gap: 16, paddingBottom: 24 },
  dropZone: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: Colors.border,
    borderStyle: "dashed",
    padding: 28,
    alignItems: "center",
    gap: 8,
  },
  dropZoneSuccess: { borderColor: Colors.accent, borderStyle: "solid" },
  fileIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: Colors.primaryMuted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  dropTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  dropHint: { fontSize: 13, color: Colors.textMuted },
  fileName: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
  },
  fileHint: { fontSize: 12, color: Colors.textMuted },
  colList: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
    marginTop: 8,
  },
  colChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: Colors.surfaceSecondary,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  colChipRequired: { backgroundColor: Colors.primaryMuted },
  colChipText: { fontSize: 11, fontWeight: "600", color: Colors.textSecondary },
  colChipTextRequired: { color: Colors.primary },
  reqStar: { fontSize: 12, color: Colors.danger, fontWeight: "700" },
  reqNote: { fontSize: 11, color: Colors.textMuted, marginTop: 4 },
  errorCard: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: Colors.dangerLight,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  errorText: { fontSize: 13, color: Colors.danger, lineHeight: 20 },
  summaryRow: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  summaryItem: { flex: 1, alignItems: "center" },
  summaryValue: {
    fontSize: 20,
    fontWeight: "800",
    color: Colors.text,
    marginBottom: 2,
  },
  summaryLabel: { fontSize: 11, color: Colors.textMuted, fontWeight: "500" },
  summaryDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 8 },
  previewCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  previewTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  previewMore: {
    fontSize: 11,
    color: Colors.textMuted,
    fontStyle: "italic",
    textAlign: "center",
    padding: 10,
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tableRowAlt: { backgroundColor: Colors.background },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  td: { fontSize: 12, color: Colors.text },
  statusPill: {
    width: 44,
    paddingVertical: 3,
    borderRadius: 20,
    alignItems: "center",
  },
  statusPillOk: { backgroundColor: Colors.successLight },
  statusPillWarn: { backgroundColor: Colors.warningLight },
  statusPillText: { fontSize: 10, fontWeight: "700" },
  footer: {
    padding: 16,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  importBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  importBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
  progressWrap: { gap: 8 },
  progressHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  progressLabel: { flex: 1, fontSize: 14, fontWeight: "700", color: Colors.text },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: Colors.surfaceSecondary,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: Colors.primary,
    borderRadius: 999,
  },
  progressHint: { fontSize: 12, color: Colors.textMuted, textAlign: "center" },
});
