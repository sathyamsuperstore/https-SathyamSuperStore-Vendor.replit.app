import React, { useCallback, useMemo, useState } from "react";
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
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as XLSX from "xlsx-js-style";
import { Colors } from "@/constants/colors";
import { useApp, type VendorPayment } from "@/context/AppContext";

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
type Mark = "Normal" | "Urgent" | null;
type Draft = { mark: Mark; comments: string };

// Tighter widths so 9 columns fit more of the viewport before the
// user has to scroll horizontally. Modify-mode columns appear only
// when toggled on.
const COL = {
  vendorName: 200,
  invoiceDate: 90,
  invoiceNo: 110,
  supplierPayment: 100,
  grnDate: 90,
  vendorCode: 90,
  gidNo: 90,
  tranNo: 100,
  status: 110,
  mark: 138,
  comments: 170,
};

// ---------- Screen ----------

export default function VendorPaymentsScreen() {
  const { vendorPayments, saveVendorPaymentsBatch, clearVendorPayments } =
    useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [search, setSearch] = useState("");
  const [paidFilter, setPaidFilter] = useState<PaidFilter>("all");

  const [activeVendors, setActiveVendors] = useState<string[]>([]);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

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
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const invFromMs = invFrom ? startOfDay(invFrom).getTime() : null;
    const invToMs = invTo ? startOfDay(invTo).getTime() : null;
    const payFromMs = payFrom ? startOfDay(payFrom).getTime() : null;
    const payToMs = payTo ? startOfDay(payTo).getTime() : null;
    const vendorSet =
      activeVendors.length > 0 ? new Set(activeVendors) : null;

    const out = vendorPayments.filter((vp) => {
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

    out.sort((a, b) => {
      const aPaid = isPaid(a);
      const bPaid = isPaid(b);
      if (aPaid !== bPaid) return aPaid ? 1 : -1;
      const ad = parseStoredDate(a.invoiceDate)?.getTime() ?? -Infinity;
      const bd = parseStoredDate(b.invoiceDate)?.getTime() ?? -Infinity;
      return bd - ad;
    });
    return out;
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

  const hasUnsavedDrafts = Object.keys(drafts).length > 0;

  function toggleVendor(v: string) {
    setActiveVendors((cur) =>
      cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v],
    );
  }

  const setRowMark = useCallback((vp: VendorPayment, next: Mark) => {
    setDrafts((cur) => {
      const existing: Draft =
        cur[vp.gidNo] ?? {
          mark: vp.markToPay ?? null,
          comments: vp.comments ?? "",
        };
      const updated: Draft = { ...existing, mark: next };
      const storedMark = vp.markToPay ?? null;
      const storedComments = vp.comments ?? "";
      if (updated.mark === storedMark && updated.comments === storedComments) {
        const { [vp.gidNo]: _, ...rest } = cur;
        return rest;
      }
      return { ...cur, [vp.gidNo]: updated };
    });
  }, []);

  const setRowComment = useCallback((vp: VendorPayment, text: string) => {
    setDrafts((cur) => {
      const existing: Draft =
        cur[vp.gidNo] ?? {
          mark: vp.markToPay ?? null,
          comments: vp.comments ?? "",
        };
      const updated: Draft = { ...existing, comments: text };
      const storedMark = vp.markToPay ?? null;
      const storedComments = vp.comments ?? "";
      if (updated.mark === storedMark && updated.comments === storedComments) {
        const { [vp.gidNo]: _, ...rest } = cur;
        return rest;
      }
      return { ...cur, [vp.gidNo]: updated };
    });
  }, []);

  async function handleSaveDrafts() {
    if (!hasUnsavedDrafts || saving) return;
    setSaving(true);
    try {
      const merged: VendorPayment[] = vendorPayments.map((vp) => {
        const d = drafts[vp.gidNo];
        if (!d) return vp;
        return { ...vp, markToPay: d.mark, comments: d.comments };
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
    const rows = vendorPayments
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
        "Payment / Status": isPaid(vp) ? vp.paymentDate || "Paid" : "Unpaid",
        "Mark to Pay": getMark(vp) ?? "",
        Comments: getComments(vp),
      }));
    if (rows.length === 0) {
      Alert.alert(
        "Nothing to export",
        'Mark at least one row as "Normal" or "Urgent" first.',
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
        { wch: 16 },
        { wch: 12 },
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

  function handleClear() {
    if (vendorPayments.length === 0) return;
    const msg = `Remove all ${vendorPayments.length} Vendor Payment${vendorPayments.length === 1 ? "" : "s"}? This cannot be undone.`;
    const run = async () => {
      try {
        await clearVendorPayments();
        setDrafts({});
        setModifyMode(false);
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

  // Sticky header for the FlatList — paid/unpaid toggle, filter chips,
  // action buttons, search, count, table column header. Sits in a
  // single dense card so the table itself can take the rest of the
  // viewport.
  const ListHeader = (
    <View style={styles.headerCard}>
      {/* Top row: title + colourful action buttons. Mirrors the
          StockUpd tab's compact action row. */}
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
            <Text
              style={[styles.actionPillText, { color: Colors.success }]}
            >
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

      {/* Dense stat pills — quick at-a-glance counters across the
          ledger. Horizontally scrollable so they never wrap. */}
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
        <StatPill label="Total" value={fmtAmount(totalPaid)} color={Colors.info} />
      </ScrollView>

      {vendorPayments.length > 0 && (
        <>
          {/* Paid / Unpaid / All segmented control */}
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

          {/* 3 filter chips in a single dense row */}
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
          </View>

          {/* Modify / Save / Process Pay row — colorful flat buttons */}
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
                  <ActivityIndicator
                    size="small"
                    color={Colors.textInverse}
                  />
                ) : (
                  <Feather
                    name="save"
                    size={14}
                    color={
                      hasUnsavedDrafts
                        ? Colors.textInverse
                        : Colors.textMuted
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
          </View>

          {/* Search bar */}
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
            <Text style={styles.resultCountStrong}>{filtered.length}</Text> of{" "}
            {vendorPayments.length}
            {paidFilter !== "all" ? ` · ${paidFilter}` : ""}
            {markedCount > 0 ? ` · ${markedCount} marked` : ""}
          </Text>
        </>
      )}
    </View>
  );

  const renderRow = useCallback(
    ({ item: vp, index: i }: { item: VendorPayment; index: number }) => {
      const paid = isPaid(vp);
      const mark = getMark(vp);
      const comments = getComments(vp);
      return (
        <View
          style={[
            styles.tableRow,
            i % 2 === 0 && styles.tableRowAlt,
            !paid && styles.tableRowUnpaid,
            mark === "Urgent" && styles.tableRowUrgent,
            mark === "Normal" && styles.tableRowNormal,
          ]}
        >
          {modifyMode && (
            <View style={{ width: COL.mark }}>
              <MarkPicker
                value={mark}
                onChange={(next) => setRowMark(vp, next)}
              />
            </View>
          )}
          <View style={{ width: COL.vendorName }}>
            <Text
              style={[styles.td, styles.tdName]}
              numberOfLines={2}
            >
              {vp.vendorName}
            </Text>
            {!modifyMode && mark && <MarkBadge mark={mark} />}
            {!modifyMode && comments.length > 0 && (
              <Text style={styles.commentInline} numberOfLines={2}>
                {comments}
              </Text>
            )}
          </View>
          <Text
            style={[styles.td, { width: COL.invoiceDate }]}
            numberOfLines={1}
          >
            {vp.invoiceDate || "—"}
          </Text>
          <Text
            style={[styles.td, { width: COL.invoiceNo }]}
            numberOfLines={1}
          >
            {vp.invoiceNo}
          </Text>
          <Text
            style={[
              styles.td,
              {
                width: COL.supplierPayment,
                textAlign: "right",
                fontWeight: "700",
              },
            ]}
            numberOfLines={1}
          >
            {fmtAmount(vp.supplierPayment)}
          </Text>
          <Text
            style={[styles.td, { width: COL.grnDate }]}
            numberOfLines={1}
          >
            {vp.grnDate || "—"}
          </Text>
          <Text
            style={[styles.td, { width: COL.vendorCode }]}
            numberOfLines={1}
          >
            {vp.vendorCode}
          </Text>
          <Text
            style={[styles.td, { width: COL.gidNo }]}
            numberOfLines={1}
          >
            {vp.gidNo}
          </Text>
          <Text
            style={[styles.td, { width: COL.tranNo }]}
            numberOfLines={1}
          >
            {vp.tranNo || "—"}
          </Text>
          <View style={{ width: COL.status }}>
            {paid ? (
              <Text
                style={[styles.td, { color: Colors.success, fontWeight: "700" }]}
                numberOfLines={1}
              >
                {vp.paymentDate || "—"}
              </Text>
            ) : (
              <View style={styles.unpaidBadge}>
                <Feather
                  name="alert-circle"
                  size={11}
                  color={Colors.warning}
                />
                <Text style={styles.unpaidBadgeText}>Unpaid</Text>
              </View>
            )}
          </View>
          {modifyMode && (
            <View style={{ width: COL.comments }}>
              <TextInput
                style={styles.commentInput}
                value={comments}
                onChangeText={(t) => setRowComment(vp, t)}
                placeholder="Add a note…"
                placeholderTextColor={Colors.textMuted}
                multiline
              />
            </View>
          )}
        </View>
      );
    },
    [getMark, getComments, modifyMode, setRowMark, setRowComment],
  );

  // Table column header — repeated as the FlatList list header inside
  // a horizontal scroller so it stays aligned with the rows.
  const TableHeader = (
    <View style={styles.tableHeader}>
      {modifyMode && (
        <Text style={[styles.th, { width: COL.mark }]}>Mark to Pay</Text>
      )}
      <Text style={[styles.th, { width: COL.vendorName }]}>VendorName</Text>
      <Text style={[styles.th, { width: COL.invoiceDate }]}>InvoiceDate</Text>
      <Text style={[styles.th, { width: COL.invoiceNo }]}>InvoiceNo</Text>
      <Text
        style={[
          styles.th,
          { width: COL.supplierPayment, textAlign: "right" },
        ]}
      >
        Supplier Pay
      </Text>
      <Text style={[styles.th, { width: COL.grnDate }]}>GRNDate</Text>
      <Text style={[styles.th, { width: COL.vendorCode }]}>VendorCode</Text>
      <Text style={[styles.th, { width: COL.gidNo }]}>GidNo</Text>
      <Text style={[styles.th, { width: COL.tranNo }]}>TranNo</Text>
      <Text style={[styles.th, { width: COL.status }]}>Pay / Status</Text>
      {modifyMode && (
        <Text style={[styles.th, { width: COL.comments }]}>Comments</Text>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      {vendorPayments.length === 0 ? (
        // Empty state — full-screen prompt to import. Keeps the
        // header card visible so users still see the action buttons.
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
        // Outer vertical scroller hosts the dense header card and
        // the table. The table itself sits inside a horizontal
        // scroller so wide columns can be reached without the header
        // bar fighting for horizontal space.
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
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ minWidth: "100%" }}
            >
              <View>
                {TableHeader}
                {filtered.length === 0 ? (
                  <View style={styles.tableEmpty}>
                    <Feather
                      name="search"
                      size={18}
                      color={Colors.textMuted}
                    />
                    <Text style={styles.tableEmptyText}>
                      No rows match your filters.
                    </Text>
                  </View>
                ) : (
                  filtered.map((vp, i) => (
                    <View key={vp.gidNo}>{renderRow({ item: vp, index: i })}</View>
                  ))
                )}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      )}

      {/* ---- Vendor multi-select modal ---- */}
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
  chipRow: { flexDirection: "row", gap: 6 },
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
});
