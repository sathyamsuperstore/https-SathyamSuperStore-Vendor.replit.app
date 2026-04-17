import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  FlatList,
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
import { useApp, OrderItem, Supplier } from "@/context/AppContext";

interface ParsedRow {
  VendorCode: string;
  "Item No": string;
  "Item Description": string;
  UOM: string;
  MRP: number;
  "Order Qty": number;
  SyncDate: string;
  Brand: string;
  Beat: string;
  Stock: number;
  Min: number;
  SortNo: number;
  Notes: string;
}

interface VendorGroup {
  vendorCode: string;
  items: ParsedRow[];
  supplierId: string;
  syncDate?: string;
  beat?: string;
}

function parseExcelDate(val: unknown): string {
  if (val === null || val === undefined || val === "") return "";
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    return val.toISOString().split("T")[0];
  }
  if (typeof val === "number") {
    const ms = (val - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().split("T")[0];
  }
  const str = String(val).trim();
  if (!str) return "";
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return str;
}

function generateItemId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export default function ImportOrderScreen() {
  const { suppliers, addOrdersBatch } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [vendorGroups, setVendorGroups] = useState<VendorGroup[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  async function pickAndParse() {
    try {
      setLoading(true);
      setErrors([]);
      setVendorGroups([]);
      setFileName(null);

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

      let workbook: XLSX.WorkBook;

      if (Platform.OS === "web") {
        // On web, expo-document-picker gives a blob: URI — read via FileReader
        const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", asset.uri, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => resolve(xhr.response as ArrayBuffer);
          xhr.onerror = () => {
            // Fallback: try fetch if XHR fails
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

      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (rows.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      const requiredCols = ["VendorCode", "Item No", "Item Description", "UOM", "MRP", "Order Qty"];
      const firstRow = rows[0];
      const missing = requiredCols.filter((col) => !(col in firstRow));
      if (missing.length > 0) {
        setErrors([`Missing required columns: ${missing.join(", ")}`]);
        setLoading(false);
        return;
      }

      const parsed: ParsedRow[] = rows.map((row, i) => ({
        VendorCode: String(row["VendorCode"] ?? "").trim(),
        "Item No": String(row["Item No"] ?? "").trim(),
        "Item Description": String(row["Item Description"] ?? "").trim(),
        UOM: String(row["UOM"] ?? "pcs").trim(),
        MRP: parseFloat(String(row["MRP"] ?? "0")) || 0,
        "Order Qty": parseFloat(String(row["Order Qty"] ?? "0")) || 0,
        SyncDate: parseExcelDate(row["SyncDate"]),
        Brand: String(row["Brand"] ?? "").trim(),
        Beat: String(row["Beat"] ?? "").trim(),
        Stock: parseFloat(String(row["Stock"] ?? "0")) || 0,
        Min: parseFloat(String(row["Min"] ?? "")) || 0,
        SortNo: parseFloat(String(row["SortNo"] ?? "")) || 0,
        Notes: String(row["Notes"] ?? "").trim(),
      }));

      const validRows = parsed.filter((r) => r.VendorCode && r["Item Description"]);
      if (validRows.length === 0) {
        setErrors(["No valid rows found. Make sure VendorCode and Item Description are filled."]);
        setLoading(false);
        return;
      }

      const groupMap: Record<string, ParsedRow[]> = {};
      for (const row of validRows) {
        if (!groupMap[row.VendorCode]) groupMap[row.VendorCode] = [];
        groupMap[row.VendorCode].push(row);
      }

      const groups: VendorGroup[] = Object.entries(groupMap).map(([vendorCode, items]) => {
        const matchedSupplier = suppliers.find(
          (s) => s.vendorCode.toUpperCase() === vendorCode.trim().toUpperCase()
        ) ?? suppliers.find(
          (s) =>
            s.name.toLowerCase() === vendorCode.toLowerCase() ||
            s.contactName.toLowerCase() === vendorCode.toLowerCase()
        );
        return {
          vendorCode,
          items,
          supplierId: matchedSupplier?.id ?? "",
          syncDate: items[0]?.SyncDate || undefined,
          beat: items[0]?.Beat || undefined,
        };
      });

      setVendorGroups(groups);
    } catch (e: any) {
      const msg = e?.message ?? String(e) ?? "Unknown error";
      setErrors([`Failed to parse file: ${msg}`]);
    } finally {
      setLoading(false);
    }
  }

  function setGroupSupplier(vendorCode: string, supplierId: string) {
    setVendorGroups((prev) =>
      prev.map((g) => (g.vendorCode === vendorCode ? { ...g, supplierId } : g))
    );
  }

  function validateAndCreate() {
    const unmatched = vendorGroups.filter((g) => !g.supplierId);
    if (unmatched.length > 0) {
      Alert.alert("Missing Supplier", `Please select a supplier for: ${unmatched.map((g) => g.vendorCode).join(", ")}`);
      return;
    }

    const orderInputs = vendorGroups.map((group) => {
      const supplier = suppliers.find((s) => s.id === group.supplierId)!;
      const items: OrderItem[] = group.items.map((row) => ({
        id: generateItemId(),
        name: `${row["Item No"] ? row["Item No"] + " - " : ""}${row["Item Description"]}`,
        brand: row["Brand"] || undefined,
        quantity: row["Order Qty"] || 1,
        unit: row["UOM"] || "pcs",
        unitPrice: row["MRP"] || 0,
        stock: row["Stock"] !== 0 ? row["Stock"] : undefined,
        min: row["Min"] !== 0 ? row["Min"] : undefined,
        sortNo: row["SortNo"] !== 0 ? row["SortNo"] : undefined,
        notes: row["Notes"] || undefined,
      }));
      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        status: "pending" as const,
        items,
        notes: `Imported from ${fileName ?? "Excel file"} · Vendor Code: ${group.vendorCode}`,
        expectedDelivery: addDays(7),
        syncDate: group.syncDate,
        beat: group.beat,
      };
    });
    addOrdersBatch(orderInputs);

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const successMsg = `${vendorGroups.length} order${vendorGroups.length > 1 ? "s" : ""} created successfully.`;
    if (Platform.OS === "web") {
      window.alert(`Orders Created\n\n${successMsg}`);
      router.back();
    } else {
      Alert.alert("Orders Created", successMsg, [{ text: "OK", onPress: () => router.back() }]);
    }
  }

  const totalItems = vendorGroups.reduce((s, g) => s + g.items.length, 0);
  const totalValue = vendorGroups.reduce(
    (s, g) => s + g.items.reduce((is, i) => is + i.MRP * i["Order Qty"], 0),
    0
  );

  return (
    <>
      <Stack.Screen options={{ title: "Import from Excel", headerBackTitle: "Back" }} />
      <View style={[styles.container, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) }]}>
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
                <Text style={styles.dropHint}>Supports .xlsx and .xls files</Text>
                <View style={styles.columnsList}>
                  {["VendorCode", "Item No", "Item Description", "UOM", "MRP", "Min", "Order Qty"].map((col) => (
                    <View key={col} style={styles.colChip}>
                      <Text style={styles.colChipText}>{col}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}
          </TouchableOpacity>

          {errors.length > 0 && (
            <View style={styles.errorCard}>
              <Feather name="alert-circle" size={16} color={Colors.danger} />
              <View style={{ flex: 1 }}>
                {errors.map((e, i) => (
                  <Text key={i} style={styles.errorText}>{e}</Text>
                ))}
              </View>
            </View>
          )}

          {vendorGroups.length > 0 && (
            <>
              <View style={styles.summaryRow}>
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{vendorGroups.length}</Text>
                  <Text style={styles.summaryLabel}>Vendor{vendorGroups.length > 1 ? "s" : ""}</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{totalItems}</Text>
                  <Text style={styles.summaryLabel}>Items</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{formatCurrency(totalValue)}</Text>
                  <Text style={styles.summaryLabel}>Total Value</Text>
                </View>
              </View>

              {vendorGroups.map((group) => (
                <VendorGroupCard
                  key={group.vendorCode}
                  group={group}
                  suppliers={suppliers}
                  onSelectSupplier={(sid) => setGroupSupplier(group.vendorCode, sid)}
                />
              ))}
            </>
          )}
        </ScrollView>

        {vendorGroups.length > 0 && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
            <TouchableOpacity style={styles.createBtn} onPress={validateAndCreate}>
              <Feather name="check-circle" size={18} color={Colors.textInverse} />
              <Text style={styles.createBtnText}>
                Create {vendorGroups.length} Order{vendorGroups.length > 1 ? "s" : ""}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </>
  );
}

function VendorGroupCard({
  group,
  suppliers,
  onSelectSupplier,
}: {
  group: VendorGroup;
  suppliers: Supplier[];
  onSelectSupplier: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const subtotal = group.items.reduce((s, i) => s + i.MRP * i["Order Qty"], 0);
  const selectedSupplier = suppliers.find((s) => s.id === group.supplierId);
  const isAutoMatched = selectedSupplier?.vendorCode.toUpperCase() === group.vendorCode.trim().toUpperCase();
  const isUnmatched = !group.supplierId;

  return (
    <View style={[groupStyles.card, isUnmatched && groupStyles.cardUnmatched]}>
      <TouchableOpacity style={groupStyles.header} onPress={() => setExpanded((e) => !e)} activeOpacity={0.7}>
        <View style={groupStyles.headerLeft}>
          <View style={groupStyles.vendorBadge}>
            <Text style={groupStyles.vendorCode}>{group.vendorCode}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={groupStyles.itemCount}>{group.items.length} item{group.items.length !== 1 ? "s" : ""}</Text>
            <Text style={groupStyles.subtotal}>{formatCurrency(subtotal)}</Text>
          </View>
          {isAutoMatched ? (
            <View style={groupStyles.matchBadge}>
              <Feather name="check-circle" size={11} color={Colors.success} />
              <Text style={groupStyles.matchBadgeText}>Auto-matched</Text>
            </View>
          ) : isUnmatched ? (
            <View style={groupStyles.unmatchedBadge}>
              <Feather name="alert-circle" size={11} color={Colors.warning} />
              <Text style={groupStyles.unmatchedBadgeText}>Select supplier</Text>
            </View>
          ) : null}
        </View>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={18} color={Colors.textMuted} />
      </TouchableOpacity>

      <View style={groupStyles.supplierRow}>
        <Feather name="link" size={14} color={isUnmatched ? Colors.warning : Colors.textMuted} />
        <Text style={groupStyles.supplierLabel}>Linked supplier:</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={groupStyles.supplierOptions}>
          {suppliers.map((s) => (
            <TouchableOpacity
              key={s.id}
              style={[groupStyles.supplierBtn, group.supplierId === s.id && groupStyles.supplierBtnActive]}
              onPress={() => onSelectSupplier(s.id)}
            >
              {s.vendorCode ? (
                <Text style={[groupStyles.supplierBtnCode, group.supplierId === s.id && groupStyles.supplierBtnCodeActive]}>
                  {s.vendorCode}
                </Text>
              ) : null}
              <Text style={[groupStyles.supplierBtnText, group.supplierId === s.id && groupStyles.supplierBtnTextActive]}>
                {s.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {expanded && (
        <View style={groupStyles.itemsTable}>
          <View style={groupStyles.tableHeader}>
            <Text style={[groupStyles.tableCell, groupStyles.cellDesc]}>Description</Text>
            <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>Qty</Text>
            <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>UOM</Text>
            <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>MRP</Text>
          </View>
          {group.items.map((item, i) => (
            <View key={i} style={[groupStyles.tableRow, i % 2 === 0 && groupStyles.tableRowAlt]}>
              <View style={[groupStyles.tableCellWrap, groupStyles.cellDesc]}>
                {item["Item No"] ? <Text style={groupStyles.itemNo}>{item["Item No"]}</Text> : null}
                <Text style={groupStyles.tableCell}>{item["Item Description"]}</Text>
              </View>
              <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>{item["Order Qty"]}</Text>
              <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>{item["UOM"]}</Text>
              <Text style={[groupStyles.tableCell, groupStyles.cellNum, groupStyles.cellPrice]}>
                {formatCurrency(item["MRP"])}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const groupStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 12,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  vendorBadge: {
    backgroundColor: Colors.primaryMuted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  vendorCode: { fontSize: 13, fontWeight: "800", color: Colors.primary },
  itemCount: { fontSize: 13, fontWeight: "600", color: Colors.text },
  subtotal: { fontSize: 12, color: Colors.textMuted },
  cardUnmatched: { borderColor: Colors.warning, borderWidth: 1.5 },
  matchBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: Colors.successLight,
  },
  matchBadgeText: { fontSize: 10, fontWeight: "700", color: Colors.success },
  unmatchedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: Colors.warningLight,
  },
  unmatchedBadgeText: { fontSize: 10, fontWeight: "700", color: Colors.warning },
  supplierBtnCode: {
    fontSize: 9,
    fontWeight: "800",
    color: Colors.primary,
    textTransform: "uppercase",
    marginBottom: 1,
  },
  supplierBtnCodeActive: { color: Colors.textInverse },
  supplierRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  supplierLabel: { fontSize: 12, color: Colors.textMuted, fontWeight: "500" },
  supplierOptions: { gap: 6, paddingVertical: 2 },
  supplierBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    minWidth: 60,
  },
  supplierBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  supplierBtnText: { fontSize: 12, fontWeight: "600", color: Colors.textSecondary },
  supplierBtnTextActive: { color: Colors.textInverse },
  itemsTable: {},
  tableHeader: {
    flexDirection: "row",
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tableRow: {
    flexDirection: "row",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  tableRowAlt: { backgroundColor: Colors.background },
  tableCellWrap: { justifyContent: "center" },
  tableCell: { fontSize: 12, color: Colors.text },
  itemNo: { fontSize: 10, color: Colors.textMuted, marginBottom: 2 },
  cellDesc: { flex: 3 },
  cellNum: { flex: 1, textAlign: "right" },
  cellPrice: { color: Colors.primary, fontWeight: "700" },
});

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
  fileName: { fontSize: 15, fontWeight: "700", color: Colors.text, textAlign: "center" },
  fileHint: { fontSize: 12, color: Colors.textMuted },
  columnsList: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 8 },
  colChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: Colors.primaryMuted,
  },
  colChipText: { fontSize: 11, fontWeight: "600", color: Colors.primary },
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
  summaryValue: { fontSize: 18, fontWeight: "800", color: Colors.text, marginBottom: 2 },
  summaryLabel: { fontSize: 11, color: Colors.textMuted, fontWeight: "500" },
  summaryDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 8 },
  footer: {
    padding: 16,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  createBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  createBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
});
