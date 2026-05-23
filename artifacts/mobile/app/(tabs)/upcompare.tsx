import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  Platform,
  ActivityIndicator,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as XLSX from "xlsx-js-style";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, type PromoEntry, type RodeoItem } from "@/context/AppContext";

// Normalised key for the join between Promo "Item No" and RodeoItem
// "ITEM CODE". Both columns are free-text upstream so we trim + lower
// to absorb whitespace / case drift without losing leading zeros.
function normCode(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0;
  return String(v).trim() !== "";
}

function fmtNum(v: unknown, dp = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return String(v);
  if (Number.isInteger(n) && dp <= 2) return String(n);
  return n.toFixed(dp);
}

function fmtText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function timestampForFile(): string {
  const d = new Date();
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()} ${pad2(
    d.getHours(),
  )}${pad2(d.getMinutes())}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Inverse of formatDDMMYYYY — accepts "DD/MM/YYYY" (or DD-MM-YYYY,
// DD/MM/YY) and returns a Date at local midnight, or null.
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

// Same row-side coercion the Promo tab uses for the Promo CR Date
// column: accepts JS Date, Excel serial number, "DD/MM/YYYY" (with
// optional trailing time), and ISO strings. Collapses everything to
// a local-midnight Date so range comparisons are a stable numeric
// check.
function parsePromoCrCell(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v < 20000) return null;
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const headDate = s.split(/[ T]/, 1)[0];
    const dm = parseDDMMYYYY(headDate);
    if (dm) return dm;
    const t = Date.parse(s);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    return null;
  }
  return null;
}

// Normalise an MRP cell to a canonical string so "100" and 100 collapse
// to the same bucket for the "Multiple MRP" detection.
function normMrp(v: unknown): string {
  if (typeof v === "number") return String(v);
  const s = String(v ?? "").trim();
  const n = parseFloat(s);
  return isNaN(n) ? s : String(n);
}

// One unified row for the compare view. Built from a Promo row joined
// (by normalised Item No → ITEM CODE) against the RodeoItems master.
//   - status "match":         Rodeo row exists AND has Offer Price
//   - status "missing-offer": Rodeo row exists BUT no Offer Price
//   - status "not-in-rodeo":  No matching RodeoItem at all
// "missing-offer" rows are hidden on screen but are the payload of
// the Excel export so the user can bulk-add those offers in Rodeo.
type CompareStatus = "match" | "missing-offer" | "not-in-rodeo";
interface CompareRow {
  promo: PromoEntry;
  rodeo: RodeoItem | null;
  status: CompareStatus;
}

export default function UniproRodeoCompareScreen() {
  const { promoEntries, rodeoItems } = useApp();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);

  // ----- Filter state (mirrors the Promo tab) -----
  const [activeVendors, setActiveVendors] = useState<string[]>([]);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");
  const [activeBrands, setActiveBrands] = useState<string[]>([]);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [onlyMultiMrp, setOnlyMultiMrp] = useState(false);
  const [promoCrFrom, setPromoCrFrom] = useState<Date | null>(null);
  const [promoCrTo, setPromoCrTo] = useState<Date | null>(null);
  const [showPromoCrModal, setShowPromoCrModal] = useState(false);
  const [promoCrFromDraft, setPromoCrFromDraft] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [promoCrToDraft, setPromoCrToDraft] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [showPromoCrFromPicker, setShowPromoCrFromPicker] = useState(false);
  const [showPromoCrToPicker, setShowPromoCrToPicker] = useState(false);
  const [promoCrError, setPromoCrError] = useState<string | null>(null);

  // Build an itemCode → RodeoItem lookup once per RodeoItems change.
  // If an itemCode appears twice in Rodeo we keep the FIRST occurrence
  // (consistent with "ITEM CODE usually has a single MRP" upstream).
  const rodeoByItemCode = useMemo(() => {
    const m = new Map<string, RodeoItem>();
    for (const r of rodeoItems) {
      const key = normCode(r.itemCode);
      if (!key) continue;
      if (!m.has(key)) m.set(key, r);
    }
    return m;
  }, [rodeoItems]);

  // All Promo rows that currently have a PromotionPrice in Unipro,
  // joined to their RodeoItem (if any) and tagged with a status.
  // This is the UNFILTERED universe — filters narrow this set below.
  const allRows = useMemo<CompareRow[]>(() => {
    const out: CompareRow[] = [];
    for (const p of promoEntries) {
      if (!hasValue(p["PromotionPrice"])) continue;
      const key = normCode(p["Item No"]);
      const rodeo = key ? rodeoByItemCode.get(key) ?? null : null;
      let status: CompareStatus;
      if (!rodeo) {
        status = "not-in-rodeo";
      } else if (hasValue(rodeo.offerPrice)) {
        status = "match";
      } else {
        status = "missing-offer";
      }
      out.push({ promo: p, rodeo, status });
    }
    return out;
  }, [promoEntries, rodeoByItemCode]);

  // ----- Promo CR Date range bounds -----
  const promoCrFromTs = useMemo(
    () => (promoCrFrom ? startOfDay(promoCrFrom).getTime() : null),
    [promoCrFrom],
  );
  const promoCrToTs = useMemo(
    () => (promoCrTo ? startOfDay(promoCrTo).getTime() : null),
    [promoCrTo],
  );

  const matchesDateRange = useCallback(
    (p: PromoEntry): boolean => {
      if (promoCrFromTs === null && promoCrToTs === null) return true;
      const d = parsePromoCrCell(p["Promo CR Date"]);
      if (!d) return false;
      const ts = d.getTime();
      if (promoCrFromTs !== null && ts < promoCrFromTs) return false;
      if (promoCrToTs !== null && ts > promoCrToTs) return false;
      return true;
    },
    [promoCrFromTs, promoCrToTs],
  );

  // ----- Cross-filter scoping for the pickers -----
  // Each picker (Vendor / Brand / Category) shows only values that
  // exist under the OTHER active filters (its own selection is
  // intentionally ignored so users can still toggle their picks off).
  // This mirrors the Promo tab's Excel-slicer behaviour.
  const scopedFor = useCallback(
    (skip: "vendor" | "brand" | "category"): CompareRow[] => {
      const vendorSet =
        skip !== "vendor" && activeVendors.length > 0
          ? new Set(activeVendors)
          : null;
      const brandSet =
        skip !== "brand" && activeBrands.length > 0
          ? new Set(activeBrands)
          : null;
      const categorySet =
        skip !== "category" && activeCategories.length > 0
          ? new Set(activeCategories)
          : null;
      if (
        !vendorSet &&
        !brandSet &&
        !categorySet &&
        promoCrFromTs === null &&
        promoCrToTs === null
      ) {
        return allRows;
      }
      return allRows.filter((r) => {
        if (
          vendorSet &&
          !vendorSet.has(String(r.promo["VendorName"] ?? "").trim())
        )
          return false;
        if (brandSet && !brandSet.has(String(r.promo["Brand"] ?? "").trim()))
          return false;
        if (
          categorySet &&
          !categorySet.has(String(r.promo["Category"] ?? "").trim())
        )
          return false;
        if (!matchesDateRange(r.promo)) return false;
        return true;
      });
    },
    [
      allRows,
      activeVendors,
      activeBrands,
      activeCategories,
      promoCrFromTs,
      promoCrToTs,
      matchesDateRange,
    ],
  );

  const vendorScopeRows = useMemo(() => scopedFor("vendor"), [scopedFor]);
  const brandScopeRows = useMemo(() => scopedFor("brand"), [scopedFor]);
  const categoryScopeRows = useMemo(() => scopedFor("category"), [scopedFor]);

  const allVendors = useMemo(() => {
    const set = new Set<string>();
    for (const r of vendorScopeRows) {
      const v = String(r.promo["VendorName"] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [vendorScopeRows]);

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    for (const r of brandScopeRows) {
      const v = String(r.promo["Brand"] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [brandScopeRows]);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of categoryScopeRows) {
      const v = String(r.promo["Category"] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [categoryScopeRows]);

  // Drop selections that no longer exist in the underlying data so we
  // never get stuck on a "phantom" filter that hides every row.
  useEffect(() => {
    if (activeVendors.length === 0) return;
    const allowed = new Set(allVendors);
    const next = activeVendors.filter((v) => allowed.has(v));
    if (next.length !== activeVendors.length) setActiveVendors(next);
  }, [allVendors, activeVendors]);
  useEffect(() => {
    if (activeBrands.length === 0) return;
    const allowed = new Set(allBrands);
    const next = activeBrands.filter((b) => allowed.has(b));
    if (next.length !== activeBrands.length) setActiveBrands(next);
  }, [allBrands, activeBrands]);
  useEffect(() => {
    if (activeCategories.length === 0) return;
    const allowed = new Set(allCategories);
    const next = activeCategories.filter((c) => allowed.has(c));
    if (next.length !== activeCategories.length) setActiveCategories(next);
  }, [allCategories, activeCategories]);

  function toggleVendor(name: string) {
    setActiveVendors((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name],
    );
  }
  function toggleBrand(brand: string) {
    setActiveBrands((prev) =>
      prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand],
    );
  }
  function toggleCategory(cat: string) {
    setActiveCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  }

  // ----- Counts shown next to each option in the picker -----
  // Mirrors the same cross-filtered scope as the option list itself.
  function vendorRowCount(name: string): number {
    let n = 0;
    for (const r of vendorScopeRows)
      if (String(r.promo["VendorName"] ?? "").trim() === name) n++;
    return n;
  }
  function brandRowCount(brand: string): number {
    let n = 0;
    for (const r of brandScopeRows)
      if (String(r.promo["Brand"] ?? "").trim() === brand) n++;
    return n;
  }
  function categoryRowCount(cat: string): number {
    let n = 0;
    for (const r of categoryScopeRows)
      if (String(r.promo["Category"] ?? "").trim() === cat) n++;
    return n;
  }

  // ----- Filtered base (vendors + brands + categories + date) -----
  // Stats, export, and search all derive from this so the numbers
  // always match what the filter chips advertise.
  const filteredRows = useMemo<CompareRow[]>(() => {
    const vendorSet = activeVendors.length > 0 ? new Set(activeVendors) : null;
    const brandSet = activeBrands.length > 0 ? new Set(activeBrands) : null;
    const categorySet =
      activeCategories.length > 0 ? new Set(activeCategories) : null;
    let base = allRows.filter((r) => {
      if (
        vendorSet &&
        !vendorSet.has(String(r.promo["VendorName"] ?? "").trim())
      )
        return false;
      if (brandSet && !brandSet.has(String(r.promo["Brand"] ?? "").trim()))
        return false;
      if (
        categorySet &&
        !categorySet.has(String(r.promo["Category"] ?? "").trim())
      )
        return false;
      if (!matchesDateRange(r.promo)) return false;
      return true;
    });

    // "Multiple MRP" toggle: keep only rows whose Item No, within the
    // current view, appears with more than one distinct MRP value.
    if (onlyMultiMrp) {
      const mrpsByItem = new Map<string, Set<string>>();
      for (const r of base) {
        const itemNo = String(r.promo["Item No"] ?? "").trim();
        if (!itemNo) continue;
        let s = mrpsByItem.get(itemNo);
        if (!s) {
          s = new Set();
          mrpsByItem.set(itemNo, s);
        }
        s.add(normMrp(r.promo["MRP"]));
      }
      base = base.filter((r) => {
        const itemNo = String(r.promo["Item No"] ?? "").trim();
        const s = itemNo ? mrpsByItem.get(itemNo) : undefined;
        return !!s && s.size > 1;
      });
    }
    return base;
  }, [
    allRows,
    activeVendors,
    activeBrands,
    activeCategories,
    matchesDateRange,
    onlyMultiMrp,
  ]);

  // Visible rows: matches + "not in Rodeo" (missing-offer hidden by
  // design — they're surfaced via the Export button), then search.
  const visibleRows = useMemo(() => {
    const base = filteredRows.filter((r) => r.status !== "missing-offer");
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((r) => {
      const haystack = [
        fmtText(r.promo["Item No"]),
        fmtText(r.promo["Item Description"]),
        fmtText(r.promo["Brand"]),
        fmtText(r.promo["Category"]),
        fmtText(r.promo["VendorName"]),
        fmtText(r.rodeo?.itemCode),
        fmtText(r.rodeo?.productName),
      ]
        .join(" | ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [filteredRows, search]);

  const exportableRows = useMemo(
    () => filteredRows.filter((r) => r.status === "missing-offer"),
    [filteredRows],
  );

  const counts = useMemo(() => {
    let match = 0;
    let missingOffer = 0;
    let notInRodeo = 0;
    for (const r of filteredRows) {
      if (r.status === "match") match += 1;
      else if (r.status === "missing-offer") missingOffer += 1;
      else notInRodeo += 1;
    }
    return { match, missingOffer, notInRodeo, total: filteredRows.length };
  }, [filteredRows]);

  const anyFilterActive =
    activeVendors.length > 0 ||
    activeBrands.length > 0 ||
    activeCategories.length > 0 ||
    onlyMultiMrp ||
    promoCrFrom !== null ||
    promoCrTo !== null;

  function clearAllFilters() {
    setActiveVendors([]);
    setActiveBrands([]);
    setActiveCategories([]);
    setOnlyMultiMrp(false);
    setPromoCrFrom(null);
    setPromoCrTo(null);
  }

  // Promo lookup keyed by normalized Item No → first row that carries
  // a PromotionPrice (falls back to the very first row if none has a
  // price). Used by the "RodeoItems + Promo" export so we can stamp
  // each Rodeo row with its matching promo's price + end date.
  const promoByItemCode = useMemo(() => {
    const m = new Map<string, PromoEntry>();
    for (const p of promoEntries) {
      const key = normCode(p["Item No"]);
      if (!key) continue;
      const existing = m.get(key);
      if (!existing) {
        m.set(key, p);
        continue;
      }
      // Upgrade to a row that actually has a PromotionPrice if the
      // currently-stored one doesn't.
      if (!hasValue(existing["PromotionPrice"]) && hasValue(p["PromotionPrice"])) {
        m.set(key, p);
      }
    }
    return m;
  }, [promoEntries]);

  async function handleExportRodeoWithPromo() {
    if (rodeoItems.length === 0) {
      const msg = "No RodeoItems loaded — import a RodeoItems sheet first.";
      if (Platform.OS === "web") window.alert(`Nothing to export\n\n${msg}`);
      else Alert.alert("Nothing to export", msg);
      return;
    }
    setExporting(true);
    try {
      // All RodeoItem fields, in the same order as the type, plus the
      // two Promo columns appended on the right.
      const headers = [
        "productId",
        "skuId",
        "productName",
        "barCode",
        "itemCode",
        "gst",
        "mrp",
        "purchasePrice",
        "sellingPrice",
        "offerPrice",
        "offerStartDate",
        "offerEndDate",
        "active",
        "PromotionPrice",
        "PromotionToDate",
      ];
      const data: (string | number)[][] = [headers];
      let matched = 0;
      for (const rd of rodeoItems) {
        const key = normCode(rd.itemCode);
        const p = key ? promoByItemCode.get(key) : undefined;
        if (p) matched += 1;
        data.push([
          rd.productId ?? "",
          rd.skuId ?? "",
          fmtText(rd.productName),
          fmtText(rd.barCode),
          fmtText(rd.itemCode),
          rd.gst ?? "",
          rd.mrp ?? "",
          rd.purchasePrice ?? "",
          rd.sellingPrice ?? "",
          rd.offerPrice ?? "",
          fmtText(rd.offerStartDate),
          fmtText(rd.offerEndDate),
          rd.active ? "TRUE" : "FALSE",
          p ? ((p["PromotionPrice"] as number | string | undefined) ?? "") : "",
          p ? fmtText(p["PromotionToDate"]) : "",
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = headers.map((h) =>
        h === "productName" || h === "barCode" ? { wch: 32 } : { wch: 16 },
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "RodeoItems+Promo");
      const fileName = `Sathyam RodeoItems with Promo - ${timestampForFile()}.xlsx`;
      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, {
          bookType: "xlsx",
          type: "array",
          cellStyles: true,
        });
        const blob = new Blob([wbout], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, {
          bookType: "xlsx",
          type: "base64",
          cellStyles: true,
        });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: "base64" as any,
        });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export RodeoItems with Promo",
            UTI: "com.microsoft.excel.xlsx",
          });
        } else {
          Alert.alert("Export saved", `File saved to: ${fileUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const summary = `${rodeoItems.length} RodeoItems exported · ${matched} matched a Promo row.`;
      if (Platform.OS === "web") {
        // No alert on web — the toast-like behavior would require extra
        // UI. The browser's download dialog is the implicit confirmation.
        console.log(summary);
      } else {
        // Non-blocking: schedule after the share sheet closes.
        setTimeout(() => Alert.alert("Export complete", summary), 300);
      }
    } catch (e: any) {
      const msg = e?.message ?? "Unknown error";
      if (Platform.OS === "web") window.alert(`Export Failed\n\n${msg}`);
      else Alert.alert("Export Failed", msg);
    } finally {
      setExporting(false);
    }
  }

  async function handleExportMissingOffers() {
    if (exportableRows.length === 0) {
      const msg =
        "No Unipro promo items in the current filter whose matching RodeoItem has an empty Offer Price.";
      if (Platform.OS === "web") window.alert(`Nothing to export\n\n${msg}`);
      else Alert.alert("Nothing to export", msg);
      return;
    }
    setExporting(true);
    try {
      const headers = [
        "Item No",
        "Item Description",
        "Brand",
        "Category",
        "VendorName",
        "MRP",
        "SP",
        "PromotionPrice",
        "PromotionToDate",
        "Rodeo ITEM CODE",
        "Rodeo Product Name",
        "Rodeo MRP",
        "Rodeo Selling Price",
        "Rodeo Offer Price",
        "Rodeo Offer End Date",
      ];
      const data: (string | number)[][] = [headers];
      for (const r of exportableRows) {
        const p = r.promo;
        const rd = r.rodeo;
        data.push([
          fmtText(p["Item No"]),
          fmtText(p["Item Description"]),
          fmtText(p["Brand"]),
          fmtText(p["Category"]),
          fmtText(p["VendorName"]),
          (p["MRP"] as number | string | undefined) ?? "",
          (p["SP"] as number | string | undefined) ?? "",
          (p["PromotionPrice"] as number | string | undefined) ?? "",
          fmtText(p["PromotionToDate"]),
          fmtText(rd?.itemCode),
          fmtText(rd?.productName),
          rd?.mrp ?? "",
          rd?.sellingPrice ?? "",
          rd?.offerPrice ?? "",
          fmtText(rd?.offerEndDate),
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = headers.map((h) =>
        h.toLowerCase().includes("description") ||
        h.toLowerCase().includes("product name")
          ? { wch: 32 }
          : { wch: 16 },
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "MissingRodeoOffers");
      const fileName = `Sathyam Unipro-Rodeo Missing Offers - ${timestampForFile()}.xlsx`;
      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, {
          bookType: "xlsx",
          type: "array",
          cellStyles: true,
        });
        const blob = new Blob([wbout], {
          type: "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, {
          bookType: "xlsx",
          type: "base64",
          cellStyles: true,
        });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: "base64" as any,
        });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export Missing Rodeo Offers",
            UTI: "com.microsoft.excel.xlsx",
          });
        } else {
          Alert.alert("Export saved", `File saved to: ${fileUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      const msg = e?.message ?? "Unknown error";
      if (Platform.OS === "web") window.alert(`Export Failed\n\n${msg}`);
      else Alert.alert("Export Failed", msg);
    } finally {
      setExporting(false);
    }
  }

  if (promoEntries.length === 0 || rodeoItems.length === 0) {
    return (
      <View style={[styles.empty, { paddingTop: insets.top + 24 }]}>
        <Feather name="git-merge" size={48} color={Colors.textMuted} />
        <Text style={styles.emptyTitle}>UniproRodeoCompare</Text>
        <Text style={styles.emptyBody}>
          {promoEntries.length === 0
            ? "Import a Promo sheet from the Promo tab to populate the Unipro side of this comparison."
            : "Import a RodeoItems sheet from the RodeoItems tab to populate the Rodeo side of this comparison."}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 100 : 24) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerCard}>
          <Text style={styles.title}>Unipro ↔ Rodeo Compare</Text>
          <Text style={styles.subtitle}>
            Promo rows with a PromotionPrice, joined to RodeoItems by ITEM CODE.
          </Text>

          <View style={styles.statRow}>
            <View style={styles.statCell}>
              <Text style={[styles.statValue, { color: Colors.success }]}>
                {counts.match}
              </Text>
              <Text style={styles.statLabel}>Match{"\n"}(both have offer)</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={[styles.statValue, { color: Colors.warning }]}>
                {counts.missingOffer}
              </Text>
              <Text style={styles.statLabel}>Missing in{"\n"}Rodeo (hidden)</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={[styles.statValue, { color: Colors.danger }]}>
                {counts.notInRodeo}
              </Text>
              <Text style={styles.statLabel}>Not in{"\n"}Rodeo at all</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[
              styles.exportBtn,
              (exportableRows.length === 0 || exporting) &&
                styles.exportBtnDisabled,
            ]}
            onPress={handleExportMissingOffers}
            disabled={exportableRows.length === 0 || exporting}
          >
            {exporting ? (
              <ActivityIndicator color={Colors.textInverse} size="small" />
            ) : (
              <Feather name="download" size={16} color={Colors.textInverse} />
            )}
            <Text style={styles.exportBtnText}>
              Export {exportableRows.length} missing offer
              {exportableRows.length === 1 ? "" : "s"} to Excel
            </Text>
          </TouchableOpacity>
          <Text style={styles.exportHint}>
            Promo items with a PromotionPrice whose matching RodeoItem has an
            empty Offer Price — the list of offers you still need to add in
            Rodeo. Honours the filters below.
          </Text>

          <TouchableOpacity
            style={[
              styles.exportBtn,
              styles.exportBtnAccent,
              (rodeoItems.length === 0 || exporting) && styles.exportBtnDisabled,
            ]}
            onPress={handleExportRodeoWithPromo}
            disabled={rodeoItems.length === 0 || exporting}
          >
            {exporting ? (
              <ActivityIndicator color={Colors.textInverse} size="small" />
            ) : (
              <Feather name="file-text" size={16} color={Colors.textInverse} />
            )}
            <Text style={styles.exportBtnText}>
              Export all {rodeoItems.length} RodeoItem
              {rodeoItems.length === 1 ? "" : "s"} + Promo to Excel
            </Text>
          </TouchableOpacity>
          <Text style={styles.exportHint}>
            Every RodeoItem with all its fields, plus PromotionPrice and
            PromotionToDate from the Promo tab where Item No matches the
            Rodeo ITEM CODE. Ignores the filters below — exports the
            entire RodeoItems list.
          </Text>

          {/* Filter chip grid — same layout the Promo tab uses */}
          <View style={styles.filterGrid}>
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
                onPress={() => {
                  setVendorSearch("");
                  setShowVendorModal(true);
                }}
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
                onPress={() => {
                  setBrandSearch("");
                  setShowBrandModal(true);
                }}
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
                onPress={() => {
                  setCategorySearch("");
                  setShowCategoryModal(true);
                }}
                onClear={() => setActiveCategories([])}
              />
            </View>
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
            {anyFilterActive && (
              <View style={styles.filterCol}>
                <TouchableOpacity
                  style={[styles.filterBar, styles.filterBarReset]}
                  onPress={clearAllFilters}
                  activeOpacity={0.75}
                >
                  <Feather
                    name="x-circle"
                    size={15}
                    color={Colors.textInverse}
                  />
                  <Text
                    style={[styles.filterBarText, styles.filterBarResetText]}
                    numberOfLines={1}
                  >
                    Clear all filters
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <View style={styles.searchWrap}>
            <Feather name="search" size={14} color={Colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search Item No, Description, Brand, Vendor…"
              placeholderTextColor={Colors.textMuted}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch("")}>
                <Feather name="x" size={14} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {visibleRows.length === 0 ? (
          <View style={styles.emptyInline}>
            <Text style={styles.emptyInlineText}>
              No rows match.{" "}
              {counts.missingOffer > 0
                ? `${counts.missingOffer} item${counts.missingOffer === 1 ? "" : "s"} are hidden because their matching RodeoItem has no Offer Price — use the Export button above to surface them.`
                : ""}
            </Text>
          </View>
        ) : (
          visibleRows.map((r, i) => <CompareCard key={i} row={r} />)
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
        countLabel={(v) =>
          `${vendorRowCount(v)} row${vendorRowCount(v) !== 1 ? "s" : ""}`
        }
        allLabel="All Vendors"
        allCount={`${vendorScopeRows.length} rows`}
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
        countLabel={(b) =>
          `${brandRowCount(b)} row${brandRowCount(b) !== 1 ? "s" : ""}`
        }
        allLabel="All Brands"
        allCount={`${brandScopeRows.length} rows`}
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
        countLabel={(c) =>
          `${categoryRowCount(c)} row${categoryRowCount(c) !== 1 ? "s" : ""}`
        }
        allLabel="All Categories"
        allCount={`${categoryScopeRows.length} rows`}
        onToggle={toggleCategory}
        onClear={() => setActiveCategories([])}
        onClose={() => setShowCategoryModal(false)}
        bottomInset={insets.bottom}
      />

      {/* Promo CR Date range filter modal */}
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
        <View
          style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}
        >
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
    </View>
  );
}

function CompareCard({ row }: { row: CompareRow }) {
  const p = row.promo;
  const rd = row.rodeo;
  return (
    <View style={styles.card}>
      {/* Unipro / Promo section */}
      <View style={styles.uniproBlock}>
        <View style={styles.blockHeader}>
          <Text style={styles.blockHeaderText}>UNIPRO · Promo</Text>
        </View>
        <View style={styles.cardLine1}>
          <Text style={styles.itemNo} numberOfLines={1}>
            {fmtText(p["Item No"]) || "—"}
          </Text>
          <Text style={styles.itemDesc} numberOfLines={2}>
            {fmtText(p["Item Description"])}
          </Text>
        </View>
        <View style={styles.metaRow}>
          {p["Brand"] ? (
            <Text style={styles.metaChip}>{fmtText(p["Brand"])}</Text>
          ) : null}
          {p["Category"] ? (
            <Text style={styles.metaChip}>{fmtText(p["Category"])}</Text>
          ) : null}
          {p["VendorName"] ? (
            <Text style={styles.metaChip}>{fmtText(p["VendorName"])}</Text>
          ) : null}
        </View>
        <View style={styles.kvGrid}>
          <KV label="MRP" value={fmtNum(p["MRP"])} />
          <KV label="SP" value={fmtNum(p["SP"])} />
          <KV
            label="Promo Price"
            value={fmtNum(p["PromotionPrice"])}
            highlight
          />
          <KV
            label="Valid Till"
            value={fmtText(p["PromotionToDate"]) || "—"}
          />
        </View>
      </View>

      {/* Rodeo section */}
      {row.status === "not-in-rodeo" ? (
        <View style={[styles.rodeoBlock, styles.rodeoBlockEmpty]}>
          <View style={[styles.blockHeader, styles.rodeoBlockHeader]}>
            <Text style={[styles.blockHeaderText, styles.rodeoHeaderText]}>
              RODEO
            </Text>
            <View style={styles.notInRodeoBadge}>
              <Feather name="alert-triangle" size={11} color={Colors.danger} />
              <Text style={styles.notInRodeoBadgeText}>Not in Rodeo</Text>
            </View>
          </View>
          <Text style={styles.notInRodeoBody}>
            No RodeoItem with ITEM CODE = {fmtText(p["Item No"]) || "(blank)"}.
            Add the product in Rodeo (or the ITEM CODE may be mismatched).
          </Text>
        </View>
      ) : (
        <View style={styles.rodeoBlock}>
          <View style={[styles.blockHeader, styles.rodeoBlockHeader]}>
            <Text style={[styles.blockHeaderText, styles.rodeoHeaderText]}>
              RODEO · Online
            </Text>
            {!rd?.active ? (
              <View style={styles.inactiveBadge}>
                <Text style={styles.inactiveBadgeText}>Inactive</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.cardLine1}>
            <Text style={[styles.itemNo, styles.rodeoItemNo]} numberOfLines={1}>
              {fmtText(rd?.itemCode) || "—"}
            </Text>
            <Text style={[styles.itemDesc, styles.rodeoText]} numberOfLines={2}>
              {fmtText(rd?.productName)}
            </Text>
          </View>
          <View style={styles.kvGrid}>
            <KV label="MRP" value={fmtNum(rd?.mrp)} rodeo />
            <KV label="Selling" value={fmtNum(rd?.sellingPrice)} rodeo />
            <KV
              label="Offer Price"
              value={fmtNum(rd?.offerPrice)}
              rodeo
              highlight
            />
            <KV
              label="Offer End"
              value={fmtText(rd?.offerEndDate) || "—"}
              rodeo
            />
          </View>
        </View>
      )}
    </View>
  );
}

function KV({
  label,
  value,
  rodeo,
  highlight,
}: {
  label: string;
  value: string;
  rodeo?: boolean;
  highlight?: boolean;
}) {
  return (
    <View style={styles.kvCell}>
      <Text style={[styles.kvLabel, rodeo && styles.rodeoMutedText]}>
        {label}
      </Text>
      <Text
        style={[
          styles.kvValue,
          rodeo && styles.rodeoText,
          highlight && styles.kvValueHighlight,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

// ---- Filter chip (toggle / dropdown style) ----
type FilterBarProps = {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  active: boolean;
  onPress: () => void;
  onClear: () => void;
  toggleOnly?: boolean;
  variant?: "default" | "highlight";
};
function FilterBar({
  icon,
  label,
  active,
  onPress,
  onClear,
  toggleOnly,
  variant = "default",
}: FilterBarProps) {
  const isHighlight = variant === "highlight";
  const inactiveIconColor = isHighlight
    ? Colors.textInverse
    : Colors.textSecondary;
  return (
    <TouchableOpacity
      style={[
        styles.filterBar,
        isHighlight && styles.filterBarHighlight,
        active &&
          (isHighlight ? styles.filterBarHighlightActive : styles.filterBarActive),
      ]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Feather
        name={icon}
        size={isHighlight ? 15 : 14}
        color={active ? Colors.textInverse : inactiveIconColor}
      />
      <Text
        style={[
          styles.filterBarText,
          isHighlight && styles.filterBarHighlightText,
          active &&
            (isHighlight
              ? styles.filterBarHighlightTextActive
              : styles.filterBarTextActive),
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {active ? (
        <TouchableOpacity
          onPress={(e) => {
            e.stopPropagation?.();
            onClear();
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="x-circle" size={15} color={Colors.textInverse} />
        </TouchableOpacity>
      ) : toggleOnly ? null : (
        <Feather name="chevron-down" size={14} color={Colors.textMuted} />
      )}
    </TouchableOpacity>
  );
}

// ---- Generic bottom-sheet multi-select ----
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
    visible,
    title,
    emptyIcon,
    emptyTitle,
    emptySub,
    searchPlaceholder,
    searchValue,
    onChangeSearch,
    items,
    active,
    countLabel,
    allLabel,
    allCount,
    onToggle,
    onClear,
    onClose,
    bottomInset,
  } = props;
  const q = searchValue.trim().toLowerCase();
  const visibleItems = q
    ? items.filter((b) => b.toLowerCase().includes(q))
    : items;
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
              <TouchableOpacity
                onPress={() => onChangeSearch("")}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
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
          <ScrollView
            showsVerticalScrollIndicator={false}
            style={styles.modalList}
            keyboardShouldPersistTaps="handled"
          >
            {!q && (
              <TouchableOpacity
                style={[
                  styles.modalRow,
                  active.length === 0 && styles.modalRowActive,
                ]}
                onPress={onClear}
              >
                <Text
                  style={[
                    styles.modalRowName,
                    active.length === 0 && styles.modalRowNameActive,
                  ]}
                >
                  {allLabel}
                </Text>
                <Text style={styles.modalRowCount}>{allCount}</Text>
                {active.length === 0 && (
                  <Feather name="check" size={16} color={Colors.primary} />
                )}
              </TouchableOpacity>
            )}
            {visibleItems.length === 0 ? (
              <View style={styles.modalEmpty}>
                <Feather name="search" size={28} color={Colors.textMuted} />
                <Text style={styles.modalEmptyTitle}>No match</Text>
                <Text style={styles.modalEmptySub}>
                  No matches for "{searchValue}"
                </Text>
              </View>
            ) : (
              visibleItems.map((item) => {
                const isSelected = active.includes(item);
                return (
                  <TouchableOpacity
                    key={item}
                    style={[
                      styles.modalRow,
                      isSelected && styles.modalRowActive,
                    ]}
                    onPress={() => onToggle(item)}
                  >
                    <Feather
                      name={isSelected ? "check-square" : "square"}
                      size={17}
                      color={isSelected ? Colors.primary : Colors.textMuted}
                    />
                    <Text
                      style={[
                        styles.modalRowName,
                        isSelected && styles.modalRowNameActive,
                      ]}
                      numberOfLines={1}
                    >
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

// Rodeo-side palette: a distinct contrasting teal/indigo wash so the
// Rodeo block reads unmistakably different from the Unipro block on
// every card, even at a glance.
const RODEO_BG = "#EEF2FF";
const RODEO_BORDER = "#A5B4FC";
const RODEO_TEXT = "#1E1B4B";
const RODEO_MUTED = "#4338CA";

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: 24,
    gap: 10,
    backgroundColor: Colors.background,
  },
  emptyTitle: { fontSize: 18, fontWeight: "800", color: Colors.text },
  emptyBody: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  headerCard: {
    backgroundColor: Colors.surface,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 10,
  },
  title: { fontSize: 18, fontWeight: "800", color: Colors.text },
  subtitle: { fontSize: 12, color: Colors.textMuted },
  statRow: {
    flexDirection: "row",
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 12,
    paddingVertical: 10,
  },
  statCell: { flex: 1, alignItems: "center", paddingHorizontal: 4 },
  statValue: { fontSize: 18, fontWeight: "800" },
  statLabel: {
    fontSize: 10,
    color: Colors.textMuted,
    textAlign: "center",
    marginTop: 2,
    lineHeight: 13,
  },
  statDivider: { width: 1, backgroundColor: Colors.border, marginVertical: 6 },
  exportBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  exportBtnAccent: { backgroundColor: Colors.accent, marginTop: 8 },
  exportBtnDisabled: { opacity: 0.5 },
  exportBtnText: {
    color: Colors.textInverse,
    fontSize: 13,
    fontWeight: "700",
  },
  exportHint: {
    fontSize: 11,
    color: Colors.textMuted,
    lineHeight: 15,
  },
  filterGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  filterCol: { width: "48.5%" },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
    paddingVertical: 0,
  },
  list: { flex: 1 },
  listContent: { paddingBottom: 12, gap: 12 },
  emptyInline: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    marginHorizontal: 12,
    marginTop: 12,
  },
  emptyInlineText: { fontSize: 13, color: Colors.textMuted, lineHeight: 19 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
    marginHorizontal: 12,
    marginTop: 12,
  },
  uniproBlock: { padding: 12, gap: 8 },
  rodeoBlock: {
    padding: 12,
    gap: 8,
    backgroundColor: RODEO_BG,
    borderTopWidth: 2,
    borderTopColor: RODEO_BORDER,
  },
  rodeoBlockEmpty: { backgroundColor: Colors.dangerLight },
  blockHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  rodeoBlockHeader: {},
  blockHeaderText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    color: Colors.textMuted,
  },
  rodeoHeaderText: { color: RODEO_MUTED },
  cardLine1: { gap: 2 },
  itemNo: { fontSize: 15, fontWeight: "800", color: Colors.text },
  rodeoItemNo: { color: RODEO_TEXT },
  itemDesc: { fontSize: 13, color: Colors.textSecondary, lineHeight: 17 },
  rodeoText: { color: RODEO_TEXT },
  rodeoMutedText: { color: RODEO_MUTED },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  metaChip: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.textSecondary,
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  kvGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -4,
  },
  kvCell: {
    width: "25%",
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  kvLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.4,
    color: Colors.textMuted,
    textTransform: "uppercase",
  },
  kvValue: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    marginTop: 1,
  },
  kvValueHighlight: { color: Colors.accent },
  notInRodeoBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.dangerLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  notInRodeoBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.danger,
  },
  notInRodeoBody: {
    fontSize: 12,
    color: Colors.danger,
    lineHeight: 16,
  },
  inactiveBadge: {
    backgroundColor: Colors.warningLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  inactiveBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.warning,
  },

  // ---- Filter chip styles (mirror Promo tab) ----
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
  filterBarText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  filterBarTextActive: { color: Colors.textInverse },
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
  filterBarHighlightTextActive: {
    color: Colors.textInverse,
    fontWeight: "700",
  },
  filterBarReset: {
    backgroundColor: Colors.danger,
    borderColor: Colors.danger,
  },
  filterBarResetText: { color: Colors.textInverse, fontWeight: "700" },

  // ---- Bottom-sheet modal ----
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
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
  modalRowName: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
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
  modalDoneBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.textInverse,
  },

  // ---- Date range modal ----
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
