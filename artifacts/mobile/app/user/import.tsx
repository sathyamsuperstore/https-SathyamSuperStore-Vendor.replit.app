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
import { useApp, UserType, showStorageErrorAlert } from "@/context/AppContext";

const REQUIRED_COLS = ["UserID", "Password"];
const ALL_COLS = ["UserID", "Password", "UserType", "VendorCode", "VendorName", "VendorMobileNo1", "VendorMobileNo2"];
const VALID_USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

interface ParsedUser {
  userId: string;
  password: string;
  userType: UserType;
  vendorCode: string;
  vendorName: string;
  vendorMobileNo1: string;
  vendorMobileNo2: string;
}

export default function ImportUsersScreen() {
  const { appUsers, addUsersBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedUser[]>([]);
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
      const items: ParsedUser[] = [];
      const seenIds = new Set<string>();

      rows.forEach((row, i) => {
        const userId = String(row["UserID"] ?? "").trim();
        const password = String(row["Password"] ?? "").trim();
        if (!userId || !password) {
          rowErrors.push(`Row ${i + 2}: UserID and Password are required.`);
          return;
        }
        if (seenIds.has(userId.toLowerCase())) {
          rowErrors.push(`Row ${i + 2}: Duplicate UserID "${userId}" in file — skipped.`);
          return;
        }
        seenIds.add(userId.toLowerCase());

        const rawType = String(row["UserType"] ?? "").trim();
        const userType: UserType = (VALID_USER_TYPES as string[]).includes(rawType) ? (rawType as UserType) : "Vendor";

        items.push({
          userId,
          password,
          userType,
          vendorCode: String(row["VendorCode"] ?? "").trim().toUpperCase(),
          vendorName: String(row["VendorName"] ?? "").trim(),
          vendorMobileNo1: String(row["VendorMobileNo1"] ?? "").trim(),
          vendorMobileNo2: String(row["VendorMobileNo2"] ?? "").trim(),
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
      appUsers.some((u) => u.userId.toLowerCase() === p.userId.toLowerCase())
    );

    const doImport = async () => {
      try {
        const { added, skipped } = await addUsersBatch(parsed.map((p) => ({
          userId: p.userId,
          password: p.password,
          userType: p.userType,
          vendorCode: p.vendorCode,
          vendorName: p.vendorName,
          vendorMobileNo1: p.vendorMobileNo1,
          vendorMobileNo2: p.vendorMobileNo2,
        })));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const msg = skipped.length > 0
          ? `${added} user${added !== 1 ? "s" : ""} added.\n${skipped.length} skipped (duplicate UserID): ${skipped.join(", ")}`
          : `${added} user${added !== 1 ? "s" : ""} added successfully.`;
        // Chain to the next step in the import sequence: Users →
        // LastSupplyDate. router.replace so the importer stack
        // doesn't grow as the operator walks through each tab.
        const goNext = () => router.replace("/(tabs)/last-supply-date");
        if (Platform.OS === "web") {
          window.alert(`Import Complete\n\n${msg}`);
          goNext();
        } else {
          Alert.alert("Import Complete", msg, [{ text: "OK", onPress: goNext }]);
        }
      } catch {
        showStorageErrorAlert();
      }
    };

    if (existingConflicts.length > 0) {
      const conflictMsg = `${existingConflicts.length} user(s) already exist with the same UserID and will be skipped:\n${existingConflicts.map((p) => p.userId).join(", ")}\n\nContinue?`;
      if (Platform.OS === "web") {
        if (window.confirm(`Duplicate UserIDs\n\n${conflictMsg}`)) void doImport();
      } else {
        Alert.alert("Duplicate UserIDs", conflictMsg, [
          { text: "Cancel", style: "cancel" },
          { text: "Continue", onPress: () => void doImport() },
        ]);
      }
    } else {
      void doImport();
    }
  }

  const existingCount = parsed.filter((p) =>
    appUsers.some((u) => u.userId.toLowerCase() === p.userId.toLowerCase())
  ).length;
  const newCount = parsed.length - existingCount;

  return (
    <>
      <Stack.Screen options={{ title: "Import Users", headerBackTitle: "Back" }} />
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
                <Text style={styles.dropHint}>Imports users from .xlsx or .xls</Text>
                <View style={styles.colList}>
                  {ALL_COLS.map((c) => (
                    <View key={c} style={[styles.colChip, REQUIRED_COLS.includes(c) && styles.colChipRequired]}>
                      <Text style={[styles.colChipText, REQUIRED_COLS.includes(c) && styles.colChipTextRequired]}>{c}</Text>
                      {REQUIRED_COLS.includes(c) && <Text style={styles.reqStar}>*</Text>}
                    </View>
                  ))}
                </View>
                <Text style={styles.reqNote}>* Required columns · UserType: Admin / Vendor / Manager / Staff (defaults to Vendor)</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.driveBtn}
            onPress={() => router.push("/drive-import")}
            activeOpacity={0.7}
          >
            <Feather name="hard-drive" size={16} color="#1a73e8" />
            <Text style={styles.driveBtnText}>Import from Google Drive</Text>
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
                <Text style={styles.previewTitle}>Preview ({parsed.length} users)</Text>
                <View style={styles.tableHeader}>
                  <Text style={[styles.th, { flex: 2 }]}>UserID</Text>
                  <Text style={[styles.th, { flex: 2 }]}>Type</Text>
                  <Text style={[styles.th, { flex: 2 }]}>VendorCode</Text>
                  <Text style={styles.thStatus}>Status</Text>
                </View>
                {parsed.map((item, i) => {
                  const isDuplicate = appUsers.some((u) => u.userId.toLowerCase() === item.userId.toLowerCase());
                  return (
                    <View key={i} style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}>
                      <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>{item.userId}</Text>
                      <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>{item.userType}</Text>
                      <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>{item.vendorCode || "—"}</Text>
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
              <Text style={styles.importBtnText}>Import {newCount} User{newCount !== 1 ? "s" : ""}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  driveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#e8f0fe",
    borderWidth: 1,
    borderColor: "#1a73e830",
  },
  driveBtnText: { fontSize: 14, fontWeight: "700", color: "#1a73e8" },
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
  reqNote: { fontSize: 11, color: Colors.textMuted, marginTop: 4, textAlign: "center" },
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
