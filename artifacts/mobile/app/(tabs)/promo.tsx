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
  Keyboard,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as XLSX from "xlsx-js-style";
import * as Haptics from "expo-haptics";
import * as Sharing from "expo-sharing";
import { Colors } from "@/constants/colors";
import {
  useApp,
  PromoEntry,
  PROMO_FIELDS,
  showStorageErrorAlert,
} from "@/context/AppContext";

// Columns the importer should attempt to coerce to a number. Anything
// outside this set (Item No, BatchNo, Brand, Category, Item Description)
// stays as the original string so leading zeros and free-text values
// survive the round trip through Excel.
const NUMERIC_FIELDS = new Set<string>([
  "NoofBatches",
  "SP",
  "SoldQty",
  "PromotionPrice",
  "Latest MRP",
  "MRP",
  // On-hand stock quantity. Stored as Double so it survives fractional
  // unit-of-measure values (kg, ltr) without being silently truncated.
  "OH Qty",
  // Wholesale / purchase cost per unit. Decimal so values like 12.50
  // survive the round trip through Excel.
  "Cost",
]);

// Date columns. Excel surfaces these as JS Date objects (cellDates:true),
// raw serial numbers (e.g. 45123 for 2023-07-12), or already-formatted
// strings — none of which render usefully if we just String()-stringify
// them. Normalised to "DD/MM/YYYY".
const DATE_FIELDS = new Set<string>([
  "PromotionToDate",
  "Promo CR Date",
]);

// Columns that NoofBatches-style values should display as integers, even
// though they're stored as numbers (it's an integer field per the
// schema). Other numeric fields use 2dp.
const INTEGER_FIELDS = new Set<string>(["NoofBatches"]);

// Columns that should always render with two decimal places, even when
// the underlying value is a whole number (e.g. Cost of 12 displays as
// "12.00"). Other numeric fields keep the existing behaviour where
// integers render without trailing zeros.
const DECIMAL_FIELDS = new Set<string>(["Cost"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Strip the time component so date comparisons are inclusive on
// whole-day boundaries regardless of when the picker fires.
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Inverse of formatDDMMYYYY — accepts "DD/MM/YYYY" (or DD-MM-YYYY,
// DD/MM/YY) and returns a Date at local midnight, or null if the
// string isn't a valid date. Used by the Promo CR Date range filter
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

// Coerce a raw Excel date cell into a stable "DD/MM/YYYY" display
// string. Same logic used by the Latest Purchases tab — anything we
// can't parse falls through to its original string so we never
// silently destroy user data.
function coerceDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : formatDDMMYYYY(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? String(v) : formatDDMMYYYY(d);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return "";
    const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m1) {
      const day = parseInt(m1[1], 10);
      const mon = parseInt(m1[2], 10);
      let yr = parseInt(m1[3], 10);
      if (yr < 100) yr += 2000;
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    const m2 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const yr = parseInt(m2[1], 10);
      const mon = parseInt(m2[2], 10);
      const day = parseInt(m2[3], 10);
      const d = new Date(yr, mon - 1, day);
      if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return formatDDMMYYYY(d);
    return s;
  }
  return String(v);
}

// Per-column display widths for the horizontally scrollable table. Wider
// columns are reserved for free-text fields that overflow (Item
// Description, Brand, Category); narrow columns for short numerics and
// dates. Falls back to 90 for anything not listed.
const COL_WIDTHS: Record<string, number> = {
  PromotionToDate: 86,
  Category: 96,
  "Item No": 78,
  Brand: 120,
  NoofBatches: 64,
  "Item Description": 220,
  SP: 56,
  SoldQty: 64,
  PromotionPrice: 72,
  "New Qty": 64,
  "Promo CR Date": 86,
  "Latest MRP": 76,
  MRP: 56,
  BatchNo: 88,
  VendorCode: 88,
  VendorName: 150,
  "OH Qty": 58,
  Cost: 56,
};

function colWidth(field: string): number {
  return COL_WIDTHS[field] ?? 70;
}

// Fields shown in each item card, organized into three stacked lines.
// Other PROMO_FIELDS (e.g. Category, BatchNo, VendorCode, SoldQty,
// Brand, VendorName) are still imported and remain
// searchable / filterable; Brand and VendorName drive the nested group
// headers above each set of cards.
const CARD_LINE_1_LEFT = "Item No";
const CARD_LINE_1_RIGHT = "Item Description";
const CARD_LINE_2 = "Latest MRP";
// All Promo columns shown in the per-row table on each card. Item No /
// Item Description / Latest MRP appear above the table on lines 1 and
// 2, and Brand / VendorName drive the nested group headers, so they
// are intentionally omitted here. Cost is removed for non-Admin users
// downstream.
const CARD_LINE_3: readonly string[] = [
  "MRP",
  "SP",
  "Cost",
  "PromotionPrice",
  "OH Qty",
  "New Qty",
  "PromotionToDate",
  "Category",
];

// Sentinel field name for the user-editable "New Qty" cell. Not a real
// imported column — it's stored separately in AppContext keyed by
// `${itemNo}|${batchNo}` so a fresh Promo import doesn't blow it away.
const NEW_QTY_FIELD = "New Qty";

// Display labels for card fields whose underlying column name we want
// to abbreviate or soften for the user. The data field name itself
// stays unchanged (still `PromotionPrice` / `PromotionToDate` in the
// imported rows, search, filters, etc).
const CARD_FIELD_LABEL: Record<string, string> = {
  PromotionPrice: "Promo",
  PromotionToDate: "Valid Till",
};

function cardLabel(field: string): string {
  return CARD_FIELD_LABEL[field] ?? field;
}

// Fields a user is most likely to search by. Numeric fields are
// excluded so a stray "10" doesn't match every row with a price ending
// in 10.
const SEARCH_FIELDS = [
  "Item No",
  "BatchNo",
  "Brand",
  "Category",
  "Item Description",
  "VendorCode",
  "VendorName",
];

function formatCell(field: string, value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    if (DECIMAL_FIELDS.has(field)) return value.toFixed(2);
    if (INTEGER_FIELDS.has(field) || Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }
  return String(value);
}

export default function PromoScreen() {
  const router = useRouter();
  const {
    promoEntries,
    mrpEntries,
    savePromoBatch,
    clearPromoBatch,
    currentUser,
    promoNewQty,
    setPromoNewQtyValue,
  } = useApp();
  // Cost (wholesale / purchase price per unit) is sensitive margin info,
  // so it's only shown to admin-privileged users. Vendors / Managers /
  // Staff see the same card layout with the Cost cell removed.
  const isAdmin = currentUser?.userType === "Admin";
  const cardLine3 = isAdmin ? CARD_LINE_3 : CARD_LINE_3.filter((f) => f !== "Cost");
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Multi-select filters that mirror the StockUpd tab — sheet-style
  // pickers, search-as-you-type inside each modal, and progressive
  // scoping (vendor narrows brand list, vendor + brand narrow
  // category list).
  const [activeVendors, setActiveVendors] = useState<string[]>([]);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");
  const [activeBrands, setActiveBrands] = useState<string[]>([]);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  // Quick toggle: when on, restrict the table to items whose Item No
  // appears with more than one distinct MRP value across the imported
  // data. Useful for spotting price discrepancies / multi-batch items.
  const [onlyMultiMrp, setOnlyMultiMrp] = useState(false);
  // Quick toggle: when on, restrict the table to Item Nos that have at
  // least one MRP value present in the MRP tab but missing from this
  // item's Promo rows (the same items that would render an injected
  // amber "from MRP tab" row). Lets the user jump straight to items
  // that need their promo data filled in.
  const [missingPromo, setMissingPromo] = useState(false);
  // Inclusive date range filter for the "Promo CR Date" column. Both
  // bounds are optional — only-from / only-to / both-set all narrow
  // the table; cleared = show all rows. Drafts hold the in-progress
  // text in the modal so partial input like "1/" doesn't immediately
  // discard whatever the user typed.
  const [promoCrFrom, setPromoCrFrom] = useState<Date | null>(null);
  const [promoCrTo, setPromoCrTo] = useState<Date | null>(null);
  const [showPromoCrModal, setShowPromoCrModal] = useState(false);
  // Calendar-picker drafts. Defaults to "today" so the picker opens
  // on a sensible date instead of an arbitrary epoch. The actual
  // committed filter (promoCrFrom/promoCrTo) is only updated on Apply.
  const [promoCrFromDraft, setPromoCrFromDraft] = useState<Date>(() => startOfDay(new Date()));
  const [promoCrToDraft, setPromoCrToDraft] = useState<Date>(() => startOfDay(new Date()));
  // Which sub-picker is currently visible. On Android, DateTimePicker
  // is a one-shot dialog; on iOS/web we render it inline below the
  // matching field button.
  const [showPromoCrFromPicker, setShowPromoCrFromPicker] = useState(false);
  const [showPromoCrToPicker, setShowPromoCrToPicker] = useState(false);
  const [promoCrError, setPromoCrError] = useState<string | null>(null);
  // When on, the "New Qty" cell becomes an inline decimal TextInput so
  // the user can type a quantity per row. Off by default so the table
  // stays scrollable / tap-safe.
  const [modifyMode, setModifyMode] = useState(false);
  // Local in-progress text per (itemNo|batchNo) while the user is
  // typing. Lets us accept partial values like "12." that aren't yet a
  // valid number, and only commit on blur.
  const [newQtyDrafts, setNewQtyDrafts] = useState<Record<string, string>>({});
  // Spinner on the explicit "Save" chip while we flush every pending
  // New Qty draft into AsyncStorage via setPromoNewQtyValue. Drafts
  // already auto-save on blur, but the chip gives users an obvious,
  // discoverable way to commit changes without having to tap outside
  // the input first.
  const [savingNewQty, setSavingNewQty] = useState(false);
  async function flushNewQtyDrafts() {
    Keyboard.dismiss();
    const entries = Object.entries(newQtyDrafts);
    if (entries.length === 0) {
      setStatusMsg("All New Qty changes already saved.");
      setTimeout(() => setStatusMsg(null), 2500);
      return;
    }
    setSavingNewQty(true);
    let saved = 0;
    let cleared = 0;
    let invalid = 0;
    try {
      for (const [key, raw] of entries) {
        const trimmed = raw.trim();
        if (trimmed === "") {
          if (promoNewQty[key] !== undefined) {
            await setPromoNewQtyValue(key, undefined);
            cleared += 1;
          }
          continue;
        }
        const num = Number(trimmed);
        if (!Number.isFinite(num) || num < 0) {
          invalid += 1;
          continue;
        }
        await setPromoNewQtyValue(key, num);
        saved += 1;
      }
      setNewQtyDrafts({});
      const parts: string[] = [];
      if (saved > 0) parts.push(`${saved} saved`);
      if (cleared > 0) parts.push(`${cleared} cleared`);
      if (invalid > 0) parts.push(`${invalid} skipped (invalid)`);
      setStatusMsg(`New Qty: ${parts.join(", ") || "no changes"}.`);
      setTimeout(() => setStatusMsg(null), 3000);
    } finally {
      setSavingNewQty(false);
    }
  }
  // Spinner shown on the export button while the workbook is being
  // built and shared. Mirrors the MRP tab's `downloading` flag.
  const [exporting, setExporting] = useState(false);

  // When another tab deep-links into Promo with `?q=<itemNo>` (e.g.
  // tapping an Item No on the Stock Update tab), seed the search box
  // with that value and clear any active vendor/brand/category/multi-MRP
  // filters so the targeted item isn't accidentally hidden. Re-runs
  // whenever the param value changes so repeat taps re-focus.
  const params = useLocalSearchParams<{ q?: string | string[] }>();
  const qParam = Array.isArray(params.q) ? params.q[0] : params.q;
  useEffect(() => {
    if (typeof qParam === "string" && qParam.trim() !== "") {
      setSearch(qParam.trim());
      setActiveVendors([]);
      setActiveBrands([]);
      setActiveCategories([]);
      setOnlyMultiMrp(false);
      setMissingPromo(false);
    }
  }, [qParam]);
  // Import progress: 0-100 with a human-readable phase label. Same
  // pattern as the MRP import — the parsing loop yields to the event
  // loop in chunks so the bar can actually paint while we work.
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState<string>("");

  // Refs + guard for syncing horizontal scroll between the (sticky)
  // table header and the rows below it. Without the guard each
  // scrollTo would re-fire its sibling's onScroll handler and create
  // a feedback loop.
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

  // Vendor list = every distinct VendorName seen in the data, sorted
  // case-insensitively.
  const allVendors = useMemo(() => {
    const set = new Set<string>();
    for (const r of promoEntries) {
      const v = String(r["VendorName"] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [promoEntries]);

  // Rows that survive the vendor filter — used to scope the brand
  // picker so users only see brands that actually exist for the
  // selected vendor(s). With no vendor selected, this is the full
  // dataset.
  const vendorScopedEntries = useMemo(() => {
    if (activeVendors.length === 0) return promoEntries;
    const set = new Set(activeVendors);
    return promoEntries.filter(
      (r) => set.has(String(r["VendorName"] ?? "").trim())
    );
  }, [promoEntries, activeVendors]);

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    for (const r of vendorScopedEntries) {
      const v = String(r["Brand"] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [vendorScopedEntries]);

  // Categories are scoped by both vendor and brand, so picking a brand
  // only offers categories that actually have rows under that brand
  // (and vendor, if one is selected).
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    const brandSet = activeBrands.length > 0 ? new Set(activeBrands) : null;
    for (const r of vendorScopedEntries) {
      if (brandSet && !brandSet.has(String(r["Brand"] ?? "").trim())) continue;
      const v = String(r["Category"] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [vendorScopedEntries, activeBrands]);

  // If the underlying data changes (e.g. a re-import) such that a
  // previously-selected vendor / brand / category no longer exists,
  // drop those selections so the UI never shows a "phantom" active
  // filter that hides every row.
  React.useEffect(() => {
    if (activeVendors.length === 0) return;
    const allowed = new Set(allVendors);
    const next = activeVendors.filter((v) => allowed.has(v));
    if (next.length !== activeVendors.length) setActiveVendors(next);
  }, [allVendors, activeVendors]);

  React.useEffect(() => {
    if (activeBrands.length === 0) return;
    const allowed = new Set(allBrands);
    const next = activeBrands.filter((b) => allowed.has(b));
    if (next.length !== activeBrands.length) setActiveBrands(next);
  }, [allBrands, activeBrands]);

  React.useEffect(() => {
    if (activeCategories.length === 0) return;
    const allowed = new Set(allCategories);
    const next = activeCategories.filter((c) => allowed.has(c));
    if (next.length !== activeCategories.length) setActiveCategories(next);
  }, [allCategories, activeCategories]);

  function toggleVendor(name: string) {
    setActiveVendors((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]
    );
  }
  function toggleBrand(brand: string) {
    setActiveBrands((prev) =>
      prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]
    );
  }
  function toggleCategory(category: string) {
    setActiveCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  }

  // Per-row counts shown next to each option in the picker. Vendor
  // counts are over the full dataset; brand counts respect the vendor
  // filter; category counts respect both vendor + brand.
  function vendorRowCount(name: string): number {
    let n = 0;
    for (const r of promoEntries) {
      if (String(r["VendorName"] ?? "").trim() === name) n++;
    }
    return n;
  }
  function brandRowCount(brand: string): number {
    let n = 0;
    for (const r of vendorScopedEntries) {
      if (String(r["Brand"] ?? "").trim() === brand) n++;
    }
    return n;
  }
  function categoryRowCount(category: string): number {
    const brandSet = activeBrands.length > 0 ? new Set(activeBrands) : null;
    let n = 0;
    for (const r of vendorScopedEntries) {
      if (brandSet && !brandSet.has(String(r["Brand"] ?? "").trim())) continue;
      if (String(r["Category"] ?? "").trim() === category) n++;
    }
    return n;
  }

  // Map of normalised Item No -> sorted unique MRP values pulled from
  // the MRP tab. Used below to surface MRPs that exist in the MRP tab
  // but have no matching Promo row for the same Item No, so the user
  // can see at a glance which prices are missing promo data.
  const mrpByItem = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const e of mrpEntries) {
      const key = e.itemNo.trim().toLowerCase();
      if (!key) continue;
      let arr = m.get(key);
      if (!arr) {
        arr = [];
        m.set(key, arr);
      }
      if (!arr.includes(e.mrp)) arr.push(e.mrp);
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b);
    return m;
  }, [mrpEntries]);

  // Pre-computed set of trimmed Item Nos that qualify for the
  // "Missing Promo" filter — an Item No qualifies if the MRP tab
  // lists at least one MRP value that isn't represented in any of
  // the Item's existing Promo rows. This used to be re-derived
  // inside the `filtered` useMemo on every toggle (and every
  // unrelated filter change), which scanned all promo rows and
  // walked the MRP map for each item — noticeable on large data
  // sets. Now it's memoised against the raw `promoEntries` and
  // `mrpByItem` so toggling Missing Promo collapses to a single
  // Set lookup per row.
  const missingPromoItemSet = useMemo(() => {
    const existingByItem = new Map<string, Set<string>>();
    for (const r of promoEntries) {
      const itemNo = String(r["Item No"] ?? "").trim();
      if (!itemNo) continue;
      const v = r["MRP"];
      const n =
        typeof v === "number" ? v : parseFloat(String(v ?? "").trim());
      if (isNaN(n)) continue;
      let s = existingByItem.get(itemNo);
      if (!s) {
        s = new Set();
        existingByItem.set(itemNo, s);
      }
      s.add(String(n));
    }
    const qualifies = new Set<string>();
    for (const [itemNo, existing] of existingByItem) {
      const list = mrpByItem.get(itemNo.toLowerCase()) ?? [];
      if (list.some((m) => !existing.has(String(m)))) {
        qualifies.add(itemNo);
      }
    }
    return qualifies;
  }, [promoEntries, mrpByItem]);

  const filtered = useMemo(() => {
    const vendorSet = activeVendors.length > 0 ? new Set(activeVendors) : null;
    const brandSet = activeBrands.length > 0 ? new Set(activeBrands) : null;
    const categorySet = activeCategories.length > 0 ? new Set(activeCategories) : null;
    const q = search.trim().toLowerCase();
    // Normalise the Promo CR Date bounds to local-midnight timestamps
    // once so the per-row check is a cheap numeric comparison. Both
    // bounds are inclusive: a row dated exactly on `from` or `to`
    // passes the filter.
    const fromTs = promoCrFrom
      ? new Date(
          promoCrFrom.getFullYear(),
          promoCrFrom.getMonth(),
          promoCrFrom.getDate()
        ).getTime()
      : null;
    const toTs = promoCrTo
      ? new Date(
          promoCrTo.getFullYear(),
          promoCrTo.getMonth(),
          promoCrTo.getDate()
        ).getTime()
      : null;
    let base = promoEntries.filter((r) => {
      if (vendorSet && !vendorSet.has(String(r["VendorName"] ?? "").trim())) return false;
      if (brandSet && !brandSet.has(String(r["Brand"] ?? "").trim())) return false;
      if (categorySet && !categorySet.has(String(r["Category"] ?? "").trim())) return false;
      if (q && !SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q))) return false;
      if (fromTs !== null || toTs !== null) {
        const raw = r["Promo CR Date"];
        const parsed = typeof raw === "string" ? parseDDMMYYYY(raw) : null;
        if (!parsed) return false;
        const ts = parsed.getTime();
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      return true;
    });

    // "Multiple MRP" toggle: keep only rows whose Item No, within the
    // current view, has more than one distinct MRP value. Numeric
    // normalisation so "100" and 100 collapse to the same value.
    if (onlyMultiMrp) {
      const mrpsByItem = new Map<string, Set<string>>();
      for (const r of base) {
        const itemNo = String(r["Item No"] ?? "").trim();
        if (!itemNo) continue;
        const mrpRaw = r["MRP"];
        const norm =
          typeof mrpRaw === "number"
            ? String(mrpRaw)
            : (() => {
                const s = String(mrpRaw ?? "").trim();
                const n = parseFloat(s);
                return isNaN(n) ? s : String(n);
              })();
        let s = mrpsByItem.get(itemNo);
        if (!s) {
          s = new Set();
          mrpsByItem.set(itemNo, s);
        }
        s.add(norm);
      }
      base = base.filter((r) => {
        const itemNo = String(r["Item No"] ?? "").trim();
        const set = itemNo ? mrpsByItem.get(itemNo) : undefined;
        return !!set && set.size > 1;
      });
    }

    // "Missing Promo" toggle: keep only rows whose Item No is in the
    // pre-computed `missingPromoItemSet`. The set is derived from the
    // full `promoEntries` + MRP-tab data once (see `missingPromoItemSet`
    // above) so toggling this chip is a cheap O(n) Set lookup over
    // the current `base` instead of re-scanning everything.
    if (missingPromo) {
      base = base.filter((r) =>
        missingPromoItemSet.has(String(r["Item No"] ?? "").trim())
      );
    }

    return base;
  }, [
    promoEntries,
    search,
    activeVendors,
    activeBrands,
    activeCategories,
    onlyMultiMrp,
    missingPromo,
    missingPromoItemSet,
  ]);

  // Group the filtered rows three levels deep:
  //   Brand -> VendorName -> Item No -> rows (one row per price variant)
  // so that an Item No with multiple MRP/Batch combinations renders as a
  // single card whose price strip is a stacked list of variants.
  // Brands / vendors / item-no order is case-insensitive alphabetical;
  // missing brand or vendor values bucket into "(No Brand)" /
  // "(No Vendor)" and sort last.
  const grouped = useMemo(() => {
    type ItemBucket = { itemNo: string; rows: PromoEntry[] };
    type VendorBucket = { vendorName: string; items: ItemBucket[]; itemCount: number };
    type BrandBucket = { brand: string; vendors: VendorBucket[]; itemCount: number };

    const sortKeys = (a: string, b: string, missing: string) => {
      if (a === missing) return 1;
      if (b === missing) return -1;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    };

    // brand -> vendor -> itemNo -> rows[]
    const brandMap = new Map<string, Map<string, Map<string, PromoEntry[]>>>();
    for (const r of filtered) {
      const brandKey = String(r["Brand"] ?? "").trim() || "(No Brand)";
      const vendorKey = String(r["VendorName"] ?? "").trim() || "(No Vendor)";
      const itemKey = String(r["Item No"] ?? "").trim() || "(No Item No)";

      let vendorMap = brandMap.get(brandKey);
      if (!vendorMap) {
        vendorMap = new Map();
        brandMap.set(brandKey, vendorMap);
      }
      let itemMap = vendorMap.get(vendorKey);
      if (!itemMap) {
        itemMap = new Map();
        vendorMap.set(vendorKey, itemMap);
      }
      let rows = itemMap.get(itemKey);
      if (!rows) {
        rows = [];
        itemMap.set(itemKey, rows);
      }
      rows.push(r);
    }

    const out: BrandBucket[] = [];
    const brandKeys = Array.from(brandMap.keys()).sort((a, b) =>
      sortKeys(a, b, "(No Brand)")
    );
    for (const brand of brandKeys) {
      const vendorMap = brandMap.get(brand)!;
      const vendorKeys = Array.from(vendorMap.keys()).sort((a, b) =>
        sortKeys(a, b, "(No Vendor)")
      );
      const vendors: VendorBucket[] = vendorKeys.map((vendorName) => {
        const itemMap = vendorMap.get(vendorName)!;
        const itemKeys = Array.from(itemMap.keys()).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
        );
        const items: ItemBucket[] = itemKeys.map((itemNo) => {
          const existingRows = itemMap.get(itemNo)!;
          // Collect MRP values already represented in this Item No's
          // promo rows. Numbers and numeric strings ("100", 100) collapse
          // to the same key so they don't double-count.
          const existingMrps = new Set<string>();
          for (const r of existingRows) {
            const v = r["MRP"];
            const n =
              typeof v === "number" ? v : parseFloat(String(v ?? "").trim());
            if (!isNaN(n)) existingMrps.add(String(n));
          }
          // Look up MRP-tab values for this Item No (case/whitespace
          // insensitive). Any MRP present in the MRP tab but missing
          // from the Promo rows is appended as a synthetic row that
          // shows the MRP and leaves SP / Promo / Valid Till / OH Qty
          // intentionally blank so the user can spot the gap.
          const lookupKey = itemNo.trim().toLowerCase();
          const mrpListFromTab =
            lookupKey && lookupKey !== "(no item no)"
              ? mrpByItem.get(lookupKey) ?? []
              : [];
          const head = existingRows[0];
          const synthetic: PromoEntry[] = [];
          for (const m of mrpListFromTab) {
            if (existingMrps.has(String(m))) continue;
            // Synthetic rows have no real BatchNo (they were injected
            // from the MRP tab where there's no Promo row). Generate a
            // deterministic placeholder by concatenating the MRP value
            // with "00" and left-padding with zeros to a 6-char string,
            // e.g. MRP 125 -> "012500". Stored as text so it survives
            // round-trips without losing leading zeros, and so the
            // editable "New Qty" cell has a stable per-row key.
            const synthBatchRaw = `${String(m)}00`;
            const synthBatchNo =
              synthBatchRaw.length < 6
                ? synthBatchRaw.padStart(6, "0")
                : synthBatchRaw;
            synthetic.push({
              "Item No": String(head["Item No"] ?? itemNo),
              Brand: String(head["Brand"] ?? ""),
              Category: String(head["Category"] ?? ""),
              VendorName: String(head["VendorName"] ?? ""),
              "Item Description": String(head["Item Description"] ?? ""),
              MRP: m,
              BatchNo: synthBatchNo,
              // Marker (non-PROMO_FIELDS key) used by the row renderer
              // to apply a subtle highlight so the user can see this
              // row was injected from the MRP tab and has no promo
              // detail of its own.
              __mrpFromMrpTab: 1,
            } as PromoEntry);
          }
          return {
            itemNo,
            rows: synthetic.length > 0 ? [...existingRows, ...synthetic] : existingRows,
          };
        });
        return { vendorName, items, itemCount: items.length };
      });
      const itemCount = vendors.reduce((s, v) => s + v.itemCount, 0);
      out.push({ brand, vendors, itemCount });
    }
    return out;
  }, [filtered, mrpByItem]);

  function yieldToUI(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }

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

      const asset = result.assets[0];
      setProgress(5);
      setProgressLabel("Opening file…");
      await yieldToUI();

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
        await yieldToUI();
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
        await yieldToUI();
        workbook = XLSX.read(base64, { type: "base64", cellDates: true });
      }

      setProgress(40);
      setProgressLabel("Extracting rows…");
      await yieldToUI();

      const sheetName =
        workbook.SheetNames.find(
          (n) => n.toLowerCase().replace(/\s+/g, "") === "promo" ||
                 n.toLowerCase().replace(/\s+/g, "") === "promotionmaster"
        ) ?? workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (raw.length === 0) {
        setErrors(["The file appears to be empty or has no data rows."]);
        setLoading(false);
        return;
      }

      // Case- and whitespace-insensitive header lookup, matches the
      // MRP and Latest Purchases tabs.
      const firstRow = raw[0];
      const keyMap: Record<string, string> = {};
      for (const k of Object.keys(firstRow)) {
        keyMap[k.toLowerCase().replace(/\s+/g, "")] = k;
      }
      const fieldKeys: Record<string, string | undefined> = {};
      for (const field of PROMO_FIELDS) {
        fieldKeys[field] = keyMap[field.toLowerCase().replace(/\s+/g, "")];
      }

      const itemNoKey = fieldKeys["Item No"];
      const batchNoKey = fieldKeys["BatchNo"];
      const mrpKey = fieldKeys["MRP"];
      if (!itemNoKey || !batchNoKey) {
        setErrors([
          `Missing required columns. Expected "Item No" and "BatchNo" (other columns like "Cost" are optional). Found: ${Object.keys(firstRow).join(", ")}`,
        ]);
        setLoading(false);
        return;
      }

      // Walk the rows in chunks so we can drive the progress bar
      // through the parsing phase. Aim for ~25 progress updates
      // regardless of file size.
      const seenPair = new Set<string>();
      const parsed: PromoEntry[] = [];
      const localErrors: string[] = [];
      const chunkSize = Math.max(50, Math.ceil(raw.length / 25));
      const PARSE_FROM = 40;
      const PARSE_TO = 90;
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const itemNo = String(r[itemNoKey] ?? "").trim();
        const batchNo = String(r[batchNoKey] ?? "").trim();
        const mrpRaw = mrpKey ? String(r[mrpKey] ?? "").trim() : "";
        if (!itemNo || !batchNo) {
          localErrors.push(`Row ${i + 2}: missing Item No / BatchNo`);
        } else {
          // Dedupe by (Item No, BatchNo, MRP) — first occurrence wins.
          // Including MRP in the key means the same Item+Batch with
          // different MRP values survive as separate rows, so the user
          // can see every MRP/Promo combination on the cards.
          const key = `${itemNo.toUpperCase()}|${batchNo.toUpperCase()}|${mrpRaw.toUpperCase()}`;
          if (!seenPair.has(key)) {
            seenPair.add(key);
            const entry: PromoEntry = {};
            for (const field of PROMO_FIELDS) {
              const sourceKey = fieldKeys[field];
              if (!sourceKey) {
                entry[field] = "";
                continue;
              }
              const v = r[sourceKey];
              if (DATE_FIELDS.has(field)) {
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
          }
        }
        if ((i + 1) % chunkSize === 0 || i === raw.length - 1) {
          const ratio = (i + 1) / raw.length;
          setProgress(Math.round(PARSE_FROM + (PARSE_TO - PARSE_FROM) * ratio));
          setProgressLabel(`Parsing rows ${i + 1} of ${raw.length}…`);
          await yieldToUI();
        }
      }

      if (parsed.length === 0) {
        setErrors([
          "No valid rows found. Make sure Item No and BatchNo are filled.",
          ...localErrors,
        ]);
        setLoading(false);
        return;
      }

      setProgress(92);
      setProgressLabel("Sorting entries…");
      await yieldToUI();
      // Sort by Item No, then BatchNo, then MRP — so all rows for the
      // same item group together visually and multiple MRPs for the
      // same item+batch appear in a stable, ascending order.
      parsed.sort((a, b) => {
        const ai = String(a["Item No"] ?? "");
        const bi = String(b["Item No"] ?? "");
        const c = ai.localeCompare(bi, undefined, { numeric: true, sensitivity: "base" });
        if (c !== 0) return c;
        const ab = String(a["BatchNo"] ?? "");
        const bb = String(b["BatchNo"] ?? "");
        const cb = ab.localeCompare(bb, undefined, { numeric: true, sensitivity: "base" });
        if (cb !== 0) return cb;
        const am = typeof a["MRP"] === "number" ? (a["MRP"] as number) : parseFloat(String(a["MRP"] ?? "")) || 0;
        const bm = typeof b["MRP"] === "number" ? (b["MRP"] as number) : parseFloat(String(b["MRP"] ?? "")) || 0;
        return am - bm;
      });

      setProgress(95);
      setProgressLabel("Saving…");
      await yieldToUI();
      try {
        await savePromoBatch(parsed);
      } catch {
        showStorageErrorAlert();
        setLoading(false);
        return;
      }
      setProgress(100);
      setProgressLabel("Done");
      setStatusMsg(
        `Imported ${parsed.length} promo entr${parsed.length !== 1 ? "ies" : "y"} from "${asset.name}".`
      );
      if (localErrors.length > 0) setErrors(localErrors);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Jump to the Orders tab so the user can immediately start placing
      // orders against the freshly imported promo data, which is the
      // most common next step after a Promo import.
      router.replace("/orders-hub?view=place");
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to import file"]);
    } finally {
      setLoading(false);
    }
  }

  // True iff at least one currently-visible row (i.e. a row in the
  // filtered + grouped set, including synthetic "from MRP tab" rows)
  // has a user-entered "New Qty" value. Drives the visibility of the
  // export button so we never show a button that would produce an
  // empty workbook.
  const hasNewQtyToExport = useMemo(() => {
    for (const brand of grouped) {
      for (const vendor of brand.vendors) {
        for (const item of vendor.items) {
          for (const row of item.rows) {
            const batchNoStr = String(row["BatchNo"] ?? "");
            const qtyKey = `${item.itemNo}|${batchNoStr}`;
            if (promoNewQty[qtyKey] !== undefined) return true;
          }
        }
      }
    }
    return false;
  }, [grouped, promoNewQty]);

  // Build an .xlsx of every visible row that has a "New Qty" value
  // typed in. Honours the active filters (search + vendor / brand /
  // category + Missing Promo + Multiple MRP) so the export matches the
  // on-screen view, but does NOT touch any of the filter button states
  // — they're left exactly as the user set them.
  async function handleExportNewQty() {
    if (!hasNewQtyToExport) return;
    try {
      setExporting(true);
      const headers = [...PROMO_FIELDS, NEW_QTY_FIELD];
      const data: (string | number)[][] = [headers];
      for (const brand of grouped) {
        for (const vendor of brand.vendors) {
          for (const item of vendor.items) {
            for (const row of item.rows) {
              const batchNoStr = String(row["BatchNo"] ?? "");
              const qtyKey = `${item.itemNo}|${batchNoStr}`;
              const qty = promoNewQty[qtyKey];
              if (qty === undefined) continue;
              const out: (string | number)[] = headers.map((h) => {
                if (h === NEW_QTY_FIELD) return qty;
                const v = row[h];
                if (v === undefined || v === null) return "";
                return v;
              });
              data.push(out);
            }
          }
        }
      }
      if (data.length <= 1) {
        Alert.alert("Nothing to export", "No rows with a New Qty match the current filters.");
        return;
      }
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = headers.map((h) =>
        h === "Item Description" ? { wch: 32 } : h === NEW_QTY_FIELD ? { wch: 10 } : { wch: 14 }
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "PromoNewQty");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Sathyam Promo NewQty - ${_ts}.xlsx`;
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
            dialogTitle: "Export Promo New Qty",
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
      setExporting(false);
    }
  }

  // Build an .xlsx of every batch row for any Item No that has at
  // least one user-entered "New Qty" value. Unlike `handleExportNewQty`
  // (which exports only the rows whose New Qty was set and respects
  // the on-screen filters), this dump pulls straight from
  // `promoEntries` so every batch of every touched Item No is
  // included, regardless of search / vendor / brand / category /
  // Missing Promo / Multiple MRP filters. All PROMO_FIELDS columns
  // plus the New Qty column are written.
  const hasTouchedItemsToExport = useMemo(() => {
    if (Object.keys(promoNewQty).length === 0) return false;
    for (const key of Object.keys(promoNewQty)) {
      if (promoNewQty[key] !== undefined) return true;
    }
    return false;
  }, [promoNewQty]);
  async function handleExportTouchedItemBatches() {
    if (!hasTouchedItemsToExport) return;
    try {
      setExporting(true);
      // Collect every itemNo that has at least one batch with a
      // user-entered New Qty value. Normalize (trim + lowercase) so
      // raw rows whose Item No has stray whitespace or differing case
      // still match — the grouped-card path stores keys built from a
      // trimmed itemNo, while raw promoEntries rows may not be
      // trimmed.
      const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
      const touchedItemNos = new Set<string>();
      for (const key of Object.keys(promoNewQty)) {
        if (promoNewQty[key] === undefined) continue;
        const itemNo = norm(key.split("|")[0]);
        if (itemNo) touchedItemNos.add(itemNo);
      }
      if (touchedItemNos.size === 0) {
        Alert.alert("Nothing to export", "No items with a New Qty value yet.");
        return;
      }
      const headers = [...PROMO_FIELDS, NEW_QTY_FIELD];
      const data: (string | number)[][] = [headers];
      for (const row of promoEntries) {
        const rowItemNoRaw = String(row["Item No"] ?? "");
        const rowItemNoTrim = rowItemNoRaw.trim();
        if (!touchedItemNos.has(rowItemNoTrim.toLowerCase())) continue;
        // The New Qty map is keyed by `${trimmedItemNo}|${batchNoStr}`
        // where batchNoStr can legitimately be the empty string for
        // rows whose BatchNo column was blank in the import. Look the
        // qty up using the same trimmed key shape so empty-BatchNo
        // rows pick up their stored value.
        const batchNoStr = String(row["BatchNo"] ?? "");
        const qtyKey = `${rowItemNoTrim}|${batchNoStr}`;
        const qty = promoNewQty[qtyKey];
        const out: (string | number)[] = headers.map((h) => {
          if (h === NEW_QTY_FIELD) return qty ?? "";
          const v = row[h];
          if (v === undefined || v === null) return "";
          return v;
        });
        data.push(out);
      }
      if (data.length <= 1) {
        Alert.alert(
          "Nothing to export",
          "Couldn't find any batches for the items with New Qty values."
        );
        return;
      }
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = headers.map((h) =>
        h === "Item Description" ? { wch: 32 } : h === NEW_QTY_FIELD ? { wch: 10 } : { wch: 14 }
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "PromoTouchedItems");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Sathyam Promo Touched Items - ${_ts}.xlsx`;
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
            dialogTitle: "Export Promo Touched Items",
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
      setExporting(false);
    }
  }

  function handleClear() {
    if (promoEntries.length === 0) return;
    const msg = `Remove all ${promoEntries.length} promo entries? This cannot be undone.`;
    const doClear = async () => {
      try {
        await clearPromoBatch();
        setStatusMsg(null);
        setErrors([]);
        setSearch("");
        setActiveVendors([]);
        setActiveBrands([]);
        setActiveCategories([]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Mirrors the post-import flow on the other batch tabs: once the
        // Promo table is wiped, jump to MRP so the user lands on the next
        // screen they normally work with after clearing.
        router.push("/(tabs)/mrp");
      } catch {
        showStorageErrorAlert("Couldn't Clear");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(msg)) doClear();
    } else {
      Alert.alert("Delete All Promo Entries?", msg, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doClear },
      ]);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Promo</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Import Promo</Text>
          <Text style={styles.cardSub}>
            Excel file with the promotion-master layout. Required columns:{" "}
            <Text style={styles.mono}>Item No</Text> and{" "}
            <Text style={styles.mono}>BatchNo</Text>. Each (Item No, BatchNo)
            pair is a unique row. Other columns like{" "}
            <Text style={styles.mono}>Cost</Text> are optional — sheets
            without them still import successfully.
          </Text>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.pickBtn, loading && { opacity: 0.6 }]}
              onPress={pickAndImport}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <Feather name="upload" size={16} color={Colors.primary} />
              )}
              <Text style={styles.pickBtnText}>
                {loading
                  ? "Importing…"
                  : promoEntries.length > 0
                    ? "Re-Import"
                    : "Excel"}
              </Text>
            </TouchableOpacity>
            {promoEntries.length > 0 && (
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={handleClear}
              >
                <Feather name="trash-2" size={16} color={Colors.danger} />
                <Text style={styles.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            )}
            {/* Export only the rows whose user-entered "New Qty" value is
                set. Honours the currently active filters (search,
                vendor / brand / category, Missing Promo, Multiple MRP)
                so the workbook matches what's on screen. The filter
                button states themselves are untouched by the export. */}
            {hasNewQtyToExport && (
              <TouchableOpacity
                style={styles.exportBtn}
                onPress={handleExportNewQty}
                disabled={exporting}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Feather name="download" size={16} color={Colors.primary} />
                )}
                <Text style={styles.exportBtnText}>
                  {exporting ? "Exporting…" : "Export New Qty"}
                </Text>
              </TouchableOpacity>
            )}
            {/* Export every batch of every Item No that has at least
                one user-entered New Qty value, with the full set of
                Promo columns. Filters are intentionally ignored so the
                workbook always covers every batch of each touched
                item. */}
            {hasTouchedItemsToExport && (
              <TouchableOpacity
                style={[styles.exportBtn, styles.exportBtnAccent]}
                onPress={handleExportTouchedItemBatches}
                disabled={exporting}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={Colors.accent} />
                ) : (
                  <Feather name="package" size={16} color={Colors.accent} />
                )}
                <Text style={[styles.exportBtnText, styles.exportBtnAccentText]}>
                  {exporting ? "Exporting…" : "Export All Batches"}
                </Text>
              </TouchableOpacity>
            )}
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

        {statusMsg && (
          <View style={styles.successBox}>
            <Feather name="check-circle" size={16} color={Colors.success ?? "#16A34A"} />
            <Text style={styles.successText}>{statusMsg}</Text>
          </View>
        )}

        {promoEntries.length > 0 && (
          <>
            {/* Vendor / Brand / Category filter bars — same UX as the
                StockUpd tab. Each opens a slide-up sheet with a search
                box and multi-select rows. Laid out in a 2-column grid
                so the chips take half the vertical space they used to. */}
            <View style={styles.filterGrid}>
              {/* Promoted quick-action toggle: "Missing Promo" lives at
                  the top of the filter list (above the vendor / brand /
                  category dropdowns) and uses an amber alert-style
                  treatment so users notice it immediately and can jump
                  to items that have MRP-tab values missing from their
                  Promo rows. */}
              <View style={styles.filterCol}>
                <FilterBar
                  icon="alert-circle"
                  label="Missing Promo"
                  active={missingPromo}
                  toggleOnly
                  variant="alert"
                  onPress={() => setMissingPromo((v) => !v)}
                  onClear={() => setMissingPromo(false)}
                />
              </View>
              {/* Toggles inline editing for the "New Qty" cell. Drops any
                  in-progress drafts when turning off so the next "Modify"
                  session starts from the persisted values. */}
              <View style={styles.filterCol}>
                <FilterBar
                  icon="edit-3"
                  label="Modify"
                  active={modifyMode}
                  toggleOnly
                  onPress={() => {
                    setModifyMode((v) => {
                      if (v) setNewQtyDrafts({});
                      return !v;
                    });
                  }}
                  onClear={() => {
                    setModifyMode(false);
                    setNewQtyDrafts({});
                  }}
                />
              </View>
              <View style={styles.filterCol}>
                <FilterBar
                  icon="layers"
                  label="Multiple MRP"
                  active={onlyMultiMrp}
                  toggleOnly
                  variant="highlight"
                  onPress={() => setOnlyMultiMrp((v) => !v)}
                  onClear={() => setOnlyMultiMrp(false)}
                />
              </View>
              {/* Explicit "Save" chip surfaced only while Modify mode
                  is on. Drafts auto-save on blur, but a visible Save
                  affordance makes the flow discoverable for users who
                  expect a button. */}
              {modifyMode && (
                <View style={styles.filterCol}>
                  <TouchableOpacity
                    style={[styles.filterBar, styles.filterBarSave]}
                    onPress={() => { void flushNewQtyDrafts(); }}
                    activeOpacity={0.75}
                    disabled={savingNewQty}
                  >
                    {savingNewQty ? (
                      <ActivityIndicator size="small" color={Colors.textInverse} />
                    ) : (
                      <Feather name="save" size={15} color={Colors.textInverse} />
                    )}
                    <Text style={[styles.filterBarText, styles.filterBarSaveText]} numberOfLines={1}>
                      {savingNewQty
                        ? "Saving…"
                        : Object.keys(newQtyDrafts).length > 0
                          ? `Save (${Object.keys(newQtyDrafts).length})`
                          : "Save"}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
              <View style={styles.filterCol}>
                <FilterBar
                  icon="users"
                  label={
                    activeVendors.length === 0
                      ? "All Vendors"
                      : activeVendors.length === 1
                        ? activeVendors[0]
                        : `${activeVendors.length} Vendors`
                  }
                  active={activeVendors.length > 0}
                  onPress={() => { setVendorSearch(""); setShowVendorModal(true); }}
                  onClear={() => setActiveVendors([])}
                />
              </View>
              <View style={styles.filterCol}>
                <FilterBar
                  icon="tag"
                  label={
                    activeBrands.length === 0
                      ? "All Brands"
                      : activeBrands.length === 1
                        ? activeBrands[0]
                        : `${activeBrands.length} Brands`
                  }
                  active={activeBrands.length > 0}
                  onPress={() => { setBrandSearch(""); setShowBrandModal(true); }}
                  onClear={() => setActiveBrands([])}
                />
              </View>
              <View style={styles.filterCol}>
                <FilterBar
                  icon="folder"
                  label={
                    activeCategories.length === 0
                      ? "All Categories"
                      : activeCategories.length === 1
                        ? activeCategories[0]
                        : `${activeCategories.length} Categories`
                  }
                  active={activeCategories.length > 0}
                  onPress={() => { setCategorySearch(""); setShowCategoryModal(true); }}
                  onClear={() => setActiveCategories([])}
                />
              </View>
              {/* Promo CR Date range filter. Active label shows the
                  currently-applied bounds (open-ended on either side
                  when only one bound is set) so the user can see the
                  range without opening the modal. */}
              <View style={styles.filterCol}>
                <FilterBar
                  icon="calendar"
                  label={
                    promoCrFrom || promoCrTo
                      ? `${promoCrFrom ? formatDDMMYYYY(promoCrFrom) : "Any"} → ${promoCrTo ? formatDDMMYYYY(promoCrTo) : "Any"}`
                      : "All Promo CR Dates"
                  }
                  active={!!(promoCrFrom || promoCrTo)}
                  onPress={() => {
                    const today = startOfDay(new Date());
                    setPromoCrFromDraft(promoCrFrom ?? today);
                    setPromoCrToDraft(promoCrTo ?? today);
                    setShowPromoCrFromPicker(false);
                    setShowPromoCrToPicker(false);
                    setPromoCrError(null);
                    setShowPromoCrModal(true);
                  }}
                  onClear={() => {
                    setPromoCrFrom(null);
                    setPromoCrTo(null);
                  }}
                />
              </View>
            </View>

            <View style={styles.searchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search Item No, BatchNo, Brand, Vendor…"
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

            <View style={styles.statsRow}>
              <Text style={styles.statText}>
                {filtered.length} of {promoEntries.length} entr
                {promoEntries.length !== 1 ? "ies" : "y"}
              </Text>
            </View>

            <View style={styles.cardsWrap}>
              {filtered.length === 0 ? (
                <View style={styles.noRows}>
                  <Feather name="search" size={24} color={Colors.textMuted} />
                  <Text style={styles.noRowsText}>
                    {search.trim().length > 0
                      ? `No items match "${search}"`
                      : "No items"}
                  </Text>
                </View>
              ) : (
                grouped.map((group) => (
                  <View key={`brand:${group.brand}`} style={styles.brandBlock}>
                    <View style={styles.brandGroupHeader}>
                      <Feather name="tag" size={13} color={Colors.primary} />
                      <Text style={styles.brandGroupHeaderText} numberOfLines={1}>
                        {group.brand}
                      </Text>
                      <Text style={styles.brandGroupHeaderCount}>
                        {group.itemCount} item{group.itemCount !== 1 ? "s" : ""}
                      </Text>
                    </View>
                    {group.vendors.map((vendor) => (
                      <View key={`brand:${group.brand}|vendor:${vendor.vendorName}`}>
                        <View style={styles.vendorGroupHeader}>
                          <Feather name="briefcase" size={11} color={Colors.textMuted} />
                          <Text style={styles.vendorGroupHeaderText} numberOfLines={1}>
                            {vendor.vendorName}
                          </Text>
                          <Text style={styles.vendorGroupHeaderCount}>
                            {vendor.itemCount}
                          </Text>
                        </View>
                        {vendor.items.map((item, i) => {
                          // All rows for the same Item No share identity-
                          // level fields (description / latest MRP); pick
                          // the first row as the representative for the
                          // top of the card.
                          const head = item.rows[0];
                          return (
                            <View
                              key={`${group.brand}-${vendor.vendorName}-${item.itemNo}`}
                              style={[styles.itemCard, i % 2 === 1 && styles.itemCardAlt]}
                            >
                              <View style={styles.cardLine1}>
                                <Text style={styles.itemNoText} numberOfLines={1}>
                                  {formatCell(CARD_LINE_1_LEFT, head[CARD_LINE_1_LEFT])}
                                </Text>
                                <Text style={styles.itemDescText} numberOfLines={2}>
                                  {formatCell(CARD_LINE_1_RIGHT, head[CARD_LINE_1_RIGHT])}
                                </Text>
                              </View>

                              <View style={styles.cardLine2}>
                                <Text style={styles.fieldLabel}>{CARD_LINE_2}</Text>
                                <Text style={styles.fieldValueLg}>
                                  {formatCell(CARD_LINE_2, head[CARD_LINE_2])}
                                </Text>
                              </View>

                              <View style={styles.priceList}>
                                {/* The full promo column set is wider than
                                    a phone screen, so the header + value
                                    rows scroll together inside one
                                    horizontal ScrollView. Each cell gets
                                    a fixed width from colWidth() so the
                                    header labels stay aligned with their
                                    values across rows. */}
                                <ScrollView
                                  horizontal
                                  showsHorizontalScrollIndicator
                                  contentContainerStyle={styles.priceListScrollContent}
                                >
                                  <View>
                                <View style={styles.priceListHead}>
                                  {cardLine3.map((f) => (
                                    <Text
                                      key={`hd:${f}`}
                                      style={[styles.fieldLabel, styles.priceCellFixed, { width: colWidth(f) }]}
                                      numberOfLines={1}
                                    >
                                      {cardLabel(f)}
                                    </Text>
                                  ))}
                                </View>
                                {item.rows.map((row, ri) => {
                                  // Synthetic rows are MRPs that exist in
                                  // the MRP tab but have no matching Promo
                                  // row for this Item No. Soft amber tint
                                  // + italic value text signals to the
                                  // user "this MRP has no promo data".
                                  const isFromMrpTab =
                                    (row as Record<string, unknown>)["__mrpFromMrpTab"] === 1;
                                  return (
                                    <View
                                      key={`${item.itemNo}-${row["BatchNo"] ?? ""}-${row["MRP"] ?? ""}-${ri}${isFromMrpTab ? "-mrptab" : ""}`}
                                      style={[
                                        styles.priceListRow,
                                        ri % 2 === 1 && styles.priceListRowAlt,
                                        isFromMrpTab && styles.priceListRowFromMrpTab,
                                      ]}
                                    >
                                      {cardLine3.map((f) => {
                                        if (f === NEW_QTY_FIELD) {
                                          // The "New Qty" cell is the
                                          // user-editable column. It has
                                          // no underlying imported value
                                          // — we read/write the standalone
                                          // promoNewQty map keyed by
                                          // (itemNo, BatchNo). Synthetic
                                          // "from MRP tab" rows have no
                                          // BatchNo to key on, so they
                                          // render the cell as blank /
                                          // disabled.
                                          const batchNoStr = String(row["BatchNo"] ?? "");
                                          const qtyKey = `${item.itemNo}|${batchNoStr}`;
                                          const editable = modifyMode;
                                          const persisted = promoNewQty[qtyKey];
                                          const draft = newQtyDrafts[qtyKey];
                                          if (editable) {
                                            const value =
                                              draft !== undefined
                                                ? draft
                                                : persisted !== undefined
                                                  ? String(persisted)
                                                  : "";
                                            return (
                                              <TextInput
                                                key={f}
                                                style={[
                                                  styles.priceCellFixed,
                                                  { width: colWidth(f) },
                                                  styles.newQtyInput,
                                                ]}
                                                value={value}
                                                onChangeText={(text) =>
                                                  setNewQtyDrafts((d) => ({
                                                    ...d,
                                                    [qtyKey]: text,
                                                  }))
                                                }
                                                onEndEditing={() => {
                                                  const raw = (
                                                    newQtyDrafts[qtyKey] ?? ""
                                                  ).trim();
                                                  setNewQtyDrafts((d) => {
                                                    const { [qtyKey]: _drop, ...rest } = d;
                                                    return rest;
                                                  });
                                                  if (raw === "") {
                                                    if (persisted !== undefined) {
                                                      void setPromoNewQtyValue(qtyKey, undefined);
                                                    }
                                                    return;
                                                  }
                                                  const num = Number(raw);
                                                  if (!Number.isFinite(num) || num < 0) return;
                                                  void setPromoNewQtyValue(qtyKey, num);
                                                }}
                                                keyboardType="decimal-pad"
                                                inputMode="decimal"
                                                placeholder="0"
                                                placeholderTextColor={Colors.textMuted}
                                                selectTextOnFocus
                                              />
                                            );
                                          }
                                          const display =
                                            persisted !== undefined
                                              ? formatCell(f, persisted)
                                              : "";
                                          return (
                                            <Text
                                              key={f}
                                              style={[
                                                styles.fieldValue,
                                                styles.priceCellFixed,
                                                { width: colWidth(f) },
                                                isFromMrpTab && styles.fieldValueFromMrpTab,
                                              ]}
                                              numberOfLines={1}
                                            >
                                              {display}
                                            </Text>
                                          );
                                        }
                                        return (
                                          <Text
                                            key={f}
                                            style={[
                                              styles.fieldValue,
                                              styles.priceCellFixed,
                                              { width: colWidth(f) },
                                              isFromMrpTab && styles.fieldValueFromMrpTab,
                                            ]}
                                            numberOfLines={1}
                                          >
                                            {formatCell(f, row[f])}
                                          </Text>
                                        );
                                      })}
                                    </View>
                                  );
                                })}
                                  </View>
                                </ScrollView>
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                ))
              )}
            </View>
          </>
        )}

        {promoEntries.length === 0 && !loading && (
          <View style={styles.emptyHint}>
            <Feather name="info" size={14} color={Colors.textMuted} />
            <Text style={styles.emptyHintText}>
              Pick an Excel file to load the Promo table.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Vendor filter modal */}
      <FilterModal
        visible={showVendorModal}
        title="Filter by Vendor"
        emptyIcon="users"
        emptyTitle="No Vendors Yet"
        emptySub="Import a Promo file with a VendorName column to filter by vendor."
        searchPlaceholder="Search vendors…"
        searchValue={vendorSearch}
        onChangeSearch={setVendorSearch}
        items={allVendors}
        active={activeVendors}
        countLabel={(v) => `${vendorRowCount(v)} row${vendorRowCount(v) !== 1 ? "s" : ""}`}
        allLabel="All Vendors"
        allCount={`${promoEntries.length} rows`}
        onToggle={toggleVendor}
        onClear={() => setActiveVendors([])}
        onClose={() => setShowVendorModal(false)}
        bottomInset={insets.bottom}
      />

      {/* Brand filter modal */}
      <FilterModal
        visible={showBrandModal}
        title="Filter by Brand"
        emptyIcon="tag"
        emptyTitle="No Brands Yet"
        emptySub="Import a Promo file with a Brand column to filter by brand."
        searchPlaceholder="Search brands…"
        searchValue={brandSearch}
        onChangeSearch={setBrandSearch}
        items={allBrands}
        active={activeBrands}
        countLabel={(b) => `${brandRowCount(b)} row${brandRowCount(b) !== 1 ? "s" : ""}`}
        allLabel="All Brands"
        allCount={`${vendorScopedEntries.length} rows`}
        onToggle={toggleBrand}
        onClear={() => setActiveBrands([])}
        onClose={() => setShowBrandModal(false)}
        bottomInset={insets.bottom}
      />

      {/* Promo CR Date range filter modal. Two date buttons that open
          a calendar via @react-native-community/datetimepicker.
          Defaults to today on first open; Clear resets the bounds
          (and the drafts) back to today. Apply commits the drafts
          to promoCrFrom/promoCrTo. */}
      <Modal
        visible={showPromoCrModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPromoCrModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowPromoCrModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Promo CR Date</Text>
            <TouchableOpacity
              onPress={() => {
                const today = startOfDay(new Date());
                setPromoCrFromDraft(today);
                setPromoCrToDraft(today);
                setPromoCrFrom(null);
                setPromoCrTo(null);
                setShowPromoCrFromPicker(false);
                setShowPromoCrToPicker(false);
                setPromoCrError(null);
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
                  setShowPromoCrToPicker(false);
                  setShowPromoCrFromPicker((v) => !v);
                  setPromoCrError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(promoCrFromDraft)}
                </Text>
              </TouchableOpacity>
              {showPromoCrFromPicker && (
                <DateTimePicker
                  value={promoCrFromDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    if (Platform.OS !== "ios") setShowPromoCrFromPicker(false);
                    if (selected) {
                      setPromoCrFromDraft(startOfDay(selected));
                      setPromoCrError(null);
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
                  setShowPromoCrFromPicker(false);
                  setShowPromoCrToPicker((v) => !v);
                  setPromoCrError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(promoCrToDraft)}
                </Text>
              </TouchableOpacity>
              {showPromoCrToPicker && (
                <DateTimePicker
                  value={promoCrToDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    if (Platform.OS !== "ios") setShowPromoCrToPicker(false);
                    if (selected) {
                      setPromoCrToDraft(startOfDay(selected));
                      setPromoCrError(null);
                    }
                  }}
                />
              )}
            </View>
          </View>
          {promoCrError && (
            <Text style={styles.dateRangeError}>{promoCrError}</Text>
          )}
          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => {
              const from = startOfDay(promoCrFromDraft);
              const to = startOfDay(promoCrToDraft);
              if (from.getTime() > to.getTime()) {
                setPromoCrError("From date can't be after To date.");
                return;
              }
              setPromoCrFrom(from);
              setPromoCrTo(to);
              setShowPromoCrFromPicker(false);
              setShowPromoCrToPicker(false);
              setPromoCrError(null);
              setShowPromoCrModal(false);
            }}
          >
            <Text style={styles.modalDoneBtnText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Category filter modal */}
      <FilterModal
        visible={showCategoryModal}
        title="Filter by Category"
        emptyIcon="folder"
        emptyTitle="No Categories Yet"
        emptySub="Import a Promo file with a Category column to filter by category."
        searchPlaceholder="Search categories…"
        searchValue={categorySearch}
        onChangeSearch={setCategorySearch}
        items={allCategories}
        active={activeCategories}
        countLabel={(c) => `${categoryRowCount(c)} row${categoryRowCount(c) !== 1 ? "s" : ""}`}
        allLabel="All Categories"
        allCount={`${vendorScopedEntries.length} rows`}
        onToggle={toggleCategory}
        onClear={() => setActiveCategories([])}
        onClose={() => setShowCategoryModal(false)}
        bottomInset={insets.bottom}
      />
    </View>
  );
}

// Compact filter pill the user taps to open the picker for a given
// dimension (Vendor / Brand / Category). Mirrors the visual treatment
// used by the StockUpd tab.
type FilterBarProps = {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  active: boolean;
  onPress: () => void;
  onClear: () => void;
  // When true, the bar acts as a simple on/off toggle (no expansion
  // sheet) — the chevron-down is suppressed so the affordance reads
  // as a toggle rather than a dropdown.
  toggleOnly?: boolean;
  // Optional visual variant. "alert" gives the chip an amber
  // attention-grabbing treatment so a promoted quick-action toggle
  // (e.g. "Missing Promo") stands out from the neutral
  // dropdown-style filter chips around it.
  variant?: "default" | "alert" | "highlight";
};
function FilterBar({ icon, label, active, onPress, onClear, toggleOnly, variant = "default" }: FilterBarProps) {
  const isAlert = variant === "alert";
  const isHighlight = variant === "highlight";
  const inactiveIconColor = isAlert
    ? Colors.warning
    : isHighlight
      ? Colors.textInverse
      : Colors.textSecondary;
  const activeIconColor = Colors.textInverse;
  const activeClearColor = Colors.textInverse;
  return (
    <TouchableOpacity
      style={[
        styles.filterBar,
        isAlert && styles.filterBarAlert,
        isHighlight && styles.filterBarHighlight,
        active &&
          (isAlert
            ? styles.filterBarAlertActive
            : isHighlight
              ? styles.filterBarHighlightActive
              : styles.filterBarActive),
      ]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Feather
        name={icon}
        size={isAlert || isHighlight ? 15 : 14}
        color={active ? activeIconColor : inactiveIconColor}
      />
      <Text
        style={[
          styles.filterBarText,
          isAlert && styles.filterBarAlertText,
          isHighlight && styles.filterBarHighlightText,
          active &&
            (isAlert
              ? styles.filterBarAlertTextActive
              : isHighlight
                ? styles.filterBarHighlightTextActive
                : styles.filterBarTextActive),
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {active ? (
        <TouchableOpacity
          onPress={(e) => { e.stopPropagation?.(); onClear(); }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="x-circle" size={15} color={activeClearColor} />
        </TouchableOpacity>
      ) : toggleOnly ? null : (
        <Feather name="chevron-down" size={14} color={Colors.textMuted} />
      )}
    </TouchableOpacity>
  );
}

// Generic slide-up sheet for picking multiple values from a list with
// a search box. All three filter modals (Vendor / Brand / Category)
// render through this component to keep them consistent.
type FilterModalProps = {
  visible: boolean;
  title: string;
  emptyIcon: React.ComponentProps<typeof Feather>["name"];
  emptyTitle: string;
  emptySub: string;
  searchPlaceholder: string;
  searchValue: string;
  onChangeSearch: (s: string) => void;
  items: string[];
  active: string[];
  countLabel: (item: string) => string;
  allLabel: string;
  allCount: string;
  onToggle: (item: string) => void;
  onClear: () => void;
  onClose: () => void;
  bottomInset: number;
};
function FilterModal(props: FilterModalProps) {
  const {
    visible, title, emptyIcon, emptyTitle, emptySub,
    searchPlaceholder, searchValue, onChangeSearch,
    items, active, countLabel, allLabel, allCount,
    onToggle, onClear, onClose, bottomInset,
  } = props;
  const q = searchValue.trim().toLowerCase();
  const visibleItems = q ? items.filter((b) => b.toLowerCase().includes(q)) : items;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.modalBackdrop}
        activeOpacity={1}
        onPress={onClose}
      />
      <View style={[styles.modalSheet, { paddingBottom: bottomInset + 16 }]}>
        <View style={styles.modalHandle} />
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{title}</Text>
          {active.length > 0 && (
            <TouchableOpacity onPress={onClear}>
              <Text style={styles.modalClear}>Clear All</Text>
            </TouchableOpacity>
          )}
        </View>

        {items.length > 0 && (
          <View style={styles.modalSearchWrap}>
            <Feather name="search" size={15} color={Colors.textMuted} />
            <TextInput
              style={styles.modalSearchInput}
              value={searchValue}
              onChangeText={onChangeSearch}
              placeholder={searchPlaceholder}
              placeholderTextColor={Colors.textMuted}
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
            {searchValue.length > 0 && Platform.OS !== "ios" && (
              <TouchableOpacity onPress={() => onChangeSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="x" size={14} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        )}

        {items.length === 0 ? (
          <View style={styles.modalEmpty}>
            <Feather name={emptyIcon} size={32} color={Colors.textMuted} />
            <Text style={styles.modalEmptyTitle}>{emptyTitle}</Text>
            <Text style={styles.modalEmptySub}>{emptySub}</Text>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} style={styles.modalList} keyboardShouldPersistTaps="handled">
            {!q && (
              <TouchableOpacity
                style={[styles.modalRow, active.length === 0 && styles.modalRowActive]}
                onPress={onClear}
              >
                <Text style={[styles.modalRowName, active.length === 0 && styles.modalRowNameActive]}>
                  {allLabel}
                </Text>
                <Text style={styles.modalRowCount}>{allCount}</Text>
                {active.length === 0 && <Feather name="check" size={16} color={Colors.primary} />}
              </TouchableOpacity>
            )}
            {visibleItems.length === 0 ? (
              <View style={styles.modalEmpty}>
                <Feather name="search" size={28} color={Colors.textMuted} />
                <Text style={styles.modalEmptyTitle}>No match</Text>
                <Text style={styles.modalEmptySub}>No matches for "{searchValue}"</Text>
              </View>
            ) : (
              visibleItems.map((item) => {
                const isSelected = active.includes(item);
                return (
                  <TouchableOpacity
                    key={item}
                    style={[styles.modalRow, isSelected && styles.modalRowActive]}
                    onPress={() => onToggle(item)}
                  >
                    <Feather
                      name={isSelected ? "check-square" : "square"}
                      size={17}
                      color={isSelected ? Colors.primary : Colors.textMuted}
                    />
                    <Text style={[styles.modalRowName, isSelected && styles.modalRowNameActive]} numberOfLines={1}>
                      {item}
                    </Text>
                    <Text style={styles.modalRowCount}>{countLabel(item)}</Text>
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        )}

        <TouchableOpacity style={styles.modalDoneBtn} onPress={onClose}>
          <Text style={styles.modalDoneBtnText}>
            {active.length === 0 ? "Close" : `Apply (${active.length} selected)`}
          </Text>
        </TouchableOpacity>
      </View>
    </Modal>
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
  // Pill-style action buttons that match the Orders tab: compact,
  // colored background tinted toward the action's role (blue =
  // primary action, red = destructive), thin colored border, bold
  // 13pt label.
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pickBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  pickBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.dangerLight,
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  deleteBtnText: { fontSize: 13, fontWeight: "700", color: Colors.danger },
  // "Export New Qty" pill — same shape as the Import pill but uses
  // the primary palette so it visually pairs with the download icon.
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  exportBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  // Accent (green) variant of the export pill used for the
  // "Export All Batches" action so the two export buttons are
  // visually distinct at a glance.
  exportBtnAccent: {
    backgroundColor: Colors.accentLight,
    borderColor: Colors.accent + "40",
  },
  exportBtnAccentText: { color: Colors.accent },
  progressWrap: { gap: 6 },
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
  stickyHeaderWrap: {
    backgroundColor: Colors.surface ?? "#fff",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: Colors.border,
    overflow: "hidden",
  },
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  th: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
  },
  tableRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  rowAlt: { backgroundColor: Colors.background },
  td: { fontSize: 12, color: Colors.text },
  brandGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.primaryMuted,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: Colors.border,
  },
  brandGroupHeaderText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "800",
    color: Colors.primary,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  brandGroupHeaderCount: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.primary,
    opacity: 0.75,
  },
  vendorGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 24,
    paddingVertical: 5,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  vendorGroupHeaderText: {
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    letterSpacing: 0.3,
  },
  vendorGroupHeaderCount: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.textMuted,
    opacity: 0.85,
  },

  // Item-card layout (replaces the wide horizontal-scroll table). Each
  // item renders as three stacked lines: identity, latest MRP, then a
  // 4-up strip of the promo numbers/date.
  cardsWrap: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  brandBlock: {},
  itemCard: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  itemCardAlt: {
    backgroundColor: Colors.background,
  },
  cardLine1: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  itemNoText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.primary,
    backgroundColor: Colors.primaryMuted,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: "hidden",
  },
  itemDescText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    lineHeight: 17,
  },
  cardLine2: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
  },
  cardLine3: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  statBlock: {
    flex: 1,
    minWidth: 0,
  },
  // Stacked price-variant list (replaces the single 4-up cardLine3 row
  // when an Item No has multiple MRP/Batch combinations). One small
  // label header row, then one value row per variant.
  priceList: {
    marginTop: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  priceListHead: {
    flexDirection: "row",
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 3,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 2,
  },
  priceListRow: {
    flexDirection: "row",
    paddingHorizontal: 4,
    paddingVertical: 6,
    gap: 2,
    backgroundColor: Colors.surface,
  },
  priceListRowAlt: {
    backgroundColor: Colors.background,
  },
  // Subtle amber tint applied to rows whose MRP came from the MRP tab
  // (i.e. there's no matching Promo row for this Item No / MRP). The
  // tint is applied last so it overrides the alternating-row colour.
  priceListRowFromMrpTab: {
    backgroundColor: "#FFFBEA",
    borderTopWidth: 1,
    borderTopColor: "#FDE68A",
  },
  // Italic + muted colour for synthetic MRP rows so the lone MRP value
  // visually reads as "informational" rather than a confirmed price.
  fieldValueFromMrpTab: {
    fontStyle: "italic",
    color: Colors.textSecondary,
    fontWeight: "600",
  },
  priceCell: {
    flex: 1,
    minWidth: 0,
    marginBottom: 0,
    fontSize: 11,
  },
  // Fixed-width variant of priceCell used inside the horizontal
  // ScrollView. Width comes from colWidth(field) per cell so the
  // header labels stay aligned with their values across rows.
  priceCellFixed: {
    marginBottom: 0,
    fontSize: 11,
    paddingHorizontal: 1,
  },
  priceListScrollContent: {
    paddingRight: 4,
  },
  // Inline editor used for the "New Qty" cell when Modify mode is on.
  // Sized to match the surrounding price cells so the row layout
  // doesn't jump when toggling Modify.
  newQtyInput: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.text,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: Colors.border ?? "#D1D5DB",
    borderRadius: 4,
    backgroundColor: Colors.surface,
    textAlign: "center",
  },
  fieldLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  fieldValue: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.text,
  },
  fieldValueLg: {
    fontSize: 14,
    fontWeight: "800",
    color: Colors.text,
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

  // 2-column grid wrapper for the filter chips so they fit two-up
  // and take half the vertical space they used to.
  filterGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  filterCol: {
    // ~50% width per chip with the 8-px gap accounted for, so two
    // chips sit side-by-side and the leftover one wraps to its own
    // half-row instead of stretching to full width.
    width: "48.5%",
  },

  // Filter bar pills (Vendor / Brand / Category)
  filterBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  filterBarActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterBarText: { flex: 1, fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  filterBarTextActive: { color: Colors.textInverse },
  // "Alert"-style variant used to promote a quick-action toggle (e.g.
  // "Missing Promo") so it stands out from the neutral
  // dropdown-style filter chips around it.
  filterBarAlert: {
    backgroundColor: Colors.warningLight,
    borderColor: Colors.warning,
    borderWidth: 1.5,
  },
  filterBarAlertActive: {
    backgroundColor: Colors.warning,
    borderColor: Colors.warning,
  },
  filterBarAlertText: { color: Colors.warning, fontWeight: "700" },
  filterBarAlertTextActive: { color: Colors.textInverse, fontWeight: "700" },
  // "Highlight" variant — vivid magenta/pink so the chip stands out
  // from the neutral filter row at a glance. Used for "Multiple MRP".
  filterBarHighlight: {
    backgroundColor: "#DB2777",
    borderColor: "#BE185D",
    borderWidth: 1.5,
  },
  filterBarHighlightActive: {
    backgroundColor: "#9D174D",
    borderColor: "#9D174D",
  },
  filterBarHighlightText: { color: Colors.textInverse, fontWeight: "700" },
  filterBarHighlightTextActive: { color: Colors.textInverse, fontWeight: "700" },
  // Solid green "Save" chip used inside the filter grid while Modify
  // mode is on so users have an obvious commit affordance instead of
  // relying on the input's auto-save-on-blur behaviour.
  filterBarSave: {
    backgroundColor: Colors.success,
    borderColor: Colors.success,
    borderWidth: 1.5,
  },
  filterBarSaveText: { color: Colors.textInverse, fontWeight: "700" },

  // Bottom-sheet modal shared by all three filters
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  modalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    maxHeight: "70%",
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
  modalSearchWrap: {
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
  modalSearchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.text,
    paddingVertical: 0,
  },
  modalEmpty: { alignItems: "center", padding: 40, gap: 10 },
  modalEmptyTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  modalEmptySub: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  modalList: { paddingHorizontal: 20 },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  modalRowActive: { backgroundColor: Colors.primaryMuted + "80" },
  modalRowName: { flex: 1, fontSize: 15, fontWeight: "600", color: Colors.text },
  modalRowNameActive: { color: Colors.primary },
  modalRowCount: { fontSize: 12, color: Colors.textMuted, marginRight: 4 },
  modalDoneBtn: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  modalDoneBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
  // Promo CR Date range modal — two side-by-side DD/MM/YYYY inputs.
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
});
