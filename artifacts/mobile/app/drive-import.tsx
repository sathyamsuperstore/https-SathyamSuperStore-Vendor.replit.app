import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Platform,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as XLSX from "xlsx-js-style";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, OrderItem, UserType } from "@/context/AppContext";

const GSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const VALID_USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

function extractFileId(input: string): { id: string; isSheet: boolean } | null {
  const s = input.trim();
  // Google Sheets URL: /spreadsheets/d/{ID}
  const sheetsMatch = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (sheetsMatch) return { id: sheetsMatch[1], isSheet: true };
  // Google Drive file URL: /file/d/{ID} or /open?id={ID} or /uc?id={ID}
  const fileMatch = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return { id: fileMatch[1], isSheet: false };
  const openMatch = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openMatch) return { id: openMatch[1], isSheet: false };
  // Bare ID (26+ chars, only base64url chars)
  if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) return { id: s, isSheet: false };
  return null;
}

function extractFileName(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const last = parts[parts.length - 1];
    if (last && last.includes(".")) return last;
  } catch {}
  return "";
}

function guessIsSheet(url: string): boolean {
  return url.includes("spreadsheets") || url.includes("docs.google.com/spreadsheets");
}

function detectFileType(url: string, name: string): "orders" | "suppliers" | "users" | "unknown" {
  const haystack = (url + " " + name).toLowerCase();
  if (haystack.includes("order")) return "orders";
  if (haystack.includes("supplier") || haystack.includes("vendor")) return "suppliers";
  if (haystack.includes("user")) return "users";
  return "unknown";
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

interface FileEntry {
  url: string;
  id: string;
  isSheet: boolean;
  type: "orders" | "suppliers" | "users" | "unknown";
  status: "pending" | "importing" | "success" | "error" | "skipped";
  message?: string;
}

export default function DriveImportScreen() {
  const { suppliers, addOrdersBatch, addSuppliersBatch, addUsersBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [urlInput, setUrlInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [importing, setImporting] = useState(false);

  function parseInput() {
    const lines = urlInput.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
    const parsed: FileEntry[] = [];
    for (const line of lines) {
      const info = extractFileId(line);
      if (!info) continue;
      const isSheet = info.isSheet || guessIsSheet(line);
      parsed.push({
        url: line,
        id: info.id,
        isSheet,
        type: detectFileType(line, ""),
        status: "pending",
      });
    }
    setEntries(parsed);
  }

  async function downloadAndParse(entry: FileEntry): Promise<XLSX.WorkBook> {
    // Use Google's public export URLs — works for "Anyone with the link" shared files
    let downloadUrl: string;
    if (entry.isSheet) {
      downloadUrl = `https://docs.google.com/spreadsheets/d/${entry.id}/export?format=xlsx`;
    } else {
      downloadUrl = `https://drive.google.com/uc?export=download&id=${entry.id}&confirm=t`;
    }

    const resp = await fetch(downloadUrl);
    if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status}). Make sure the file is shared as "Anyone with the link".`);
    const arrayBuffer = await resp.arrayBuffer();
    if (arrayBuffer.byteLength === 0) throw new Error("Downloaded file is empty.");
    return XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
  }

  async function importEntry(entry: FileEntry): Promise<{ message: string }> {
    const type = entry.type;
    if (type === "unknown") {
      return { message: "Could not detect file type. Add 'order', 'supplier', or 'user' to the URL description." };
    }

    const workbook = await downloadAndParse(entry);
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
          notes: `Imported from Drive`,
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
            userType: (VALID_USER_TYPES as string[]).includes(rawType) ? (rawType as UserType) : ("Vendor" as UserType),
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
    if (entries.length === 0) return;
    setImporting(true);
    setEntries((prev) => prev.map((e) => ({ ...e, status: "pending", message: undefined })));

    for (let i = 0; i < entries.length; i++) {
      setEntries((prev) => prev.map((e, idx) => idx === i ? { ...e, status: "importing" } : e));
      const entry = entries[i];
      try {
        if (entry.type === "unknown") {
          setEntries((prev) => prev.map((e, idx) => idx === i ? { ...e, status: "skipped", message: "Unknown type — include 'order', 'supplier', or 'user' in the URL or label." } : e));
          continue;
        }
        const { message } = await importEntry(entry);
        setEntries((prev) => prev.map((e, idx) => idx === i ? { ...e, status: "success", message } : e));
      } catch (err: any) {
        setEntries((prev) => prev.map((e, idx) => idx === i ? { ...e, status: "error", message: err?.message ?? "Failed to import." } : e));
      }
    }

    setImporting(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function setType(idx: number, type: FileEntry["type"]) {
    setEntries((prev) => prev.map((e, i) => i === idx ? { ...e, type } : e));
  }

  function removeEntry(idx: number) {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  }

  const hasResults = entries.some((e) => e.status !== "pending");
  const done = hasResults && !importing;
  const typeOptions: FileEntry["type"][] = ["orders", "suppliers", "users"];

  return (
    <>
      <Stack.Screen options={{ title: "Drive Import", headerBackTitle: "Back" }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* How-to banner */}
        <View style={styles.infoBanner}>
          <Feather name="info" size={15} color={Colors.primary} style={{ marginTop: 1 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.infoTitle}>How to use</Text>
            <Text style={styles.infoText}>
              1. Open the Google Sheet or file{"\n"}
              2. Click Share → "Anyone with the link" → Copy link{"\n"}
              3. Paste the link(s) below (one per line){"\n"}
              4. Tap Detect Files, set the type, then Import
            </Text>
          </View>
        </View>

        {/* URL input */}
        <View style={styles.inputCard}>
          <Text style={styles.inputLabel}>Paste Google Sheets / Drive file URLs</Text>
          <TextInput
            style={styles.textArea}
            value={urlInput}
            onChangeText={setUrlInput}
            placeholder={"https://docs.google.com/spreadsheets/d/...\nhttps://docs.google.com/spreadsheets/d/..."}
            placeholderTextColor={Colors.textMuted}
            multiline
            numberOfLines={5}
            autoCapitalize="none"
            autoCorrect={false}
            textAlignVertical="top"
          />
          <TouchableOpacity
            style={[styles.detectBtn, !urlInput.trim() && { opacity: 0.5 }]}
            onPress={parseInput}
            disabled={!urlInput.trim()}
            activeOpacity={0.8}
          >
            <Feather name="search" size={16} color={Colors.textInverse} />
            <Text style={styles.detectBtnText}>Detect Files</Text>
          </TouchableOpacity>
        </View>

        {/* File entries */}
        {entries.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{entries.length} file{entries.length !== 1 ? "s" : ""} detected</Text>

            {entries.map((entry, idx) => (
              <View key={idx} style={[
                styles.entryCard,
                entry.status === "success" && styles.entryCardSuccess,
                entry.status === "error" && styles.entryCardError,
                entry.status === "skipped" && styles.entryCardWarning,
              ]}>
                <View style={styles.entryTop}>
                  <View style={styles.entryLeft}>
                    {entry.status === "importing" ? (
                      <ActivityIndicator size="small" color={Colors.primary} />
                    ) : entry.status === "success" ? (
                      <Feather name="check-circle" size={18} color={Colors.success} />
                    ) : entry.status === "error" ? (
                      <Feather name="x-circle" size={18} color={Colors.danger} />
                    ) : entry.status === "skipped" ? (
                      <Feather name="minus-circle" size={18} color={Colors.warning} />
                    ) : (
                      <Feather name={entry.isSheet ? "grid" : "file"} size={18} color={Colors.primary} />
                    )}
                    <Text style={styles.entryId} numberOfLines={1}>
                      {entry.isSheet ? "Google Sheet" : "Drive File"} · {entry.id.slice(0, 12)}…
                    </Text>
                  </View>
                  {entry.status === "pending" && (
                    <TouchableOpacity onPress={() => removeEntry(idx)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Feather name="x" size={16} color={Colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>

                {/* Type selector */}
                {(entry.status === "pending" || entry.status === "skipped") && (
                  <View style={styles.typeRow}>
                    <Text style={styles.typeLabel}>Type:</Text>
                    {typeOptions.map((t) => (
                      <TouchableOpacity
                        key={t}
                        style={[styles.typeChip, entry.type === t && styles.typeChipActive]}
                        onPress={() => setType(idx, t)}
                      >
                        <Text style={[styles.typeChipText, entry.type === t && styles.typeChipTextActive]}>
                          {t.charAt(0).toUpperCase() + t.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {entry.message && (
                  <Text style={[
                    styles.entryMsg,
                    entry.status === "error" && { color: Colors.danger },
                    entry.status === "success" && { color: Colors.success },
                    entry.status === "skipped" && { color: Colors.warning },
                  ]}>
                    {entry.message}
                  </Text>
                )}
              </View>
            ))}

            {!hasResults && (
              <TouchableOpacity
                style={[styles.importBtn, (importing || entries.length === 0) && { opacity: 0.5 }]}
                onPress={runImport}
                disabled={importing || entries.length === 0}
                activeOpacity={0.8}
              >
                <Feather name="download-cloud" size={18} color={Colors.textInverse} />
                <Text style={styles.importBtnText}>
                  Import {entries.length} File{entries.length !== 1 ? "s" : ""}
                </Text>
              </TouchableOpacity>
            )}

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
  content: { padding: 20, gap: 16 },
  infoBanner: {
    flexDirection: "row", gap: 10, alignItems: "flex-start",
    backgroundColor: Colors.primaryMuted, borderRadius: 14, padding: 14,
  },
  infoTitle: { fontSize: 13, fontWeight: "700", color: Colors.primary, marginBottom: 4 },
  infoText: { fontSize: 12, color: Colors.primary, lineHeight: 20 },
  inputCard: {
    backgroundColor: Colors.surface, borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border, padding: 14, gap: 12,
  },
  inputLabel: { fontSize: 13, fontWeight: "700", color: Colors.text },
  textArea: {
    backgroundColor: Colors.surfaceSecondary, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 12, color: Colors.text, minHeight: 110, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  detectBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 12,
  },
  detectBtnText: { fontSize: 14, fontWeight: "700", color: Colors.textInverse },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: Colors.text },
  entryCard: {
    backgroundColor: Colors.surface, borderRadius: 14,
    borderWidth: 1.5, borderColor: Colors.border, padding: 14, gap: 10,
  },
  entryCardSuccess: { borderColor: Colors.success, backgroundColor: Colors.successLight + "60" },
  entryCardError: { borderColor: Colors.danger, backgroundColor: Colors.dangerLight + "60" },
  entryCardWarning: { borderColor: Colors.warning, backgroundColor: Colors.warningLight + "60" },
  entryTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  entryLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  entryId: { fontSize: 12, color: Colors.textSecondary, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", flex: 1 },
  typeRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  typeLabel: { fontSize: 12, fontWeight: "600", color: Colors.textMuted },
  typeChip: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20,
    backgroundColor: Colors.surfaceSecondary, borderWidth: 1.5, borderColor: Colors.border,
  },
  typeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeChipText: { fontSize: 12, fontWeight: "600", color: Colors.textSecondary },
  typeChipTextActive: { color: Colors.textInverse },
  entryMsg: { fontSize: 12, color: Colors.textSecondary, lineHeight: 18 },
  importBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 16,
  },
  importBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
  doneBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.success, borderRadius: 14, paddingVertical: 16,
  },
  doneBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
});
