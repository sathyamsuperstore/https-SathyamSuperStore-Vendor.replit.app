import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useRouter, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { File as FsFile } from "expo-file-system";
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

// Detect the most-likely separator on the header line: tab > pipe > semicolon > comma.
// We pick whichever produces the most fields (and at least 2).
function detectSeparator(headerLine: string): string {
  const candidates = ["\t", "|", ";", ","];
  let best = "\t";
  let bestCount = 0;
  for (const sep of candidates) {
    const count = splitDelimited(headerLine, sep).length;
    if (count > bestCount) {
      bestCount = count;
      best = sep;
    }
  }
  return bestCount >= 2 ? best : "\t";
}

// CSV-aware split that handles double-quoted fields containing the separator.
// For tab/pipe/semicolon files this still works correctly.
function splitDelimited(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Parse a TXT/TSV/CSV string into rows of {header: value} objects, matching the
// shape that XLSX.utils.sheet_to_json produces so the rest of the import flow
// (validation, vendor grouping, supplier matching) works unchanged.
function parseDelimitedText(text: string): Record<string, string>[] {
  // Strip BOM and normalise newlines.
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rawLines = cleaned.split("\n");
  // Drop trailing empty lines.
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") {
    rawLines.pop();
  }
  if (rawLines.length === 0) return [];

  const sep = detectSeparator(rawLines[0]);
  const headers = splitDelimited(rawLines[0], sep).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim() === "") continue;
    const cells = splitDelimited(line, sep);
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = (cells[c] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
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
  const { suppliers, addOrdersBatchAsync } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ format?: string }>();
  const isTxtMode = params.format === "txt";

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [vendorGroups, setVendorGroups] = useState<VendorGroup[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  // Creating-orders flow (separate from parse `loading` so the lists stay
  // visible while the footer button shows progress).
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState<string>("");
  // Synchronous mutex: setCreating is async-scheduled, so two rapid taps can
  // both pass the `if (creating) return` check before the next render. The
  // ref flips synchronously and prevents duplicate order creation.
  const creatingRef = useRef(false);
  // Cancel-in-progress flow. `canCancel` controls whether the Cancel button
  // is visible (true while we're still building inputs / before the point of
  // no return). `cancelRequested` reflects that the user has tapped Cancel
  // and we're waiting for the next chunk boundary to bail out — used purely
  // for UI feedback (disabled button + "Canceling..." label). The ref flips
  // synchronously so the loop can check it without waiting for re-render.
  const [canCancel, setCanCancel] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);
  // Brief confirmation banner shown after a successful cancel so the user
  // knows nothing was saved. Auto-dismisses after a few seconds; we keep a
  // ref to the timeout so we can cancel it on unmount or when the user
  // starts another action / dismisses manually.
  const [showCanceled, setShowCanceled] = useState(false);
  const canceledTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);

  const clearCanceledMessage = useCallback(() => {
    if (canceledTimeoutRef.current) {
      clearTimeout(canceledTimeoutRef.current);
      canceledTimeoutRef.current = null;
    }
    setShowCanceled(false);
  }, []);

  // Cleanup the auto-dismiss timer if the screen unmounts mid-countdown.
  useEffect(() => {
    return () => {
      if (canceledTimeoutRef.current) {
        clearTimeout(canceledTimeoutRef.current);
        canceledTimeoutRef.current = null;
      }
    };
  }, []);

  // Helper: yield to UI thread so spinner/progress can render between heavy steps.
  // Without this, Android's ANR watchdog can kill the JS thread on large files.
  const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

  async function pickAndParse() {
    try {
      setLoading(true);
      setProgress("Opening file picker...");
      setErrors([]);
      setVendorGroups([]);
      setFileName(null);
      setSearchQuery("");
      setUnmatchedOnly(false);
      // Picking a new file is a fresh action — clear any leftover cancel
      // confirmation from a previous attempt.
      clearCanceledMessage();

      const pickerTypes = isTxtMode
        ? ["text/plain", "text/tab-separated-values", "text/csv", "application/octet-stream", "*/*"]
        : [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "application/octet-stream",
            "*/*",
          ];

      const result = await DocumentPicker.getDocumentAsync({
        type: pickerTypes,
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        setLoading(false);
        setProgress("");
        return;
      }

      const asset = result.assets[0];
      setFileName(asset.name);
      setProgress("Reading file...");
      await yieldToUI();

      let rows: Record<string, unknown>[];

      if (isTxtMode) {
        // TXT / TSV / CSV path — read as UTF-8 string and parse with our own
        // delimited-text parser (auto-detects tab / pipe / semicolon / comma).
        let text = "";
        if (Platform.OS === "web") {
          const resp = await fetch(asset.uri);
          text = await resp.text();
        } else {
          try {
            text = await FileSystem.readAsStringAsync(asset.uri, {
              encoding: "utf8" as any,
            });
          } catch {
            // Fallback: read as base64 then decode (rare on Android with content://).
            const b64 = await FileSystem.readAsStringAsync(asset.uri, {
              encoding: "base64" as any,
            });
            if (!b64) throw new Error("Could not read file content.");
            const bin = globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, "base64").toString("binary");
            text = bin;
          }
        }
        if (!text || text.trim() === "") {
          throw new Error("The text file is empty.");
        }
        await yieldToUI();
        setProgress("Parsing text file...");
        await yieldToUI();
        rows = parseDelimitedText(text);
      } else {
        let workbook: XLSX.WorkBook;

        if (Platform.OS === "web") {
          // On web, expo-document-picker gives a blob: URI — read via XHR
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
          setProgress("Parsing spreadsheet...");
          await yieldToUI();
          workbook = XLSX.read(new Uint8Array(arrayBuffer), {
            type: "array",
            cellFormula: false,
            cellHTML: false,
            cellStyles: false,
            cellNF: false,
            cellText: false,
          });
        } else {
          // Prefer the new File API which reads raw bytes directly — much faster
          // than base64 on Android (no double-encoding, no JS string allocation).
          let bytes: Uint8Array | null = null;
          try {
            const f = new FsFile(asset.uri);
            const ab = await f.arrayBuffer();
            bytes = new Uint8Array(ab);
          } catch {
            // Fallback: legacy base64 read for content:// or older Android paths
            const base64 = await FileSystem.readAsStringAsync(asset.uri, {
              encoding: "base64" as any,
            });
            if (!base64 || base64.length === 0) {
              throw new Error("Could not read file content. Make sure the file is a valid Excel file.");
            }
            await yieldToUI();
            setProgress("Parsing spreadsheet...");
            await yieldToUI();
            workbook = XLSX.read(base64, {
              type: "base64",
              cellFormula: false,
              cellHTML: false,
              cellStyles: false,
              cellNF: false,
              cellText: false,
            });
            bytes = null;
          }

          if (bytes) {
            await yieldToUI();
            setProgress("Parsing spreadsheet...");
            await yieldToUI();
            workbook = XLSX.read(bytes, {
              type: "array",
              cellFormula: false,
              cellHTML: false,
              cellStyles: false,
              cellNF: false,
              cellText: false,
            });
          } else {
            // workbook already assigned in fallback path
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            workbook = workbook!;
          }
        }

        await yieldToUI();
        setProgress("Reading rows...");
        await yieldToUI();

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      }

      if (rows.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        setProgress("");
        return;
      }

      const requiredCols = ["VendorCode", "Item No", "Item Description", "UOM", "MRP", "Order Qty"];
      const firstRow = rows[0];
      const missing = requiredCols.filter((col) => !(col in firstRow));
      if (missing.length > 0) {
        setErrors([`Missing required columns: ${missing.join(", ")}`]);
        setLoading(false);
        setProgress("");
        return;
      }

      setProgress(`Processing ${rows.length} rows...`);
      await yieldToUI();

      // Process rows in chunks so we yield to the UI thread on very large files.
      const CHUNK = 500;
      const parsed: ParsedRow[] = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        parsed[i] = {
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
        };
        if (i > 0 && i % CHUNK === 0) {
          setProgress(`Processing ${i} / ${rows.length} rows...`);
          await yieldToUI();
        }
      }

      const validRows = parsed.filter((r) => r.VendorCode && r["Item Description"]);
      if (validRows.length === 0) {
        setErrors(["No valid rows found. Make sure VendorCode and Item Description are filled."]);
        setLoading(false);
        setProgress("");
        return;
      }

      await yieldToUI();
      setProgress("Grouping by vendor...");
      await yieldToUI();

      const groupMap: Record<string, ParsedRow[]> = Object.create(null);
      for (const row of validRows) {
        if (!groupMap[row.VendorCode]) groupMap[row.VendorCode] = [];
        groupMap[row.VendorCode].push(row);
      }

      // Pre-build supplier lookup maps once — turns the per-group match from
      // O(suppliers) to O(1). Without this, large vendor counts × supplier
      // counts can take seconds and trigger the Android ANR watchdog.
      const supplierByCode = new Map<string, Supplier>();
      const supplierByNameOrContact = new Map<string, Supplier>();
      for (const s of suppliers) {
        if (s.vendorCode) supplierByCode.set(s.vendorCode.toUpperCase(), s);
        if (s.name) supplierByNameOrContact.set(s.name.toLowerCase(), s);
        if (s.contactName) supplierByNameOrContact.set(s.contactName.toLowerCase(), s);
      }

      const entries = Object.entries(groupMap);
      const groups: VendorGroup[] = new Array(entries.length);
      const GROUP_CHUNK = 200;
      for (let i = 0; i < entries.length; i++) {
        const [vendorCode, items] = entries[i];
        const upper = vendorCode.trim().toUpperCase();
        const lower = vendorCode.toLowerCase();
        const matchedSupplier = supplierByCode.get(upper) ?? supplierByNameOrContact.get(lower);
        groups[i] = {
          vendorCode,
          items,
          supplierId: matchedSupplier?.id ?? "",
          syncDate: items[0]?.SyncDate || undefined,
          beat: items[0]?.Beat || undefined,
        };
        if (i > 0 && i % GROUP_CHUNK === 0) {
          setProgress(`Grouping vendor ${i} / ${entries.length}...`);
          await yieldToUI();
        }
      }

      setProgress(`Preparing display for ${groups.length} vendor${groups.length > 1 ? "s" : ""}...`);
      await yieldToUI();
      setVendorGroups(groups);
      // Yield so the initial render commits before we clear the progress text.
      await yieldToUI();
      setProgress("");
    } catch (e: any) {
      const msg = e?.message ?? String(e) ?? "Unknown error";
      setErrors([`Failed to parse file: ${msg}`]);
      setProgress("");
    } finally {
      setLoading(false);
    }
  }

  // Stable reference so React.memo on VendorGroupCard actually skips re-renders
  // when other parent state changes (otherwise an inline closure here would
  // create a new prop identity for every card on every render).
  const setGroupSupplier = useCallback((vendorCode: string, supplierId: string) => {
    setVendorGroups((prev) =>
      prev.map((g) => (g.vendorCode === vendorCode ? { ...g, supplierId } : g))
    );
  }, []);

  // Stable callbacks for FlatList so React.memo on VendorGroupCard can skip
  // re-renders when other parent state (loading, progress, etc.) changes.
  const keyExtractor = useCallback((g: VendorGroup) => g.vendorCode, []);
  const renderVendorGroup = useCallback(
    ({ item }: { item: VendorGroup }) => (
      <VendorGroupCard
        group={item}
        suppliers={suppliers}
        onSelectSupplier={setGroupSupplier}
      />
    ),
    [suppliers, setGroupSupplier]
  );

  // Tap handler for the Cancel button. Flips the synchronous ref so the
  // build loop bails at the next chunk boundary, plus state for UI feedback.
  const requestCancel = useCallback(() => {
    if (!cancelRef.current) {
      cancelRef.current = true;
      setCancelRequested(true);
    }
  }, []);

  async function validateAndCreate() {
    // Synchronous guard against double-tap (state-based check would race).
    if (creatingRef.current) return;
    const unmatched = vendorGroups.filter((g) => !g.supplierId);
    if (unmatched.length > 0) {
      Alert.alert("Missing Supplier", `Please select a supplier for: ${unmatched.map((g) => g.vendorCode).join(", ")}`);
      return;
    }
    creatingRef.current = true;
    cancelRef.current = false;
    // Re-tapping Create is a fresh action — clear any stale cancel banner.
    clearCanceledMessage();
    // Set true only at an early-return cancel checkpoint, so `finally` knows
    // unambiguously that we bailed out before the persist call ran. This is
    // strictly safer than reading `cancelRef.current` in `finally`, which
    // could in theory be set after the point-of-no-return.
    let canceledBeforePersist = false;

    try {
      setCreating(true);
      setCanCancel(true);
      setCancelRequested(false);
      const total = vendorGroups.length;
      setCreateProgress(`Preparing ${total} order${total > 1 ? "s" : ""}...`);
      // Yield once so the spinner appears before we start building inputs.
      await yieldToUI();
      if (cancelRef.current) {
        canceledBeforePersist = true;
        return;
      }

      // Build a fast supplier lookup so we don't scan suppliers per group.
      const supplierById = new Map<string, Supplier>();
      for (const s of suppliers) supplierById.set(s.id, s);

      const orderInputs: ReturnType<typeof buildInput>[] = new Array(total);
      function buildInput(group: VendorGroup) {
        const supplier = supplierById.get(group.supplierId)!;
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
      }

      // Build inputs in chunks so the UI thread can paint progress between batches.
      // Each chunk boundary is also a cancel checkpoint — if the user tapped
      // Cancel, bail out before doing more work and before persisting anything.
      const BUILD_CHUNK = 50;
      for (let i = 0; i < total; i++) {
        orderInputs[i] = buildInput(vendorGroups[i]);
        // Report at clean milestones: 50/N, 100/N, ...
        if ((i + 1) % BUILD_CHUNK === 0 && i + 1 < total) {
          setCreateProgress(`Preparing ${i + 1} / ${total} orders...`);
          await yieldToUI();
          if (cancelRef.current) {
            canceledBeforePersist = true;
            return;
          }
        }
      }

      // Final cancel checkpoint right before the point of no return. After
      // this we hide the Cancel button — addOrdersBatchAsync persists rows
      // and we can't safely interrupt it.
      if (cancelRef.current) {
        canceledBeforePersist = true;
        return;
      }
      setCanCancel(false);

      setCreateProgress(`Saving ${total} order${total > 1 ? "s" : ""}...`);
      await yieldToUI();

      await addOrdersBatchAsync(orderInputs, async (processed, t) => {
        setCreateProgress(`Saving ${processed} / ${t} orders...`);
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const successMsg = `${total} order${total > 1 ? "s" : ""} created successfully.`;
      if (Platform.OS === "web") {
        window.alert(`Orders Created\n\n${successMsg}`);
        router.back();
      } else {
        Alert.alert("Orders Created", successMsg, [{ text: "OK", onPress: () => router.back() }]);
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e) ?? "Unknown error";
      Alert.alert("Failed to Create Orders", msg);
    } finally {
      setCreating(false);
      setCreateProgress("");
      setCanCancel(false);
      setCancelRequested(false);
      creatingRef.current = false;
      cancelRef.current = false;
      // Only show the banner if we actually returned at one of the early
      // cancel checkpoints — never after a successful save or a thrown error,
      // even in the (very rare) case where cancelRef was flipped late.
      if (canceledBeforePersist) {
        // Show the inline confirmation and auto-dismiss after a few seconds.
        // Replace any previous timer so the banner shows for the full duration.
        if (canceledTimeoutRef.current) {
          clearTimeout(canceledTimeoutRef.current);
        }
        setShowCanceled(true);
        canceledTimeoutRef.current = setTimeout(() => {
          setShowCanceled(false);
          canceledTimeoutRef.current = null;
        }, 4000);
      }
    }
  }

  const totalItems = vendorGroups.reduce((s, g) => s + g.items.length, 0);
  const totalValue = vendorGroups.reduce(
    (s, g) => s + g.items.reduce((is, i) => is + i.MRP * i["Order Qty"], 0),
    0
  );
  const unmatchedCount = useMemo(
    () => vendorGroups.reduce((n, g) => (g.supplierId ? n : n + 1), 0),
    [vendorGroups]
  );

  // Filter the vendor groups for display only — totals above and the
  // "Create N Orders" button below still operate on the full list.
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q && !unmatchedOnly) return vendorGroups;
    return vendorGroups.filter((g) => {
      if (unmatchedOnly && g.supplierId) return false;
      if (q && !g.vendorCode.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [vendorGroups, searchQuery, unmatchedOnly]);

  const isFiltering = searchQuery.trim().length > 0 || unmatchedOnly;

  return (
    <>
      <Stack.Screen
        options={{
          title: isTxtMode ? "Import from Text File" : "Import from Excel",
          headerBackTitle: "Back",
        }}
      />
      <View style={[styles.container, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) }]}>
        <FlatList
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          data={filteredGroups}
          keyExtractor={keyExtractor}
          renderItem={renderVendorGroup}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          // Virtualization tuning: keep memory bounded on huge imports (500+
          // vendors) by only mounting cards near the viewport. Defaults are
          // already reasonable; these values just make the trade-off explicit.
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={11}
          removeClippedSubviews={Platform.OS === "android"}
          ListHeaderComponent={
            <View style={styles.headerStack}>
              <TouchableOpacity
                style={[styles.dropZone, !!fileName && styles.dropZoneSuccess]}
                onPress={pickAndParse}
                activeOpacity={0.7}
              >
                {loading ? (
                  <>
                    <ActivityIndicator color={Colors.primary} size="large" />
                    {progress ? <Text style={styles.progressText}>{progress}</Text> : null}
                  </>
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
                      {isTxtMode ? "Tap to select text file" : "Tap to select Excel file"}
                    </Text>
                    <Text style={styles.dropHint}>
                      {isTxtMode
                        ? "Supports .txt, .tsv, .csv (tab, comma, pipe or semicolon separated)"
                        : "Supports .xlsx and .xls files"}
                    </Text>
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
              )}

              {vendorGroups.length > 0 && (
                <View style={styles.filterStack}>
                  <View style={styles.searchWrap}>
                    <Feather name="search" size={15} color={Colors.textMuted} />
                    <TextInput
                      style={styles.searchInput}
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Search vendor code…"
                      placeholderTextColor={Colors.textMuted}
                      autoCorrect={false}
                      autoCapitalize="none"
                      clearButtonMode="while-editing"
                    />
                    {searchQuery.length > 0 && Platform.OS !== "ios" && (
                      <TouchableOpacity
                        onPress={() => setSearchQuery("")}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Feather name="x" size={14} color={Colors.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>

                  <View style={styles.filterChipsRow}>
                    <TouchableOpacity
                      style={[styles.filterChip, unmatchedOnly && styles.filterChipActive]}
                      onPress={() => setUnmatchedOnly((v) => !v)}
                      activeOpacity={0.7}
                    >
                      <Feather
                        name="alert-circle"
                        size={12}
                        color={unmatchedOnly ? Colors.textInverse : Colors.warning}
                      />
                      <Text
                        style={[
                          styles.filterChipText,
                          unmatchedOnly && styles.filterChipTextActive,
                        ]}
                      >
                        Needs supplier
                      </Text>
                      <View
                        style={[
                          styles.filterChipBadge,
                          unmatchedOnly && styles.filterChipBadgeActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.filterChipBadgeText,
                            unmatchedOnly && styles.filterChipBadgeTextActive,
                          ]}
                        >
                          {unmatchedCount}
                        </Text>
                      </View>
                    </TouchableOpacity>

                    {isFiltering && (
                      <Text style={styles.filterCountLabel}>
                        Showing {filteredGroups.length} of {vendorGroups.length}
                      </Text>
                    )}
                  </View>

                  {isFiltering && filteredGroups.length === 0 && (
                    <View style={styles.emptyFilter}>
                      <Feather name="search" size={20} color={Colors.textMuted} />
                      <Text style={styles.emptyFilterText}>
                        No vendors match the current filter.
                      </Text>
                      <TouchableOpacity
                        onPress={() => {
                          setSearchQuery("");
                          setUnmatchedOnly(false);
                        }}
                      >
                        <Text style={styles.emptyFilterClear}>Clear filters</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}
            </View>
          }
        />

        {vendorGroups.length > 0 && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
            {creating && createProgress ? (
              <Text style={styles.createProgressText}>{createProgress}</Text>
            ) : null}
            {showCanceled && !creating && (
              <View style={styles.canceledBanner}>
                <Feather name="info" size={14} color={Colors.textMuted} />
                <Text style={styles.canceledBannerText}>
                  Canceled — no orders saved
                </Text>
                <TouchableOpacity
                  onPress={clearCanceledMessage}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Dismiss canceled message"
                >
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.footerActions}>
              <TouchableOpacity
                style={[styles.createBtn, creating && styles.createBtnDisabled]}
                onPress={validateAndCreate}
                disabled={creating}
                activeOpacity={creating ? 1 : 0.7}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={Colors.textInverse} />
                ) : (
                  <Feather name="check-circle" size={18} color={Colors.textInverse} />
                )}
                <Text style={styles.createBtnText}>
                  {creating
                    ? `Creating ${vendorGroups.length} Order${vendorGroups.length > 1 ? "s" : ""}...`
                    : `Create ${vendorGroups.length} Order${vendorGroups.length > 1 ? "s" : ""}`}
                </Text>
              </TouchableOpacity>
              {creating && canCancel && (
                <TouchableOpacity
                  style={[styles.cancelBtn, cancelRequested && styles.cancelBtnDisabled]}
                  onPress={requestCancel}
                  disabled={cancelRequested}
                  activeOpacity={cancelRequested ? 1 : 0.7}
                >
                  <Feather name="x" size={16} color={Colors.danger} />
                  <Text style={styles.cancelBtnText}>
                    {cancelRequested ? "Canceling..." : "Cancel"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
      </View>
    </>
  );
}

const VendorGroupCard = React.memo(function VendorGroupCard({
  group,
  suppliers,
  onSelectSupplier,
}: {
  group: VendorGroup;
  suppliers: Supplier[];
  onSelectSupplier: (vendorCode: string, supplierId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Lazy-render the supplier picker: by default we render only the linked
  // supplier (1 button). Without this, every card eagerly rendered all
  // suppliers, causing 1000s of TouchableOpacity components on first paint
  // and freezing the JS thread for many seconds on Android.
  // Default: open the picker for unmatched groups so the user can pick one.
  const [pickerOpen, setPickerOpen] = useState(!group.supplierId);
  // Re-sync the picker if group.supplierId changes externally — e.g. if React
  // reuses a card instance across imports with the same vendorCode key.
  // Without this, an unmatched card carried over from a previous render could
  // stay collapsed even though the user needs to pick a supplier.
  useEffect(() => {
    if (!group.supplierId) setPickerOpen(true);
  }, [group.supplierId]);
  const PREVIEW_LIMIT = 50;
  const subtotal = group.items.reduce((s, i) => s + i.MRP * i["Order Qty"], 0);
  const previewItems = group.items.slice(0, PREVIEW_LIMIT);
  const hiddenCount = group.items.length - previewItems.length;
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
        {!pickerOpen ? (
          // Compact: linked supplier as a single chip + a "Change" button.
          <View style={groupStyles.supplierCompactRow}>
            {selectedSupplier ? (
              <View style={[groupStyles.supplierBtn, groupStyles.supplierBtnActive]}>
                {selectedSupplier.vendorCode ? (
                  <Text style={[groupStyles.supplierBtnCode, groupStyles.supplierBtnCodeActive]}>
                    {selectedSupplier.vendorCode}
                  </Text>
                ) : null}
                <Text style={[groupStyles.supplierBtnText, groupStyles.supplierBtnTextActive]}>
                  {selectedSupplier.name}
                </Text>
              </View>
            ) : (
              <Text style={groupStyles.supplierNone}>None</Text>
            )}
            <TouchableOpacity style={groupStyles.changeBtn} onPress={() => setPickerOpen(true)}>
              <Feather name="edit-2" size={12} color={Colors.primary} />
              <Text style={groupStyles.changeBtnText}>Change</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Expanded: full supplier picker (only mounted on demand).
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={groupStyles.supplierOptions}>
            {suppliers.map((s) => (
              <TouchableOpacity
                key={s.id}
                style={[groupStyles.supplierBtn, group.supplierId === s.id && groupStyles.supplierBtnActive]}
                onPress={() => {
                  onSelectSupplier(group.vendorCode, s.id);
                  setPickerOpen(false);
                }}
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
        )}
      </View>

      {expanded && (
        <View style={groupStyles.itemsTable}>
          <View style={groupStyles.tableHeader}>
            <Text style={[groupStyles.tableCell, groupStyles.cellDesc]}>Description</Text>
            <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>Qty</Text>
            <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>UOM</Text>
            <Text style={[groupStyles.tableCell, groupStyles.cellNum]}>MRP</Text>
          </View>
          {previewItems.map((item, i) => (
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
          {hiddenCount > 0 && (
            <View style={groupStyles.moreRow}>
              <Feather name="more-horizontal" size={14} color={Colors.textMuted} />
              <Text style={groupStyles.moreText}>
                +{hiddenCount} more item{hiddenCount > 1 ? "s" : ""} (all will be imported)
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
});

const groupStyles = StyleSheet.create({
  supplierCompactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    flexWrap: "wrap",
  },
  supplierNone: { fontSize: 12, color: Colors.warning, fontStyle: "italic" },
  changeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  changeBtnText: { fontSize: 11, fontWeight: "700", color: Colors.primary },
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
  moreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: Colors.surfaceSecondary,
  },
  moreText: { fontSize: 12, color: Colors.textMuted, fontStyle: "italic" },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, gap: 16, paddingBottom: 24 },
  // Container for dropZone + errors + summary inside FlatList's header.
  // Mirrors the `gap: 16` from `scrollContent` so spacing between those blocks
  // stays the same now that the parent is a FlatList instead of a ScrollView.
  headerStack: { gap: 16 },
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
  progressText: { fontSize: 13, fontWeight: "600", color: Colors.primary, marginTop: 8, textAlign: "center" },
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
  footerActions: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 10,
  },
  createBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  createBtnDisabled: { opacity: 0.7 },
  createBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
  cancelBtn: {
    paddingHorizontal: 16,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: Colors.danger,
    backgroundColor: Colors.surface,
  },
  cancelBtnDisabled: { opacity: 0.6 },
  cancelBtnText: { fontSize: 14, fontWeight: "700", color: Colors.danger },
  createProgressText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textMuted,
    textAlign: "center",
    marginBottom: 8,
  },
  canceledBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 10,
  },
  canceledBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  filterStack: { gap: 10 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 4,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.text,
    paddingVertical: Platform.OS === "ios" ? 0 : 6,
  },
  filterChipsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipActive: {
    backgroundColor: Colors.warning,
    borderColor: Colors.warning,
  },
  filterChipText: { fontSize: 12, fontWeight: "700", color: Colors.text },
  filterChipTextActive: { color: Colors.textInverse },
  filterChipBadge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    backgroundColor: Colors.warningLight,
    alignItems: "center",
    justifyContent: "center",
  },
  filterChipBadgeActive: { backgroundColor: "rgba(255,255,255,0.25)" },
  filterChipBadgeText: { fontSize: 10, fontWeight: "800", color: Colors.warning },
  filterChipBadgeTextActive: { color: Colors.textInverse },
  filterCountLabel: { fontSize: 12, color: Colors.textMuted, fontWeight: "500" },
  emptyFilter: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  emptyFilterText: { fontSize: 13, color: Colors.textMuted, textAlign: "center" },
  emptyFilterClear: { fontSize: 13, fontWeight: "700", color: Colors.primary },
});
