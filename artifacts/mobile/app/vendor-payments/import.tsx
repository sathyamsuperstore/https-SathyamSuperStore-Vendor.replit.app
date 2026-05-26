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
import { useRouter, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as XLSX from "xlsx-js-style";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, type VendorPayment } from "@/context/AppContext";

// Canonical Excel column order. Header matching is whitespace- and
// case-insensitive, so "GIDNO" / "Gid No" / "gidno" all map to GidNo.
const ALL_COLS = [
  "GidNo",
  "VendorCode",
  "VendorName",
  "InvoiceNo",
  "GRNDate",
  "InvoiceDate",
  "TranNo",
  "SupplierPayment",
  "PaymentDate",
] as const;

// Per user spec: GidNo is the unique primary key (and required).
// TranNo and PaymentDate are the only optional fields.
const REQUIRED_COLS = [
  "GidNo",
  "VendorCode",
  "VendorName",
  "InvoiceNo",
  "GRNDate",
  "InvoiceDate",
  "SupplierPayment",
] as const;

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

function formatDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// Mirror of the RodeoItems importer's parseDate — same accepted shapes
// so a sheet hand-edited by the same user behaves identically.
function parseDate(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  if (v instanceof Date && !isNaN(v.getTime())) return formatDDMMYYYY(v);
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    return "";
  }
  const s = String(v).trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let [, dd, mm, yyyy] = m;
    if (yyyy.length === 2) yyyy = (Number(yyyy) >= 70 ? "19" : "20") + yyyy;
    const day = dd.padStart(2, "0");
    const mon = mm.padStart(2, "0");
    return `${day}/${mon}/${yyyy}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    return `${dd}/${mm}/${yyyy}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
  return "";
}

export default function ImportVendorPaymentsScreen() {
  const { vendorPayments, saveVendorPaymentsBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ format?: string }>();
  const csvMode = String(params.format ?? "").toLowerCase() === "csv";

  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<VendorPayment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dupes, setDupes] = useState<number>(0);
  const [saveDone, setSaveDone] = useState(0);
  const [saveTotal, setSaveTotal] = useState(0);

  async function pickAndParse() {
    try {
      setLoading(true);
      setErrors([]);
      setParsed([]);
      setDupes(0);
      setFileName(null);

      const pickerTypes = csvMode
        ? ["text/csv", "text/comma-separated-values", "*/*"]
        : [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "text/csv",
            "*/*",
          ];

      const result = await DocumentPicker.getDocumentAsync({
        type: pickerTypes,
        copyToCacheDirectory: true,
      });
      if (result.canceled) {
        setLoading(false);
        return;
      }

      const asset = result.assets[0];
      setFileName(asset.name);

      const lowerName = asset.name.toLowerCase();
      const lowerMime = String(asset.mimeType ?? "").toLowerCase();
      const isCsv =
        lowerName.endsWith(".csv") ||
        lowerMime.includes("csv") ||
        lowerMime === "text/plain";

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
        if (isCsv) {
          const text = new TextDecoder("utf-8").decode(arrayBuffer);
          workbook = XLSX.read(text, { type: "string", cellDates: true });
        } else {
          workbook = XLSX.read(new Uint8Array(arrayBuffer), {
            type: "array",
            cellDates: true,
          });
        }
      } else {
        if (isCsv) {
          const text = await FileSystem.readAsStringAsync(asset.uri, {
            encoding: "utf8" as any,
          });
          workbook = XLSX.read(text, { type: "string", cellDates: true });
        } else {
          const base64 = await FileSystem.readAsStringAsync(asset.uri, {
            encoding: "base64" as any,
          });
          workbook = XLSX.read(base64, { type: "base64", cellDates: true });
        }
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
      const items: VendorPayment[] = [];
      // GidNo is the unique primary key — drop later duplicates so a
      // sheet with accidental repeats still imports cleanly. Track the
      // dropped count so we can surface it on the preview.
      const seenGids = new Set<string>();
      let duplicateCount = 0;

      rows.forEach((row, i) => {
        const rowNum = i + 2; // +2 = header row + 1-based index
        const gidNo = parseText(getCell(row, headerMap, "GidNo"));
        const vendorCode = parseText(getCell(row, headerMap, "VendorCode"));
        const vendorName = parseText(getCell(row, headerMap, "VendorName"));
        const invoiceNo = parseText(getCell(row, headerMap, "InvoiceNo"));
        const grnDate = parseDate(getCell(row, headerMap, "GRNDate"));
        const invoiceDate = parseDate(getCell(row, headerMap, "InvoiceDate"));
        const supplierPayment = parseDecimal(
          getCell(row, headerMap, "SupplierPayment"),
        );

        if (!gidNo) {
          rowErrors.push(`Row ${rowNum}: GidNo is required — skipped.`);
          return;
        }
        if (!vendorCode) {
          rowErrors.push(`Row ${rowNum}: VendorCode is required — skipped.`);
          return;
        }
        if (!vendorName) {
          rowErrors.push(`Row ${rowNum}: VendorName is required — skipped.`);
          return;
        }
        if (!invoiceNo) {
          rowErrors.push(`Row ${rowNum}: InvoiceNo is required — skipped.`);
          return;
        }
        if (!grnDate) {
          rowErrors.push(
            `Row ${rowNum}: GRNDate is required and must be a valid date — skipped.`,
          );
          return;
        }
        if (!invoiceDate) {
          rowErrors.push(
            `Row ${rowNum}: InvoiceDate is required and must be a valid date — skipped.`,
          );
          return;
        }
        if (supplierPayment === null) {
          rowErrors.push(
            `Row ${rowNum}: SupplierPayment is required and must be a number — skipped.`,
          );
          return;
        }
        if (seenGids.has(gidNo)) {
          duplicateCount += 1;
          rowErrors.push(
            `Row ${rowNum}: duplicate GidNo "${gidNo}" — kept first occurrence, skipped this row.`,
          );
          return;
        }
        seenGids.add(gidNo);
        items.push({
          gidNo,
          vendorCode,
          vendorName,
          invoiceNo,
          grnDate,
          invoiceDate,
          tranNo: parseText(getCell(row, headerMap, "TranNo")),
          supplierPayment,
          paymentDate: parseDate(getCell(row, headerMap, "PaymentDate")),
        });
      });

      if (items.length === 0 && rowErrors.length > 0) {
        setErrors(rowErrors);
        setLoading(false);
        return;
      }
      if (rowErrors.length > 0) setErrors(rowErrors);
      setDupes(duplicateCount);
      setParsed(items);
    } catch (e: any) {
      setErrors([`Failed to parse file: ${e?.message ?? String(e)}`]);
    } finally {
      setLoading(false);
    }
  }

  function handleImport() {
    if (parsed.length === 0) return;
    const existing = vendorPayments.length;
    const doImport = async () => {
      try {
        // 200-row batches mirror the storage layout; native still
        // collapses to a single file write but we report 0/N → N/N
        // so the user sees continuous progress on big imports.
        const expectedBatches = Math.max(1, Math.ceil(parsed.length / 200));
        setSaveDone(0);
        setSaveTotal(expectedBatches);
        await saveVendorPaymentsBatch(parsed, (done, total) => {
          setSaveDone(done);
          setSaveTotal(total);
        });
        setSaveDone(0);
        setSaveTotal(0);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const msg = `${parsed.length} Vendor Payment${parsed.length !== 1 ? "s" : ""} imported successfully.`;
        const goNext = () => router.replace("/(tabs)/directory");
        if (Platform.OS === "web") {
          window.alert(`Import Complete\n\n${msg}`);
          goNext();
        } else {
          Alert.alert("Import Complete", msg, [
            { text: "OK", onPress: goNext },
          ]);
        }
      } catch (e: any) {
        setSaveDone(0);
        setSaveTotal(0);
        const detail = e?.message ?? String(e);
        const title = "Couldn't Save Vendor Payments";
        const body = `Import failed after parsing ${parsed.length.toLocaleString()} row${parsed.length === 1 ? "" : "s"}.\n\n${detail}\n\nIf your phone is low on storage, free a few hundred MB and try again.`;
        if (Platform.OS === "web") {
          window.alert(`${title}\n\n${body}`);
        } else {
          Alert.alert(title, body);
        }
      }
    };

    if (existing > 0) {
      const msg = `Importing will replace all ${existing} existing Vendor Payment${existing !== 1 ? "s" : ""} with the ${parsed.length} row${parsed.length !== 1 ? "s" : ""} from this file.\n\nContinue?`;
      if (Platform.OS === "web") {
        if (window.confirm(`Replace Existing Vendor Payments?\n\n${msg}`)) {
          void doImport();
        }
      } else {
        Alert.alert("Replace Existing Vendor Payments?", msg, [
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
        options={{
          title: csvMode
            ? "Import Vendor Payments (CSV)"
            : "Import Vendor Payments",
          headerBackTitle: "Back",
        }}
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
                <Text style={styles.dropTitle}>
                  {csvMode
                    ? "Tap to select CSV file"
                    : "Tap to select Excel file"}
                </Text>
                <Text style={styles.dropHint}>
                  {csvMode
                    ? "Imports Vendor Payments from .csv"
                    : "Imports Vendor Payments from .xlsx, .xls or .csv"}
                </Text>
                <View style={styles.colList}>
                  {ALL_COLS.map((c) => {
                    const required = (REQUIRED_COLS as readonly string[]).includes(
                      c,
                    );
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
                <Text style={styles.reqNote}>
                  * Required column. GidNo is the unique primary key.
                </Text>
              </>
            )}
          </TouchableOpacity>

          {errors.length > 0 && (
            <View style={styles.errorCard}>
              <Feather name="alert-circle" size={16} color={Colors.danger} />
              <View style={{ flex: 1 }}>
                {errors.slice(0, 50).map((e, i) => (
                  <Text key={i} style={styles.errorText}>
                    {e}
                  </Text>
                ))}
                {errors.length > 50 && (
                  <Text style={styles.errorText}>
                    + {errors.length - 50} more issue
                    {errors.length - 50 !== 1 ? "s" : ""} (preview limited)
                  </Text>
                )}
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
                    style={[styles.summaryValue, { color: Colors.warning }]}
                  >
                    {vendorPayments.length}
                  </Text>
                  <Text style={styles.summaryLabel}>Will Replace</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text
                    style={[
                      styles.summaryValue,
                      { color: dupes > 0 ? Colors.danger : Colors.success },
                    ]}
                  >
                    {dupes}
                  </Text>
                  <Text style={styles.summaryLabel}>Dupe GidNo</Text>
                </View>
              </View>

              <View style={styles.previewCard}>
                <Text style={styles.previewTitle}>
                  Preview ({parsed.length} row{parsed.length !== 1 ? "s" : ""})
                </Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.th, { flex: 1.2 }]}>GidNo</Text>
                  <Text style={[styles.th, { flex: 2.4 }]}>Vendor</Text>
                  <Text style={[styles.th, { flex: 1.4 }]}>Invoice</Text>
                  <Text style={[styles.th, { flex: 1.1 }]}>Amount</Text>
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
                      {item.gidNo}
                    </Text>
                    <Text style={[styles.td, { flex: 2.4 }]} numberOfLines={1}>
                      {item.vendorName}
                    </Text>
                    <Text style={[styles.td, { flex: 1.4 }]} numberOfLines={1}>
                      {item.invoiceNo}
                    </Text>
                    <Text style={[styles.td, { flex: 1.1 }]} numberOfLines={1}>
                      {item.supplierPayment === null
                        ? "—"
                        : item.supplierPayment.toLocaleString()}
                    </Text>
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
            {saveTotal > 0 ? (
              <View style={styles.progressWrap}>
                <View style={styles.progressHeader}>
                  <ActivityIndicator color={Colors.primary} size="small" />
                  <Text style={styles.progressLabel}>
                    Saving {Math.min(
                      Math.round(
                        (saveDone / Math.max(1, saveTotal)) * parsed.length,
                      ),
                      parsed.length,
                    ).toLocaleString()} of {parsed.length.toLocaleString()} rows…
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.round((saveDone / Math.max(1, saveTotal)) * 100)}%`,
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
                  Import {parsed.length} Vendor Payment
                  {parsed.length !== 1 ? "s" : ""}
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
  dropHint: { fontSize: 13, color: Colors.textMuted, textAlign: "center" },
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
    gap: 6,
    marginTop: 12,
    justifyContent: "center",
  },
  colChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  colChipRequired: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary + "60",
  },
  colChipText: { fontSize: 11, fontWeight: "600", color: Colors.textSecondary },
  colChipTextRequired: { color: Colors.primary },
  reqStar: { fontSize: 11, color: Colors.danger, fontWeight: "800" },
  reqNote: { fontSize: 11, color: Colors.textMuted, marginTop: 6 },
  errorCard: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    backgroundColor: Colors.dangerLight,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  errorText: { fontSize: 12, color: Colors.danger, lineHeight: 16 },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 14,
  },
  summaryItem: { flex: 1, alignItems: "center" },
  summaryDivider: { width: 1, height: 32, backgroundColor: Colors.border },
  summaryValue: {
    fontSize: 22,
    fontWeight: "800",
    color: Colors.text,
    marginBottom: 2,
  },
  summaryLabel: { fontSize: 11, color: Colors.textMuted, fontWeight: "600" },
  previewCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    gap: 6,
  },
  previewTitle: { fontSize: 13, fontWeight: "700", color: Colors.text },
  tableHeader: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tableRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tableRowAlt: { backgroundColor: Colors.background },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  td: { fontSize: 12, color: Colors.text },
  previewMore: { fontSize: 11, color: Colors.textMuted, marginTop: 4 },
  footer: {
    padding: 16,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  importBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.textInverse,
  },
  progressWrap: { gap: 8 },
  progressHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  progressLabel: { fontSize: 13, fontWeight: "700", color: Colors.text },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.background,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  progressFill: { height: "100%", backgroundColor: Colors.primary },
  progressHint: { fontSize: 11, color: Colors.textMuted },
});
