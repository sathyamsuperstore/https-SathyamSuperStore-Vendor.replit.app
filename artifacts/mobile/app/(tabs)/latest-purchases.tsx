import React, { useState, useMemo, useRef, useEffect } from "react";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  ActivityIndicator,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as XLSX from "xlsx-js-style";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import {
  useApp,
  LatestPurchaseEntry,
  LATEST_PURCHASES_FIELDS,
  showStorageErrorAlert,
} from "@/context/AppContext";

// Columns to attempt numeric parsing on at import time. Anything else
// (dates, IDs like GidNo / Item No / VendorCode, free-text fields) is
// kept as the original string so leading zeros and date formats survive.
const NUMERIC_FIELDS = new Set<string>([
  "SortNo",
  "Purchase Qty",
  "Free Qty",
  "NetCost",
  "MRP",
  "Tax",
  "Weight",
]);

// Columns the source spreadsheet stores as date types. Excel surfaces these
// either as JS Date objects (when read with cellDates:true) or as raw
// serial numbers (e.g. 45123 for 2023-07-12), neither of which renders
// usefully if we just String()-stringify them. Normalised to "DD/MM/YYYY".
const DATE_FIELDS = new Set<string>(["GidDate", "DODate", "CreatedDate"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Strip the time component so date comparisons are inclusive on
// whole-day boundaries regardless of when the picker fires.
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Inverse of formatDDMMYYYY — accepts "DD/MM/YYYY" (or DD-MM-YYYY,
// DD/MM/YY) and returns a Date at local midnight, or null if the
// string isn't a valid calendar date. Used by the DODate range filter
// to compare row dates against user-typed bounds.
function parseDDMMYYYY(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10);
  let yr = parseInt(m[3], 10);
  if (yr < 100) yr += 2000;
  const d = new Date(yr, mon - 1, day);
  if (isNaN(d.getTime())) return null;
  if (d.getDate() !== day || d.getMonth() !== mon - 1 || d.getFullYear() !== yr) {
    return null;
  }
  return d;
}

// Coerce a raw Excel date cell into a stable "DD/MM/YYYY" display string.
// Accepts: JS Date (cellDates:true path), Excel serial number (Lotus
// 1-2-3 epoch via the canonical 25569 offset), or strings already formatted
// as DD/MM/YYYY, DD-MM-YYYY, or ISO YYYY-MM-DD. Anything unparseable falls
// back to the original string so we never silently destroy user data.
function coerceDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : formatDDMMYYYY(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial → ms since epoch. 25569 = days between 1899-12-30
    // (Excel's effective epoch including the 1900 leap-year bug) and
    // 1970-01-01 (Unix epoch).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? String(v) : formatDDMMYYYY(d);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return "";
    // DD/MM/YYYY or DD-MM-YYYY (also handles 2-digit years).
    const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m1) {
      const day = parseInt(m1[1], 10);
      const mon = parseInt(m1[2], 10);
      let yr = parseInt(m1[3], 10);
      if (yr < 100) yr += 2000;
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    // ISO YYYY-MM-DD (or YYYY-MM-DDTHH:mm:ss).
    const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const yr = parseInt(m2[1], 10);
      const mon = parseInt(m2[2], 10);
      const day = parseInt(m2[3], 10);
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    // Last resort: native Date parser (handles "Jul 12, 2023" etc.).
    const d = new Date(s);
    if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    return s;
  }
  return String(v);
}

// Per-column display widths for the horizontally scrollable table. Wider
// columns are reserved for free-text fields that frequently overflow
// (Item Description, Brand, Category); narrow columns for short numerics
// and date IDs. Falls back to 90 for anything not listed.
const COL_WIDTHS: Record<string, number> = {
  GidNo: 90,
  SortNo: 80,
  VendorCode: 100,
  GidDate: 110,
  DONo: 100,
  DODate: 88,
  CreatedDate: 120,
  "Item No": 70,
  "Item Description": 170,
  "Purchase Qty": 60,
  "Free Qty": 60,
  NetCost: 70,
  MRP: 60,
  Tax: 60,
  Category: 100,
  Weight: 70,
  Brand: 120,
  // Synthetic display-only column: vendor name resolved from the
  // Suppliers tab via VendorCode. Wide enough for typical store names.
  "Vendor Name": 180,
};

function colWidth(field: string): number {
  return COL_WIDTHS[field] ?? 90;
}

// Display-only header overrides. The underlying field key (used by
// row data, import/export, sort, search) stays as-is; only the
// rendered column header changes.
const COL_HEADER_LABELS: Record<string, string> = {
  "Purchase Qty": "P Qty",
};
function colLabel(field: string): string {
  return COL_HEADER_LABELS[field] ?? field;
}

// Synthetic column rendered between VendorCode and the rest. Not part
// of LATEST_PURCHASES_FIELDS — that constant is the import/export
// schema and must stay in sync with the source spreadsheet.
const VENDOR_NAME_COL = "Vendor Name";

// Columns intentionally suppressed from the on-screen table. They
// remain part of LATEST_PURCHASES_FIELDS so import/export keep
// reading and writing them — we just don't render them. Listed using
// the same spelling as the schema constants so the lookup is exact.
const HIDDEN_DISPLAY_COLUMNS: ReadonlySet<string> = new Set([
  "GidNo",
  "SortNo",
  "VendorCode",
  "GidDate",
  "DONo",
  "CreatedDate",
  "Free Qty",
  "Tax",
  "Weight",
  "Brand",
  // Synthetic vendor-name column (rendered next to VendorCode) is
  // suppressed alongside it so neither vendor identifier shows up.
  VENDOR_NAME_COL,
]);

// Explicit on-screen column order, decoupled from the schema order
// in LATEST_PURCHASES_FIELDS so we can rearrange the table without
// touching the import/export contract. Any column listed here that
// also appears in HIDDEN_DISPLAY_COLUMNS is dropped at the final
// filter step below.
const DISPLAY_COLUMN_ORDER: readonly string[] = [
  "Item Description",
  "MRP",
  "Purchase Qty",
  "NetCost",
  "Item No",
  "Category",
  "DODate",
  // Trailing columns kept here so that toggling them back on in
  // HIDDEN_DISPLAY_COLUMNS still produces a stable, predictable
  // order rather than appending in schema order.
  "VendorCode",
  VENDOR_NAME_COL,
  "Brand",
  "Free Qty",
  "Tax",
  "Weight",
  "GidNo",
  "SortNo",
  "DONo",
  "GidDate",
  "CreatedDate",
];

// Build the on-screen column list using the explicit display order
// above, dropping any column the user has asked to hide. The
// `fields` parameter is unused — kept for call-site stability — but
// asserted against the order list in dev to surface schema additions
// that haven't been placed in DISPLAY_COLUMN_ORDER yet.
function buildDisplayColumns(fields: readonly string[]): string[] {
  if (__DEV__) {
    const known = new Set([...DISPLAY_COLUMN_ORDER, VENDOR_NAME_COL]);
    for (const f of fields) {
      if (!known.has(f)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[latest-purchases] Schema field "${f}" is not present in DISPLAY_COLUMN_ORDER; it will not be rendered.`
        );
      }
    }
  }
  return DISPLAY_COLUMN_ORDER.filter((f) => !HIDDEN_DISPLAY_COLUMNS.has(f));
}

// Fields a user is likely to know to search by. SortNo included so
// numeric IDs work via substring match (e.g. "12" matches "12" / "112").
// Vendor name is searchable via a separate code path (it lives on
// the supplier record, not on the purchase row itself).
const SEARCH_FIELDS = [
  "GidNo",
  "SortNo",
  "VendorCode",
  "DONo",
  "Item No",
  "Item Description",
  "Category",
  "Brand",
];

function formatCell(field: string, value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    // Keep integers integer-looking, prices/margins to 2dp. Avoids
    // showing "12.000000001" style noise from floating-point parses.
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }
  return String(value);
}

export default function LatestPurchasesScreen() {
  const router = useRouter();
  const { latestPurchases, saveLatestPurchasesBatch, clearLatestPurchases, suppliers } = useApp();

  // VendorCode (uppercased, trimmed) → supplier name. Built once per
  // suppliers change so each row's vendor-name lookup is O(1).
  const vendorNameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suppliers) {
      const code = (s.vendorCode ?? "").trim().toUpperCase();
      if (code) m.set(code, (s.name ?? "").trim());
    }
    return m;
  }, [suppliers]);

  // Resolve a row's vendor name; "Unlisted" if the VendorCode is not
  // present in the Suppliers tab. Empty/missing VendorCode also reads as
  // "Unlisted" so the column is never blank.
  const vendorNameFor = (code: unknown): string => {
    const k = String(code ?? "").trim().toUpperCase();
    if (!k) return "Unlisted";
    const name = vendorNameByCode.get(k);
    return name && name.length > 0 ? name : "Unlisted";
  };

  // Display columns = canonical schema + the synthetic "Vendor Name"
  // column inserted right after VendorCode.
  const displayColumns = useMemo(
    () => buildDisplayColumns(LATEST_PURCHASES_FIELDS),
    []
  );
  const insets = useSafeAreaInsets();
  // Optional URL param: when navigated to from the Orders tab via a tap
  // on a VendorCode chip, the search box gets pre-filled with that code.
  const params = useLocalSearchParams<{ search?: string }>();

  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Import progress: 0-100 with a human-readable phase label. Same
  // pattern as the Promo tab so the user gets visible feedback during
  // the long workbook-read + parse cycle on large purchase histories.
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string>("");

  // Multi-select filters. Empty array = "All". Modeled after the brand
  // filter on the Orders tab so the UX feels consistent.
  const [activeVendorCodes, setActiveVendorCodes] = useState<string[]>([]);
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [showVendorModal, setShowVendorModal] = useState(false);
  // Inclusive date-range filter for the DODate column. Both bounds
  // are optional — only-from / only-to / both-set all narrow the
  // table; cleared = show all rows. Drafts hold the in-progress text
  // in the modal so partial input like "1/" doesn't immediately
  // discard whatever the user typed.
  const [doDateFrom, setDoDateFrom] = useState<Date | null>(null);
  const [doDateTo, setDoDateTo] = useState<Date | null>(null);
  const [showDoDateModal, setShowDoDateModal] = useState(false);
  // Calendar-picker drafts. Defaults to "today" so the picker opens
  // on a sensible date instead of an arbitrary epoch. The actual
  // committed filter (doDateFrom/doDateTo) is only updated on Apply.
  const [doDateFromDraft, setDoDateFromDraft] = useState<Date>(() => startOfDay(new Date()));
  const [doDateToDraft, setDoDateToDraft] = useState<Date>(() => startOfDay(new Date()));
  // Which sub-picker is currently visible. On Android, DateTimePicker
  // is a one-shot dialog; on iOS/web we render it inline below the
  // matching field button.
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);
  const [doDateError, setDoDateError] = useState<string | null>(null);
  // Vendors the user has collapsed in the grouped table view. Stored
  // as a Set of vendor names; absence = expanded (the default), so
  // newly-imported / newly-filtered vendors are visible right away.
  const [collapsedVendors, setCollapsedVendors] = useState<Set<string>>(
    () => new Set()
  );
  const toggleVendorCollapsed = (vendor: string) =>
    setCollapsedVendors((prev) => {
      const next = new Set(prev);
      if (next.has(vendor)) next.delete(vendor);
      else next.add(vendor);
      return next;
    });
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [vendorOptionSearch, setVendorOptionSearch] = useState("");
  const [categoryOptionSearch, setCategoryOptionSearch] = useState("");

  const toggleVendorCode = (code: string) =>
    setActiveVendorCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  const toggleCategory = (cat: string) =>
    setActiveCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );

  // Consume the `search` URL param on entry. Each distinct param value is
  // applied at most once via consumedSearchParam so a tab-bar revisit (the
  // URL still carries the same `?search=...`) doesn't keep re-overriding
  // the user's edits. A new VendorCode tap from Orders updates the param
  // to a different value and triggers a fresh consume.
  const consumedSearchParam = useRef<string | null>(null);
  useEffect(() => {
    const incoming = typeof params.search === "string" ? params.search.trim() : "";
    if (incoming.length > 0 && consumedSearchParam.current !== incoming) {
      setSearch(incoming);
      consumedSearchParam.current = incoming;
    }
  }, [params.search]);

  // Refs + guard for syncing horizontal scroll between the (sticky) table
  // header and the rows below it. The guard prevents a feedback loop where
  // each scrollTo would re-fire its sibling's onScroll handler.
  const headerScrollRef = useRef<ScrollView>(null);
  const rowsScrollRef = useRef<ScrollView>(null);
  const isSyncingScroll = useRef(false);

  const onHeaderScroll = (e: any) => {
    if (isSyncingScroll.current) {
      isSyncingScroll.current = false;
      return;
    }
    const x = e.nativeEvent.contentOffset.x;
    isSyncingScroll.current = true;
    rowsScrollRef.current?.scrollTo({ x, animated: false });
  };

  const onRowsScroll = (e: any) => {
    if (isSyncingScroll.current) {
      isSyncingScroll.current = false;
      return;
    }
    const x = e.nativeEvent.contentOffset.x;
    isSyncingScroll.current = true;
    headerScrollRef.current?.scrollTo({ x, animated: false });
  };

  // Unique sorted option lists for the two filter modals.
  const allVendorCodes = useMemo(() => {
    const s = new Set<string>();
    for (const r of latestPurchases) {
      const v = String(r["VendorCode"] ?? "").trim();
      if (v) s.add(v);
    }
    return Array.from(s).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
  }, [latestPurchases]);

  const allCategories = useMemo(() => {
    const s = new Set<string>();
    for (const r of latestPurchases) {
      const v = String(r["Category"] ?? "").trim();
      if (v) s.add(v);
    }
    return Array.from(s).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
  }, [latestPurchases]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const vendorSet = activeVendorCodes.length > 0 ? new Set(activeVendorCodes) : null;
    const catSet = activeCategories.length > 0 ? new Set(activeCategories) : null;
    // Normalise the DODate bounds to local-midnight timestamps once
    // so the per-row check is a cheap numeric comparison. Both bounds
    // are inclusive: a row dated exactly on `from` or `to` passes.
    const fromTs = doDateFrom
      ? new Date(doDateFrom.getFullYear(), doDateFrom.getMonth(), doDateFrom.getDate()).getTime()
      : null;
    const toTs = doDateTo
      ? new Date(doDateTo.getFullYear(), doDateTo.getMonth(), doDateTo.getDate()).getTime()
      : null;
    return latestPurchases.filter((r) => {
      if (vendorSet) {
        const v = String(r["VendorCode"] ?? "").trim();
        if (!vendorSet.has(v)) return false;
      }
      if (catSet) {
        const c = String(r["Category"] ?? "").trim();
        if (!catSet.has(c)) return false;
      }
      if (fromTs !== null || toTs !== null) {
        const raw = r["DODate"];
        const parsed = typeof raw === "string" ? parseDDMMYYYY(raw) : null;
        if (!parsed) return false;
        const ts = parsed.getTime();
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      if (!q) return true;
      if (SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q))) {
        return true;
      }
      // Also match against the resolved vendor name so users can find
      // rows by typing the supplier name even though it isn't stored
      // on the purchase row itself.
      return vendorNameFor(r["VendorCode"]).toLowerCase().includes(q);
    });
  }, [latestPurchases, search, vendorNameByCode, activeVendorCodes, activeCategories, doDateFrom, doDateTo]);

  // Group filtered rows by Vendor Name → Brand → Category for the
  // table render. Vendor name comes from the suppliers lookup (same
  // resolver used by the synthetic column); Brand and Category are
  // read straight off the row with "(No Brand)" / "(No Category)"
  // fallbacks so blanks stay visible. Sorting is case-insensitive,
  // locale-aware at every level.
  const grouped = useMemo(() => {
    const byVendor = new Map<
      string,
      Map<string, Map<string, typeof filtered>>
    >();
    for (const r of filtered) {
      const vendor = vendorNameFor(r["VendorCode"]);
      const brand = String(r["Brand"] ?? "").trim() || "(No Brand)";
      const category = String(r["Category"] ?? "").trim() || "(No Category)";
      let bm = byVendor.get(vendor);
      if (!bm) {
        bm = new Map();
        byVendor.set(vendor, bm);
      }
      let cm = bm.get(brand);
      if (!cm) {
        cm = new Map();
        bm.set(brand, cm);
      }
      let arr = cm.get(category);
      if (!arr) {
        arr = [];
        cm.set(category, arr);
      }
      arr.push(r);
    }
    const sortKeys = (m: Map<string, unknown>) =>
      Array.from(m.keys()).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
    return sortKeys(byVendor).map((vendor) => {
      const bm = byVendor.get(vendor)!;
      let vendorCount = 0;
      const brandGroups = sortKeys(bm).map((brand) => {
        const cm = bm.get(brand)!;
        let brandCount = 0;
        const categoryGroups = sortKeys(cm).map((category) => {
          const rows = cm.get(category)!;
          brandCount += rows.length;
          return { category, rows };
        });
        vendorCount += brandCount;
        return { brand, count: brandCount, categories: categoryGroups };
      });
      return { vendor, count: vendorCount, brands: brandGroups };
    });
  }, [filtered, vendorNameByCode]);

  // Total pixel width of one fully-rendered table row. Group headers
  // need an explicit width so they span the full table inside the
  // horizontal scroll viewport (otherwise they'd shrink to viewport
  // width and look detached from the cells when scrolled right).
  const tableWidth = useMemo(() => {
    const cols = displayColumns.length;
    const cellTotal = displayColumns.reduce((sum, f) => sum + colWidth(f), 0);
    const gaps = Math.max(0, cols - 1) * 8;
    const padding = 12 * 2;
    return cellTotal + gaps + padding;
  }, [displayColumns]);

  // Per-option counts for the modals — pre-applies the *other* filter +
  // search so the numbers reflect what the user would actually see.
  const vendorCountFor = (code: string): number => {
    const q = search.trim().toLowerCase();
    const catSet = activeCategories.length > 0 ? new Set(activeCategories) : null;
    let n = 0;
    for (const r of latestPurchases) {
      if (String(r["VendorCode"] ?? "").trim() !== code) continue;
      if (catSet && !catSet.has(String(r["Category"] ?? "").trim())) continue;
      if (q) {
        const matchesSearch =
          SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q)) ||
          vendorNameFor(r["VendorCode"]).toLowerCase().includes(q);
        if (!matchesSearch) continue;
      }
      n++;
    }
    return n;
  };
  const categoryCountFor = (cat: string): number => {
    const q = search.trim().toLowerCase();
    const vendorSet = activeVendorCodes.length > 0 ? new Set(activeVendorCodes) : null;
    let n = 0;
    for (const r of latestPurchases) {
      if (String(r["Category"] ?? "").trim() !== cat) continue;
      if (vendorSet && !vendorSet.has(String(r["VendorCode"] ?? "").trim())) continue;
      if (q) {
        const matchesSearch =
          SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q)) ||
          vendorNameFor(r["VendorCode"]).toLowerCase().includes(q);
        if (!matchesSearch) continue;
      }
      n++;
    }
    return n;
  };

  const vendorFilterLabel =
    activeVendorCodes.length === 0
      ? "Vendor: All"
      : activeVendorCodes.length === 1
        ? `Vendor: ${activeVendorCodes[0]}`
        : `Vendor: ${activeVendorCodes.length} selected`;
  const categoryFilterLabel =
    activeCategories.length === 0
      ? "Category: All"
      : activeCategories.length === 1
        ? `Category: ${activeCategories[0]}`
        : `Category: ${activeCategories.length} selected`;

  async function pickAndImport() {
    try {
      setLoading(true);
      setErrors([]);
      setStatusMsg(null);
      setProgress(0);
      setProgressLabel("");

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

      setProgress(5);
      setProgressLabel("Opening file…");

      const asset = result.assets[0];
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
        setProgress(25);
        setProgressLabel("Reading workbook…");
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array", cellDates: true });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: "base64" as any,
        });
        if (!base64 || base64.length === 0) {
          throw new Error("Could not read file content. Make sure the file is a valid Excel file.");
        }
        setProgress(25);
        setProgressLabel("Reading workbook…");
        workbook = XLSX.read(base64, { type: "base64", cellDates: true });
      }

      setProgress(40);
      setProgressLabel("Extracting rows…");

      const sheetName =
        workbook.SheetNames.find((n) => n.toLowerCase() === "latestpurchases") ??
        workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      // Case- and whitespace-insensitive header lookup, matches MRP behavior.
      const firstRow = raw[0];
      const keyMap: Record<string, string> = {};
      for (const k of Object.keys(firstRow)) {
        keyMap[k.toLowerCase().replace(/\s+/g, "")] = k;
      }
      const fieldKeys: Record<string, string | undefined> = {};
      for (const field of LATEST_PURCHASES_FIELDS) {
        fieldKeys[field] = keyMap[field.toLowerCase().replace(/\s+/g, "")];
      }

      const gidNoKey = fieldKeys["GidNo"];
      const sortNoKey = fieldKeys["SortNo"];
      if (!gidNoKey || !sortNoKey) {
        setErrors([
          `Missing required columns. Expected "GidNo" and "SortNo". Found: ${Object.keys(firstRow).join(", ")}`,
        ]);
        setLoading(false);
        return;
      }

      // Walk rows in chunks so we can drive the progress bar through
      // the parse phase. Aim for ~25 progress updates regardless of
      // file size; mirrors the Promo tab's chunked-parse pattern.
      const PARSE_FROM = 40;
      const PARSE_TO = 90;
      const chunkSize = Math.max(1, Math.ceil(raw.length / 25));

      const seenPair = new Set<string>();
      const parsed: LatestPurchaseEntry[] = [];
      const localErrors: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const gid = String(r[gidNoKey] ?? "").trim();
        const sortRaw = String(r[sortNoKey] ?? "").trim();
        if (!gid || !sortRaw) {
          localErrors.push(`Row ${i + 2}: missing GidNo / SortNo`);
          continue;
        }
        // Dedupe by (GidNo, SortNo) — first occurrence wins, mirrors the
        // MRP tab's (ItemNo, MRP) dedupe behavior.
        const key = `${gid.toUpperCase()}|${sortRaw}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);

        const entry: LatestPurchaseEntry = {};
        for (const field of LATEST_PURCHASES_FIELDS) {
          const sourceKey = fieldKeys[field];
          if (!sourceKey) {
            entry[field] = "";
            continue;
          }
          const v = r[sourceKey];
          if (DATE_FIELDS.has(field)) {
            // Pass the raw cell value (Date / number / string) so the
            // coercer can pick the right branch — String()-stringifying
            // first would lose Date objects and Excel serial numbers.
            entry[field] = coerceDate(v);
            continue;
          }
          const str = v === undefined || v === null ? "" : String(v);
          if (NUMERIC_FIELDS.has(field) && str.trim() !== "") {
            const n = parseFloat(str);
            entry[field] = isNaN(n) ? str : n;
          } else {
            entry[field] = str;
          }
        }
        parsed.push(entry);

        // Yield to the UI thread between chunks so the progress bar
        // can actually paint while the parse loop runs.
        if ((i + 1) % chunkSize === 0 || i === raw.length - 1) {
          const ratio = (i + 1) / raw.length;
          setProgress(Math.round(PARSE_FROM + (PARSE_TO - PARSE_FROM) * ratio));
          setProgressLabel(`Parsing rows ${i + 1} of ${raw.length}…`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      if (parsed.length === 0) {
        setErrors([
          "No valid rows found. Make sure GidNo and SortNo are filled.",
          ...localErrors,
        ]);
        setLoading(false);
        return;
      }

      setProgress(92);
      setProgressLabel("Sorting entries…");

      // Sort priority (per user request):
      //   1. DODate descending (newest delivery order first)
      //   2. VendorCode ascending
      //   3. Brand ascending
      //   4. Category ascending
      // DODate at this point is the normalized "DD/MM/YYYY" string from
      // coerceDate. We turn it into a sortable YYYYMMDD integer; missing
      // or unparseable dates sort to the end regardless of direction so
      // they don't pollute the top.
      const dateKey = (s: unknown): number => {
        const m = String(s ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return -1;
        return parseInt(m[3] + m[2] + m[1], 10);
      };
      const textCmp = (a: unknown, b: unknown): number =>
        String(a ?? "").localeCompare(String(b ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      parsed.sort((a, b) => {
        const aD = dateKey(a["DODate"]);
        const bD = dateKey(b["DODate"]);
        // Push missing/unparseable DODate rows to the bottom in both
        // directions so they don't claim the top of a descending sort.
        if (aD === -1 && bD !== -1) return 1;
        if (bD === -1 && aD !== -1) return -1;
        if (aD !== bD) return bD - aD; // descending
        const v = textCmp(a["VendorCode"], b["VendorCode"]);
        if (v !== 0) return v;
        const br = textCmp(a["Brand"], b["Brand"]);
        if (br !== 0) return br;
        return textCmp(a["Category"], b["Category"]);
      });

      setProgress(95);
      setProgressLabel("Saving…");

      try {
        await saveLatestPurchasesBatch(parsed);
      } catch {
        // Storage failures (e.g. phone out of space) get the standard
        // friendly alert instead of being lumped into the parser error
        // list, which would show a raw exception like "QuotaExceededError".
        showStorageErrorAlert();
        setLoading(false);
        return;
      }
      setProgress(100);
      setProgressLabel("Done");
      setStatusMsg(
        `Imported ${parsed.length} row${parsed.length !== 1 ? "s" : ""} from "${asset.name}".`
      );
      if (localErrors.length > 0) setErrors(localErrors);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Jump to the Promo tab so the user immediately sees the freshly
      // imported purchase data alongside the live promo offers, which is
      // the most common next step after a Latest Purchases import.
      router.replace("/catalog?view=promo");
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to import file"]);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    if (latestPurchases.length === 0) return;
    const msg = `Remove all ${latestPurchases.length} Latest Purchases rows? This cannot be undone.`;
    const doClear = async () => {
      try {
        await clearLatestPurchases();
        setStatusMsg(null);
        setErrors([]);
        setSearch("");
        // Mirrors the post-import flow: once the Latest Purchases table
        // is cleared, jump to Promo so the user lands on the next screen
        // they normally work with after wiping the batch.
        router.push("/(tabs)/promo");
      } catch {
        showStorageErrorAlert();
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(msg)) void doClear();
      return;
    }
    Alert.alert("Clear Latest Purchases", msg, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => void doClear() },
    ]);
  }

  async function handleExport() {
    if (latestPurchases.length === 0) return;
    try {
      setDownloading(true);
      // Header row + one row per entry, columns in canonical field order.
      const data: (string | number)[][] = [
        [...LATEST_PURCHASES_FIELDS],
        ...latestPurchases.map((e) =>
          LATEST_PURCHASES_FIELDS.map((f) => {
            const v = e[f];
            if (v === undefined || v === null) return "";
            return v as string | number;
          })
        ),
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = LATEST_PURCHASES_FIELDS.map((f) => ({
        wch: Math.max(10, Math.floor(colWidth(f) / 8)),
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "LatestPurchases");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Sathyam Super Store - Latest Purchases - ${_ts}.xlsx`;
      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
        const blob = new Blob([wbout], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { bookType: "xlsx", type: "base64", cellStyles: true });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: "base64" as any });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export Latest Purchases",
            UTI: "com.microsoft.excel.xlsx",
          });
        } else {
          Alert.alert("Export saved", `File saved to: ${fileUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Export Failed", e?.message ?? "Unknown error");
    } finally {
      setDownloading(false);
    }
  }

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Latest Purchases</Text>
        <View style={styles.headerActions}>
          {latestPurchases.length > 0 && (
            <>
              <TouchableOpacity
                style={styles.exportBtn}
                onPress={handleExport}
                disabled={downloading}
              >
                {downloading ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Feather name="download" size={16} color={Colors.primary} />
                )}
                <Text style={styles.exportBtnText}>Export</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
                <Feather name="trash-2" size={15} color={Colors.danger} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/*
        Layout strategy:
        - The body is a single vertical ScrollView so the import card scrolls
          out of view when reviewing the table.
        - The table header is rendered as its own direct child of the outer
          ScrollView at a STABLE index, so we can pass `stickyHeaderIndices`
          and have it pin to the top during vertical scrolling.
        - The header (sticky) and rows are two separate horizontal
          ScrollViews; their horizontal positions are kept in sync via
          onScroll handlers above. This is the standard React Native pattern
          for a sticky header on a horizontally scrollable wide table.
        - Sections that are conditional in content (errors / status / data
          area) still render an outer wrapper View so the sticky index
          (5 = table header) stays stable across re-renders.
      */}
      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
        ]}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={latestPurchases.length > 0 ? [5] : undefined}
      >
        {/* 0: import card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import Latest Purchases</Text>
          <Text style={styles.cardSub}>
            Excel file with the wide purchase-history layout. Required columns:{" "}
            <Text style={styles.mono}>GidNo</Text> and{" "}
            <Text style={styles.mono}>SortNo</Text>. Imported data is stored independently of
            Orders and MRP.
          </Text>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.pickBtn, loading && { opacity: 0.6 }, { flex: 1 }]}
              onPress={pickAndImport}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color={Colors.textInverse} />
              ) : (
                <Feather name="upload" size={18} color={Colors.textInverse} />
              )}
              <Text style={styles.pickBtnText}>
                {loading
                  ? "Reading file..."
                  : latestPurchases.length > 0
                    ? "Re-Import (Replace)"
                    : "Choose Excel File"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.deleteBtn, latestPurchases.length === 0 && { opacity: 0.4 }]}
              onPress={handleClear}
              disabled={latestPurchases.length === 0}
            >
              <Feather name="trash-2" size={18} color={Colors.textInverse} />
              <Text style={styles.deleteBtnText}>Delete All</Text>
            </TouchableOpacity>
          </View>

          {loading && (
            <View style={styles.progressWrap}>
              <View style={styles.progressLabelRow}>
                <Text style={styles.progressLabelText} numberOfLines={1}>
                  {progressLabel || "Starting…"}
                </Text>
                <Text style={styles.progressPercentText}>{progress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.max(0, Math.min(100, progress))}%` },
                  ]}
                />
              </View>
            </View>
          )}
        </View>

        {/* 1: errors box (always rendered, content conditional) */}
        <View>
          {errors.length > 0 && (
            <View style={styles.errorBox}>
              <Feather name="alert-triangle" size={16} color={Colors.danger} />
              <View style={{ flex: 1 }}>
                {errors.map((e, i) => (
                  <Text key={i} style={styles.errorText}>
                    {e}
                  </Text>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* 2: status (success) box */}
        <View>
          {statusMsg && (
            <View style={styles.successBox}>
              <Feather name="check-circle" size={16} color={Colors.success ?? "#16A34A"} />
              <Text style={styles.successText}>{statusMsg}</Text>
            </View>
          )}
        </View>

        {/* 3: search wrap + filter chips */}
        <View>
          {latestPurchases.length > 0 && (
            <>
              <View style={styles.searchWrap}>
                <Feather name="search" size={15} color={Colors.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search GidNo, SortNo, Item No, Brand…"
                  placeholderTextColor={Colors.textMuted}
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                />
                {search.length > 0 && Platform.OS !== "ios" && (
                  <TouchableOpacity
                    onPress={() => setSearch("")}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Feather name="x" size={14} color={Colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.filterRow}>
                <TouchableOpacity
                  style={[
                    styles.filterChip,
                    activeVendorCodes.length > 0 && styles.filterChipActive,
                  ]}
                  onPress={() => {
                    setVendorOptionSearch("");
                    setShowVendorModal(true);
                  }}
                  activeOpacity={0.75}
                >
                  <Feather
                    name="user"
                    size={13}
                    color={
                      activeVendorCodes.length > 0
                        ? Colors.textInverse
                        : Colors.textSecondary
                    }
                  />
                  <Text
                    style={[
                      styles.filterChipText,
                      activeVendorCodes.length > 0 && styles.filterChipTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {vendorFilterLabel}
                  </Text>
                  {activeVendorCodes.length > 0 ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        setActiveVendorCodes([]);
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Feather name="x-circle" size={14} color={Colors.textInverse} />
                    </TouchableOpacity>
                  ) : (
                    <Feather name="chevron-down" size={13} color={Colors.textMuted} />
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.filterChip,
                    activeCategories.length > 0 && styles.filterChipActive,
                  ]}
                  onPress={() => {
                    setCategoryOptionSearch("");
                    setShowCategoryModal(true);
                  }}
                  activeOpacity={0.75}
                >
                  <Feather
                    name="grid"
                    size={13}
                    color={
                      activeCategories.length > 0
                        ? Colors.textInverse
                        : Colors.textSecondary
                    }
                  />
                  <Text
                    style={[
                      styles.filterChipText,
                      activeCategories.length > 0 && styles.filterChipTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {categoryFilterLabel}
                  </Text>
                  {activeCategories.length > 0 ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        setActiveCategories([]);
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Feather name="x-circle" size={14} color={Colors.textInverse} />
                    </TouchableOpacity>
                  ) : (
                    <Feather name="chevron-down" size={13} color={Colors.textMuted} />
                  )}
                </TouchableOpacity>

                {/* DODate range filter chip. Active label shows the
                    currently-applied bounds (open-ended on either side
                    when only one bound is set) so the user can see the
                    range without opening the modal. */}
                <TouchableOpacity
                  style={[
                    styles.filterChip,
                    (doDateFrom || doDateTo) && styles.filterChipActive,
                  ]}
                  onPress={() => {
                    const today = startOfDay(new Date());
                    setDoDateFromDraft(doDateFrom ?? today);
                    setDoDateToDraft(doDateTo ?? today);
                    setShowFromPicker(false);
                    setShowToPicker(false);
                    setDoDateError(null);
                    setShowDoDateModal(true);
                  }}
                  activeOpacity={0.75}
                >
                  <Feather
                    name="calendar"
                    size={13}
                    color={
                      doDateFrom || doDateTo
                        ? Colors.textInverse
                        : Colors.textSecondary
                    }
                  />
                  <Text
                    style={[
                      styles.filterChipText,
                      (doDateFrom || doDateTo) && styles.filterChipTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {doDateFrom || doDateTo
                      ? `${doDateFrom ? formatDDMMYYYY(doDateFrom) : "Any"} → ${doDateTo ? formatDDMMYYYY(doDateTo) : "Any"}`
                      : "All DODates"}
                  </Text>
                  {doDateFrom || doDateTo ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        setDoDateFrom(null);
                        setDoDateTo(null);
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Feather name="x-circle" size={14} color={Colors.textInverse} />
                    </TouchableOpacity>
                  ) : (
                    <Feather name="chevron-down" size={13} color={Colors.textMuted} />
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        {/* 4: stats row */}
        <View>
          {latestPurchases.length > 0 && (
            <View style={styles.statsRow}>
              <Text style={styles.statText}>
                {filtered.length} of {latestPurchases.length} entr
                {latestPurchases.length !== 1 ? "ies" : "y"}
              </Text>
            </View>
          )}
        </View>

        {/* 5: STICKY table header — opaque background so rows scroll under it cleanly */}
        <View style={styles.stickyHeaderWrap}>
          {latestPurchases.length > 0 && (
            <ScrollView
              ref={headerScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              onScroll={onHeaderScroll}
              scrollEventThrottle={16}
              style={styles.headerScroll}
            >
              <View style={styles.tableHead}>
                {displayColumns.map((f) => {
                  const numeric = NUMERIC_FIELDS.has(f);
                  return (
                    <Text
                      key={f}
                      style={[
                        styles.th,
                        { width: colWidth(f), textAlign: numeric ? "right" : "left" },
                      ]}
                      numberOfLines={1}
                    >
                      {colLabel(f)}
                    </Text>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </View>

        {/* 6: table rows */}
        <View>
          {latestPurchases.length > 0 && (
            <View style={styles.tableRowsCard}>
              <ScrollView
                ref={rowsScrollRef}
                horizontal
                showsHorizontalScrollIndicator
                onScroll={onRowsScroll}
                scrollEventThrottle={16}
              >
                <View>
                  {filtered.length === 0 ? (
                    <View style={styles.noRows}>
                      <Feather name="search" size={24} color={Colors.textMuted} />
                      <Text style={styles.noRowsText}>
                        {search.trim().length > 0
                          ? `No items match "${search}"`
                          : "No items match the active filters"}
                      </Text>
                      {(activeVendorCodes.length > 0 || activeCategories.length > 0) && (
                        <TouchableOpacity
                          onPress={() => {
                            setActiveVendorCodes([]);
                            setActiveCategories([]);
                          }}
                        >
                          <Text style={styles.noRowsClear}>Clear filters</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  ) : (
                    // Three-level grouping: outer = Vendor Name (from
                    // the suppliers lookup), middle = Brand, inner =
                    // Category. Group headers span the full table
                    // width so they line up correctly when the user
                    // scrolls horizontally.
                    grouped.map((g) => {
                      const isCollapsed = collapsedVendors.has(g.vendor);
                      return (
                      <View key={`v|${g.vendor}`}>
                        <TouchableOpacity
                          style={[styles.groupVendorHeader, { width: tableWidth }]}
                          activeOpacity={0.7}
                          onPress={() => toggleVendorCollapsed(g.vendor)}
                        >
                          <Feather
                            name={isCollapsed ? "chevron-right" : "chevron-down"}
                            size={14}
                            color={Colors.primary}
                          />
                          <Feather name="users" size={13} color={Colors.primary} />
                          <Text style={styles.groupVendorText} numberOfLines={1}>
                            {g.vendor}
                          </Text>
                          <Text style={styles.groupVendorCount}>
                            {g.count} row{g.count === 1 ? "" : "s"}
                          </Text>
                        </TouchableOpacity>
                        {!isCollapsed && g.brands.map((bg) => (
                          <View key={`v|${g.vendor}|b|${bg.brand}`}>
                            <View style={[styles.groupBrandHeader, { width: tableWidth }]}>
                              <Feather name="tag" size={11} color={Colors.textMuted} />
                              <Text style={styles.groupBrandText} numberOfLines={1}>
                                {bg.brand}
                              </Text>
                              <Text style={styles.groupBrandCount}>
                                {bg.count}
                              </Text>
                            </View>
                            {bg.categories.map((cg) => (
                              <View key={`v|${g.vendor}|b|${bg.brand}|c|${cg.category}`}>
                                <View style={[styles.groupCategoryHeader, { width: tableWidth }]}>
                                  <Feather name="folder" size={10} color={Colors.textMuted} />
                                  <Text style={styles.groupCategoryText} numberOfLines={1}>
                                    {cg.category}
                                  </Text>
                                  <Text style={styles.groupCategoryCount}>
                                    {cg.rows.length}
                                  </Text>
                                </View>
                                {cg.rows.map((row, i) => (
                              <View
                                key={`${row["GidNo"] ?? ""}-${row["SortNo"] ?? ""}-${i}`}
                                style={[styles.tableRow, i % 2 === 1 && styles.rowAlt]}
                              >
                                {displayColumns.map((f) => {
                                  const numeric = NUMERIC_FIELDS.has(f);
                                  // The synthetic vendor-name column reads from
                                  // the suppliers lookup, not from the row.
                                  const isVendorName = f === VENDOR_NAME_COL;
                                  const cellText = isVendorName
                                    ? vendorNameFor(row["VendorCode"])
                                    : formatCell(f, row[f]);
                                  const isUnlisted = isVendorName && cellText === "Unlisted";
                                  return (
                                    <Text
                                      key={f}
                                      style={[
                                        styles.td,
                                        {
                                          width: colWidth(f),
                                          textAlign: numeric ? "right" : "left",
                                          fontWeight: numeric ? "600" : "400",
                                        },
                                        // Mute unlisted vendors so a populated
                                        // store doesn't visually drown the
                                        // legitimate matches.
                                        isUnlisted && { color: Colors.textMuted, fontStyle: "italic" },
                                      ]}
                                      numberOfLines={1}
                                    >
                                      {cellText}
                                    </Text>
                                  );
                                })}
                              </View>
                            ))}
                              </View>
                            ))}
                          </View>
                        ))}
                      </View>
                      );
                    })
                  )}
                </View>
              </ScrollView>
            </View>
          )}
        </View>

        {latestPurchases.length === 0 && !loading && (
          <>
            {/* If a search filter arrived via the VendorCode link from the
                Orders tab but there's no purchase data yet, surface that
                fact so the user understands the link worked and the
                filter will apply once they import a file. */}
            {search.trim().length > 0 && (
              <View style={styles.linkedQueuedBox}>
                <Feather name="link" size={14} color={Colors.primary} />
                <Text style={styles.linkedQueuedText}>
                  Search filter <Text style={styles.linkedQueuedCode}>{search}</Text> is set.
                  It will apply once you import a Latest Purchases file.
                </Text>
              </View>
            )}
            <View style={styles.emptyHint}>
              <Feather name="info" size={14} color={Colors.textMuted} />
              <Text style={styles.emptyHintText}>
                Pick an Excel file to load the Latest Purchases table.
              </Text>
            </View>
          </>
        )}
      </ScrollView>

      {/* DODate range filter modal. Two date buttons that open a
          calendar via @react-native-community/datetimepicker.
          Defaults to today on first open; Clear resets the bounds
          (and the drafts) back to today. Apply commits the drafts
          to doDateFrom/doDateTo. */}
      <Modal
        visible={showDoDateModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDoDateModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowDoDateModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>DODate</Text>
            <TouchableOpacity
              onPress={() => {
                const today = startOfDay(new Date());
                setDoDateFromDraft(today);
                setDoDateToDraft(today);
                setDoDateFrom(null);
                setDoDateTo(null);
                setShowFromPicker(false);
                setShowToPicker(false);
                setDoDateError(null);
              }}
            >
              <Text style={styles.modalClear}>Clear</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.dateRangeWrap}>
            <View style={styles.dateRangeField}>
              <Text style={styles.dateRangeLabel}>From</Text>
              <TouchableOpacity
                style={styles.dateRangeButton}
                onPress={() => {
                  setShowToPicker(false);
                  setShowFromPicker((v) => !v);
                  setDoDateError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(doDateFromDraft)}
                </Text>
              </TouchableOpacity>
              {showFromPicker && (
                <DateTimePicker
                  value={doDateFromDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    // Android closes the dialog on every event;
                    // iOS/web keep the inline picker visible.
                    if (Platform.OS !== "ios") setShowFromPicker(false);
                    if (selected) {
                      setDoDateFromDraft(startOfDay(selected));
                      setDoDateError(null);
                    }
                  }}
                />
              )}
            </View>
            <View style={styles.dateRangeField}>
              <Text style={styles.dateRangeLabel}>To</Text>
              <TouchableOpacity
                style={styles.dateRangeButton}
                onPress={() => {
                  setShowFromPicker(false);
                  setShowToPicker((v) => !v);
                  setDoDateError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(doDateToDraft)}
                </Text>
              </TouchableOpacity>
              {showToPicker && (
                <DateTimePicker
                  value={doDateToDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    if (Platform.OS !== "ios") setShowToPicker(false);
                    if (selected) {
                      setDoDateToDraft(startOfDay(selected));
                      setDoDateError(null);
                    }
                  }}
                />
              )}
            </View>
          </View>
          {doDateError && (
            <Text style={styles.dateRangeError}>{doDateError}</Text>
          )}
          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => {
              const from = startOfDay(doDateFromDraft);
              const to = startOfDay(doDateToDraft);
              if (from.getTime() > to.getTime()) {
                setDoDateError("From date can't be after To date.");
                return;
              }
              setDoDateFrom(from);
              setDoDateTo(to);
              setShowFromPicker(false);
              setShowToPicker(false);
              setDoDateError(null);
              setShowDoDateModal(false);
            }}
          >
            <Text style={styles.modalDoneBtnText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Vendor filter modal */}
      <Modal
        visible={showVendorModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowVendorModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowVendorModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter by Vendor Code</Text>
            {activeVendorCodes.length > 0 && (
              <TouchableOpacity onPress={() => setActiveVendorCodes([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allVendorCodes.length > 0 && (
            <View style={styles.optionSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.optionSearchInput}
                value={vendorOptionSearch}
                onChangeText={setVendorOptionSearch}
                placeholder="Search vendor code or name…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {vendorOptionSearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity
                  onPress={() => setVendorOptionSearch("")}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allVendorCodes.length === 0 ? (
            <View style={styles.noOptions}>
              <Feather name="user" size={32} color={Colors.textMuted} />
              <Text style={styles.noOptionsTitle}>No Vendor Codes</Text>
              <Text style={styles.noOptionsSub}>
                Import a Latest Purchases file to filter by vendor.
              </Text>
            </View>
          ) : (
            <ScrollView
              showsVerticalScrollIndicator={false}
              style={styles.optionList}
              keyboardShouldPersistTaps="handled"
            >
              {(() => {
                const q = vendorOptionSearch.trim().toLowerCase();
                const visible = q
                  ? allVendorCodes.filter(
                      (c) =>
                        c.toLowerCase().includes(q) ||
                        vendorNameFor(c).toLowerCase().includes(q)
                    )
                  : allVendorCodes;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[
                          styles.optionRow,
                          activeVendorCodes.length === 0 && styles.optionRowActive,
                        ]}
                        onPress={() => setActiveVendorCodes([])}
                      >
                        <Text
                          style={[
                            styles.optionLabel,
                            activeVendorCodes.length === 0 && styles.optionLabelActive,
                          ]}
                        >
                          All Vendors
                        </Text>
                        {activeVendorCodes.length === 0 && (
                          <Feather name="check" size={16} color={Colors.primary} />
                        )}
                      </TouchableOpacity>
                    )}
                    {visible.length === 0 ? (
                      <View style={styles.noOptions}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noOptionsTitle}>No match</Text>
                        <Text style={styles.noOptionsSub}>
                          No vendor codes for "{vendorOptionSearch}"
                        </Text>
                      </View>
                    ) : (
                      visible.map((code) => {
                        const isSelected = activeVendorCodes.includes(code);
                        const count = vendorCountFor(code);
                        const name = vendorNameFor(code);
                        return (
                          <TouchableOpacity
                            key={code}
                            style={[styles.optionRow, isSelected && styles.optionRowActive]}
                            onPress={() => toggleVendorCode(code)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <View style={{ flex: 1 }}>
                              <Text
                                style={[
                                  styles.optionLabel,
                                  isSelected && styles.optionLabelActive,
                                ]}
                                numberOfLines={1}
                              >
                                {code}
                              </Text>
                              <Text style={styles.optionSubLabel} numberOfLines={1}>
                                {name}
                              </Text>
                            </View>
                            <Text style={styles.optionCount}>
                              {count} row{count !== 1 ? "s" : ""}
                            </Text>
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </>
                );
              })()}
            </ScrollView>
          )}

          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => setShowVendorModal(false)}
          >
            <Text style={styles.modalDoneBtnText}>
              {activeVendorCodes.length === 0
                ? "Close"
                : `Apply (${activeVendorCodes.length} selected)`}
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Category filter modal */}
      <Modal
        visible={showCategoryModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCategoryModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowCategoryModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter by Category</Text>
            {activeCategories.length > 0 && (
              <TouchableOpacity onPress={() => setActiveCategories([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allCategories.length > 0 && (
            <View style={styles.optionSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.optionSearchInput}
                value={categoryOptionSearch}
                onChangeText={setCategoryOptionSearch}
                placeholder="Search categories…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {categoryOptionSearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity
                  onPress={() => setCategoryOptionSearch("")}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allCategories.length === 0 ? (
            <View style={styles.noOptions}>
              <Feather name="grid" size={32} color={Colors.textMuted} />
              <Text style={styles.noOptionsTitle}>No Categories</Text>
              <Text style={styles.noOptionsSub}>
                Import a Latest Purchases file with a Category column.
              </Text>
            </View>
          ) : (
            <ScrollView
              showsVerticalScrollIndicator={false}
              style={styles.optionList}
              keyboardShouldPersistTaps="handled"
            >
              {(() => {
                const q = categoryOptionSearch.trim().toLowerCase();
                const visible = q
                  ? allCategories.filter((c) => c.toLowerCase().includes(q))
                  : allCategories;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[
                          styles.optionRow,
                          activeCategories.length === 0 && styles.optionRowActive,
                        ]}
                        onPress={() => setActiveCategories([])}
                      >
                        <Text
                          style={[
                            styles.optionLabel,
                            activeCategories.length === 0 && styles.optionLabelActive,
                          ]}
                        >
                          All Categories
                        </Text>
                        {activeCategories.length === 0 && (
                          <Feather name="check" size={16} color={Colors.primary} />
                        )}
                      </TouchableOpacity>
                    )}
                    {visible.length === 0 ? (
                      <View style={styles.noOptions}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noOptionsTitle}>No match</Text>
                        <Text style={styles.noOptionsSub}>
                          No categories for "{categoryOptionSearch}"
                        </Text>
                      </View>
                    ) : (
                      visible.map((cat) => {
                        const isSelected = activeCategories.includes(cat);
                        const count = categoryCountFor(cat);
                        return (
                          <TouchableOpacity
                            key={cat}
                            style={[styles.optionRow, isSelected && styles.optionRowActive]}
                            onPress={() => toggleCategory(cat)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <Text
                              style={[
                                styles.optionLabel,
                                isSelected && styles.optionLabelActive,
                                { flex: 1 },
                              ]}
                              numberOfLines={1}
                            >
                              {cat}
                            </Text>
                            <Text style={styles.optionCount}>
                              {count} row{count !== 1 ? "s" : ""}
                            </Text>
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </>
                );
              })()}
            </ScrollView>
          )}

          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => setShowCategoryModal(false)}
          >
            <Text style={styles.modalDoneBtnText}>
              {activeCategories.length === 0
                ? "Close"
                : `Apply (${activeCategories.length} selected)`}
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
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
  title: { fontSize: 24, fontWeight: "800", color: Colors.text },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primaryLight ?? "#E0EAFF",
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  exportBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  clearBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fecaca",
  },
  body: { padding: 16, gap: 14 },
  card: {
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 12,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  cardSub: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  mono: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontWeight: "600",
    color: Colors.text,
  },
  actionRow: { flexDirection: "row", gap: 8 },
  pickBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  pickBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 15 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: Colors.danger,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  deleteBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 14 },
  progressWrap: { gap: 6, marginTop: 12 },
  progressLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  progressLabelText: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
    flex: 1,
    marginRight: 8,
  },
  progressPercentText: {
    fontSize: 12,
    fontWeight: "800",
    color: Colors.primary,
    fontVariant: ["tabular-nums"],
  },
  progressTrack: {
    height: 8,
    backgroundColor: Colors.border,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: Colors.primary,
    borderRadius: 999,
  },
  errorBox: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#fecaca",
  },
  errorText: { color: Colors.danger, fontSize: 13, lineHeight: 18 },
  successBox: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    alignItems: "center",
    backgroundColor: "#f0fdf4",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#bbf7d0",
  },
  successText: { color: Colors.success ?? "#16A34A", fontWeight: "600", fontSize: 13, flex: 1 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text, padding: 0 },
  statsRow: { paddingHorizontal: 4 },
  statText: { fontSize: 12, color: Colors.textMuted },
  tableCard: {
    backgroundColor: Colors.surface ?? "#fff",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  // Wrapper for the sticky header. Opaque background prevents data rows
  // from showing through as they scroll underneath the pinned header.
  // Rounded top corners + matched border to visually attach to the rows
  // card below it.
  stickyHeaderWrap: {
    backgroundColor: Colors.surface ?? "#fff",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  headerScroll: {},
  // Rows portion of the table (header lives in stickyHeaderWrap above).
  tableRowsCard: {
    backgroundColor: Colors.surface ?? "#fff",
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  tableHead: {
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 4,
  },
  th: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
  },
  tableRow: {
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 4,
  },
  rowAlt: { backgroundColor: Colors.background },
  td: { fontSize: 12, color: Colors.text },
  // Vendor-Name group header: bold, primary-tinted band that introduces
  // a vendor's block of rows.
  groupVendorHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.primaryMuted,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: Colors.border,
  },
  groupVendorText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "800",
    color: Colors.primary,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  groupVendorCount: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.primary,
  },
  // Brand sub-header: lighter band nested visually under the vendor.
  groupBrandHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 6,
    backgroundColor: Colors.surfaceSecondary,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  groupBrandText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  groupBrandCount: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textMuted,
  },
  // Category sub-sub-header: thinnest band, deeper indent so the
  // three-level hierarchy (vendor → brand → category) reads visually.
  groupCategoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 28,
    paddingRight: 18,
    paddingVertical: 4,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  groupCategoryText: {
    flex: 1,
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textMuted,
    fontStyle: "italic",
  },
  groupCategoryCount: {
    fontSize: 10,
    fontWeight: "600",
    color: Colors.textMuted,
  },
  noRows: { padding: 24, alignItems: "center", gap: 6 },
  noRowsText: { fontSize: 13, color: Colors.textMuted },
  emptyHint: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
  },
  emptyHintText: { fontSize: 12, color: Colors.textMuted },
  // Notice shown in the empty-data state when a search filter was set via
  // the VendorCode link from the Orders tab. Helps the user understand
  // the navigation worked even though there's nothing to filter yet.
  linkedQueuedBox: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    backgroundColor: Colors.surface,
    borderColor: Colors.primary,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 4,
  },
  linkedQueuedText: { flex: 1, fontSize: 12, color: Colors.text, lineHeight: 18 },
  linkedQueuedCode: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontWeight: "700" },

  // Filter chip row (sits below the search box)
  filterRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  filterChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterChipText: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  filterChipTextActive: {
    color: Colors.textInverse,
  },

  // "No rows" extra clear-filters action
  noRowsClear: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: "700",
    color: Colors.primary,
  },

  // Filter modal (vendor / category)
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    maxHeight: "75%",
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: "center",
    marginBottom: 16,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: Colors.text },
  modalClear: { fontSize: 14, fontWeight: "700", color: Colors.danger },
  modalDoneBtn: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  // DODate range modal — two side-by-side DD/MM/YYYY inputs.
  dateRangeWrap: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  dateRangeField: { flex: 1 },
  dateRangeLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  dateRangeInput: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  dateRangeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  dateRangeButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  dateRangeError: {
    fontSize: 12,
    color: Colors.danger,
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 4,
  },
  modalDoneBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.textInverse,
  },
  optionSearchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  optionSearchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.text,
    paddingVertical: 0,
  },
  optionList: { paddingHorizontal: 20 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  optionRowActive: { backgroundColor: Colors.primaryMuted + "80" },
  optionLabel: { fontSize: 15, fontWeight: "600", color: Colors.text },
  optionLabelActive: { color: Colors.primary },
  optionSubLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 1,
  },
  optionCount: {
    fontSize: 12,
    color: Colors.textMuted,
    marginRight: 4,
  },
  noOptions: {
    alignItems: "center",
    padding: 32,
    gap: 8,
  },
  noOptionsTitle: { fontSize: 15, fontWeight: "700", color: Colors.text },
  noOptionsSub: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
});
