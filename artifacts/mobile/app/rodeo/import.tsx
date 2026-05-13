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
import {
  useApp,
  showStorageErrorAlert,
  type RodeoItem,
} from "@/context/AppContext";

// Canonical Excel column order. Header matching is whitespace- and
// case-insensitive so "BAR CODE" and "Bar Code" both map to barCode.
const ALL_COLS = [
  "Product Id",
  "SKU Id",
  "Product Name",
  "BAR CODE",
  "ITEM CODE",
  "GST",
  "MRP",
  "Purchase Price",
  "Selling Price",
  "Offer Price",
  "Offer Start Date",
  "Offer End Date",
  "Active",
] as const;

const REQUIRED_COLS = ["Product Name"] as const;

function normHeader(h: string): string {
  return h.replace(/\s+/g, " ").trim().toLowerCase();
}

// Build a lookup from normalised header -> original header so we can
// tolerate case / whitespace differences in the user's sheet.
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

function parseInteger(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseDecimal(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Strip common formatting noise: thousands separators, trailing %, ₹
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
  return (
    s === "yes" ||
    s === "y" ||
    s === "true" ||
    s === "t" ||
    s === "1" ||
    s === "active"
  );
}

// Normalise a date cell to "DD/MM/YYYY". Accepts JS Date objects (when
// the workbook is read with cellDates), Excel numeric serials,
// "DD/MM/YYYY", "DD-MM-YYYY", and ISO strings ("YYYY-MM-DD"...).
function parseDate(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";

  if (v instanceof Date && !isNaN(v.getTime())) {
    return formatDDMMYYYY(v);
  }

  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial date (days since 1899-12-30)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    return "";
  }

  const s = String(v).trim();
  if (!s) return "";

  // DD/MM/YYYY or DD-MM-YYYY (with optional time after a space)
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let [, dd, mm, yyyy] = m;
    if (yyyy.length === 2) yyyy = (Number(yyyy) >= 70 ? "19" : "20") + yyyy;
    const day = dd.padStart(2, "0");
    const mon = mm.padStart(2, "0");
    return `${day}/${mon}/${yyyy}`;
  }

  // ISO YYYY-MM-DD (and longer)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    return `${dd}/${mm}/${yyyy}`;
  }

  // Fallback to Date.parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
  return "";
}

function formatDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export default function ImportRodeoItemsScreen() {
  const { rodeoItems, saveRodeoItemsBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<RodeoItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

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
            fetch(asset.uri).then((r) => r.arrayBuffer()).then(resolve).catch(reject);
          xhr.send();
        });
        workbook = XLSX.read(new Uint8Array(arrayBuffer), {
          type: "array",
          cellDates: true,
        });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: "base64" as any,
        });
        workbook = XLSX.read(base64, { type: "base64", cellDates: true });
      }

      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      if (rows.length === 0) {
        setErrors(["File is empty or has no data rows."]);
        setLoading(false);
        return;
      }

      const headerMap = buildHeaderMap(rows[0]);
      const missing = REQUIRED_COLS.filter(
        (c) => !headerMap.has(normHeader(c)),
      );
      if (missing.length > 0) {
        setErrors([`Missing required columns: ${missing.join(", ")}`]);
        setLoading(false);
        return;
      }

      const rowErrors: string[] = [];
      const items: RodeoItem[] = [];

      rows.forEach((row, i) => {
        const productName = parseText(getCell(row, headerMap, "Product Name"));
        if (!productName) {
          rowErrors.push(`Row ${i + 2}: Product Name is required — skipped.`);
          return;
        }
        items.push({
          productId: parseInteger(getCell(row, headerMap, "Product Id")),
          skuId: parseInteger(getCell(row, headerMap, "SKU Id")),
          productName,
          barCode: parseText(getCell(row, headerMap, "BAR CODE")),
          itemCode: parseText(getCell(row, headerMap, "ITEM CODE")),
          gst: parseDecimal(getCell(row, headerMap, "GST")),
          mrp: parseDecimal(getCell(row, headerMap, "MRP")),
          purchasePrice: parseDecimal(
            getCell(row, headerMap, "Purchase Price"),
          ),
          sellingPrice: parseDecimal(getCell(row, headerMap, "Selling Price")),
          offerPrice: parseDecimal(getCell(row, headerMap, "Offer Price")),
          offerStartDate: parseDate(getCell(row, headerMap, "Offer Start Date")),
          offerEndDate: parseDate(getCell(row, headerMap, "Offer End Date")),
          active: parseBool(getCell(row, headerMap, "Active")),
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

    const existing = rodeoItems.length;
    const doImport = async () => {
      try {
        // Replace-all semantics: each import is a fresh snapshot of the
        // RodeoItems sheet, mirroring how MRP / Promo handle re-imports.
        await saveRodeoItemsBatch(parsed);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const msg = `${parsed.length} RodeoItem${parsed.length !== 1 ? "s" : ""} imported successfully.`;
        const goNext = () => router.replace("/(tabs)/rodeo-items");
        if (Platform.OS === "web") {
          window.alert(`Import Complete\n\n${msg}`);
          goNext();
        } else {
          Alert.alert("Import Complete", msg, [
            { text: "OK", onPress: goNext },
          ]);
        }
      } catch {
        showStorageErrorAlert();
      }
    };

    if (existing > 0) {
      const msg = `Importing will replace all ${existing} existing RodeoItem${existing !== 1 ? "s" : ""} with the ${parsed.length} row${parsed.length !== 1 ? "s" : ""} from this file.\n\nContinue?`;
      if (Platform.OS === "web") {
        if (window.confirm(`Replace Existing RodeoItems?\n\n${msg}`)) {
          void doImport();
        }
      } else {
        Alert.alert("Replace Existing RodeoItems?", msg, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Replace",
            style: "destructive",
            onPress: () => void doImport(),
          },
        ]);
      }
    } else {
      void doImport();
    }
  }

  return (
    <>
      <Stack.Screen
        options={{ title: "Import RodeoItems", headerBackTitle: "Back" }}
      />
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
                <Text style={styles.dropHint}>
                  Imports RodeoItems from .xlsx or .xls
                </Text>
                <View style={styles.colList}>
                  {ALL_COLS.map((c) => {
                    const required = (REQUIRED_COLS as readonly string[]).includes(c);
                    return (
                      <View
                        key={c}
                        style={[
                          styles.colChip,
                          required && styles.colChipRequired,
                        ]}
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
                  <Text
                    style={[
                      styles.summaryValue,
                      { color: Colors.warning },
                    ]}
                  >
                    {rodeoItems.length}
                  </Text>
                  <Text style={styles.summaryLabel}>Will Replace</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text
                    style={[styles.summaryValue, { color: Colors.success }]}
                  >
                    {parsed.filter((p) => p.active).length}
                  </Text>
                  <Text style={styles.summaryLabel}>Active</Text>
                </View>
              </View>

              <View style={styles.previewCard}>
                <Text style={styles.previewTitle}>
                  Preview ({parsed.length} item{parsed.length !== 1 ? "s" : ""})
                </Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.th, { flex: 1.2 }]}>Prod Id</Text>
                  <Text style={[styles.th, { flex: 3 }]}>Name</Text>
                  <Text style={[styles.th, { flex: 1.2 }]}>MRP</Text>
                  <Text style={[styles.th, { flex: 1.2 }]}>Sell</Text>
                  <Text style={styles.thStatus}>Act</Text>
                </View>
                {parsed.slice(0, 200).map((item, i) => (
                  <View
                    key={i}
                    style={[
                      styles.tableRow,
                      i % 2 === 0 && styles.tableRowAlt,
                    ]}
                  >
                    <Text style={[styles.td, { flex: 1.2 }]} numberOfLines={1}>
                      {item.productId ?? "—"}
                    </Text>
                    <Text style={[styles.td, { flex: 3 }]} numberOfLines={1}>
                      {item.productName}
                    </Text>
                    <Text style={[styles.td, { flex: 1.2 }]} numberOfLines={1}>
                      {item.mrp ?? "—"}
                    </Text>
                    <Text style={[styles.td, { flex: 1.2 }]} numberOfLines={1}>
                      {item.sellingPrice ?? "—"}
                    </Text>
                    <View
                      style={[
                        styles.statusPill,
                        item.active
                          ? styles.statusPillOk
                          : styles.statusPillWarn,
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusPillText,
                          item.active
                            ? { color: Colors.success }
                            : { color: Colors.warning },
                        ]}
                      >
                        {item.active ? "Yes" : "No"}
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
          <View
            style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}
          >
            <TouchableOpacity style={styles.importBtn} onPress={handleImport}>
              <Feather name="download" size={18} color={Colors.textInverse} />
              <Text style={styles.importBtnText}>
                Import {parsed.length} RodeoItem
                {parsed.length !== 1 ? "s" : ""}
              </Text>
            </TouchableOpacity>
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
  colChipText: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
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
  summaryDivider: {
    width: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 8,
  },
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
  thStatus: {
    width: 44,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
  },
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
});
