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
import * as XLSX from "xlsx";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp } from "@/context/AppContext";

const REQUIRED_COLS = ["VendorCode", "VendorName"];
const ALL_COLS = ["VendorCode", "VendorName", "VendorGstNo", "ContactName", "Email", "Phone", "Address", "VendorCategory"];

interface ParsedSupplier {
  vendorCode: string;
  name: string;
  vendorGstNo: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  category: string;
}

export default function ImportSuppliersScreen() {
  const { suppliers, addSuppliersBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedSupplier[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  async function pickAndParse() {
    try {
      setLoading(true);
      setErrors([]);
      setParsed([]);
      setFileName(null);

      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "*/*"],
        copyToCacheDirectory: true,
      });
      if (result.canceled) { setLoading(false); return; }

      const asset = result.assets[0];
      setFileName(asset.name);

      let workbook: XLSX.WorkBook;
      if (Platform.OS === "web") {
        const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", asset.uri, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => resolve(xhr.response as ArrayBuffer);
          xhr.onerror = () => fetch(asset.uri).then((r) => r.arrayBuffer()).then(resolve).catch(reject);
          xhr.send();
        });
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" as any });
        workbook = XLSX.read(base64, { type: "base64" });
      }

      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (rows.length === 0) { setErrors(["File is empty or has no data rows."]); setLoading(false); return; }

      const firstRow = rows[0];
      const missing = REQUIRED_COLS.filter((c) => !(c in firstRow));
      if (missing.length > 0) {
        setErrors([`Missing required columns: ${missing.join(", ")}`]);
        setLoading(false);
        return;
      }

      const rowErrors: string[] = [];
      const items: ParsedSupplier[] = [];
      const seenCodes = new Set<string>();

      rows.forEach((row, i) => {
        const vendorCode = String(row["VendorCode"] ?? "").trim().toUpperCase();
        const name = String(row["VendorName"] ?? "").trim();
        if (!vendorCode || !name) {
          rowErrors.push(`Row ${i + 2}: VendorCode and VendorName are required.`);
          return;
        }
        if (seenCodes.has(vendorCode)) {
          rowErrors.push(`Row ${i + 2}: Duplicate VendorCode "${vendorCode}" in file — skipped.`);
          return;
        }
        seenCodes.add(vendorCode);
        items.push({
          vendorCode,
          name,
          vendorGstNo: String(row["VendorGstNo"] ?? "").trim(),
          contactName: String(row["ContactName"] ?? "").trim(),
          email: String(row["Email"] ?? "").trim(),
          phone: String(row["Phone"] ?? "").trim(),
          address: String(row["Address"] ?? "").trim(),
          category: String(row["VendorCategory"] ?? "").trim(),
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

    const existingConflicts = parsed.filter((p) =>
      suppliers.some((s) => s.vendorCode.toUpperCase() === p.vendorCode.toUpperCase())
    );

    const doImport = () => {
      const { added, skipped } = addSuppliersBatch(parsed.map((p) => ({
        vendorCode: p.vendorCode,
        name: p.name,
        vendorGstNo: p.vendorGstNo,
        contactName: p.contactName,
        email: p.email,
        phone: p.phone,
        address: p.address,
        category: p.category,
      })));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const msg = skipped.length > 0
        ? `${added} supplier${added !== 1 ? "s" : ""} added.\n${skipped.length} skipped (duplicate VendorCode): ${skipped.join(", ")}`
        : `${added} supplier${added !== 1 ? "s" : ""} added successfully.`;
      Alert.alert("Import Complete", msg, [{ text: "OK", onPress: () => router.back() }]);
    };

    if (existingConflicts.length > 0) {
      Alert.alert(
        "Duplicate VendorCodes",
        `${existingConflicts.length} supplier(s) already exist with the same VendorCode and will be skipped:\n${existingConflicts.map((p) => p.vendorCode).join(", ")}\n\nContinue?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Continue", onPress: doImport },
        ]
      );
    } else {
      doImport();
    }
  }

  const existingCount = parsed.filter((p) =>
    suppliers.some((s) => s.vendorCode.toUpperCase() === p.vendorCode.toUpperCase())
  ).length;
  const newCount = parsed.length - existingCount;

  return (
    <>
      <Stack.Screen options={{ title: "Import Suppliers", headerBackTitle: "Back" }} />
      <View style={[styles.container, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) }]}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          <TouchableOpacity style={[styles.dropZone, !!fileName && styles.dropZoneSuccess]} onPress={pickAndParse} activeOpacity={0.7}>
            {loading ? (
              <ActivityIndicator color={Colors.primary} size="large" />
            ) : fileName ? (
              <>
                <View style={styles.fileIconWrap}><Feather name="file-text" size={28} color={Colors.accent} /></View>
                <Text style={styles.fileName}>{fileName}</Text>
                <Text style={styles.fileHint}>Tap to pick a different file</Text>
              </>
            ) : (
              <>
                <View style={styles.fileIconWrap}><Feather name="upload" size={28} color={Colors.primary} /></View>
                <Text style={styles.dropTitle}>Tap to select Excel file</Text>
                <Text style={styles.dropHint}>Imports suppliers from .xlsx or .xls</Text>
                <View style={styles.colList}>
                  {ALL_COLS.map((c) => (
                    <View key={c} style={[styles.colChip, REQUIRED_COLS.includes(c) && styles.colChipRequired]}>
                      <Text style={[styles.colChipText, REQUIRED_COLS.includes(c) && styles.colChipTextRequired]}>{c}</Text>
                      {REQUIRED_COLS.includes(c) && <Text style={styles.reqStar}>*</Text>}
                    </View>
                  ))}
                </View>
                <Text style={styles.reqNote}>* Required columns</Text>
              </>
            )}
          </TouchableOpacity>

          {errors.length > 0 && (
            <View style={styles.errorCard}>
              <Feather name="alert-circle" size={16} color={Colors.danger} />
              <View style={{ flex: 1 }}>
                {errors.map((e, i) => <Text key={i} style={styles.errorText}>{e}</Text>)}
              </View>
            </View>
          )}

          {parsed.length > 0 && (
            <>
              <View style={styles.summaryRow}>
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{parsed.length}</Text>
                  <Text style={styles.summaryLabel}>Total Rows</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryValue, { color: Colors.success }]}>{newCount}</Text>
                  <Text style={styles.summaryLabel}>New</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryValue, { color: Colors.warning }]}>{existingCount}</Text>
                  <Text style={styles.summaryLabel}>Duplicate</Text>
                </View>
              </View>

              <View style={styles.previewCard}>
                <Text style={styles.previewTitle}>Preview ({parsed.length} suppliers)</Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.th, { flex: 2 }]}>VendorCode</Text>
                  <Text style={[styles.th, { flex: 3 }]}>VendorName</Text>
                  <Text style={[styles.th, { flex: 2 }]}>VendorCategory</Text>
                  <Text style={styles.thStatus}>Status</Text>
                </View>
                {parsed.map((item, i) => {
                  const isDuplicate = suppliers.some((s) => s.vendorCode.toUpperCase() === item.vendorCode.toUpperCase());
                  return (
                    <View key={i} style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}>
                      <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>{item.vendorCode}</Text>
                      <Text style={[styles.td, { flex: 3 }]} numberOfLines={1}>{item.name}</Text>
                      <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>{item.category || "—"}</Text>
                      <View style={[styles.statusPill, isDuplicate ? styles.statusPillWarn : styles.statusPillOk]}>
                        <Text style={[styles.statusPillText, isDuplicate ? { color: Colors.warning } : { color: Colors.success }]}>
                          {isDuplicate ? "Skip" : "New"}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>

        {parsed.length > 0 && newCount > 0 && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
            <TouchableOpacity style={styles.importBtn} onPress={handleImport}>
              <Feather name="download" size={18} color={Colors.textInverse} />
              <Text style={styles.importBtnText}>Import {newCount} Supplier{newCount !== 1 ? "s" : ""}</Text>
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
    backgroundColor: Colors.surface, borderRadius: 16, borderWidth: 2,
    borderColor: Colors.border, borderStyle: "dashed", padding: 28, alignItems: "center", gap: 8,
  },
  dropZoneSuccess: { borderColor: Colors.accent, borderStyle: "solid" },
  fileIconWrap: {
    width: 56, height: 56, borderRadius: 14, backgroundColor: Colors.primaryMuted,
    alignItems: "center", justifyContent: "center", marginBottom: 4,
  },
  dropTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  dropHint: { fontSize: 13, color: Colors.textMuted },
  fileName: { fontSize: 15, fontWeight: "700", color: Colors.text, textAlign: "center" },
  fileHint: { fontSize: 12, color: Colors.textMuted },
  colList: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 8 },
  colChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: Colors.surfaceSecondary, flexDirection: "row", alignItems: "center", gap: 2 },
  colChipRequired: { backgroundColor: Colors.primaryMuted },
  colChipText: { fontSize: 11, fontWeight: "600", color: Colors.textSecondary },
  colChipTextRequired: { color: Colors.primary },
  reqStar: { fontSize: 12, color: Colors.danger, fontWeight: "700" },
  reqNote: { fontSize: 11, color: Colors.textMuted, marginTop: 4 },
  errorCard: {
    flexDirection: "row", gap: 10, backgroundColor: Colors.dangerLight, borderRadius: 12,
    padding: 14, borderWidth: 1, borderColor: Colors.danger + "30",
  },
  errorText: { fontSize: 13, color: Colors.danger, lineHeight: 20 },
  summaryRow: {
    flexDirection: "row", backgroundColor: Colors.surface, borderRadius: 14,
    padding: 16, borderWidth: 1, borderColor: Colors.border,
  },
  summaryItem: { flex: 1, alignItems: "center" },
  summaryValue: { fontSize: 20, fontWeight: "800", color: Colors.text, marginBottom: 2 },
  summaryLabel: { fontSize: 11, color: Colors.textMuted, fontWeight: "500" },
  summaryDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 8 },
  previewCard: { backgroundColor: Colors.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  previewTitle: { fontSize: 13, fontWeight: "700", color: Colors.text, padding: 14, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tableHeader: {
    flexDirection: "row", alignItems: "center", backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  tableRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Colors.borderLight },
  tableRowAlt: { backgroundColor: Colors.background },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  thStatus: { width: 44, textAlign: "center", fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  td: { fontSize: 12, color: Colors.text },
  statusPill: { width: 44, paddingVertical: 3, borderRadius: 20, alignItems: "center" },
  statusPillOk: { backgroundColor: Colors.successLight },
  statusPillWarn: { backgroundColor: Colors.warningLight },
  statusPillText: { fontSize: 10, fontWeight: "700" },
  footer: { padding: 16, backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border },
  importBtn: {
    backgroundColor: Colors.primary, borderRadius: 14, padding: 16,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
  },
  importBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
});
