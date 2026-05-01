import React, { useState, useMemo, useRef } from "react";
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
import * as Haptics from "expo-haptics";
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
]);

// Date columns. Excel surfaces these as JS Date objects (cellDates:true),
// raw serial numbers (e.g. 45123 for 2023-07-12), or already-formatted
// strings — none of which render usefully if we just String()-stringify
// them. Normalised to "DD/MM/YYYY".
const DATE_FIELDS = new Set<string>(["PromotionToDate", "Promo Create Date"]);

// Columns that NoofBatches-style values should display as integers, even
// though they're stored as numbers (it's an integer field per the
// schema). Other numeric fields use 2dp.
const INTEGER_FIELDS = new Set<string>(["NoofBatches"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
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
  PromotionToDate: 120,
  Category: 130,
  "Item No": 90,
  Brand: 140,
  NoofBatches: 90,
  "Item Description": 240,
  SP: 80,
  SoldQty: 90,
  PromotionPrice: 110,
  "Promo Create Date": 130,
  "Latest MRP": 100,
  MRP: 80,
  BatchNo: 110,
  VendorCode: 110,
  VendorName: 180,
};

function colWidth(field: string): number {
  return COL_WIDTHS[field] ?? 90;
}

// Fields shown in each item card, organized into three stacked lines.
// Other PROMO_FIELDS (e.g. Category, BatchNo, VendorCode, SoldQty,
// Brand, VendorName, Promo Create Date) are still imported and remain
// searchable / filterable; Brand and VendorName drive the nested group
// headers above each set of cards.
const CARD_LINE_1_LEFT = "Item No";
const CARD_LINE_1_RIGHT = "Item Description";
const CARD_LINE_2 = "Latest MRP";
const CARD_LINE_3: readonly string[] = ["MRP", "SP", "PromotionPrice", "PromotionToDate"];

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
    if (INTEGER_FIELDS.has(field) || Number.isInteger(value)) return String(value);
    return value.toFixed(2);
  }
  return String(value);
}

export default function PromoScreen() {
  const { promoEntries, savePromoBatch, clearPromoBatch } = useApp();
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

  const filtered = useMemo(() => {
    const vendorSet = activeVendors.length > 0 ? new Set(activeVendors) : null;
    const brandSet = activeBrands.length > 0 ? new Set(activeBrands) : null;
    const categorySet = activeCategories.length > 0 ? new Set(activeCategories) : null;
    const q = search.trim().toLowerCase();
    return promoEntries.filter((r) => {
      if (vendorSet && !vendorSet.has(String(r["VendorName"] ?? "").trim())) return false;
      if (brandSet && !brandSet.has(String(r["Brand"] ?? "").trim())) return false;
      if (categorySet && !categorySet.has(String(r["Category"] ?? "").trim())) return false;
      if (q && !SEARCH_FIELDS.some((f) => String(r[f] ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [promoEntries, search, activeVendors, activeBrands, activeCategories]);

  // Group the filtered rows by Brand, then by VendorName inside each
  // brand. Rows inside the innermost group keep their original (file)
  // order. Brands and vendors are sorted case-insensitively; missing
  // values bucket into "(No Brand)" / "(No Vendor)" and sort last.
  const grouped = useMemo(() => {
    type VendorBucket = { vendorName: string; rows: PromoEntry[] };
    type BrandBucket = { brand: string; vendors: VendorBucket[]; total: number };

    const sortKeys = (a: string, b: string, missing: string) => {
      if (a === missing) return 1;
      if (b === missing) return -1;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    };

    const brandMap = new Map<string, Map<string, PromoEntry[]>>();
    for (const r of filtered) {
      const brandKey = String(r["Brand"] ?? "").trim() || "(No Brand)";
      const vendorKey = String(r["VendorName"] ?? "").trim() || "(No Vendor)";
      let vendorMap = brandMap.get(brandKey);
      if (!vendorMap) {
        vendorMap = new Map<string, PromoEntry[]>();
        brandMap.set(brandKey, vendorMap);
      }
      let arr = vendorMap.get(vendorKey);
      if (!arr) {
        arr = [];
        vendorMap.set(vendorKey, arr);
      }
      arr.push(r);
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
      const vendors: VendorBucket[] = vendorKeys.map((vendorName) => ({
        vendorName,
        rows: vendorMap.get(vendorName)!,
      }));
      const total = vendors.reduce((s, v) => s + v.rows.length, 0);
      out.push({ brand, vendors, total });
    }
    return out;
  }, [filtered]);

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
          `Missing required columns. Expected "Item No" and "BatchNo". Found: ${Object.keys(firstRow).join(", ")}`,
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
    } catch (e: any) {
      setErrors([e?.message ?? "Failed to import file"]);
    } finally {
      setLoading(false);
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
            pair is a unique row.
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
                box and multi-select rows. */}
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
                        {group.total} item{group.total !== 1 ? "s" : ""}
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
                            {vendor.rows.length}
                          </Text>
                        </View>
                        {vendor.rows.map((row, i) => (
                          <View
                            key={`${group.brand}-${vendor.vendorName}-${row["Item No"] ?? ""}-${row["BatchNo"] ?? ""}-${row["MRP"] ?? ""}-${i}`}
                            style={[styles.itemCard, i % 2 === 1 && styles.itemCardAlt]}
                          >
                            <View style={styles.cardLine1}>
                              <Text style={styles.itemNoText} numberOfLines={1}>
                                {formatCell(CARD_LINE_1_LEFT, row[CARD_LINE_1_LEFT])}
                              </Text>
                              <Text style={styles.itemDescText} numberOfLines={2}>
                                {formatCell(CARD_LINE_1_RIGHT, row[CARD_LINE_1_RIGHT])}
                              </Text>
                            </View>

                            <View style={styles.cardLine2}>
                              <Text style={styles.fieldLabel}>{CARD_LINE_2}</Text>
                              <Text style={styles.fieldValueLg}>
                                {formatCell(CARD_LINE_2, row[CARD_LINE_2])}
                              </Text>
                            </View>

                            <View style={styles.cardLine3}>
                              {CARD_LINE_3.map((f) => (
                                <View key={f} style={styles.statBlock}>
                                  <Text style={styles.fieldLabel} numberOfLines={1}>
                                    {cardLabel(f)}
                                  </Text>
                                  <Text style={styles.fieldValue} numberOfLines={1}>
                                    {formatCell(f, row[f])}
                                  </Text>
                                </View>
                              ))}
                            </View>
                          </View>
                        ))}
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
};
function FilterBar({ icon, label, active, onPress, onClear }: FilterBarProps) {
  return (
    <TouchableOpacity
      style={[styles.filterBar, active && styles.filterBarActive]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Feather
        name={icon}
        size={14}
        color={active ? Colors.textInverse : Colors.textSecondary}
      />
      <Text
        style={[styles.filterBarText, active && styles.filterBarTextActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {active ? (
        <TouchableOpacity
          onPress={(e) => { e.stopPropagation?.(); onClear(); }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="x-circle" size={15} color={Colors.textInverse} />
        </TouchableOpacity>
      ) : (
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
});
