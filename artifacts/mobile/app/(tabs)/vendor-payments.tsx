import React, { useMemo, useState } from "react";
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
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

// Parse the canonical "DD/MM/YYYY" we store on rows; also accepts ISO
// shapes for forward-compatibility. Returns local-midnight Date or
// null. Empty/blank → null.
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

// "Paid" means TranNo is non-empty per user spec. Empty TranNo = Unpaid.
function isPaid(vp: VendorPayment): boolean {
  return !!(vp.tranNo && vp.tranNo.trim().length > 0);
}

type PaidFilter = "all" | "paid" | "unpaid";

// ---------- Screen ----------

export default function VendorPaymentsScreen() {
  const { vendorPayments, clearVendorPayments } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [search, setSearch] = useState("");
  const [paidFilter, setPaidFilter] = useState<PaidFilter>("all");

  // VendorName multi-select filter. Stored as a Set of exact
  // vendor-name strings (case-sensitive — matches the values in the
  // imported sheet). Empty = no vendor restriction.
  const [activeVendors, setActiveVendors] = useState<string[]>([]);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

  // Inclusive InvoiceDate range filter — same UX as Promo CR Date.
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

  // Inclusive PaymentDate range filter.
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

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  // Unique vendor name list — alphabetical, derived from the full
  // dataset (not filtered) so the picker always shows every option.
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

  // Main filtered + sorted list. Sort spec: Unpaid rows on top, then
  // by InvoiceDate descending; rows missing an InvoiceDate fall to
  // the bottom of their respective paid/unpaid group.
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
        // Unpaid rows have no payment date — exclude them when a
        // PaymentDate range filter is active.
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
      if (aPaid !== bPaid) return aPaid ? 1 : -1; // unpaid first
      const ad = parseStoredDate(a.invoiceDate)?.getTime() ?? -Infinity;
      const bd = parseStoredDate(b.invoiceDate)?.getTime() ?? -Infinity;
      return bd - ad; // invoice date desc
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

  function toggleVendor(v: string) {
    setActiveVendors((cur) =>
      cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v],
    );
  }

  function handleClear() {
    if (vendorPayments.length === 0) return;
    const msg = `Remove all ${vendorPayments.length} Vendor Payment${vendorPayments.length === 1 ? "" : "s"}? This cannot be undone.`;
    const run = async () => {
      try {
        await clearVendorPayments();
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

  return (
    <View style={styles.container}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.content,
          { paddingTop: topPt + 16, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>Ledger</Text>
            <Text style={styles.title}>Vendor Payments</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => router.push("/vendor-payments/import")}
              activeOpacity={0.85}
            >
              <Feather name="upload" size={16} color={Colors.primary} />
              <Text style={styles.iconBtnText}>Excel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() =>
                router.push("/vendor-payments/import?format=csv")
              }
              activeOpacity={0.85}
            >
              <Feather name="file-text" size={16} color={Colors.primary} />
              <Text style={styles.iconBtnText}>CSV</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.iconBtn,
                styles.iconBtnDanger,
                vendorPayments.length === 0 && styles.iconBtnDisabled,
              ]}
              onPress={handleClear}
              disabled={vendorPayments.length === 0}
              activeOpacity={0.85}
            >
              <Feather
                name="trash-2"
                size={16}
                color={
                  vendorPayments.length === 0
                    ? Colors.textMuted
                    : Colors.danger
                }
              />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{vendorPayments.length}</Text>
            <Text style={styles.statLabel}>Rows</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: Colors.primary }]}>
              {uniqueVendors}
            </Text>
            <Text style={styles.statLabel}>Vendors</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: Colors.warning }]}>
              {unpaidCount}
            </Text>
            <Text style={styles.statLabel}>Unpaid</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: Colors.success }]}>
              {fmtAmount(totalPaid)}
            </Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
        </View>

        {vendorPayments.length === 0 ? (
          <View style={styles.emptyCard}>
            <Feather name="inbox" size={32} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No Vendor Payments yet</Text>
            <Text style={styles.emptyHint}>
              Import an Excel sheet to populate the ledger.
            </Text>
            <View style={styles.emptyActions}>
              <TouchableOpacity
                style={styles.primaryBtn}
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
                <Feather name="file-text" size={16} color={Colors.primary} />
                <Text style={styles.secondaryBtnText}>Import CSV</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            {/* Paid / Unpaid / All segmented toggle. Sits above the
                filter grid so it reads as the primary axis the user
                pivots on. */}
            <View style={styles.segWrap}>
              {(
                [
                  { key: "all", label: "All" },
                  {
                    key: "unpaid",
                    label: `Unpaid${unpaidCount > 0 ? ` · ${unpaidCount}` : ""}`,
                  },
                  {
                    key: "paid",
                    label: `Paid${vendorPayments.length - unpaidCount > 0 ? ` · ${vendorPayments.length - unpaidCount}` : ""}`,
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

            {/* Filter chips: VendorName + InvoiceDate range + PaymentDate range */}
            <View style={styles.filterGrid}>
              <FilterChip
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
              <FilterChip
                icon="calendar"
                label={
                  invFrom || invTo
                    ? `Inv: ${invFrom ? formatDDMMYYYY(invFrom) : "Any"} → ${invTo ? formatDDMMYYYY(invTo) : "Any"}`
                    : "All Invoice Dates"
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
                    ? `Pay: ${payFrom ? formatDDMMYYYY(payFrom) : "Any"} → ${payTo ? formatDDMMYYYY(payTo) : "Any"}`
                    : "All Payment Dates"
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

            <View style={styles.searchWrap}>
              <Feather name="search" size={14} color={Colors.textMuted} />
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
              Showing {filtered.length} of {vendorPayments.length}
              {paidFilter !== "all" ? ` · ${paidFilter}` : ""}
            </Text>

            <View style={styles.tableCard}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                contentContainerStyle={{ minWidth: "100%" }}
              >
                <View>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.th, { width: 100 }]}>GidNo</Text>
                    <Text style={[styles.th, { width: 100 }]}>VendorCode</Text>
                    <Text style={[styles.th, { width: 220 }]}>VendorName</Text>
                    <Text style={[styles.th, { width: 130 }]}>InvoiceNo</Text>
                    <Text style={[styles.th, { width: 100 }]}>GRNDate</Text>
                    <Text style={[styles.th, { width: 100 }]}>InvoiceDate</Text>
                    <Text style={[styles.th, { width: 110 }]}>TranNo</Text>
                    <Text
                      style={[
                        styles.th,
                        { width: 110, textAlign: "right" },
                      ]}
                    >
                      Supplier Payment
                    </Text>
                    <Text style={[styles.th, { width: 120 }]}>
                      Payment / Status
                    </Text>
                  </View>
                  {filtered.map((vp, i) => {
                    const paid = isPaid(vp);
                    return (
                      <View
                        key={`${vp.gidNo}-${i}`}
                        style={[
                          styles.tableRow,
                          i % 2 === 0 && styles.tableRowAlt,
                          !paid && styles.tableRowUnpaid,
                        ]}
                      >
                        <Text
                          style={[styles.td, { width: 100 }]}
                          numberOfLines={1}
                        >
                          {vp.gidNo}
                        </Text>
                        <Text
                          style={[styles.td, { width: 100 }]}
                          numberOfLines={1}
                        >
                          {vp.vendorCode}
                        </Text>
                        <Text
                          style={[styles.td, styles.tdName, { width: 220 }]}
                          numberOfLines={2}
                        >
                          {vp.vendorName}
                        </Text>
                        <Text
                          style={[styles.td, { width: 130 }]}
                          numberOfLines={1}
                        >
                          {vp.invoiceNo}
                        </Text>
                        <Text
                          style={[styles.td, { width: 100 }]}
                          numberOfLines={1}
                        >
                          {vp.grnDate || "—"}
                        </Text>
                        <Text
                          style={[styles.td, { width: 100 }]}
                          numberOfLines={1}
                        >
                          {vp.invoiceDate || "—"}
                        </Text>
                        <Text
                          style={[styles.td, { width: 110 }]}
                          numberOfLines={1}
                        >
                          {vp.tranNo || "—"}
                        </Text>
                        <Text
                          style={[
                            styles.td,
                            {
                              width: 110,
                              textAlign: "right",
                              fontWeight: "700",
                            },
                          ]}
                          numberOfLines={1}
                        >
                          {fmtAmount(vp.supplierPayment)}
                        </Text>
                        <View style={{ width: 120 }}>
                          {paid ? (
                            <Text
                              style={[styles.td, { color: Colors.success }]}
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
                      </View>
                    );
                  })}
                  {filtered.length === 0 && (
                    <View style={styles.tableEmpty}>
                      <Text style={styles.tableEmptyText}>
                        No rows match your filters.
                      </Text>
                    </View>
                  )}
                </View>
              </ScrollView>
            </View>
          </>
        )}
      </ScrollView>

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
                    style={[
                      styles.checkBox,
                      checked && styles.checkBoxOn,
                    ]}
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

      {/* ---- InvoiceDate range modal ---- */}
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

      {/* ---- PaymentDate range modal ---- */}
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
        size={14}
        color={active ? Colors.textInverse : Colors.textSecondary}
      />
      <Text
        style={[
          styles.filterBarText,
          active && styles.filterBarTextActive,
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
      ) : (
        <Feather name="chevron-down" size={14} color={Colors.textMuted} />
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
  content: { paddingHorizontal: 16, gap: 14 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  headerActions: { flexDirection: "row", gap: 8 },
  greeting: { fontSize: 13, color: Colors.textMuted, marginBottom: 2 },
  title: { fontSize: 26, fontWeight: "800", color: Colors.text },
  iconBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.primary + "12",
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  iconBtnText: { fontSize: 12, fontWeight: "700", color: Colors.primary },
  iconBtnDanger: {
    backgroundColor: Colors.dangerLight,
    borderColor: Colors.danger + "30",
    paddingHorizontal: 10,
  },
  iconBtnDisabled: {
    backgroundColor: Colors.background,
    borderColor: Colors.border,
  },
  statsRow: { flexDirection: "row", gap: 8 },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 12,
    paddingHorizontal: 4,
    alignItems: "center",
  },
  statValue: {
    fontSize: 16,
    fontWeight: "800",
    color: Colors.text,
    marginBottom: 2,
  },
  statLabel: { fontSize: 10, color: Colors.textMuted, fontWeight: "600" },
  emptyCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 28,
    alignItems: "center",
    gap: 10,
    marginTop: 8,
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
    backgroundColor: Colors.primary + "12",
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.primary,
  },

  // Paid/Unpaid segmented control
  segWrap: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 4,
    gap: 4,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: "center",
    backgroundColor: "transparent",
  },
  segBtnActive: { backgroundColor: Colors.primary },
  segBtnText: { fontSize: 12, fontWeight: "700", color: Colors.textSecondary },
  segBtnTextActive: { color: Colors.textInverse },

  // Filter grid (vendor + 2 date chips)
  filterGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  filterBar: {
    flex: 1,
    minWidth: "47%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
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
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  filterBarTextActive: { color: Colors.textInverse },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 13, color: Colors.text, padding: 0 },
  resultCount: { fontSize: 11, color: Colors.textMuted, fontWeight: "600" },
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    gap: 8,
  },
  tableRowAlt: { backgroundColor: Colors.background },
  tableRowUnpaid: { backgroundColor: Colors.warningLight },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  td: { fontSize: 12, color: Colors.text },
  tdName: { fontWeight: "600" },
  tableEmpty: { padding: 24, alignItems: "center" },
  tableEmptyText: { fontSize: 13, color: Colors.textMuted },
  unpaidBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.warning + "22",
    borderColor: Colors.warning,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  unpaidBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.warning,
    letterSpacing: 0.3,
  },

  // Modal bits
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
