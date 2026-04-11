import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as XLSX from "xlsx-js-style";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Colors } from "@/constants/colors";
import { useApp, OrderItem, UserType } from "@/context/AppContext";

const FOLDER_ID_KEY = "@driveImportFolderId";
const VALID_USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

function getApiBase(): string {
  if (Platform.OS === "web") {
    return "";
  }
  const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
  return `https://${domain}`;
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  size?: string;
}

function parseExcelDate(val: unknown): string {
  if (val === null || val === undefined || val === "") return "";
  if (val instanceof Date) return isNaN(val.getTime()) ? "" : val.toISOString().split("T")[0];
  if (typeof val === "number") {
    const d = new Date((val - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
  }
  const str = String(val).trim();
  const d = new Date(str);
  return isNaN(d.getTime()) ? str : d.toISOString().split("T")[0];
}

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function detectFileType(name: string): "orders" | "suppliers" | "users" | "unknown" {
  const n = name.toLowerCase();
  if (n.includes("order")) return "orders";
  if (n.includes("supplier") || n.includes("vendor")) return "suppliers";
  if (n.includes("user")) return "users";
  return "unknown";
}

interface ImportResult {
  fileName: string;
  type: "orders" | "suppliers" | "users" | "unknown";
  status: "pending" | "importing" | "success" | "error" | "skipped";
  message?: string;
}

export default function DriveImportScreen() {
  const { suppliers, appUsers, addOrdersBatch, addSuppliersBatch, addUsersBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [folderId, setFolderId] = useState("");
  const [folderIdInput, setFolderIdInput] = useState("");
  const [showFolderConfig, setShowFolderConfig] = useState(false);

  const [listing, setListing] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [listError, setListError] = useState("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ImportResult[]>([]);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(FOLDER_ID_KEY).then((v) => {
      if (v) {
        setFolderId(v);
        setFolderIdInput(v);
      }
    });
  }, []);

  async function saveFolderId() {
    const id = folderIdInput.trim();
    await AsyncStorage.setItem(FOLDER_ID_KEY, id);
    setFolderId(id);
    setShowFolderConfig(false);
    setFiles([]);
    setSelectedIds(new Set());
    setResults([]);
  }

  async function listFiles() {
    setListing(true);
    setListError("");
    setFiles([]);
    setSelectedIds(new Set());
    setResults([]);
    try {
      const base = getApiBase();
      const url = folderId
        ? `${base}/api/drive/files?folderId=${encodeURIComponent(folderId)}`
        : `${base}/api/drive/files`;
      const resp = await fetch(url);
      const data = await resp.json() as any;
      if (data.error) throw new Error(data.error);
      const fileList: DriveFile[] = data.files ?? [];
      if (fileList.length === 0) {
        setListError("No Excel files found in the specified folder.");
      } else {
        setFiles(fileList);
        setSelectedIds(new Set(fileList.map((f) => f.id)));
      }
    } catch (e: any) {
      setListError(e?.message ?? "Failed to list files from Google Drive.");
    } finally {
      setListing(false);
    }
  }

  function toggleFile(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function downloadAndParse(file: DriveFile): Promise<XLSX.WorkBook> {
    const base = getApiBase();
    const url = `${base}/api/drive/file/${file.id}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${file.name}`);
    const arrayBuffer = await resp.arrayBuffer();
    return XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
  }

  async function importFile(file: DriveFile): Promise<{ message: string }> {
    const type = detectFileType(file.name);
    if (type === "unknown") {
      return { message: "Could not detect file type from filename. Rename to include 'order', 'supplier', or 'user'." };
    }

    const workbook = await downloadAndParse(file);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (rows.length === 0) return { message: "File is empty." };

    if (type === "orders") {
      const required = ["VendorCode", "Item Description", "UOM", "MRP", "Order Qty"];
      const first = rows[0];
      const missing = required.filter((c) => !(c in first));
      if (missing.length > 0) return { message: `Missing columns: ${missing.join(", ")}` };

      const groupMap: Record<string, any[]> = {};
      for (const row of rows) {
        const vc = String(row["VendorCode"] ?? "").trim();
        const desc = String(row["Item Description"] ?? "").trim();
        if (!vc || !desc) continue;
        if (!groupMap[vc]) groupMap[vc] = [];
        groupMap[vc].push(row);
      }
      const orderInputs = Object.entries(groupMap).map(([vendorCode, items]) => {
        const matchedSupplier = suppliers.find(
          (s) => s.vendorCode.toUpperCase() === vendorCode.toUpperCase()
        );
        const orderItems: OrderItem[] = items.map((row) => ({
          id: generateId(),
          name: `${String(row["Item No"] ?? "").trim() ? String(row["Item No"]).trim() + " - " : ""}${String(row["Item Description"]).trim()}`,
          brand: String(row["Brand"] ?? "").trim() || undefined,
          quantity: parseFloat(String(row["Order Qty"] ?? "0")) || 1,
          unit: String(row["UOM"] ?? "pcs").trim(),
          unitPrice: parseFloat(String(row["MRP"] ?? "0")) || 0,
          stock: parseFloat(String(row["Stock"] ?? "")) || undefined,
        }));
        return {
          supplierId: matchedSupplier?.id ?? "",
          supplierName: matchedSupplier?.name ?? vendorCode,
          status: "pending" as const,
          items: orderItems,
          notes: `Imported from Drive: ${file.name}`,
          expectedDelivery: addDays(7),
          syncDate: parseExcelDate(items[0]?.["SyncDate"]) || undefined,
          beat: String(items[0]?.["Beat"] ?? "").trim() || undefined,
        };
      });
      const validOrders = orderInputs.filter((o) => o.items.length > 0);
      addOrdersBatch(validOrders);
      return { message: `${validOrders.length} order(s) created from ${Object.keys(groupMap).length} vendor group(s).` };
    }

    if (type === "suppliers") {
      const required = ["VendorCode", "VendorName"];
      const first = rows[0];
      const missing = required.filter((c) => !(c in first));
      if (missing.length > 0) return { message: `Missing columns: ${missing.join(", ")}` };

      const items = rows
        .map((row) => ({
          vendorCode: String(row["VendorCode"] ?? "").trim().toUpperCase(),
          name: String(row["VendorName"] ?? "").trim(),
          vendorGstNo: String(row["VendorGstNo"] ?? "").trim(),
          contactName: String(row["ContactName"] ?? "").trim(),
          email: String(row["Email"] ?? "").trim(),
          phone: String(row["Phone"] ?? "").trim(),
          address: String(row["Address"] ?? "").trim(),
          category: String(row["VendorCategory"] ?? "").trim(),
        }))
        .filter((i) => i.vendorCode && i.name);
      const { added, skipped } = addSuppliersBatch(items);
      return { message: `${added} supplier(s) added, ${skipped.length} skipped (duplicate).` };
    }

    if (type === "users") {
      const required = ["UserID", "Password"];
      const first = rows[0];
      const missing = required.filter((c) => !(c in first));
      if (missing.length > 0) return { message: `Missing columns: ${missing.join(", ")}` };

      const items = rows
        .map((row) => {
          const rawType = String(row["UserType"] ?? "").trim();
          return {
            userId: String(row["UserID"] ?? "").trim(),
            password: String(row["Password"] ?? "").trim(),
            userType: (VALID_USER_TYPES as string[]).includes(rawType) ? (rawType as UserType) : "Vendor" as UserType,
            vendorCode: String(row["VendorCode"] ?? "").trim().toUpperCase(),
            vendorName: String(row["VendorName"] ?? "").trim(),
            vendorMobileNo1: String(row["VendorMobileNo1"] ?? "").trim(),
            vendorMobileNo2: String(row["VendorMobileNo2"] ?? "").trim(),
          };
        })
        .filter((i) => i.userId && i.password);
      const { added, skipped } = addUsersBatch(items);
      return { message: `${added} user(s) added, ${skipped.length} skipped (duplicate).` };
    }

    return { message: "Unknown error." };
  }

  async function runImport() {
    const toImport = files.filter((f) => selectedIds.has(f.id));
    if (toImport.length === 0) return;

    setImporting(true);
    const initResults: ImportResult[] = toImport.map((f) => ({
      fileName: f.name,
      type: detectFileType(f.name),
      status: "pending",
    }));
    setResults(initResults);

    for (let i = 0; i < toImport.length; i++) {
      const file = toImport[i];
      setResults((prev) => prev.map((r, idx) => idx === i ? { ...r, status: "importing" } : r));
      try {
        const type = detectFileType(file.name);
        if (type === "unknown") {
          setResults((prev) => prev.map((r, idx) => idx === i ? { ...r, status: "skipped", message: "Unknown type — rename file to include 'order', 'supplier', or 'user'." } : r));
          continue;
        }
        const { message } = await importFile(file);
        setResults((prev) => prev.map((r, idx) => idx === i ? { ...r, status: "success", message } : r));
      } catch (e: any) {
        setResults((prev) => prev.map((r, idx) => idx === i ? { ...r, status: "error", message: e?.message ?? "Failed" } : r));
      }
    }
    setImporting(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  const selectedCount = selectedIds.size;
  const done = results.length > 0 && !importing;

  return (
    <>
      <Stack.Screen options={{ title: "Drive Import", headerBackTitle: "Back" }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Folder config */}
        <View style={styles.configCard}>
          <View style={styles.configRow}>
            <View style={styles.configLeft}>
              <Feather name="folder" size={18} color={Colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.configLabel}>Google Drive Folder</Text>
                <Text style={styles.configValue} numberOfLines={1}>
                  {folderId ? folderId : "All Drive files (no folder filter)"}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.configEditBtn}
              onPress={() => { setFolderIdInput(folderId); setShowFolderConfig((v) => !v); }}
            >
              <Feather name={showFolderConfig ? "x" : "settings"} size={15} color={Colors.primary} />
            </TouchableOpacity>
          </View>

          {showFolderConfig && (
            <View style={styles.folderInputWrap}>
              <Text style={styles.folderInputLabel}>
                Paste your Google Drive Folder ID below. Leave blank to search all files.
              </Text>
              <TextInput
                style={styles.folderInput}
                value={folderIdInput}
                onChangeText={setFolderIdInput}
                placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity style={styles.saveFolderBtn} onPress={saveFolderId}>
                <Feather name="check" size={14} color={Colors.textInverse} />
                <Text style={styles.saveFolderBtnText}>Save & Apply</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Info banner */}
        <View style={styles.infoBanner}>
          <Feather name="info" size={14} color={Colors.primary} />
          <Text style={styles.infoText}>
            Files are auto-detected by name: filenames containing "order", "supplier"/"vendor", or "user" are imported accordingly.
          </Text>
        </View>

        {/* List button */}
        <TouchableOpacity
          style={[styles.listBtn, listing && { opacity: 0.6 }]}
          onPress={listFiles}
          disabled={listing}
          activeOpacity={0.8}
        >
          {listing ? (
            <ActivityIndicator size="small" color={Colors.textInverse} />
          ) : (
            <Feather name="refresh-cw" size={16} color={Colors.textInverse} />
          )}
          <Text style={styles.listBtnText}>{listing ? "Scanning Drive..." : "Scan Google Drive"}</Text>
        </TouchableOpacity>

        {!!listError && (
          <View style={styles.errorCard}>
            <Feather name="alert-circle" size={16} color={Colors.danger} />
            <Text style={styles.errorText}>{listError}</Text>
          </View>
        )}

        {/* File list */}
        {files.length > 0 && results.length === 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{files.length} file{files.length !== 1 ? "s" : ""} found</Text>
              <TouchableOpacity onPress={() => setSelectedIds(selectedIds.size === files.length ? new Set() : new Set(files.map((f) => f.id)))}>
                <Text style={styles.selectAll}>{selectedIds.size === files.length ? "Deselect All" : "Select All"}</Text>
              </TouchableOpacity>
            </View>
            {files.map((file) => {
              const type = detectFileType(file.name);
              const isSelected = selectedIds.has(file.id);
              return (
                <TouchableOpacity
                  key={file.id}
                  style={[styles.fileCard, isSelected && styles.fileCardSelected]}
                  onPress={() => toggleFile(file.id)}
                  activeOpacity={0.7}
                >
                  <Feather
                    name={isSelected ? "check-square" : "square"}
                    size={18}
                    color={isSelected ? Colors.primary : Colors.textMuted}
                    style={{ marginTop: 2 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fileName} numberOfLines={2}>{file.name}</Text>
                    <View style={styles.fileMeta}>
                      <View style={[styles.typeChip, type === "unknown" && styles.typeChipUnknown]}>
                        <Text style={[styles.typeChipText, type === "unknown" && styles.typeChipTextUnknown]}>
                          {type === "orders" ? "Orders" : type === "suppliers" ? "Suppliers" : type === "users" ? "Users" : "Unknown"}
                        </Text>
                      </View>
                      <Text style={styles.fileDate}>
                        {new Date(file.modifiedTime).toLocaleDateString("en-IN")}
                      </Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              style={[styles.importBtn, (selectedCount === 0 || importing) && { opacity: 0.5 }]}
              onPress={runImport}
              disabled={selectedCount === 0 || importing}
              activeOpacity={0.8}
            >
              <Feather name="download-cloud" size={18} color={Colors.textInverse} />
              <Text style={styles.importBtnText}>
                Import {selectedCount} File{selectedCount !== 1 ? "s" : ""}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {/* Results */}
        {results.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Import Results</Text>
            </View>
            {results.map((r, i) => (
              <View key={i} style={styles.resultCard}>
                <View style={styles.resultHeader}>
                  {r.status === "importing" ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : r.status === "success" ? (
                    <Feather name="check-circle" size={16} color={Colors.success} />
                  ) : r.status === "error" ? (
                    <Feather name="x-circle" size={16} color={Colors.danger} />
                  ) : r.status === "skipped" ? (
                    <Feather name="minus-circle" size={16} color={Colors.warning} />
                  ) : (
                    <Feather name="clock" size={16} color={Colors.textMuted} />
                  )}
                  <Text style={styles.resultFileName} numberOfLines={1}>{r.fileName}</Text>
                </View>
                {r.message && (
                  <Text style={[
                    styles.resultMsg,
                    r.status === "error" && { color: Colors.danger },
                    r.status === "success" && { color: Colors.success },
                    r.status === "skipped" && { color: Colors.warning },
                  ]}>
                    {r.message}
                  </Text>
                )}
              </View>
            ))}
            {done && (
              <TouchableOpacity style={styles.doneBtn} onPress={() => router.back()} activeOpacity={0.8}>
                <Feather name="check" size={16} color={Colors.textInverse} />
                <Text style={styles.doneBtnText}>Done</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 14 },
  configCard: {
    backgroundColor: Colors.surface, borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border, overflow: "hidden",
  },
  configRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: 14, gap: 10,
  },
  configLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  configLabel: { fontSize: 11, fontWeight: "700", color: Colors.textMuted, textTransform: "uppercase" },
  configValue: { fontSize: 12, color: Colors.text, fontWeight: "500", marginTop: 2 },
  configEditBtn: {
    padding: 8, borderRadius: 8, backgroundColor: Colors.primaryMuted,
  },
  folderInputWrap: {
    padding: 14, paddingTop: 0, gap: 10, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  folderInputLabel: { fontSize: 12, color: Colors.textMuted, lineHeight: 18 },
  folderInput: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: 10, borderWidth: 1,
    borderColor: Colors.border, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 13, color: Colors.text, fontFamily: "monospace",
  },
  saveFolderBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: Colors.primary, borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 10, alignSelf: "flex-end",
  },
  saveFolderBtnText: { fontSize: 13, fontWeight: "700", color: Colors.textInverse },
  infoBanner: {
    flexDirection: "row", gap: 8, alignItems: "flex-start",
    backgroundColor: Colors.primaryMuted, borderRadius: 12, padding: 12,
  },
  infoText: { fontSize: 12, color: Colors.primary, flex: 1, lineHeight: 18 },
  listBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 14,
  },
  listBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
  errorCard: {
    flexDirection: "row", gap: 10, alignItems: "flex-start",
    backgroundColor: Colors.dangerLight, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: Colors.danger + "30",
  },
  errorText: { fontSize: 13, color: Colors.danger, flex: 1 },
  sectionHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: Colors.text },
  selectAll: { fontSize: 13, fontWeight: "600", color: Colors.primary },
  fileCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 12,
    backgroundColor: Colors.surface, borderRadius: 12,
    borderWidth: 1.5, borderColor: Colors.border, padding: 14,
  },
  fileCardSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted + "30" },
  fileName: { fontSize: 13, fontWeight: "600", color: Colors.text, marginBottom: 6 },
  fileMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  typeChip: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
    backgroundColor: Colors.primaryMuted,
  },
  typeChipUnknown: { backgroundColor: Colors.warningLight },
  typeChipText: { fontSize: 10, fontWeight: "700", color: Colors.primary },
  typeChipTextUnknown: { color: Colors.warning },
  fileDate: { fontSize: 11, color: Colors.textMuted },
  importBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 16, marginTop: 4,
  },
  importBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
  resultCard: {
    backgroundColor: Colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, padding: 14, gap: 6,
  },
  resultHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  resultFileName: { fontSize: 13, fontWeight: "600", color: Colors.text, flex: 1 },
  resultMsg: { fontSize: 12, color: Colors.textSecondary, marginLeft: 28 },
  doneBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.success, borderRadius: 14, paddingVertical: 16, marginTop: 4,
  },
  doneBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
});
