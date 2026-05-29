import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  Modal,
  FlatList,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Print from "expo-print";
import * as XLSX from "xlsx-js-style";
import { Colors } from "@/constants/colors";
import { useApp, type Supplier, type VendorPayment } from "@/context/AppContext";
import { LOGO_BASE64 } from "@/constants/LogoBase64";
import { SupplierPhotosBox } from "@/components/SupplierPhotosBox";

// ---------- Helpers ----------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function parseStoredDate(s: string | undefined | null): Date | null {
  if (!s) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    let yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    const d = new Date(yr, mon - 1, day);
    if (isNaN(d.getTime())) return null;
    if (d.getDate() !== day || d.getMonth() !== mon - 1) return null;
    return d;
  }
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(
      parseInt(iso[1], 10),
      parseInt(iso[2], 10) - 1,
      parseInt(iso[3], 10),
    );
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function fmtAmount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isPaid(vp: VendorPayment): boolean {
  return !!(vp.tranNo && vp.tranNo.trim().length > 0);
}

type PaidFilter = "all" | "paid" | "unpaid";
type UnpaidCountFilter = "all" | "0" | "1" | "2" | "3" | "4" | "5+";
type Mark = "Normal" | "Urgent" | null;
type Draft = {
  mark: Mark;
  comments: string;
  crFlag: boolean;
  crNotes: string;
  chequeNo: string;
  paidFlag: boolean;
};

// Preset chips for the Unpaid Bills Count filter on the vendor-summary
// table. "5+" buckets anything five or more so the chip strip stays
// short and the long tail of high-count vendors collapses into one bin.
const UNPAID_COUNT_FILTERS: { key: UnpaidCountFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "0", label: "0" },
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
  { key: "4", label: "4" },
  { key: "5+", label: "5+" },
];

function matchesUnpaidCount(count: number, filter: UnpaidCountFilter): boolean {
  if (filter === "all") return true;
  if (filter === "5+") return count >= 5;
  return count === parseInt(filter, 10);
}

// Aggregated row in the vendor-summary table — one entry per unique
// `vendorCode` in the filtered bill set. `bills` is the underlying
// post-filter bill list (used by the expanded panel + PDF export).
interface VendorSummary {
  vendorCode: string;
  vendorName: string;
  bills: VendorPayment[];
  totalBills: number;
  unpaidCount: number;
  paidCount: number;
  totalPay: number;
  markedCount: number;
  crFlagCount: number;
}

// Strict data-URI guard so a malformed photo string can never leak
// into the print HTML. Mirrors the StockUpd PDF exporter.
const PHOTO_URI_RE =
  /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Strip filename-hostile characters so the per-vendor PDF name always
// resolves to a valid file on iOS / Android / web. Keeps spaces and
// dashes intact since the brief requires the literal pattern
// "Sathyam Super Store - <VendorName> Credit Note Needed DDMMYY HHMM.pdf".
function sanitizeFileNameSegment(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- Screen ----------


export default function VendorPaymentsScreen() {
  const {
    vendorPayments,
    saveVendorPaymentsBatch,
    clearVendorPayments,
    suppliers,
    setSupplierCrPhotos,
  } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Deep-link entry point: when the user taps the admin-only "Pay"
  // pill on a StockUpd order card, we land here with `?vendor=<name>`
  // and apply the multi-vendor filter on arrival.
  const params = useLocalSearchParams<{ vendor?: string | string[] }>();

  const [search, setSearch] = useState("");
  const [paidFilter, setPaidFilter] = useState<PaidFilter>("all");
  const [unpaidCountFilter, setUnpaidCountFilter] =
    useState<UnpaidCountFilter>("all");

  const [activeVendors, setActiveVendors] = useState<string[]>([]);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

  // Apply the `?vendor=<name>` deep-link param once per arrival.
  // We strip the param from the URL with `router.setParams` after
  // applying so navigating away + back doesn't keep re-pinning the
  // same vendor — and so the user can freely clear/change the filter
  // from the chip without it snapping back.
  useEffect(() => {
    const raw = params.vendor;
    const name =
      Array.isArray(raw) ? raw[0] : typeof raw === "string" ? raw : "";
    if (!name) return;
    setActiveVendors((cur) => (cur.includes(name) ? cur : [name]));
    router.setParams({ vendor: undefined });
  }, [params.vendor, router]);

  const [invFrom, setInvFrom] = useState<Date | null>(null);
  const [invTo, setInvTo] = useState<Date | null>(null);
  const [showInvModal, setShowInvModal] = useState(false);
  const [invFromDraft, setInvFromDraft] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [invToDraft, setInvToDraft] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [showInvFromPicker, setShowInvFromPicker] = useState(false);
  const [showInvToPicker, setShowInvToPicker] = useState(false);
  const [invError, setInvError] = useState<string | null>(null);

  const [payFrom, setPayFrom] = useState<Date | null>(null);
  const [payTo, setPayTo] = useState<Date | null>(null);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payFromDraft, setPayFromDraft] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [payToDraft, setPayToDraft] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [showPayFromPicker, setShowPayFromPicker] = useState(false);
  const [showPayToPicker, setShowPayToPicker] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const [modifyMode, setModifyMode] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [crPhotoSupplier, setCrPhotoSupplier] = useState<Supplier | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingStatus, setExportingStatus] = useState(false);

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  // Lookup by vendorCode — used by the expanded panel's CR Photos
  // button and the PDF export to attach supplier-level notes/photos
  // to the per-vendor PDF. Falls back to undefined when a bill's
  // vendorCode has no matching Supplier record (bills can be imported
  // without a paired supplier).
  const supplierByCode = useMemo(() => {
    const m = new Map<string, Supplier>();
    for (const s of suppliers) {
      const code = (s.vendorCode ?? "").trim();
      if (code) m.set(code, s);
    }
    return m;
  }, [suppliers]);

  // Distinct vendor names — populates the vendor multi-select modal.
  const allVendors = useMemo(() => {
    const set = new Set<string>();
    for (const vp of vendorPayments) {
      if (vp.vendorName) set.add(vp.vendorName);
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [vendorPayments]);

  const filteredVendors = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    if (!q) return allVendors;
    return allVendors.filter((v) => v.toLowerCase().includes(q));
  }, [allVendors, vendorSearch]);

  // Draft-aware getters so the UI always reads the live in-flight
  // edits (un-saved drafts) before falling back to persisted values.
  const getMark = useCallback(
    (vp: VendorPayment): Mark =>
      drafts[vp.gidNo]?.mark ?? vp.markToPay ?? null,
    [drafts],
  );
  const getComments = useCallback(
    (vp: VendorPayment): string =>
      drafts[vp.gidNo]?.comments ?? vp.comments ?? "",
    [drafts],
  );
  const getCrFlag = useCallback(
    (vp: VendorPayment): boolean =>
      drafts[vp.gidNo]?.crFlag ?? !!vp.crFlag,
    [drafts],
  );
  const getCrNotes = useCallback(
    (vp: VendorPayment): string =>
      drafts[vp.gidNo]?.crNotes ?? vp.crNotes ?? "",
    [drafts],
  );
  const getChequeNo = useCallback(
    (vp: VendorPayment): string =>
      drafts[vp.gidNo]?.chequeNo ?? vp.chequeNo ?? "",
    [drafts],
  );
  const getPaidFlag = useCallback(
    (vp: VendorPayment): boolean =>
      drafts[vp.gidNo]?.paidFlag ?? !!vp.paidFlag,
    [drafts],
  );

  // Row-level filters (search, vendor multi-select, paid/unpaid, both
  // date ranges) are applied first — this is the bill set used by both
  // the vendor summary aggregation and the Credit Note PDF export.
  const filteredBills = useMemo(() => {
    const q = search.trim().toLowerCase();
    const invFromMs = invFrom ? startOfDay(invFrom).getTime() : null;
    const invToMs = invTo ? startOfDay(invTo).getTime() : null;
    const payFromMs = payFrom ? startOfDay(payFrom).getTime() : null;
    const payToMs = payTo ? startOfDay(payTo).getTime() : null;
    const vendorSet =
      activeVendors.length > 0 ? new Set(activeVendors) : null;

    return vendorPayments.filter((vp) => {
      if (q) {
        const matches =
          vp.vendorCode.toLowerCase().includes(q) ||
          vp.vendorName.toLowerCase().includes(q);
        if (!matches) return false;
      }
      if (vendorSet && !vendorSet.has(vp.vendorName)) return false;
      if (paidFilter === "paid" && !isPaid(vp)) return false;
      if (paidFilter === "unpaid" && isPaid(vp)) return false;

      if (invFromMs !== null || invToMs !== null) {
        const d = parseStoredDate(vp.invoiceDate);
        if (!d) return false;
        const t = d.getTime();
        if (invFromMs !== null && t < invFromMs) return false;
        if (invToMs !== null && t > invToMs) return false;
      }
      if (payFromMs !== null || payToMs !== null) {
        const d = parseStoredDate(vp.paymentDate);
        if (!d) return false;
        const t = d.getTime();
        if (payFromMs !== null && t < payFromMs) return false;
        if (payToMs !== null && t > payToMs) return false;
      }
      return true;
    });
  }, [
    vendorPayments,
    search,
    activeVendors,
    paidFilter,
    invFrom,
    invTo,
    payFrom,
    payTo,
  ]);

  // Aggregate the filtered bills into one row per vendorCode. The
  // Unpaid Bills Count filter is applied AFTER aggregation so a vendor
  // whose unpaid count happens to land in the selected bucket survives
  // even when some of their bills got dropped by the date/paid filters.
  const summaries: VendorSummary[] = useMemo(() => {
    const byCode = new Map<string, VendorSummary>();
    for (const vp of filteredBills) {
      const code = vp.vendorCode || "—";
      let s = byCode.get(code);
      if (!s) {
        s = {
          vendorCode: code,
          vendorName: vp.vendorName,
          bills: [],
          totalBills: 0,
          unpaidCount: 0,
          paidCount: 0,
          totalPay: 0,
          markedCount: 0,
          crFlagCount: 0,
        };
        byCode.set(code, s);
      }
      s.bills.push(vp);
      s.totalBills += 1;
      if (isPaid(vp)) s.paidCount += 1;
      else s.unpaidCount += 1;
      s.totalPay += vp.supplierPayment ?? 0;
      if (getMark(vp)) s.markedCount += 1;
      if (getCrFlag(vp)) s.crFlagCount += 1;
    }

    // Sort each vendor's bill list: unpaid first, then most-recent
    // invoice date — matches the prior row-level table sort.
    for (const s of byCode.values()) {
      s.bills.sort((a, b) => {
        const aPaid = isPaid(a);
        const bPaid = isPaid(b);
        if (aPaid !== bPaid) return aPaid ? 1 : -1;
        const ad = parseStoredDate(a.invoiceDate)?.getTime() ?? -Infinity;
        const bd = parseStoredDate(b.invoiceDate)?.getTime() ?? -Infinity;
        return bd - ad;
      });
    }

    const out = Array.from(byCode.values()).filter((s) =>
      matchesUnpaidCount(s.unpaidCount, unpaidCountFilter),
    );
    // Sort vendors: highest unpaid count first, then by vendor name.
    out.sort((a, b) => {
      if (a.unpaidCount !== b.unpaidCount) return b.unpaidCount - a.unpaidCount;
      return a.vendorName.localeCompare(b.vendorName, undefined, {
        sensitivity: "base",
      });
    });
    return out;
  }, [filteredBills, unpaidCountFilter, getMark, getCrFlag]);

  // Stats are computed across the full ledger (unfiltered) so the
  // pills always reflect the whole dataset rather than the current
  // filter, mirroring the prior screen behaviour.
  const totalPaid = useMemo(
    () => vendorPayments.reduce((s, vp) => s + (vp.supplierPayment ?? 0), 0),
    [vendorPayments],
  );
  const uniqueVendors = useMemo(
    () => new Set(vendorPayments.map((vp) => vp.vendorCode)).size,
    [vendorPayments],
  );
  const unpaidCount = useMemo(
    () => vendorPayments.filter((vp) => !isPaid(vp)).length,
    [vendorPayments],
  );

  const markedCount = useMemo(() => {
    let n = 0;
    for (const vp of vendorPayments) {
      if (getMark(vp)) n += 1;
    }
    return n;
  }, [vendorPayments, getMark]);

  // Total bills with the Credit Note flag ON across the vendor
  // summaries currently visible (i.e. after BOTH the row-level filters
  // and the per-vendor Unpaid Bills Count chip). Drives the PDF export
  // button label/state — using the same source as `handlePdfExport`
  // ensures the count and the export result never disagree.
  const crFlaggedCount = useMemo(() => {
    let n = 0;
    for (const s of summaries) {
      for (const vp of s.bills) {
        if (getCrFlag(vp)) n += 1;
      }
    }
    return n;
  }, [summaries, getCrFlag]);

  const hasUnsavedDrafts = Object.keys(drafts).length > 0;

  // Drives the "Clear" filter-reset button's enabled state — true when
  // any row-level filter is narrowing the ledger.
  const hasActiveFilters =
    search.trim().length > 0 ||
    activeVendors.length > 0 ||
    invFrom !== null ||
    invTo !== null ||
    payFrom !== null ||
    payTo !== null ||
    paidFilter !== "all" ||
    unpaidCountFilter !== "all";

  function toggleVendor(v: string) {
    setActiveVendors((cur) =>
      cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v],
    );
  }

  function toggleExpanded(code: string) {
    setExpanded((cur) => ({ ...cur, [code]: !cur[code] }));
  }

  // Single draft writer — accepts a partial Draft patch. Falls back to
  // existing draft, then stored row, then defaults. When the merged
  // draft matches the stored row exactly, the draft entry is dropped
  // so "Save" doesn't keep firing for no-op edits.
  const writeDraft = useCallback(
    (vp: VendorPayment, patch: Partial<Draft>) => {
      setDrafts((cur) => {
        const existing: Draft = cur[vp.gidNo] ?? {
          mark: vp.markToPay ?? null,
          comments: vp.comments ?? "",
          crFlag: !!vp.crFlag,
          crNotes: vp.crNotes ?? "",
          chequeNo: vp.chequeNo ?? "",
          paidFlag: !!vp.paidFlag,
        };
        const updated: Draft = { ...existing, ...patch };
        const storedMark = vp.markToPay ?? null;
        const storedComments = vp.comments ?? "";
        const storedCrFlag = !!vp.crFlag;
        const storedCrNotes = vp.crNotes ?? "";
        const storedChequeNo = vp.chequeNo ?? "";
        const storedPaidFlag = !!vp.paidFlag;
        if (
          updated.mark === storedMark &&
          updated.comments === storedComments &&
          updated.crFlag === storedCrFlag &&
          updated.crNotes === storedCrNotes &&
          updated.chequeNo === storedChequeNo &&
          updated.paidFlag === storedPaidFlag
        ) {
          const { [vp.gidNo]: _, ...rest } = cur;
          return rest;
        }
        return { ...cur, [vp.gidNo]: updated };
      });
    },
    [],
  );

  const setRowMark = useCallback(
    (vp: VendorPayment, next: Mark) => writeDraft(vp, { mark: next }),
    [writeDraft],
  );
  const setRowComment = useCallback(
    (vp: VendorPayment, text: string) => writeDraft(vp, { comments: text }),
    [writeDraft],
  );
  const setRowCrFlag = useCallback(
    (vp: VendorPayment, next: boolean) => writeDraft(vp, { crFlag: next }),
    [writeDraft],
  );
  const setRowCrNotes = useCallback(
    (vp: VendorPayment, text: string) => writeDraft(vp, { crNotes: text }),
    [writeDraft],
  );
  const setRowChequeNo = useCallback(
    (vp: VendorPayment, text: string) => writeDraft(vp, { chequeNo: text }),
    [writeDraft],
  );
  const setRowPaidFlag = useCallback(
    (vp: VendorPayment, next: boolean) => writeDraft(vp, { paidFlag: next }),
    [writeDraft],
  );

  async function handleSaveDrafts() {
    if (!hasUnsavedDrafts || saving) return;
    setSaving(true);
    try {
      const merged: VendorPayment[] = vendorPayments.map((vp) => {
        const d = drafts[vp.gidNo];
        if (!d) return vp;
        return {
          ...vp,
          markToPay: d.mark,
          comments: d.comments,
          crFlag: d.crFlag,
          crNotes: d.crNotes,
          chequeNo: d.chequeNo,
          paidFlag: d.paidFlag,
        };
      });
      await saveVendorPaymentsBatch(merged);
      setDrafts({});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Couldn't Save", e?.message ?? "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  function handleToggleModify() {
    if (modifyMode && hasUnsavedDrafts) {
      const msg = `You have ${Object.keys(drafts).length} unsaved change${Object.keys(drafts).length === 1 ? "" : "s"}. Discard them?`;
      const run = () => {
        setDrafts({});
        setModifyMode(false);
      };
      if (Platform.OS === "web") {
        if (window.confirm(msg)) run();
      } else {
        Alert.alert("Discard changes?", msg, [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: run },
        ]);
      }
      return;
    }
    setModifyMode((v) => !v);
  }

  async function handleProcessPay() {
    if (exporting) return;
    // Respect the active filters (vendor, invoice/payment date, paid
    // status) by exporting from `filteredBills` rather than the whole
    // ledger, then keep only the rows the user marked to pay.
    const rows = filteredBills
      .filter((vp) => !!getMark(vp))
      .map((vp) => ({
        VendorName: vp.vendorName,
        InvoiceDate: vp.invoiceDate,
        InvoiceNo: vp.invoiceNo,
        "Supplier Payment": vp.supplierPayment ?? "",
        GRNDate: vp.grnDate,
        VendorCode: vp.vendorCode,
        GidNo: vp.gidNo,
        TranNo: vp.tranNo,
        ChequeNo: getChequeNo(vp),
        "Payment / Status": isPaid(vp) ? vp.paymentDate || "Paid" : "Unpaid",
        "Paid Flag": getPaidFlag(vp) ? "ON" : "OFF",
        "Mark to Pay": getMark(vp) ?? "",
        Comments: getComments(vp),
        "CR Flag": getCrFlag(vp) ? "ON" : "OFF",
        "CR Notes": getCrNotes(vp),
      }));
    if (rows.length === 0) {
      Alert.alert(
        "Nothing to export",
        'Mark at least one row (matching the current filters) as "Normal" or "Urgent" first.',
      );
      return;
    }
    setExporting(true);
    try {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [
        { wch: 32 },
        { wch: 12 },
        { wch: 16 },
        { wch: 14 },
        { wch: 12 },
        { wch: 12 },
        { wch: 12 },
        { wch: 14 },
        { wch: 14 },
        { wch: 16 },
        { wch: 10 },
        { wch: 12 },
        { wch: 30 },
        { wch: 8 },
        { wch: 30 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "PayToVendor");
      const d = new Date();
      const ts = `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
      const fileName = `SSS Pay to Vendor ${ts}.xls`;
      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, { bookType: "biff8", type: "array" });
        const blob = new Blob([wbout], { type: "application/vnd.ms-excel" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { bookType: "biff8", type: "base64" });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: "base64" as any,
        });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/vnd.ms-excel",
            dialogTitle: "Export Pay to Vendor",
            UTI: "com.microsoft.excel.xls",
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

  // "Payment Status" export — sends a vendor their payment details for
  // the current filter window. Exports every bill in `filteredBills`
  // (so it honours the vendor, invoice/payment date and All/Paid/Unpaid
  // filters) with its cheque number and Paid Flag, no Mark-to-Pay
  // requirement.
  async function handlePaymentStatusExport() {
    if (exportingStatus) return;
    const rows = filteredBills.map((vp) => ({
      VendorName: vp.vendorName,
      VendorCode: vp.vendorCode,
      GidNo: vp.gidNo,
      InvoiceNo: vp.invoiceNo,
      InvoiceDate: vp.invoiceDate,
      GRNDate: vp.grnDate,
      "Supplier Payment": vp.supplierPayment ?? "",
      TranNo: vp.tranNo,
      PaymentDate: vp.paymentDate,
      ChequeNo: getChequeNo(vp),
      "Paid Flag": getPaidFlag(vp) ? "ON" : "OFF",
      "Payment / Status": isPaid(vp) ? vp.paymentDate || "Paid" : "Unpaid",
    }));
    if (rows.length === 0) {
      Alert.alert(
        "Nothing to export",
        "No bills match the current filters. Adjust the filters and try again.",
      );
      return;
    }
    setExportingStatus(true);
    try {
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [
        { wch: 32 },
        { wch: 12 },
        { wch: 12 },
        { wch: 16 },
        { wch: 14 },
        { wch: 12 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
        { wch: 10 },
        { wch: 16 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "PaymentStatus");
      const d = new Date();
      const ts = `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
      const fileName = `SSS Payment Status ${ts}.xls`;
      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, { bookType: "biff8", type: "array" });
        const blob = new Blob([wbout], { type: "application/vnd.ms-excel" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { bookType: "biff8", type: "base64" });
        const fileUri = (FileSystem.cacheDirectory ?? "") + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: "base64" as any,
        });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/vnd.ms-excel",
            dialogTitle: "Export Payment Status",
            UTI: "com.microsoft.excel.xls",
          });
        } else {
          Alert.alert("Export saved", `File saved to: ${fileUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Export Failed", e?.message ?? "Unknown error");
    } finally {
      setExportingStatus(false);
    }
  }

  // Reset every row-level filter back to its default (no vendor, no
  // date ranges, paid status "All", search cleared, unpaid-count "All").
  // Distinct from `handleClear`, which deletes the whole ledger.
  function handleClearFilters() {
    setSearch("");
    setActiveVendors([]);
    setInvFrom(null);
    setInvTo(null);
    setPayFrom(null);
    setPayTo(null);
    setPaidFilter("all");
    setUnpaidCountFilter("all");
  }

  // Build the HTML body for one vendor's Credit Note PDF. Header,
  // table, and footer (supplier general notes + up-to-10 CR photos +
  // supplier/date lines) mirror the StockUpd PDF letterhead so the two
  // exports read as siblings. Only the title and the table columns
  // differ — this PDF lists the CR-flagged bills, not the order items.
  function buildCrPdfHtml(
    summary: VendorSummary,
    crBills: VendorPayment[],
  ): string {
    const supplier = supplierByCode.get(summary.vendorCode);
    const safePhotos = (supplier?.crPhotos ?? []).filter((p) =>
      PHOTO_URI_RE.test(p),
    );
    const photosHtml =
      safePhotos.length > 0
        ? `<div class="photos">${safePhotos
            .map((src) => `<img src="${src}" class="photo"/>`)
            .join("")}</div>`
        : "";
    const footerNotesRaw = (supplier?.generalNotes ?? "").trim();
    const footerNotesHtml = footerNotesRaw
      ? `<div class="footer-notes">${escapeHtml(footerNotesRaw).replace(/\r?\n/g, "<br/>")}</div>`
      : "";

    const cols = [
      "Invoice Date",
      "Invoice No",
      "GRN Date",
      "GidNo",
      "Supplier Pay",
      "Pay / Status",
      "CR Notes",
    ];
    const thCells = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const tdRows = crBills
      .map((vp, i) => {
        const bg = i % 2 === 0 ? "#ffffff" : "#f7f8fa";
        const status = isPaid(vp)
          ? vp.paymentDate || "Paid"
          : "Unpaid";
        const cells = [
          vp.invoiceDate || "",
          vp.invoiceNo || "",
          vp.grnDate || "",
          vp.gidNo || "",
          vp.supplierPayment != null ? fmtAmount(vp.supplierPayment) : "",
          status,
          getCrNotes(vp),
        ];
        const tds = cells.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("");
        return `<tr style="background:${bg}">${tds}</tr>`;
      })
      .join("");

    const exportDate = new Date().toLocaleDateString("en-IN");
    const totalCr = crBills.reduce(
      (s, vp) => s + (vp.supplierPayment ?? 0),
      0,
    );

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4 portrait; margin: 15mm 12mm; }
  body { font-family: Arial, sans-serif; font-size: 9pt; color: #111; }
  .letterhead { margin-bottom: 8px; }
  .letterhead .store { font-size: 13pt; font-weight: bold; }
  .letterhead .notice { font-size: 8pt; color: #c00; margin-top: 4px; }
  .right-block { float: right; text-align: center; }
  .form-label { font-size: 12pt; font-weight: bold; }
  .logo { width: 70px; margin-top: 6px; display: block; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  thead tr { background: #1a56db; color: #fff; }
  th, td { border: 1px solid #ccc; padding: 3px 5px; font-size: 8.5pt; }
  th { text-align: center; }
  td { text-align: left; }
  td:nth-child(5) { text-align: right; }
  .footer { margin-top: 10px; font-size: 8.5pt; }
  .footer-notes { margin-bottom: 4px; word-wrap: break-word; }
  .photos { margin: 6px 0 8px; display: flex; flex-direction: row; gap: 6px; flex-wrap: wrap; }
  .photo { width: 32%; max-height: 70mm; object-fit: contain; border: 1px solid #ccc; }
  .clearfix::after { content: ""; display: block; clear: both; }
  .total-line { margin-top: 6px; font-weight: bold; }
</style>
</head>
<body>
<div class="letterhead clearfix">
  <div class="right-block">
    <div class="form-label">CREDIT NOTE REQUIRED</div>
    <img src="${LOGO_BASE64}" class="logo" alt="Logo"/>
  </div>
  <div class="store">Sathyam Super Store</div>
  <div>2A, Mettupalayam Road, Cheran Nagar</div>
  <div>Coimbatore-641029</div>
  <div>98431-44868</div>
  <div>Whatsapp: 97881-44868</div>
  <div>Accounts: 97868-64868 For sharing Credit Notes, and Vendor payment enquiry</div>
  <div>GST# : 33ADFFS5244N1ZR</div>
  <div class="notice">*** CREDIT NOTE NEEDED FOR THE BILLS LISTED BELOW ***</div>
</div>
<table>
  <thead><tr>${thCells}</tr></thead>
  <tbody>${tdRows}</tbody>
</table>
<div class="footer">
  <div class="total-line">Total Flagged Amount : ${escapeHtml(fmtAmount(totalCr))}</div>
  ${footerNotesHtml}
  ${photosHtml}
  <div>Supplier : ${escapeHtml(summary.vendorName)} (${escapeHtml(summary.vendorCode)})</div>
  <div>Date : ${escapeHtml(exportDate)}</div>
</div>
</body>
</html>`;
  }

  // Generates one PDF per CR-flagged vendor in the currently filtered
  // bill set. On web each vendor opens in its own tab (popup-permission
  // dependent); on native each vendor triggers a sequential share sheet
  // so the user can route every PDF separately.
  async function handlePdfExport() {
    if (exportingPdf) return;
    // Build per-vendor groups from the currently filtered bill set,
    // keeping only bills with the CR Flag ON. A vendor lands in the
    // export only when at least one of their filtered bills is flagged.
    const vendorGroups: { summary: VendorSummary; crBills: VendorPayment[] }[] =
      [];
    for (const s of summaries) {
      const crBills = s.bills.filter((vp) => getCrFlag(vp));
      if (crBills.length > 0) vendorGroups.push({ summary: s, crBills });
    }
    if (vendorGroups.length === 0) {
      Alert.alert(
        "Nothing to export",
        "Turn on Supplier CR Flag for at least one bill that matches your current filters.",
      );
      return;
    }
    setExportingPdf(true);
    try {
      for (const { summary, crBills } of vendorGroups) {
        const html = buildCrPdfHtml(summary, crBills);
        const d = new Date();
        const ts = `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${String(
          d.getFullYear(),
        ).slice(-2)} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
        const vendorSeg = sanitizeFileNameSegment(summary.vendorName) ||
          sanitizeFileNameSegment(summary.vendorCode) ||
          "Vendor";
        const fileName = `Sathyam Super Store - ${vendorSeg} Credit Note Needed ${ts}.pdf`;

        if (Platform.OS === "web") {
          // Mirror the StockUpd web path: bypass expo-print and open
          // each PDF in its own tab so the user can save them
          // individually. Browsers may block the second+ window if
          // popups aren't allowed — surface a single helpful error.
          const titledHtml = html.replace(
            /<head>/i,
            `<head><title>${escapeHtml(fileName.replace(/\.pdf$/, ""))}</title>`,
          );
          const win = window.open("", "_blank");
          if (!win) {
            throw new Error(
              "Popup blocked. Please allow popups for this site to export Credit Note PDFs.",
            );
          }
          win.document.open();
          win.document.write(titledHtml);
          win.document.close();
          const triggerPrint = () => {
            try {
              win.focus();
              win.print();
            } catch {
              // Window may have been closed before print fired.
            }
          };
          if (win.document.readyState === "complete") {
            setTimeout(triggerPrint, 300);
          } else {
            win.addEventListener("load", () => setTimeout(triggerPrint, 300));
          }
        } else {
          const { uri: tmpUri } = await Print.printToFileAsync({ html });
          let shareUri = tmpUri;
          const cacheDir = FileSystem.cacheDirectory;
          if (cacheDir) {
            const targetUri = cacheDir + encodeURIComponent(fileName);
            try {
              await FileSystem.deleteAsync(targetUri, { idempotent: true });
              await FileSystem.copyAsync({ from: tmpUri, to: targetUri });
              shareUri = targetUri;
            } catch {
              shareUri = tmpUri;
            }
          }
          const canShare = await Sharing.isAvailableAsync();
          if (canShare) {
            // Sequential await so the user routes one share sheet
            // before the next vendor's PDF opens its own.
            await Sharing.shareAsync(shareUri, {
              mimeType: "application/pdf",
              dialogTitle: `Credit Note – ${summary.vendorName}`,
              UTI: "com.adobe.pdf",
            });
          } else {
            Alert.alert("PDF saved", `File saved to: ${shareUri}`);
          }
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("PDF Export Failed", e?.message ?? "Unknown error");
    } finally {
      setExportingPdf(false);
    }
  }

  function handleClear() {
    if (vendorPayments.length === 0) return;
    const msg = `Remove all ${vendorPayments.length} Vendor Payment${vendorPayments.length === 1 ? "" : "s"}? This cannot be undone.`;
    const run = async () => {
      try {
        await clearVendorPayments();
        setDrafts({});
        setModifyMode(false);
        setExpanded({});
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        Alert.alert("Couldn't Delete", e?.message ?? "Unknown error");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete All Vendor Payments?\n\n${msg}`)) void run();
    } else {
      Alert.alert("Delete All Vendor Payments?", msg, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void run() },
      ]);
    }
  }

  // Dense header card — title, action pills (Excel/CSV/PDF/Trash),
  // stat pills, paid filter, three filter chips, the new Unpaid Bills
  // Count chip strip, the Modify/Save/Process Pay/PDF row, the search
  // bar, and the result count.
  const ListHeader = (
    <View style={styles.headerCard}>
      <View style={styles.topRow}>
        <Text style={styles.title} numberOfLines={1}>
          Vendor Payments
        </Text>
        <View style={styles.topActions}>
          <TouchableOpacity
            style={[styles.actionPill, styles.actionPillExcel]}
            onPress={() => router.push("/vendor-payments/import")}
            activeOpacity={0.85}
          >
            <Feather name="upload" size={14} color={Colors.success} />
            <Text style={[styles.actionPillText, { color: Colors.success }]}>
              Excel
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionPill, styles.actionPillCsv]}
            onPress={() => router.push("/vendor-payments/import?format=csv")}
            activeOpacity={0.85}
          >
            <Feather name="file-text" size={14} color={Colors.info} />
            <Text style={[styles.actionPillText, { color: Colors.info }]}>
              CSV
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.iconSquare,
              styles.iconSquareDanger,
              vendorPayments.length === 0 && styles.iconSquareDisabled,
            ]}
            onPress={handleClear}
            disabled={vendorPayments.length === 0}
            activeOpacity={0.85}
          >
            <Feather
              name="trash-2"
              size={15}
              color={
                vendorPayments.length === 0 ? Colors.textMuted : Colors.danger
              }
            />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.statRow}
      >
        <StatPill
          label="Rows"
          value={String(vendorPayments.length)}
          color={Colors.text}
        />
        <StatPill
          label="Vendors"
          value={String(uniqueVendors)}
          color={Colors.primary}
        />
        <StatPill
          label="Unpaid"
          value={String(unpaidCount)}
          color={Colors.warning}
        />
        <StatPill
          label="Paid"
          value={String(vendorPayments.length - unpaidCount)}
          color={Colors.success}
        />
        <StatPill
          label="Marked"
          value={String(markedCount)}
          color={Colors.danger}
        />
        <StatPill
          label="CR Flag"
          value={String(crFlaggedCount)}
          color={Colors.info}
        />
        <StatPill label="Total" value={fmtAmount(totalPaid)} color={Colors.info} />
      </ScrollView>

      {vendorPayments.length > 0 && (
        <>
          <View style={styles.segWrap}>
            {(
              [
                { key: "all", label: "All" },
                { key: "unpaid", label: `Unpaid · ${unpaidCount}` },
                {
                  key: "paid",
                  label: `Paid · ${vendorPayments.length - unpaidCount}`,
                },
              ] as { key: PaidFilter; label: string }[]
            ).map((opt) => {
              const active = paidFilter === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.segBtn, active && styles.segBtnActive]}
                  onPress={() => setPaidFilter(opt.key)}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      styles.segBtnText,
                      active && styles.segBtnTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.chipRow}>
            <FilterChip
              icon="users"
              label={
                activeVendors.length === 0
                  ? "Vendors"
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
            <FilterChip
              icon="calendar"
              label={
                invFrom || invTo
                  ? `Inv ${invFrom ? formatDDMMYYYY(invFrom).slice(0, 5) : "*"}-${invTo ? formatDDMMYYYY(invTo).slice(0, 5) : "*"}`
                  : "Invoice Date"
              }
              active={!!(invFrom || invTo)}
              onPress={() => {
                const today = startOfDay(new Date());
                setInvFromDraft(invFrom ?? today);
                setInvToDraft(invTo ?? today);
                setShowInvFromPicker(false);
                setShowInvToPicker(false);
                setInvError(null);
                setShowInvModal(true);
              }}
              onClear={() => {
                setInvFrom(null);
                setInvTo(null);
              }}
            />
            <FilterChip
              icon="credit-card"
              label={
                payFrom || payTo
                  ? `Pay ${payFrom ? formatDDMMYYYY(payFrom).slice(0, 5) : "*"}-${payTo ? formatDDMMYYYY(payTo).slice(0, 5) : "*"}`
                  : "Payment Date"
              }
              active={!!(payFrom || payTo)}
              onPress={() => {
                const today = startOfDay(new Date());
                setPayFromDraft(payFrom ?? today);
                setPayToDraft(payTo ?? today);
                setShowPayFromPicker(false);
                setShowPayToPicker(false);
                setPayError(null);
                setShowPayModal(true);
              }}
              onClear={() => {
                setPayFrom(null);
                setPayTo(null);
              }}
            />
            <TouchableOpacity
              style={[
                styles.clearFiltersBtn,
                hasActiveFilters && styles.clearFiltersBtnActive,
              ]}
              onPress={handleClearFilters}
              disabled={!hasActiveFilters}
              activeOpacity={0.85}
            >
              <Feather
                name="x-circle"
                size={13}
                color={hasActiveFilters ? Colors.danger : Colors.textMuted}
              />
              <Text
                style={[
                  styles.clearFiltersText,
                  hasActiveFilters && styles.clearFiltersTextActive,
                ]}
              >
                Clear
              </Text>
            </TouchableOpacity>
          </View>

          {/* Unpaid Bills Count chip strip — preset buckets that drive
              the vendor-summary filter. "5+" covers the long tail. */}
          <View style={styles.unpaidChipsWrap}>
            <Text style={styles.unpaidChipsLabel}>Unpaid Bills</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.unpaidChipsRow}
            >
              {UNPAID_COUNT_FILTERS.map((opt) => {
                const active = unpaidCountFilter === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[
                      styles.unpaidChip,
                      active && styles.unpaidChipActive,
                    ]}
                    onPress={() => setUnpaidCountFilter(opt.key)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.unpaidChipText,
                        active && styles.unpaidChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[
                styles.actionBtn,
                modifyMode ? styles.actionBtnModifyOn : styles.actionBtnModify,
              ]}
              onPress={handleToggleModify}
              activeOpacity={0.85}
            >
              <Feather
                name={modifyMode ? "check" : "edit-3"}
                size={14}
                color={modifyMode ? Colors.textInverse : Colors.primary}
              />
              <Text
                style={[
                  styles.actionBtnText,
                  {
                    color: modifyMode ? Colors.textInverse : Colors.primary,
                  },
                ]}
              >
                {modifyMode ? "Done" : "Modify"}
              </Text>
            </TouchableOpacity>
            {modifyMode && (
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  hasUnsavedDrafts
                    ? styles.actionBtnSaveOn
                    : styles.actionBtnDisabled,
                ]}
                onPress={handleSaveDrafts}
                disabled={!hasUnsavedDrafts || saving}
                activeOpacity={0.85}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={Colors.textInverse} />
                ) : (
                  <Feather
                    name="save"
                    size={14}
                    color={
                      hasUnsavedDrafts ? Colors.textInverse : Colors.textMuted
                    }
                  />
                )}
                <Text
                  style={[
                    styles.actionBtnText,
                    {
                      color: hasUnsavedDrafts
                        ? Colors.textInverse
                        : Colors.textMuted,
                    },
                  ]}
                >
                  {hasUnsavedDrafts
                    ? `Save · ${Object.keys(drafts).length}`
                    : "Save"}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[
                styles.actionBtn,
                markedCount > 0
                  ? styles.actionBtnExportOn
                  : styles.actionBtnDisabled,
              ]}
              onPress={handleProcessPay}
              disabled={markedCount === 0 || exporting}
              activeOpacity={0.85}
            >
              {exporting ? (
                <ActivityIndicator size="small" color={Colors.textInverse} />
              ) : (
                <Feather
                  name="download"
                  size={14}
                  color={
                    markedCount > 0 ? Colors.textInverse : Colors.textMuted
                  }
                />
              )}
              <Text
                style={[
                  styles.actionBtnText,
                  {
                    color:
                      markedCount > 0 ? Colors.textInverse : Colors.textMuted,
                  },
                ]}
              >
                {markedCount > 0 ? `Process Pay · ${markedCount}` : "Process Pay"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionBtn,
                filteredBills.length > 0
                  ? styles.actionBtnStatusOn
                  : styles.actionBtnDisabled,
              ]}
              onPress={handlePaymentStatusExport}
              disabled={filteredBills.length === 0 || exportingStatus}
              activeOpacity={0.85}
            >
              {exportingStatus ? (
                <ActivityIndicator size="small" color={Colors.textInverse} />
              ) : (
                <Feather
                  name="file-plus"
                  size={14}
                  color={
                    filteredBills.length > 0
                      ? Colors.textInverse
                      : Colors.textMuted
                  }
                />
              )}
              <Text
                style={[
                  styles.actionBtnText,
                  {
                    color:
                      filteredBills.length > 0
                        ? Colors.textInverse
                        : Colors.textMuted,
                  },
                ]}
              >
                {filteredBills.length > 0
                  ? `Payment Status · ${filteredBills.length}`
                  : "Payment Status"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionBtn,
                crFlaggedCount > 0
                  ? styles.actionBtnPdfOn
                  : styles.actionBtnDisabled,
              ]}
              onPress={handlePdfExport}
              disabled={crFlaggedCount === 0 || exportingPdf}
              activeOpacity={0.85}
            >
              {exportingPdf ? (
                <ActivityIndicator size="small" color={Colors.textInverse} />
              ) : (
                <Feather
                  name="file-text"
                  size={14}
                  color={
                    crFlaggedCount > 0 ? Colors.textInverse : Colors.textMuted
                  }
                />
              )}
              <Text
                style={[
                  styles.actionBtnText,
                  {
                    color:
                      crFlaggedCount > 0
                        ? Colors.textInverse
                        : Colors.textMuted,
                  },
                ]}
              >
                {crFlaggedCount > 0
                  ? `CR PDF · ${crFlaggedCount}`
                  : "CR PDF"}
              </Text>
            </TouchableOpacity>
          </View>

          <View
            style={[
              styles.searchWrap,
              search.length > 0 && styles.searchWrapActive,
            ]}
          >
            <Feather
              name="search"
              size={14}
              color={search.length > 0 ? Colors.primary : Colors.textMuted}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search VendorCode or VendorName…"
              placeholderTextColor={Colors.textMuted}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch("")}>
                <Feather name="x" size={14} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.resultCount}>
            Showing{" "}
            <Text style={styles.resultCountStrong}>{summaries.length}</Text> of{" "}
            {uniqueVendors} vendors · {filteredBills.length} bills
            {paidFilter !== "all" ? ` · ${paidFilter}` : ""}
            {unpaidCountFilter !== "all"
              ? ` · unpaid ${unpaidCountFilter}`
              : ""}
            {crFlaggedCount > 0 ? ` · ${crFlaggedCount} CR` : ""}
          </Text>
        </>
      )}
    </View>
  );

  // One row in the vendor-summary table. Tap the row to expand and
  // see/edit each individual bill (CR Flag toggle + CR Notes input live
  // here in Modify mode). The expanded section also exposes a "Manage
  // CR Photos" button that opens the SupplierPhotosBox modal — photos
  // are scoped to the matched Supplier (by vendorCode); when no
  // supplier record exists, the button explains why.
  const renderVendorRow = useCallback(
    (s: VendorSummary, i: number) => {
      const isOpen = !!expanded[s.vendorCode];
      const supplier = supplierByCode.get(s.vendorCode);
      const crPhotoCount = (supplier?.crPhotos ?? []).filter((p) =>
        PHOTO_URI_RE.test(p),
      ).length;
      return (
        <View
          key={s.vendorCode}
          style={[
            styles.vendorRowWrap,
            i % 2 === 0 && styles.vendorRowAlt,
            s.unpaidCount > 0 && styles.vendorRowHasUnpaid,
            s.crFlagCount > 0 && styles.vendorRowHasCr,
          ]}
        >
          <TouchableOpacity
            style={styles.vendorRow}
            onPress={() => toggleExpanded(s.vendorCode)}
            activeOpacity={0.7}
          >
            <Feather
              name={isOpen ? "chevron-down" : "chevron-right"}
              size={16}
              color={Colors.textMuted}
            />
            <View style={styles.vendorRowMain}>
              <Text style={styles.vendorRowName} numberOfLines={2}>
                {s.vendorName}
              </Text>
              <Text style={styles.vendorRowCode}>{s.vendorCode}</Text>
            </View>
            <View style={styles.vendorRowStats}>
              <View
                style={[
                  styles.miniStat,
                  s.unpaidCount > 0 && styles.miniStatUnpaid,
                ]}
              >
                <Text
                  style={[
                    styles.miniStatValue,
                    s.unpaidCount > 0 && styles.miniStatValueUnpaid,
                  ]}
                >
                  {s.unpaidCount}
                </Text>
                <Text style={styles.miniStatLabel}>Unpaid</Text>
              </View>
              <View style={styles.miniStat}>
                <Text style={styles.miniStatValue}>{s.totalBills}</Text>
                <Text style={styles.miniStatLabel}>Bills</Text>
              </View>
              <View style={styles.miniStat}>
                <Text style={styles.miniStatValueAmount}>
                  {fmtAmount(s.totalPay)}
                </Text>
                <Text style={styles.miniStatLabel}>Total</Text>
              </View>
              {s.crFlagCount > 0 && (
                <View style={[styles.miniStat, styles.miniStatCr]}>
                  <Text style={styles.miniStatValueCr}>{s.crFlagCount}</Text>
                  <Text style={styles.miniStatLabel}>CR</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>

          {isOpen && (
            <View style={styles.expandedPanel}>
              <View style={styles.expandedActions}>
                <TouchableOpacity
                  style={[
                    styles.crPhotosBtn,
                    !supplier && styles.crPhotosBtnDisabled,
                  ]}
                  onPress={() => {
                    if (!supplier) {
                      Alert.alert(
                        "No supplier record",
                        `No supplier exists for vendor code "${s.vendorCode}". Add this supplier first to attach Credit Note photos.`,
                      );
                      return;
                    }
                    setCrPhotoSupplier(supplier);
                  }}
                  activeOpacity={0.8}
                >
                  <Feather
                    name="camera"
                    size={13}
                    color={supplier ? Colors.primary : Colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.crPhotosBtnText,
                      !supplier && { color: Colors.textMuted },
                    ]}
                  >
                    CR Photos · {crPhotoCount}/10
                  </Text>
                </TouchableOpacity>
              </View>

              {s.bills.map((vp) => {
                const paid = isPaid(vp);
                const mark = getMark(vp);
                const crFlag = getCrFlag(vp);
                const crNotes = getCrNotes(vp);
                const comments = getComments(vp);
                const paidFlag = getPaidFlag(vp);
                const chequeNo = getChequeNo(vp);
                return (
                  <View
                    key={vp.gidNo}
                    style={[
                      styles.billCard,
                      !paid && styles.billCardUnpaid,
                      crFlag && styles.billCardCr,
                    ]}
                  >
                    <View style={styles.billHead}>
                      <Text style={styles.billHeadDate}>
                        {vp.invoiceDate || "—"}
                      </Text>
                      <Text style={styles.billHeadInv} numberOfLines={1}>
                        #{vp.invoiceNo || "—"}
                      </Text>
                      <Text style={styles.billHeadAmt} numberOfLines={1}>
                        {fmtAmount(vp.supplierPayment)}
                      </Text>
                      {paid ? (
                        <View style={styles.paidBadge}>
                          <Text style={styles.paidBadgeText}>
                            {vp.paymentDate || "PAID"}
                          </Text>
                        </View>
                      ) : (
                        <View style={styles.unpaidBadge}>
                          <Feather
                            name="alert-circle"
                            size={10}
                            color={Colors.warning}
                          />
                          <Text style={styles.unpaidBadgeText}>UNPAID</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.billMeta}>
                      <Text style={styles.billMetaItem}>
                        GidNo: {vp.gidNo || "—"}
                      </Text>
                      <Text style={styles.billMetaItem}>
                        GRN: {vp.grnDate || "—"}
                      </Text>
                      <Text style={styles.billMetaItem} numberOfLines={1}>
                        TranNo: {vp.tranNo || "—"}
                      </Text>
                    </View>

                    {modifyMode ? (
                      <View style={styles.billEdit}>
                        <View style={styles.billEditRow}>
                          <Text style={styles.billEditLabel}>Mark</Text>
                          <MarkPicker
                            value={mark}
                            onChange={(next) => setRowMark(vp, next)}
                          />
                        </View>
                        <View style={styles.billEditRow}>
                          <View style={styles.flagGroup}>
                            <Text style={styles.billEditLabelInline}>
                              CR Flag
                            </Text>
                            <TouchableOpacity
                              style={[
                                styles.crToggle,
                                crFlag
                                  ? styles.crToggleOn
                                  : styles.crToggleOff,
                              ]}
                              onPress={() => setRowCrFlag(vp, !crFlag)}
                              activeOpacity={0.8}
                            >
                              <View
                                style={[
                                  styles.crToggleKnob,
                                  crFlag && styles.crToggleKnobOn,
                                ]}
                              />
                              <Text
                                style={[
                                  styles.crToggleText,
                                  crFlag && styles.crToggleTextOn,
                                ]}
                              >
                                {crFlag ? "ON" : "OFF"}
                              </Text>
                            </TouchableOpacity>
                          </View>
                          <View style={styles.flagGroup}>
                            <Text style={styles.billEditLabelInline}>
                              Paid Flag
                            </Text>
                            <TouchableOpacity
                              style={[
                                styles.crToggle,
                                paidFlag
                                  ? styles.paidToggleOn
                                  : styles.crToggleOff,
                              ]}
                              onPress={() => setRowPaidFlag(vp, !paidFlag)}
                              activeOpacity={0.8}
                            >
                              <View
                                style={[
                                  styles.crToggleKnob,
                                  paidFlag && styles.crToggleKnobOn,
                                ]}
                              />
                              <Text
                                style={[
                                  styles.crToggleText,
                                  paidFlag && styles.crToggleTextOn,
                                ]}
                              >
                                {paidFlag ? "ON" : "OFF"}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                        <View style={styles.billEditRow}>
                          <Text style={styles.billEditLabel}>Cheque No</Text>
                          <TextInput
                            style={styles.chequeInput}
                            value={chequeNo}
                            onChangeText={(t) => setRowChequeNo(vp, t)}
                            placeholder="Cheque number…"
                            placeholderTextColor={Colors.textMuted}
                            autoCapitalize="characters"
                            autoCorrect={false}
                          />
                        </View>
                        <View style={styles.billEditCol}>
                          <Text style={styles.billEditLabel}>Comments</Text>
                          <TextInput
                            style={styles.commentInput}
                            value={comments}
                            onChangeText={(t) => setRowComment(vp, t)}
                            placeholder="Add a note…"
                            placeholderTextColor={Colors.textMuted}
                            multiline
                          />
                        </View>
                        <View style={styles.billEditCol}>
                          <Text style={styles.billEditLabel}>
                            Supplier Notes (CR)
                          </Text>
                          <TextInput
                            style={styles.commentInput}
                            value={crNotes}
                            onChangeText={(t) => setRowCrNotes(vp, t)}
                            placeholder="Why a credit note is needed…"
                            placeholderTextColor={Colors.textMuted}
                            multiline
                          />
                        </View>
                      </View>
                    ) : (
                      <View style={styles.billView}>
                        {mark && <MarkBadge mark={mark} />}
                        {crFlag && (
                          <View style={styles.crBadge}>
                            <Feather
                              name="flag"
                              size={9}
                              color={Colors.textInverse}
                            />
                            <Text style={styles.crBadgeText}>CR</Text>
                          </View>
                        )}
                        {paidFlag && (
                          <View style={styles.paidFlagBadge}>
                            <Feather
                              name="check"
                              size={9}
                              color={Colors.textInverse}
                            />
                            <Text style={styles.crBadgeText}>PAID</Text>
                          </View>
                        )}
                        {chequeNo.length > 0 && (
                          <Text style={styles.chequeInline} numberOfLines={1}>
                            Cheque: {chequeNo}
                          </Text>
                        )}
                        {comments.length > 0 && (
                          <Text style={styles.commentInline} numberOfLines={2}>
                            {comments}
                          </Text>
                        )}
                        {crNotes.length > 0 && (
                          <Text style={styles.crNotesInline} numberOfLines={3}>
                            CR: {crNotes}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      );
    },
    [
      expanded,
      modifyMode,
      supplierByCode,
      getMark,
      getCrFlag,
      getCrNotes,
      getComments,
      getPaidFlag,
      getChequeNo,
      setRowMark,
      setRowComment,
      setRowCrFlag,
      setRowCrNotes,
      setRowPaidFlag,
      setRowChequeNo,
    ],
  );

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      {vendorPayments.length === 0 ? (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingBottom: insets.bottom + 100,
          }}
        >
          {ListHeader}
          <View style={styles.emptyCard}>
            <Feather name="inbox" size={32} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No Vendor Payments yet</Text>
            <Text style={styles.emptyHint}>
              Import an Excel or CSV file to populate the ledger.
            </Text>
            <View style={styles.emptyActions}>
              <TouchableOpacity
                style={[styles.primaryBtn]}
                onPress={() => router.push("/vendor-payments/import")}
                activeOpacity={0.85}
              >
                <Feather name="upload" size={16} color={Colors.textInverse} />
                <Text style={styles.primaryBtnText}>Import Excel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() =>
                  router.push("/vendor-payments/import?format=csv")
                }
                activeOpacity={0.85}
              >
                <Feather name="file-text" size={16} color={Colors.info} />
                <Text style={styles.secondaryBtnText}>Import CSV</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 12,
            paddingBottom: insets.bottom + 100,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {ListHeader}
          <View style={styles.tableCard}>
            {summaries.length === 0 ? (
              <View style={styles.tableEmpty}>
                <Feather name="search" size={18} color={Colors.textMuted} />
                <Text style={styles.tableEmptyText}>
                  No vendors match your filters.
                </Text>
              </View>
            ) : (
              summaries.map((s, i) => renderVendorRow(s, i))
            )}
          </View>
        </ScrollView>
      )}

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
        <View
          style={[
            styles.modalSheet,
            { paddingBottom: insets.bottom + 16, maxHeight: "75%" },
          ]}
        >
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter by Vendor</Text>
            <TouchableOpacity onPress={() => setActiveVendors([])}>
              <Text style={styles.modalClear}>Clear</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.modalSearchWrap}>
            <Feather name="search" size={14} color={Colors.textMuted} />
            <TextInput
              style={styles.modalSearchInput}
              placeholder="Search vendors…"
              placeholderTextColor={Colors.textMuted}
              value={vendorSearch}
              onChangeText={setVendorSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {vendorSearch.length > 0 && (
              <TouchableOpacity onPress={() => setVendorSearch("")}>
                <Feather name="x" size={14} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
          <FlatList
            data={filteredVendors}
            keyExtractor={(v) => v}
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}
            ListEmptyComponent={
              <View style={styles.modalEmpty}>
                <Feather name="users" size={28} color={Colors.textMuted} />
                <Text style={styles.modalEmptyText}>No vendors found</Text>
              </View>
            }
            renderItem={({ item }) => {
              const checked = activeVendors.includes(item);
              return (
                <TouchableOpacity
                  style={styles.checkRow}
                  onPress={() => toggleVendor(item)}
                  activeOpacity={0.7}
                >
                  <View
                    style={[styles.checkBox, checked && styles.checkBoxOn]}
                  >
                    {checked && (
                      <Feather
                        name="check"
                        size={12}
                        color={Colors.textInverse}
                      />
                    )}
                  </View>
                  <Text style={styles.checkText} numberOfLines={1}>
                    {item}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => setShowVendorModal(false)}
          >
            <Text style={styles.modalDoneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Credit Note photos editor — opens when the user taps the
          "CR Photos" button inside an expanded vendor row. Reuses the
          SupplierPhotosBox component but writes through the dedicated
          setSupplierCrPhotos setter so the StockUpd / My Orders photo
          pool stays untouched. */}
      <Modal
        visible={crPhotoSupplier !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setCrPhotoSupplier(null)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setCrPhotoSupplier(null)}
        />
        <View
          style={[
            styles.modalSheet,
            { paddingBottom: insets.bottom + 16, maxHeight: "75%" },
          ]}
        >
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              CR Photos · {crPhotoSupplier?.vendorCode}
            </Text>
            <TouchableOpacity onPress={() => setCrPhotoSupplier(null)}>
              <Text style={[styles.modalClear, { color: Colors.primary }]}>
                Done
              </Text>
            </TouchableOpacity>
          </View>
          <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
            <Text style={styles.crPhotosHelp}>
              These photos appear only on the Credit Note PDF export — kept
              separate from the supplier&apos;s order-form photo set.
            </Text>
            {crPhotoSupplier && (
              <SupplierPhotosBox
                supplier={crPhotoSupplier}
                photos={crPhotoSupplier.crPhotos ?? []}
                onChange={async (next) => {
                  await setSupplierCrPhotos(crPhotoSupplier.id, next);
                  // Keep the modal supplier in sync so the count + tiles
                  // refresh without closing the sheet.
                  setCrPhotoSupplier({ ...crPhotoSupplier, crPhotos: next });
                }}
              />
            )}
          </View>
        </View>
      </Modal>

      <DateRangeModal
        visible={showInvModal}
        title="Invoice Date"
        fromDraft={invFromDraft}
        toDraft={invToDraft}
        showFromPicker={showInvFromPicker}
        showToPicker={showInvToPicker}
        error={invError}
        bottomInset={insets.bottom}
        onTapFrom={() => {
          setShowInvToPicker(false);
          setShowInvFromPicker((v) => !v);
          setInvError(null);
        }}
        onTapTo={() => {
          setShowInvFromPicker(false);
          setShowInvToPicker((v) => !v);
          setInvError(null);
        }}
        onChangeFrom={(d) => {
          if (Platform.OS !== "ios") setShowInvFromPicker(false);
          if (d) {
            setInvFromDraft(startOfDay(d));
            setInvError(null);
          }
        }}
        onChangeTo={(d) => {
          if (Platform.OS !== "ios") setShowInvToPicker(false);
          if (d) {
            setInvToDraft(startOfDay(d));
            setInvError(null);
          }
        }}
        onClear={() => {
          const today = startOfDay(new Date());
          setInvFromDraft(today);
          setInvToDraft(today);
          setInvFrom(null);
          setInvTo(null);
          setShowInvFromPicker(false);
          setShowInvToPicker(false);
          setInvError(null);
        }}
        onApply={() => {
          const from = startOfDay(invFromDraft);
          const to = startOfDay(invToDraft);
          if (from.getTime() > to.getTime()) {
            setInvError("From date can't be after To date.");
            return;
          }
          setInvFrom(from);
          setInvTo(to);
          setShowInvFromPicker(false);
          setShowInvToPicker(false);
          setInvError(null);
          setShowInvModal(false);
        }}
        onClose={() => setShowInvModal(false)}
      />

      <DateRangeModal
        visible={showPayModal}
        title="Payment Date"
        fromDraft={payFromDraft}
        toDraft={payToDraft}
        showFromPicker={showPayFromPicker}
        showToPicker={showPayToPicker}
        error={payError}
        bottomInset={insets.bottom}
        onTapFrom={() => {
          setShowPayToPicker(false);
          setShowPayFromPicker((v) => !v);
          setPayError(null);
        }}
        onTapTo={() => {
          setShowPayFromPicker(false);
          setShowPayToPicker((v) => !v);
          setPayError(null);
        }}
        onChangeFrom={(d) => {
          if (Platform.OS !== "ios") setShowPayFromPicker(false);
          if (d) {
            setPayFromDraft(startOfDay(d));
            setPayError(null);
          }
        }}
        onChangeTo={(d) => {
          if (Platform.OS !== "ios") setShowPayToPicker(false);
          if (d) {
            setPayToDraft(startOfDay(d));
            setPayError(null);
          }
        }}
        onClear={() => {
          const today = startOfDay(new Date());
          setPayFromDraft(today);
          setPayToDraft(today);
          setPayFrom(null);
          setPayTo(null);
          setShowPayFromPicker(false);
          setShowPayToPicker(false);
          setPayError(null);
        }}
        onApply={() => {
          const from = startOfDay(payFromDraft);
          const to = startOfDay(payToDraft);
          if (from.getTime() > to.getTime()) {
            setPayError("From date can't be after To date.");
            return;
          }
          setPayFrom(from);
          setPayTo(to);
          setShowPayFromPicker(false);
          setShowPayToPicker(false);
          setPayError(null);
          setShowPayModal(false);
        }}
        onClose={() => setShowPayModal(false)}
      />
    </View>
  );
}
// ---------- Reusable bits ----------

function StatPill({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <View style={styles.statPill}>
      <Text style={[styles.statPillValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statPillLabel}>{label}</Text>
    </View>
  );
}

function MarkPicker({
  value,
  onChange,
}: {
  value: Mark;
  onChange: (next: Mark) => void;
}) {
  return (
    <View style={styles.markPicker}>
      <TouchableOpacity
        style={[styles.markBtn, value === null && styles.markBtnOffActive]}
        onPress={() => onChange(null)}
        activeOpacity={0.8}
      >
        <Text
          style={[
            styles.markBtnText,
            { color: value === null ? Colors.text : Colors.textMuted },
          ]}
        >
          —
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.markBtn,
          value === "Normal" && styles.markBtnNormalActive,
        ]}
        onPress={() => onChange("Normal")}
        activeOpacity={0.8}
      >
        <Text
          style={[
            styles.markBtnText,
            {
              color:
                value === "Normal" ? Colors.textInverse : Colors.primaryLight,
            },
          ]}
        >
          Normal
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.markBtn,
          value === "Urgent" && styles.markBtnUrgentActive,
        ]}
        onPress={() => onChange("Urgent")}
        activeOpacity={0.8}
      >
        <Text
          style={[
            styles.markBtnText,
            {
              color: value === "Urgent" ? Colors.textInverse : Colors.danger,
            },
          ]}
        >
          Urgent
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function MarkBadge({ mark }: { mark: Exclude<Mark, null> }) {
  const isUrgent = mark === "Urgent";
  return (
    <View
      style={[
        styles.markBadge,
        isUrgent ? styles.markBadgeUrgent : styles.markBadgeNormal,
      ]}
    >
      <Text style={styles.markBadgeText}>{mark.toUpperCase()}</Text>
    </View>
  );
}

type FilterChipProps = {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  active: boolean;
  onPress: () => void;
  onClear: () => void;
};
function FilterChip({
  icon,
  label,
  active,
  onPress,
  onClear,
}: FilterChipProps) {
  return (
    <TouchableOpacity
      style={[styles.filterBar, active && styles.filterBarActive]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Feather
        name={icon}
        size={13}
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
          onPress={(e) => {
            e.stopPropagation?.();
            onClear();
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="x-circle" size={14} color={Colors.textInverse} />
        </TouchableOpacity>
      ) : (
        <Feather name="chevron-down" size={13} color={Colors.textMuted} />
      )}
    </TouchableOpacity>
  );
}

type DateRangeModalProps = {
  visible: boolean;
  title: string;
  fromDraft: Date;
  toDraft: Date;
  showFromPicker: boolean;
  showToPicker: boolean;
  error: string | null;
  bottomInset: number;
  onTapFrom: () => void;
  onTapTo: () => void;
  onChangeFrom: (d: Date | undefined) => void;
  onChangeTo: (d: Date | undefined) => void;
  onClear: () => void;
  onApply: () => void;
  onClose: () => void;
};
function DateRangeModal({
  visible,
  title,
  fromDraft,
  toDraft,
  showFromPicker,
  showToPicker,
  error,
  bottomInset,
  onTapFrom,
  onTapTo,
  onChangeFrom,
  onChangeTo,
  onClear,
  onApply,
  onClose,
}: DateRangeModalProps) {
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
          <TouchableOpacity onPress={onClear}>
            <Text style={styles.modalClear}>Clear</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.dateRangeWrap}>
          <View style={styles.dateRangeField}>
            <Text style={styles.dateRangeLabel}>From</Text>
            <TouchableOpacity
              style={styles.dateRangeButton}
              onPress={onTapFrom}
            >
              <Feather name="calendar" size={14} color={Colors.primary} />
              <Text style={styles.dateRangeButtonText}>
                {formatDDMMYYYY(fromDraft)}
              </Text>
            </TouchableOpacity>
            {showFromPicker && (
              <DateTimePicker
                value={fromDraft}
                mode="date"
                display={Platform.OS === "ios" ? "inline" : "default"}
                onChange={(_e, selected) => onChangeFrom(selected)}
              />
            )}
          </View>
          <View style={styles.dateRangeField}>
            <Text style={styles.dateRangeLabel}>To</Text>
            <TouchableOpacity style={styles.dateRangeButton} onPress={onTapTo}>
              <Feather name="calendar" size={14} color={Colors.primary} />
              <Text style={styles.dateRangeButtonText}>
                {formatDDMMYYYY(toDraft)}
              </Text>
            </TouchableOpacity>
            {showToPicker && (
              <DateTimePicker
                value={toDraft}
                mode="date"
                display={Platform.OS === "ios" ? "inline" : "default"}
                onChange={(_e, selected) => onChangeTo(selected)}
              />
            )}
          </View>
        </View>
        {error && <Text style={styles.dateRangeError}>{error}</Text>}
        <TouchableOpacity style={styles.modalDoneBtn} onPress={onApply}>
          <Text style={styles.modalDoneBtnText}>Apply</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  // Single dense card holding title + stats + filters + actions +
  // search. Sits at the top of the FlatList so vertical scroll
  // moves it out of the way and gives the table the full screen.
  headerCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 10,
    gap: 8,
    marginTop: 10,
    marginBottom: 10,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 19,
    fontWeight: "800",
    color: Colors.text,
    letterSpacing: -0.3,
  },
  topActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  actionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionPillExcel: {
    backgroundColor: Colors.successLight,
    borderColor: Colors.success + "40",
  },
  actionPillCsv: {
    backgroundColor: Colors.infoLight,
    borderColor: Colors.info + "40",
  },
  actionPillText: { fontSize: 12, fontWeight: "700" },
  iconSquare: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  iconSquareDanger: {
    backgroundColor: Colors.dangerLight,
    borderColor: Colors.danger + "40",
  },
  iconSquareDisabled: {
    backgroundColor: Colors.background,
    borderColor: Colors.border,
  },

  // Compact horizontally-scrolling stats
  statRow: { gap: 6, paddingVertical: 2 },
  statPill: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    minWidth: 70,
    alignItems: "center",
  },
  statPillValue: { fontSize: 14, fontWeight: "800", marginBottom: 1 },
  statPillLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },

  // Paid/Unpaid segmented control
  segWrap: {
    flexDirection: "row",
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 7,
    alignItems: "center",
    backgroundColor: "transparent",
  },
  segBtnActive: { backgroundColor: Colors.primary },
  segBtnText: { fontSize: 11, fontWeight: "700", color: Colors.textSecondary },
  segBtnTextActive: { color: Colors.textInverse },

  // 3 filter chips in a single dense row
  chipRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  clearFiltersBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: Colors.surfaceSecondary,
    borderColor: Colors.border,
  },
  clearFiltersBtnActive: {
    backgroundColor: Colors.danger + "12",
    borderColor: Colors.danger,
  },
  clearFiltersText: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
  },
  clearFiltersTextActive: { color: Colors.danger },
  filterBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    minWidth: 0,
  },
  filterBarActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterBarText: {
    flex: 1,
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  filterBarTextActive: { color: Colors.textInverse },

  // Modify / Save / Process Pay
  actionRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  actionBtn: {
    flex: 1,
    minWidth: 110,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionBtnText: { fontSize: 12, fontWeight: "700" },
  actionBtnModify: {
    backgroundColor: Colors.primaryMuted,
    borderColor: Colors.primary + "30",
  },
  actionBtnModifyOn: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  actionBtnSaveOn: {
    backgroundColor: Colors.success,
    borderColor: Colors.success,
  },
  actionBtnExportOn: {
    backgroundColor: Colors.warning,
    borderColor: Colors.warning,
  },
  actionBtnStatusOn: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  actionBtnDisabled: {
    backgroundColor: Colors.surfaceSecondary,
    borderColor: Colors.border,
  },

  // Search bar
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  searchWrapActive: { borderColor: Colors.primary },
  searchInput: { flex: 1, fontSize: 12, color: Colors.text, padding: 0 },
  resultCount: {
    fontSize: 11,
    color: Colors.textMuted,
    fontWeight: "600",
    paddingHorizontal: 2,
  },
  resultCountStrong: { color: Colors.text, fontWeight: "800" },

  // Table card wraps the wide column header and rows so the inner
  // horizontal scroller has a clean rounded border to live inside.
  tableCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 8,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    backgroundColor: Colors.surface,
    gap: 8,
  },
  tableRowAlt: { backgroundColor: Colors.surfaceSecondary },
  tableRowUnpaid: { backgroundColor: Colors.warningLight },
  tableRowNormal: { backgroundColor: Colors.infoLight },
  tableRowUrgent: { backgroundColor: Colors.dangerLight },
  th: { fontSize: 10, fontWeight: "800", color: Colors.textMuted, letterSpacing: 0.3, textTransform: "uppercase" },
  td: { fontSize: 12, color: Colors.text },
  tdName: { fontWeight: "700", fontSize: 12, color: Colors.text },
  tableEmpty: {
    padding: 24,
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    borderTopWidth: 0,
  },
  tableEmptyText: { fontSize: 13, color: Colors.textMuted },
  unpaidBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.warning + "22",
    borderColor: Colors.warning,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  unpaidBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: Colors.warning,
    letterSpacing: 0.3,
  },

  // Mark-to-Pay picker in Modify mode
  markPicker: { flexDirection: "row", gap: 3 },
  markBtn: {
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    minWidth: 28,
    alignItems: "center",
  },
  markBtnText: { fontSize: 10, fontWeight: "800" },
  markBtnOffActive: {
    backgroundColor: Colors.surfaceSecondary,
    borderColor: Colors.textMuted,
  },
  markBtnNormalActive: {
    backgroundColor: Colors.primaryLight,
    borderColor: Colors.primaryLight,
  },
  markBtnUrgentActive: {
    backgroundColor: Colors.danger,
    borderColor: Colors.danger,
  },
  markBadge: {
    alignSelf: "flex-start",
    marginTop: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  markBadgeNormal: { backgroundColor: Colors.primaryLight },
  markBadgeUrgent: { backgroundColor: Colors.danger },
  markBadgeText: {
    fontSize: 8,
    fontWeight: "800",
    color: Colors.textInverse,
    letterSpacing: 0.5,
  },
  commentInline: {
    marginTop: 3,
    fontSize: 10,
    color: Colors.textSecondary,
    fontStyle: "italic",
  },
  commentInput: {
    fontSize: 11,
    color: Colors.text,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    minHeight: 30,
    textAlignVertical: "top",
  },

  // Empty state (no imports yet)
  emptyCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 28,
    alignItems: "center",
    gap: 10,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  emptyHint: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    marginBottom: 8,
  },
  emptyActions: { flexDirection: "row", gap: 10 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.textInverse,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.infoLight,
    borderWidth: 1,
    borderColor: Colors.info + "30",
  },
  secondaryBtnText: { fontSize: 14, fontWeight: "700", color: Colors.info },

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
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modalSearchInput: { flex: 1, fontSize: 13, color: Colors.text, padding: 0 },
  modalEmpty: { alignItems: "center", padding: 24, gap: 8 },
  modalEmptyText: { fontSize: 13, color: Colors.textMuted },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  checkBox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  checkText: { flex: 1, fontSize: 14, color: Colors.text },
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
  dateRangeButtonText: { fontSize: 15, fontWeight: "600", color: Colors.text },
  dateRangeError: {
    fontSize: 12,
    color: Colors.danger,
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 4,
  },

  // Unpaid-bills-count chip strip (per-vendor filter)
  unpaidChipsWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  unpaidChipsLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  unpaidChipsRow: { gap: 5, paddingVertical: 1 },
  unpaidChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
    minWidth: 32,
    alignItems: "center",
  },
  unpaidChipActive: {
    backgroundColor: Colors.warning,
    borderColor: Colors.warning,
  },
  unpaidChipText: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  unpaidChipTextActive: { color: Colors.textInverse },

  // CR PDF action button (sibling of Process Pay)
  actionBtnPdfOn: {
    backgroundColor: Colors.info,
    borderColor: Colors.info,
  },

  // Vendor-summary table row
  vendorRowWrap: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  vendorRowAlt: { backgroundColor: Colors.surfaceSecondary },
  vendorRowHasUnpaid: { backgroundColor: Colors.warningLight },
  vendorRowHasCr: { backgroundColor: Colors.infoLight },
  vendorRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 8,
  },
  vendorRowMain: { flex: 1, minWidth: 0 },
  vendorRowName: {
    fontSize: 13,
    fontWeight: "800",
    color: Colors.text,
  },
  vendorRowCode: {
    fontSize: 10,
    color: Colors.textMuted,
    fontWeight: "700",
    letterSpacing: 0.3,
    marginTop: 1,
  },
  vendorRowStats: { flexDirection: "row", gap: 5, alignItems: "center" },
  miniStat: {
    alignItems: "center",
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  miniStatUnpaid: {
    backgroundColor: Colors.warning + "22",
    borderColor: Colors.warning + "55",
  },
  miniStatCr: {
    backgroundColor: Colors.info + "22",
    borderColor: Colors.info + "55",
  },
  miniStatValue: {
    fontSize: 13,
    fontWeight: "800",
    color: Colors.text,
  },
  miniStatValueUnpaid: { color: Colors.warning },
  miniStatValueCr: { color: Colors.info, fontSize: 13, fontWeight: "800" },
  miniStatValueAmount: {
    fontSize: 11,
    fontWeight: "800",
    color: Colors.info,
  },
  miniStatLabel: {
    fontSize: 8,
    fontWeight: "700",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: 1,
  },

  // Expanded panel
  expandedPanel: {
    paddingHorizontal: 10,
    paddingBottom: 10,
    gap: 8,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
  },
  expandedActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingTop: 8,
  },
  crPhotosBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  crPhotosBtnDisabled: {
    backgroundColor: Colors.surfaceSecondary,
    borderColor: Colors.border,
  },
  crPhotosBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.primary,
  },
  crPhotosHelp: {
    fontSize: 11,
    color: Colors.textMuted,
    lineHeight: 16,
    marginBottom: 8,
  },

  // Per-bill card inside the expanded panel
  billCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 8,
    gap: 6,
  },
  billCardUnpaid: {
    backgroundColor: Colors.warningLight,
    borderColor: Colors.warning + "55",
  },
  billCardCr: {
    borderColor: Colors.info,
    borderWidth: 1.5,
  },
  billHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  billHeadDate: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  billHeadInv: {
    flex: 1,
    fontSize: 12,
    fontWeight: "800",
    color: Colors.text,
  },
  billHeadAmt: {
    fontSize: 12,
    fontWeight: "800",
    color: Colors.info,
  },
  paidBadge: {
    backgroundColor: Colors.success,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  paidBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: Colors.textInverse,
    letterSpacing: 0.3,
  },
  billMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  billMetaItem: { fontSize: 10, color: Colors.textMuted, fontWeight: "600" },
  billEdit: { gap: 6 },
  billEditRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  billEditCol: { gap: 4 },
  billEditLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    minWidth: 64,
  },
  billView: { gap: 4 },

  // CR Flag toggle (ON / OFF pill with knob)
  crToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  crToggleOff: {
    backgroundColor: Colors.surfaceSecondary,
    borderColor: Colors.border,
  },
  crToggleOn: {
    backgroundColor: Colors.info,
    borderColor: Colors.info,
  },
  paidToggleOn: {
    backgroundColor: Colors.success,
    borderColor: Colors.success,
  },
  flagGroup: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  billEditLabelInline: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  chequeInput: {
    flex: 1,
    fontSize: 12,
    color: Colors.text,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  paidFlagBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: Colors.success,
  },
  chequeInline: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: "600",
  },
  crToggleKnob: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.textMuted,
  },
  crToggleKnobOn: { backgroundColor: Colors.textInverse },
  crToggleText: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 0.5,
  },
  crToggleTextOn: { color: Colors.textInverse },

  // CR badge (view mode)
  crBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: Colors.info,
  },
  crBadgeText: {
    fontSize: 8,
    fontWeight: "800",
    color: Colors.textInverse,
    letterSpacing: 0.5,
  },
  crNotesInline: {
    fontSize: 10,
    color: Colors.info,
    fontStyle: "italic",
  },
});
