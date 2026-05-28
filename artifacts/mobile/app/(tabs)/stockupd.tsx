import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as XLSX from "xlsx-js-style";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import * as Print from "expo-print";
import { LOGO_BASE64 } from "@/constants/LogoBase64";
import { Colors } from "@/constants/colors";
import { useApp, OrderStatus, Order, OrderItem, PromoEntry, Supplier, showStorageErrorAlert } from "@/context/AppContext";
import { SupplierPhotosBox } from "@/components/SupplierPhotosBox";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";

const STATUS_FILTERS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

// ---------------------------------------------------------------------------
// Multi-level "Sort by" config (up to 3 levels). Each field declares its
// data type so the comparator can pick the right ordering (alphabetical for
// strings, numeric for numbers) and the direction button can show the right
// labels (A→Z / Z→A vs Low→High / High→Low). `scope` decides whether the
// criterion sorts the outer order list (vendor cards) or the inner item rows
// inside each card. The user's example "Vendor → Brand → Category" mixes
// both: Vendor sorts the cards, Brand+Category sort the items within them.
// ---------------------------------------------------------------------------
type SortFieldKey =
  | "supplierName"
  | "status"
  | "orderNumber"
  | "beat"
  | "brand"
  | "category"
  | "name"
  | "unit"
  | "unitPrice"
  | "quantity"
  | "newStockQty"
  | "stock"
  | "min"
  | "sortNo";
type SortFieldDef = {
  key: SortFieldKey;
  label: string;
  type: "string" | "number";
  scope: "order" | "item";
};
const SORT_FIELDS: SortFieldDef[] = [
  { key: "supplierName", label: "Vendor", type: "string", scope: "order" },
  { key: "status", label: "Status", type: "string", scope: "order" },
  { key: "orderNumber", label: "Order #", type: "string", scope: "order" },
  { key: "beat", label: "Beat", type: "string", scope: "order" },
  { key: "brand", label: "Brand", type: "string", scope: "item" },
  { key: "category", label: "Category", type: "string", scope: "item" },
  { key: "name", label: "Item Desc.", type: "string", scope: "item" },
  { key: "unit", label: "UOM", type: "string", scope: "item" },
  { key: "unitPrice", label: "MRP", type: "number", scope: "item" },
  { key: "quantity", label: "Ord Qty", type: "number", scope: "item" },
  { key: "newStockQty", label: "New Stock", type: "number", scope: "item" },
  { key: "stock", label: "Stock", type: "number", scope: "item" },
  { key: "min", label: "Min", type: "number", scope: "item" },
  { key: "sortNo", label: "Sort No", type: "number", scope: "item" },
];
const SORT_FIELD_BY_KEY: Record<SortFieldKey, SortFieldDef> = SORT_FIELDS.reduce(
  (acc, f) => {
    acc[f.key] = f;
    return acc;
  },
  {} as Record<SortFieldKey, SortFieldDef>,
);
type SortLevel = { key: SortFieldKey; dir: "asc" | "desc" } | null;
const EMPTY_SORT_LEVELS: SortLevel[] = [null, null, null];

function getOrderSortValue(o: Order, key: SortFieldKey): string | number | null {
  switch (key) {
    case "supplierName":
      return o.supplierName ?? "";
    case "status":
      return o.status ?? "";
    case "orderNumber":
      return o.orderNumber ?? "";
    case "beat":
      return (o.beat ?? "").trim();
    default:
      return null;
  }
}
function getItemSortValue(it: OrderItem, key: SortFieldKey): string | number | null {
  switch (key) {
    case "brand":
      return it.brand ?? "";
    case "category":
      return it.category ?? "";
    case "name":
      // Sort on the description part (after "ItemNo - "), falling back to
      // the full name when no separator is present, so visually adjacent
      // items match what the user reads on the card.
      return it.name.includes(" - ")
        ? it.name.split(" - ").slice(1).join(" - ")
        : it.name;
    case "unit":
      return it.unit ?? "";
    case "unitPrice":
      return it.unitPrice ?? null;
    case "quantity":
      return it.quantity ?? null;
    case "newStockQty":
      return it.newStockQty ?? null;
    case "stock":
      return it.stock ?? null;
    case "min":
      return it.min ?? null;
    case "sortNo":
      return it.sortNo ?? null;
    default:
      return null;
  }
}
// Compare two raw values according to `type` and `dir`. Empty-string and
// null values are pushed to the end regardless of direction, so blanks
// don't interleave with real data.
function cmpSortVal(
  a: string | number | null,
  b: string | number | null,
  type: "string" | "number",
  dir: "asc" | "desc",
): number {
  const aBlank = a == null || (type === "string" && a === "");
  const bBlank = b == null || (type === "string" && b === "");
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  let r = 0;
  if (type === "string") {
    r = String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
  } else {
    const an = Number(a);
    const bn = Number(b);
    if (isNaN(an) && isNaN(bn)) r = 0;
    else if (isNaN(an)) r = 1;
    else if (isNaN(bn)) r = -1;
    else r = an - bn;
  }
  return dir === "desc" ? -r : r;
}
function dirLabelFor(type: "string" | "number", dir: "asc" | "desc"): string {
  if (type === "string") return dir === "asc" ? "A→Z" : "Z→A";
  return dir === "asc" ? "Low→High" : "High→Low";
}
function shortDirLabelFor(type: "string" | "number", dir: "asc" | "desc"): string {
  if (type === "string") return dir === "asc" ? "A→Z" : "Z→A";
  return dir === "asc" ? "↑" : "↓";
}

function calcTotal(items: OrderItem[]): number {
  return items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
}

// ---------------------------------------------------------------------------
// Date helpers (mirrors latest-purchases.tsx) — used by the LastPurchRange
// filter that matches each order's supplier vendor code against the
// LastSupplyDate table and keeps only orders whose Latest Invoice Date
// falls inside the selected from/to range.
// ---------------------------------------------------------------------------
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function formatDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
// Inverse of formatDDMMYYYY — accepts DD/MM/YYYY, DD-MM-YYYY (incl.
// 2-digit years) and ISO YYYY-MM-DD. Returns null if the string isn't
// a valid calendar date so the LastPurchRange filter can simply skip
// rows whose stored date is unparseable rather than throwing.
function parseDateStr(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  const m1 = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const mon = parseInt(m1[2], 10);
    let yr = parseInt(m1[3], 10);
    if (yr < 100) yr += 2000;
    const d = new Date(yr, mon - 1, day);
    if (!isNaN(d.getTime()) && d.getDate() === day && d.getMonth() === mon - 1) {
      return d;
    }
  }
  const m2 = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m2) {
    const d = new Date(parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, parseInt(m2[3], 10));
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

// Format a numeric promo cell. Numbers render as integer when whole,
// 2dp otherwise (matches the Promo tab convention). Strings pass
// through trimmed; missing values become an empty string so the
// caller can fall back to a placeholder.
function fmtPromoNum(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v).trim();
}

function StockUpdCard({
  order,
  vendorCode,
  supplier,
  activeBrands,
  activeCategories,
  itemSearch,
  negStockOnly,
  showNotes,
  multipleMrpOnly,
  mrpMap,
  promoMap,
  itemSortLevels,
  onSave,
  onSaveSupplierNotes,
  onSaveSupplierPhotos,
}: {
  order: Order;
  vendorCode?: string;
  supplier?: Supplier;
  activeBrands: string[];
  activeCategories: string[];
  itemSearch: string;
  negStockOnly: boolean;
  showNotes: boolean;
  multipleMrpOnly: boolean;
  mrpMap: Record<string, number[]>;
  promoMap: Record<string, PromoEntry[]>;
  // Item-level criteria from the multi-level "Sort by". Empty array
  // (the default) preserves the legacy brand-then-sortNo ordering so
  // existing users see no behavior change until they pick a sort.
  itemSortLevels: { key: SortFieldKey; dir: "asc" | "desc" }[];
  onSave: (id: string, items: OrderItem[]) => Promise<boolean>;
  onSaveSupplierNotes: (id: string, notes: string) => Promise<void>;
  onSaveSupplierPhotos: (id: string, photos: string[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({});
  const [nsqEdits, setNsqEdits] = useState<Record<string, string>>({});
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Supplier-level notes box: same shape as the one on the Orders tab,
  // backed by the same `supplier.generalNotes` field, so saving here
  // immediately reflects on the Orders tab and PDF footers.
  const savedSupplierNotes = supplier?.generalNotes ?? "";
  const [supplierNotesDraft, setSupplierNotesDraft] = useState(savedSupplierNotes);
  const [supplierNotesSaving, setSupplierNotesSaving] = useState(false);
  const [supplierNotesSavedAt, setSupplierNotesSavedAt] = useState<number | null>(null);

  // Re-seed the input whenever the supplier in view changes OR the saved
  // notes value changes (e.g. saved from the Orders tab while this card
  // is mounted), but not on every keystroke for the same supplier.
  useEffect(() => {
    setSupplierNotesDraft(savedSupplierNotes);
  }, [supplier?.id, savedSupplierNotes]);

  // Auto-clear the inline "Saved" badge a couple of seconds after a write.
  useEffect(() => {
    if (supplierNotesSavedAt == null) return;
    const t = setTimeout(() => setSupplierNotesSavedAt(null), 2500);
    return () => clearTimeout(t);
  }, [supplierNotesSavedAt]);

  const supplierNotesDirty = supplierNotesDraft.trim() !== savedSupplierNotes.trim();

  async function handleSaveSupplierNotes() {
    if (!supplier || supplierNotesSaving || !supplierNotesDirty) return;
    const trimmed = supplierNotesDraft.trim();
    setSupplierNotesSaving(true);
    try {
      await onSaveSupplierNotes(supplier.id, trimmed);
      setSupplierNotesDraft(trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSupplierNotesSavedAt(Date.now());
    } catch {
      showStorageErrorAlert();
    } finally {
      setSupplierNotesSaving(false);
    }
  }
  // Used by the tappable "Item No: …" link to deep-link into the
  // Promo tab pre-filtered to that item, and by the admin-only red
  // "₹" pill in this card's header that jumps to VendorPayments
  // pre-filtered to this supplier.
  const router = useRouter();
  const { currentUser } = useApp();
  const isAdmin = currentUser?.userType === "Admin";

  const sortedItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    const brandFiltered =
      activeBrands.length === 0
        ? order.items
        : order.items.filter((it) => it.brand != null && activeBrands.includes(it.brand));
    const categoryFiltered =
      activeCategories.length === 0
        ? brandFiltered
        : brandFiltered.filter((it) => it.category != null && activeCategories.includes(it.category));
    let base = q
      ? categoryFiltered.filter((it) => {
          const desc = it.name.includes(" - ")
            ? it.name.split(" - ").slice(1).join(" - ")
            : it.name;
          return desc.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
        })
      : categoryFiltered;
    if (negStockOnly) {
      base = base.filter((it) => it.stock != null && it.stock < 0);
    }
    if (multipleMrpOnly) {
      base = base.filter((it) => {
        const itemNo = it.name.includes(" - ") ? it.name.split(" - ")[0].trim().toUpperCase() : "";
        return itemNo !== "" && mrpMap[itemNo]?.length > 0;
      });
    }
    // When the user has picked any item-level "Sort by" criteria we
    // honour those, walking levels in priority order. With no
    // criteria configured we keep the legacy brand-asc then sortNo-desc
    // ordering so the look-and-feel is unchanged for users who never
    // open the Sort modal.
    if (itemSortLevels.length > 0) {
      return [...base].sort((a, b) => {
        for (const c of itemSortLevels) {
          const def = SORT_FIELD_BY_KEY[c.key];
          const r = cmpSortVal(
            getItemSortValue(a, c.key),
            getItemSortValue(b, c.key),
            def.type,
            c.dir,
          );
          if (r !== 0) return r;
        }
        return 0;
      });
    }
    return [...base].sort((a, b) => {
      const ba = (a.brand ?? "").toLowerCase();
      const bb = (b.brand ?? "").toLowerCase();
      if (ba < bb) return -1;
      if (ba > bb) return 1;
      if (a.sortNo != null && b.sortNo != null) return b.sortNo - a.sortNo;
      if (a.sortNo != null) return -1;
      if (b.sortNo != null) return 1;
      return 0;
    });
  }, [order.items, activeBrands, activeCategories, itemSearch, negStockOnly, multipleMrpOnly, mrpMap, itemSortLevels]);

  const dirty =
    Object.keys(qtyEdits).some((k) => qtyEdits[k] !== String(order.items.find((i) => i.id === k)?.quantity ?? "")) ||
    Object.keys(nsqEdits).length > 0 ||
    Object.keys(noteEdits).length > 0;

  async function handleSave() {
    if (saving) return;
    const updated = order.items.map((item) => {
      const qStr = qtyEdits[item.id];
      const nStr = nsqEdits[item.id];
      const noteStr = noteEdits[item.id];
      const qty =
        qStr !== undefined
          ? isNaN(parseFloat(qStr)) || qStr.trim() === ""
            ? item.quantity
            : parseFloat(qStr)
          : item.quantity;
      const nsq =
        nStr !== undefined
          ? isNaN(parseFloat(nStr)) || nStr.trim() === ""
            ? undefined
            : parseFloat(nStr)
          : item.newStockQty;
      const notes =
        noteStr !== undefined
          ? noteStr.trim() === ""
            ? undefined
            : noteStr.trim()
          : item.notes;
      return { ...item, quantity: qty, newStockQty: nsq, notes };
    });
    setSaving(true);
    try {
      const ok = await onSave(order.id, updated);
      if (ok) {
        setQtyEdits({});
        setNsqEdits({});
        setNoteEdits({});
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={cardSt.card}>
      <TouchableOpacity
        style={cardSt.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.75}
      >
        <View style={{ flex: 1 }}>
          <View style={cardSt.supplierRow}>
            <Text style={cardSt.supplier} numberOfLines={1}>{order.supplierName}</Text>
            {isAdmin && order.supplierName ? (
              // Admin-only shortcut: jumps to the VendorPayments tab
              // pre-filtered to this supplier so the user can eyeball
              // outstanding bills without losing their place here.
              <TouchableOpacity
                style={cardSt.payJumpBtn}
                onPress={(e) => {
                  e.stopPropagation?.();
                  router.push({
                    pathname: "/vendor-payments",
                    params: { vendor: order.supplierName },
                  });
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.8}
              >
                <Feather name="credit-card" size={11} color="#fff" />
                <Text style={cardSt.payJumpBtnText}>Pay</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <Text style={cardSt.orderNo}>
            {vendorCode ? `${vendorCode}  ·  ` : ""}{order.orderNumber}  ·  {sortedItems.length}{(activeBrands.length > 0 || activeCategories.length > 0) ? ` of ${order.items.length}` : ""} items
          </Text>
        </View>
        <StatusBadge status={order.status} />
        <Feather
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color={Colors.textMuted}
          style={{ marginLeft: 8 }}
        />
      </TouchableOpacity>

      {expanded && (
        <View style={cardSt.body}>
          {/* Table header */}
          <View style={cardSt.tableHeader}>
            <Text style={[cardSt.th, { width: 32 }]}>S.No</Text>
            <Text style={[cardSt.th, { flex: 1 }]}>Item Description</Text>
          </View>

          {sortedItems.map((item, idx) => {
            const desc = item.name.includes(" - ")
              ? item.name.split(" - ").slice(1).join(" - ")
              : item.name;
            const itemNo = item.name.includes(" - ")
              ? item.name.split(" - ")[0]
              : "";
            const qtyVal = qtyEdits[item.id] ?? String(item.quantity);
            const nsqVal = nsqEdits[item.id] ?? (item.newStockQty != null ? String(item.newStockQty) : "");
            const noteVal = noteEdits[item.id] ?? (item.notes ?? "");
            return (
              <View
                key={item.id}
                style={[cardSt.tableRow, idx % 2 === 0 && cardSt.rowAlt]}
              >
                {/* Top: S.No + full-width item info */}
                <View style={cardSt.itemTopRow}>
                  <Text style={cardSt.sortNoCell}>
                    {item.sortNo ?? "—"}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={cardSt.itemName}>{desc}</Text>
                    {(item.brand || itemNo) ? (
                      <Text style={cardSt.itemBrand}>
                        {item.brand ?? ""}
                        {item.brand && itemNo ? "  ·  " : ""}
                        {itemNo ? (
                          <Text
                            style={cardSt.itemNoLink}
                            onPress={() =>
                              router.push({
                                pathname: "/catalog",
                                params: { view: "promo", q: itemNo.trim() },
                              })
                            }
                            suppressHighlighting
                          >
                            Item No: {itemNo}
                          </Text>
                        ) : null}
                        {itemNo && mrpMap[itemNo.trim().toUpperCase()]?.length
                          ? `  ·  MRP ₹${mrpMap[itemNo.trim().toUpperCase()].map((v) => v.toFixed(2)).join(", ")}`
                          : ""}
                      </Text>
                    ) : null}
                    <Text style={cardSt.itemMeta}>
                      {item.unit}  ·  MRP {item.unitPrice}
                      {item.stock != null ? `  ·  Stk ${item.stock}` : ""}
                      {item.min != null ? `  ·  Min ${item.min}` : ""}
                    </Text>
                    {/* Order Internal Notes (imported from the Orders
                        Excel column at order creation) — sits directly
                        under the description so the cashier sees it
                        before the editable Notes line. Hidden when blank. */}
                    {item.internalNotes ? (
                      <Text style={cardSt.itemInternalNotes}>
                        Order Internal Notes: {item.internalNotes}
                      </Text>
                    ) : null}
                    {item.notes ? (
                      <Text style={cardSt.itemNotes}>📝 {item.notes}</Text>
                    ) : null}
                  </View>
                </View>
                {/* Promo snapshot: only rendered when this item's
                    Item No has a matching row in the Promo tab. Picks
                    the first promo entry (matches the first-wins
                    dedupe used by the Promo tab itself). Five cells
                    in one neatly-stacked row: MRP / SP / Promo /
                    Valid Till / OH Qty. */}
                {(() => {
                  const k = itemNo ? itemNo.trim().toUpperCase() : "";
                  const list = k ? promoMap[k] : undefined;
                  const p = list && list.length > 0 ? list[0] : undefined;
                  if (!p) return null;
                  const cells: { label: string; value: string }[] = [
                    { label: "MRP", value: fmtPromoNum(p["MRP"]) },
                    { label: "SP", value: fmtPromoNum(p["SP"]) },
                    { label: "Promo", value: fmtPromoNum(p["PromotionPrice"]) },
                    { label: "Elig Qty", value: fmtPromoNum(p["EligibleQty"]) },
                    { label: "Sort Code", value: String(p["PromoSortCode"] ?? "") },
                    { label: "Valid Till", value: String(p["PromotionToDate"] ?? "") },
                    { label: "OH Qty", value: fmtPromoNum(p["OH Qty"]) },
                  ];
                  return (
                    <View style={cardSt.promoStrip}>
                      {cells.map((c) => (
                        <View key={c.label} style={cardSt.promoCell}>
                          <Text style={cardSt.promoLabel} numberOfLines={1}>
                            {c.label}
                          </Text>
                          <Text style={cardSt.promoValue} numberOfLines={1}>
                            {c.value || "—"}
                          </Text>
                        </View>
                      ))}
                    </View>
                  );
                })()}
                {/* Bottom: inputs with labels */}
                <View style={cardSt.inputRow}>
                  <View style={cardSt.inputGroup}>
                    <Text style={cardSt.inputLabel}>Ord Qty</Text>
                    <TextInput
                      style={cardSt.qtyInput}
                      value={qtyVal}
                      onChangeText={(v) =>
                        setQtyEdits((prev) => ({ ...prev, [item.id]: v }))
                      }
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                  </View>
                  <View style={cardSt.inputGroup}>
                    <Text style={cardSt.inputLabel}>New Stock</Text>
                    <TextInput
                      style={cardSt.qtyInput}
                      value={nsqVal}
                      onChangeText={(v) =>
                        setNsqEdits((prev) => ({ ...prev, [item.id]: v }))
                      }
                      placeholder="—"
                      placeholderTextColor={Colors.textMuted}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                  </View>
                </View>
                {showNotes && (
                  <View style={cardSt.notesInputRow}>
                    <Text style={cardSt.inputLabel}>Notes</Text>
                    {/* Green "copy Internal Notes -> Notes" shortcut.
                        Only rendered when this item actually has an
                        Internal Notes value worth copying. Tapping it
                        just primes the editable Notes draft for this
                        item id — the user is free to tweak the text
                        afterwards and persistence still happens on
                        "Save Changes" via handleSave. No-op if the
                        draft is already equal to the source, so
                        repeated taps don't clobber in-progress edits
                        silently. */}
                    {item.internalNotes ? (
                      <TouchableOpacity
                        style={cardSt.copyNotesBtn}
                        onPress={() =>
                          setNoteEdits((prev) => ({
                            ...prev,
                            [item.id]: item.internalNotes ?? "",
                          }))
                        }
                        accessibilityLabel="Copy Internal Notes into Notes"
                      >
                        <Feather name="copy" size={11} color="#FFFFFF" />
                        <Text style={cardSt.copyNotesBtnText}>
                          Copy Internal
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    <TextInput
                      style={cardSt.notesInput}
                      value={noteVal}
                      onChangeText={(v) =>
                        setNoteEdits((prev) => ({ ...prev, [item.id]: v }))
                      }
                      placeholder="Add note..."
                      placeholderTextColor={Colors.textMuted}
                      multiline
                    />
                  </View>
                )}
              </View>
            );
          })}

          {supplier && (
            <View style={cardSt.supplierNotesBox}>
              <View style={cardSt.supplierNotesHeader}>
                <Feather name="message-square" size={13} color={Colors.textSecondary} />
                <Text style={cardSt.supplierNotesLabel} numberOfLines={1}>
                  Notes for {supplier.name || supplier.vendorCode}
                </Text>
                {supplierNotesSavedAt != null && (
                  <View style={cardSt.supplierNotesSavedPill}>
                    <Feather name="check" size={11} color="#065F46" />
                    <Text style={cardSt.supplierNotesSavedText}>Saved</Text>
                  </View>
                )}
              </View>
              <TextInput
                style={cardSt.supplierNotesInput}
                value={supplierNotesDraft}
                onChangeText={setSupplierNotesDraft}
                placeholder="Add a note for this supplier (shown in the PDF footer)…"
                placeholderTextColor={Colors.textMuted}
                multiline
                textAlignVertical="top"
                editable={!supplierNotesSaving}
              />
              <View style={cardSt.supplierNotesActionRow}>
                <TouchableOpacity
                  style={[
                    cardSt.supplierNotesSaveBtn,
                    (!supplierNotesDirty || supplierNotesSaving) && cardSt.supplierNotesSaveBtnDisabled,
                  ]}
                  onPress={handleSaveSupplierNotes}
                  disabled={!supplierNotesDirty || supplierNotesSaving}
                  activeOpacity={0.8}
                >
                  {supplierNotesSaving ? (
                    <ActivityIndicator size="small" color={Colors.textInverse} />
                  ) : (
                    <Feather name="save" size={14} color={Colors.textInverse} />
                  )}
                  <Text style={cardSt.supplierNotesSaveText}>
                    {supplierNotesSaving ? "Saving…" : "SAVE"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {supplier && (
            <SupplierPhotosBox
              supplier={supplier}
              photos={supplier.photos ?? []}
              onChange={(next) => onSaveSupplierPhotos(supplier.id, next)}
            />
          )}

          <TouchableOpacity
            style={[cardSt.saveBtn, !dirty && cardSt.saveBtnDisabled]}
            onPress={handleSave}
            disabled={!dirty}
            activeOpacity={0.8}
          >
            <Feather name="save" size={15} color={dirty ? Colors.textInverse : Colors.textMuted} />
            <Text style={[cardSt.saveBtnText, !dirty && cardSt.saveBtnTextDisabled]}>
              Save Changes
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const cardSt = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
  },
  supplierRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  supplier: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "700",
    color: Colors.text,
  },
  payJumpBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: Colors.danger,
  },
  payJumpBtnText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: 0.4,
  },
  orderNo: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  body: { borderTopWidth: 1, borderTopColor: Colors.border },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surfaceSecondary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
  },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  right: { textAlign: "right" },
  tableRow: {
    flexDirection: "column",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  rowAlt: { backgroundColor: Colors.surfaceSecondary + "60" },
  td: { fontSize: 13, color: Colors.text },
  itemTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  sortNoCell: {
    width: 28,
    textAlign: "center",
    fontSize: 11,
    color: Colors.textMuted,
    paddingTop: 2,
  },
  itemName: { fontSize: 13, fontWeight: "600", color: Colors.text },
  itemBrand: { fontSize: 11, fontWeight: "600", color: Colors.primary, marginTop: 1 },
  itemNoLink: { color: Colors.primary, textDecorationLine: "underline", fontWeight: "700" },
  // Promo snapshot strip — single row of 5 equal-width cells shown
  // above the Ord Qty / New Stock inputs whenever the item appears
  // in the imported Promo data.
  promoStrip: {
    flexDirection: "row",
    marginTop: 6,
    marginBottom: 4,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    gap: 4,
  },
  promoCell: { flex: 1, minWidth: 0, alignItems: "flex-start" },
  promoLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: Colors.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 1,
  },
  promoValue: { fontSize: 11, fontWeight: "700", color: Colors.text },
  itemMeta: { fontSize: 17, color: Colors.textMuted, marginTop: 1 },
  itemNotes: { fontSize: 13, color: Colors.textSecondary, fontStyle: "italic", marginTop: 3 },
  itemInternalNotes: { fontSize: 13, color: Colors.textSecondary, fontStyle: "italic", marginTop: 3 },
  notesInputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingLeft: 34,
    paddingRight: 4,
  },
  // Green pill that copies the frozen Internal Notes value into
  // the editable Notes draft. Sized to fit alongside the "Notes"
  // label and the multiline input without crowding either.
  copyNotesBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#16A34A",
  },
  copyNotesBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: 0.3,
  },
  notesInput: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 32,
    backgroundColor: Colors.surface,
  },
  inputRow: {
    flexDirection: "row",
    gap: 10,
    paddingLeft: 34,
  },
  inputGroup: {
    flex: 1,
    gap: 4,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  qtyInput: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "right",
    borderWidth: 1.5,
    borderColor: Colors.primary,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    margin: 12,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  saveBtnDisabled: { backgroundColor: Colors.surfaceSecondary, borderWidth: 1, borderColor: Colors.border },
  // Per-supplier notes box — mirrors the one on the Orders tab so saved
  // values stay in sync (both write to supplier.generalNotes).
  supplierNotesBox: {
    marginHorizontal: 12,
    marginTop: 4,
    padding: 10,
    borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 6,
  },
  supplierNotesHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  supplierNotesLabel: {
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  supplierNotesSavedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: "#D1FAE5",
  },
  supplierNotesSavedText: { fontSize: 10, fontWeight: "700", color: "#065F46" },
  supplierNotesInput: {
    minHeight: 60,
    maxHeight: 140,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    fontSize: 13,
    color: Colors.text,
    lineHeight: 18,
  },
  supplierNotesActionRow: { flexDirection: "row", justifyContent: "flex-end" },
  supplierNotesSaveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: Colors.primary,
  },
  supplierNotesSaveBtnDisabled: { opacity: 0.45 },
  supplierNotesSaveText: { fontSize: 12, fontWeight: "800", color: Colors.textInverse, letterSpacing: 0.5 },
  saveBtnText: { fontSize: 14, fontWeight: "700", color: Colors.textInverse },
  saveBtnTextDisabled: { color: Colors.textMuted },
});

export default function StockUpdScreen() {
  const { orders, clearAllOrders, suppliers, updateOrder, setSupplierGeneralNotes, setSupplierPhotos, mrpEntries, promoEntries, lastSupplyDates } = useApp();
  const mrpMap = useMemo(() => {
    const m: Record<string, number[]> = {};
    for (const e of mrpEntries) {
      const k = e.itemNo.trim().toUpperCase();
      if (!m[k]) m[k] = [];
      if (!m[k].includes(e.mrp)) m[k].push(e.mrp);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => a - b);
    return m;
  }, [mrpEntries]);
  // Index of promo rows by Item No (uppercase, trimmed). Each Item No
  // can have several promo variants (different MRP / Batch); we keep
  // the full list so the row strip can pick the most relevant one
  // (currently the first occurrence — same first-wins rule the Promo
  // tab uses for its dedupe).
  const promoMap = useMemo(() => {
    const m: Record<string, PromoEntry[]> = {};
    for (const e of promoEntries) {
      const k = String(e["Item No"] ?? "").trim().toUpperCase();
      if (!k) continue;
      if (!m[k]) m[k] = [];
      m[k].push(e);
    }
    return m;
  }, [promoEntries]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [activeBrands, setActiveBrands] = useState<string[]>([]);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [brandSearch, setBrandSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [activeVendors, setActiveVendors] = useState<string[]>([]);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");
  const [activeBeats, setActiveBeats] = useState<string[]>([]);
  const [showBeatModal, setShowBeatModal] = useState(false);
  const [beatSearch, setBeatSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [negStockOnly, setNegStockOnly] = useState(false);
  const [multipleMrpOnly, setMultipleMrpOnly] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  // LastPurchRange filter — when active, an order is kept only if its
  // supplier's vendor code appears in the LastSupplyDate table AND
  // that table's Latest Invoice Date falls inside [from, to] inclusive.
  const [lastPurchFrom, setLastPurchFrom] = useState<Date | null>(null);
  const [lastPurchTo, setLastPurchTo] = useState<Date | null>(null);
  const [showLastPurchModal, setShowLastPurchModal] = useState(false);
  const [lastPurchFromDraft, setLastPurchFromDraft] = useState<Date>(() => startOfDay(new Date()));
  const [lastPurchToDraft, setLastPurchToDraft] = useState<Date>(() => startOfDay(new Date()));
  const [showLastPurchFromPicker, setShowLastPurchFromPicker] = useState(false);
  const [showLastPurchToPicker, setShowLastPurchToPicker] = useState(false);
  const [lastPurchError, setLastPurchError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  // Multi-level "Sort by" — committed value drives the list, draft is
  // edited inside the modal and only commits on Apply so users can
  // back out of changes by tapping the backdrop.
  const [sortLevels, setSortLevels] = useState<SortLevel[]>(EMPTY_SORT_LEVELS);
  const [sortLevelsDraft, setSortLevelsDraft] = useState<SortLevel[]>(EMPTY_SORT_LEVELS);
  const [showSortModal, setShowSortModal] = useState(false);
  const orderSortLevels = useMemo(
    () =>
      sortLevels.filter(
        (l): l is NonNullable<SortLevel> =>
          l != null && SORT_FIELD_BY_KEY[l.key].scope === "order",
      ),
    [sortLevels],
  );
  const itemSortLevels = useMemo(
    () =>
      sortLevels.filter(
        (l): l is NonNullable<SortLevel> =>
          l != null && SORT_FIELD_BY_KEY[l.key].scope === "item",
      ),
    [sortLevels],
  );
  const sortActive = orderSortLevels.length > 0 || itemSortLevels.length > 0;
  const sortBarLabel = useMemo(() => {
    const active = sortLevels.filter((l): l is NonNullable<SortLevel> => l != null);
    if (active.length === 0) return "Sort by";
    return active
      .map((l) => {
        const def = SORT_FIELD_BY_KEY[l.key];
        return `${def.label} ${shortDirLabelFor(def.type, l.dir)}`;
      })
      .join("  ›  ");
  }, [sortLevels]);

  const statusFiltered = useMemo(() => {
    if (activeFilter === "all") return orders;
    return orders.filter((o) => o.status === activeFilter);
  }, [orders, activeFilter]);

  // vendorCode (uppercase) → parsed Latest Invoice Date. Built once per
  // import so the LastPurchRange filter can do O(1) lookups per order.
  // Entries with missing or unparseable dates are skipped — those vendors
  // simply never match the date range filter.
  const lastSupplyMap = useMemo(() => {
    const m = new Map<string, Date>();
    for (const e of lastSupplyDates) {
      const code = e.vendorCode.trim().toUpperCase();
      if (!code) continue;
      const d = parseDateStr(e.latestInvoiceDate);
      if (d) m.set(code, startOfDay(d));
    }
    return m;
  }, [lastSupplyDates]);

  // Quick lookup: order id → supplier vendorCode (uppercase). Lets us
  // apply the LastPurchRange filter without rescanning the suppliers
  // array on every order during the main filter pass.
  const orderVendorCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of orders) {
      const sup = suppliers.find((s) => s.id === o.supplierId);
      const code = (sup?.vendorCode ?? "").trim().toUpperCase();
      if (code) m.set(o.id, code);
    }
    return m;
  }, [orders, suppliers]);

  const lastPurchActive = lastPurchFrom != null && lastPurchTo != null;

  // ---------------------------------------------------------------
  // Faceted filter scoping
  //
  // Each filter dimension (Vendor / Brand / Category / Beat / LastPurch)
  // narrows the visible orders. Each dimension's own option list is
  // built from the orders that pass *every other* active filter — so
  // opening Brand after picking a Vendor only lists brands carried by
  // that vendor's orders, opening Category after picking a Brand only
  // lists categories within that brand, etc. Each filter still shows
  // its own siblings (so the user can switch their selection inside a
  // dimension without first clearing it).
  //
  // `applyOrderFilters` is the single source of truth: pass `skip` to
  // exclude one (or more) dimensions from the cascade. It always runs
  // on `statusFiltered` so the status chip remains the outermost
  // filter.
  // ---------------------------------------------------------------
  type FilterDim = "vendor" | "brand" | "category" | "beat" | "lastPurch";

  const applyOrderFilters = useMemo(() => {
    return (skip: ReadonlySet<FilterDim> = new Set()) => {
      let r = statusFiltered;
      if (!skip.has("vendor") && activeVendors.length > 0) {
        r = r.filter(
          (o) => o.supplierName != null && activeVendors.includes(o.supplierName)
        );
      }
      if (!skip.has("brand") && activeBrands.length > 0) {
        r = r.filter((o) =>
          o.items.some((it) => it.brand != null && activeBrands.includes(it.brand))
        );
      }
      if (!skip.has("category") && activeCategories.length > 0) {
        r = r.filter((o) =>
          o.items.some(
            (it) => it.category != null && activeCategories.includes(it.category)
          )
        );
      }
      if (!skip.has("beat") && activeBeats.length > 0) {
        r = r.filter((o) => {
          const b = (o.beat ?? "").trim();
          return b !== "" && activeBeats.includes(b);
        });
      }
      if (!skip.has("lastPurch") && lastPurchActive) {
        const fromMs = lastPurchFrom!.getTime();
        const toMs = lastPurchTo!.getTime();
        r = r.filter((o) => {
          const code = orderVendorCode.get(o.id);
          if (!code) return false;
          const d = lastSupplyMap.get(code);
          if (!d) return false;
          const t = d.getTime();
          return t >= fromMs && t <= toMs;
        });
      }
      return r;
    };
  }, [
    statusFiltered,
    activeVendors,
    activeBrands,
    activeCategories,
    activeBeats,
    lastPurchActive,
    lastPurchFrom,
    lastPurchTo,
    orderVendorCode,
    lastSupplyMap,
  ]);

  // `vendorScopedOrders` is kept for the few callers that specifically
  // want "everything except a vendor restriction" applied. It now also
  // respects every other active filter, so it shrinks as more filters
  // are picked.
  const vendorScopedOrders = useMemo(
    () => applyOrderFilters(new Set(["vendor"])),
    [applyOrderFilters]
  );

  // Per-dimension order pools used to build option lists and counts.
  // Each pool excludes only its own dimension so the user can still
  // swap selections within a dimension without first clearing it.
  // (`vendorScopedOrders` already covers the "skip vendor" case and is
  // reused as `ordersForVendorOptions`.)
  const ordersForBrandOptions = useMemo(
    () => applyOrderFilters(new Set(["brand"])),
    [applyOrderFilters]
  );
  const ordersForCategoryOptions = useMemo(
    () => applyOrderFilters(new Set(["category"])),
    [applyOrderFilters]
  );
  const ordersForBeatOptions = useMemo(
    () => applyOrderFilters(new Set(["beat"])),
    [applyOrderFilters]
  );

  const allVendors = useMemo(() => {
    const set = new Set<string>();
    vendorScopedOrders.forEach((o) => {
      if (o.supplierName) set.add(o.supplierName);
    });
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  }, [vendorScopedOrders]);

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    const catSet = activeCategories.length > 0 ? new Set(activeCategories) : null;
    ordersForBrandOptions.forEach((o) =>
      o.items.forEach((item) => {
        if (!item.brand) return;
        // When categories are selected, only surface brands whose items
        // also fall under one of those categories — otherwise picking
        // category first then brand would offer brands that disappear
        // the moment they're selected.
        if (catSet && !(item.category != null && catSet.has(item.category))) return;
        set.add(item.brand);
      })
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [ordersForBrandOptions, activeCategories]);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    const brandSet = activeBrands.length > 0 ? new Set(activeBrands) : null;
    ordersForCategoryOptions.forEach((o) =>
      o.items.forEach((item) => {
        if (!item.category) return;
        if (brandSet && !(item.brand != null && brandSet.has(item.brand))) return;
        set.add(item.category);
      })
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [ordersForCategoryOptions, activeBrands]);

  const allBeats = useMemo(() => {
    const set = new Set<string>();
    ordersForBeatOptions.forEach((o) => {
      const b = (o.beat ?? "").trim();
      if (b) set.add(b);
    });
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  }, [ordersForBeatOptions]);

  // Drop selections that no longer exist in the freshly-faceted lists
  // (e.g. a vendor was deselected and the brand they uniquely supplied
  // is no longer offered). Without this the active chip would still
  // show but match nothing, leaving the user with an empty result and
  // no obvious way to recover.
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

  useEffect(() => {
    if (activeBeats.length === 0) return;
    const allowed = new Set(allBeats);
    const next = activeBeats.filter((b) => allowed.has(b));
    if (next.length !== activeBeats.length) setActiveBeats(next);
  }, [allBeats, activeBeats]);

  useEffect(() => {
    if (activeVendors.length === 0) return;
    const allowed = new Set(allVendors);
    const next = activeVendors.filter((v) => allowed.has(v));
    if (next.length !== activeVendors.length) setActiveVendors(next);
  }, [allVendors, activeVendors]);

  const filtered = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    let result = statusFiltered.filter((o) => {
      const vendorOk =
        activeVendors.length === 0 ||
        (o.supplierName != null && activeVendors.includes(o.supplierName));
      if (!vendorOk) return false;
      const brandOk =
        activeBrands.length === 0 ||
        o.items.some((it) => it.brand != null && activeBrands.includes(it.brand));
      if (!brandOk) return false;
      const categoryOk =
        activeCategories.length === 0 ||
        o.items.some((it) => it.category != null && activeCategories.includes(it.category));
      if (!categoryOk) return false;
      if (!q) return true;
      return o.items.some((it) => {
        const desc = it.name.includes(" - ")
          ? it.name.split(" - ").slice(1).join(" - ")
          : it.name;
        return desc.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
      });
    });
    const filterSubset = (items: OrderItem[]) => {
      let sub = activeBrands.length === 0
        ? items
        : items.filter((it) => it.brand != null && activeBrands.includes(it.brand));
      if (activeCategories.length > 0) {
        sub = sub.filter((it) => it.category != null && activeCategories.includes(it.category));
      }
      return sub;
    };
    if (negStockOnly) {
      result = result.filter((o) => {
        const subset = filterSubset(o.items);
        const searchSubset = q
          ? subset.filter((it) => {
              const desc = it.name.includes(" - ")
                ? it.name.split(" - ").slice(1).join(" - ")
                : it.name;
              return desc.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
            })
          : subset;
        return searchSubset.some((it) => it.stock != null && it.stock < 0);
      });
    }
    if (multipleMrpOnly) {
      result = result.filter((o) => {
        const subset = filterSubset(o.items);
        const searchSubset = q
          ? subset.filter((it) => {
              const desc = it.name.includes(" - ")
                ? it.name.split(" - ").slice(1).join(" - ")
                : it.name;
              return desc.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
            })
          : subset;
        return searchSubset.some((it) => {
          const itemNo = it.name.includes(" - ") ? it.name.split(" - ")[0].trim().toUpperCase() : "";
          return itemNo !== "" && mrpMap[itemNo]?.length > 0;
        });
      });
    }
    if (lastPurchActive) {
      const fromMs = lastPurchFrom!.getTime();
      const toMs = lastPurchTo!.getTime();
      result = result.filter((o) => {
        const code = orderVendorCode.get(o.id);
        if (!code) return false;
        const d = lastSupplyMap.get(code);
        if (!d) return false;
        const t = d.getTime();
        return t >= fromMs && t <= toMs;
      });
    }
    if (activeBeats.length > 0) {
      const beatSet = new Set(activeBeats);
      result = result.filter((o) => {
        const b = (o.beat ?? "").trim();
        return b !== "" && beatSet.has(b);
      });
    }
    // Apply order-level "Sort by" criteria when configured. Each
    // criterion is walked in priority order; the first non-zero result
    // wins. Without any order-level criteria we keep the legacy
    // alphabetical-by-vendor ordering so the existing default doesn't
    // change for users who never open the Sort modal.
    if (orderSortLevels.length > 0) {
      return [...result].sort((a, b) => {
        for (const c of orderSortLevels) {
          const def = SORT_FIELD_BY_KEY[c.key];
          const r = cmpSortVal(
            getOrderSortValue(a, c.key),
            getOrderSortValue(b, c.key),
            def.type,
            c.dir,
          );
          if (r !== 0) return r;
        }
        return 0;
      });
    }
    return [...result].sort((a, b) =>
      (a.supplierName ?? "").localeCompare(b.supplierName ?? "", undefined, { sensitivity: "base" })
    );
  }, [statusFiltered, activeVendors, activeBrands, activeCategories, itemSearch, negStockOnly, multipleMrpOnly, mrpMap, lastPurchActive, lastPurchFrom, lastPurchTo, orderVendorCode, lastSupplyMap, activeBeats, orderSortLevels]);

  function toggleVendor(name: string) {
    setActiveVendors((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]
    );
  }

  function vendorOrderCount(name: string): number {
    // Count within the vendor-options pool so the badge reflects the
    // narrowing already applied by Brand / Category / Beat / LastPurch.
    return vendorScopedOrders.filter((o) => o.supplierName === name).length;
  }

  function toggleBrand(brand: string) {
    setActiveBrands((prev) =>
      prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]
    );
  }

  function brandOrderCount(brand: string): number {
    // Count within the brand-options pool so badges narrow as
    // Vendor / Category / Beat / LastPurch are applied. When a
    // category is also active, only count orders whose item carries
    // both the brand AND one of the selected categories.
    const catSet = activeCategories.length > 0 ? new Set(activeCategories) : null;
    return ordersForBrandOptions.filter((o) =>
      o.items.some(
        (item) =>
          item.brand === brand &&
          (!catSet || (item.category != null && catSet.has(item.category)))
      )
    ).length;
  }

  function toggleCategory(category: string) {
    setActiveCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  }

  function toggleBeat(beat: string) {
    setActiveBeats((prev) =>
      prev.includes(beat) ? prev.filter((b) => b !== beat) : [...prev, beat]
    );
  }

  function beatOrderCount(beat: string): number {
    return ordersForBeatOptions.filter((o) => (o.beat ?? "").trim() === beat).length;
  }

  function categoryOrderCount(category: string): number {
    // When a brand is selected, count only orders with at least one
    // item that matches BOTH the category and one of the active brands —
    // matches the brand-scoped category list shown in the picker. Use
    // the category-options pool so Vendor / Beat / LastPurch also
    // narrow the count.
    const brandSet = activeBrands.length > 0 ? new Set(activeBrands) : null;
    return ordersForCategoryOptions.filter((o) =>
      o.items.some(
        (item) =>
          item.category === category &&
          (!brandSet || (item.brand != null && brandSet.has(item.brand)))
      )
    ).length;
  }

  async function handleExport() {
    try {
      setDownloading(true);
      const colHeader = ["Item No", "Item Description", "UOM", "MRP", "Stock", "Order Qty", "New Stock Qty", "Notes"];
      const dataRows: (string | number)[][] = [];
      const suppliersWithData = new Set<string>();
      for (const order of filtered) {
        let exportItems = activeBrands.length > 0
          ? order.items.filter((it) => it.brand != null && activeBrands.includes(it.brand))
          : order.items;
        if (activeCategories.length > 0) {
          exportItems = exportItems.filter((it) => it.category != null && activeCategories.includes(it.category));
        }
        if (itemSortLevels.length > 0) {
          exportItems = [...exportItems].sort((a, b) => {
            for (const c of itemSortLevels) {
              const def = SORT_FIELD_BY_KEY[c.key];
              const r = cmpSortVal(getItemSortValue(a, c.key), getItemSortValue(b, c.key), def.type, c.dir);
              if (r !== 0) return r;
            }
            return 0;
          });
        }
        for (const item of exportItems) {
          if (item.newStockQty == null) continue;
          const itemNo = item.name.includes(" - ") ? item.name.split(" - ")[0] : "";
          const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
          dataRows.push([
            itemNo,
            desc,
            item.unit,
            item.unitPrice,
            item.stock ?? "",
            item.quantity,
            item.newStockQty,
            item.notes ?? "",
          ]);
          suppliersWithData.add(order.supplierName);
        }
      }
      if (dataRows.length === 0) {
        Alert.alert("Nothing to Export", "No items have a New Stock Qty value yet.");
        setDownloading(false);
        return;
      }
      const uniqueSuppliers = [...suppliersWithData].sort().join(", ");
      const exportDate = new Date().toLocaleDateString("en-IN");
      const sheetData: (string | number)[][] = [
        ["Sathyam Super Store",                                                  "", "ORDER FORM",  "", "", "", "", ""],
        ["2A,Mettupalayam Road, Cheran Nagar",                                   "", "",            "", "", "", "", ""],
        ["Coimbatore-641029",                                                    "", "",            "", "", "", "", ""],
        ["98431-44868",                                                          "", "",            "", "", "", "", ""],
        ["Whatsapp: 97881-44868",                                                "", "",            "", "", "", "", ""],
        ["Accounts: 97868-64868 For sharing Credit Notes, and Vendor payment enquiry", "", "", "", "", "", "", ""],
        ["GST# : 33ADFFS5244N1ZR",                                               "", "",            "", "", "", "", ""],
        ["***ORDER FORM MUST BE ATTACHED WITH INVOICE DURING DELIVERY ***",      "", "",            "", "", "", "", ""],
        ["", "", "", "", "", "", "", ""],
        colHeader,
        ...dataRows,
        ["", "", "", "", "", "", "", ""],
        [`Supplier : ${uniqueSuppliers}`,  "", "", "", "", "", "", ""],
        [`Order Date : ${exportDate}`,     "", "", "", "", "", "", ""],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [
        { wch: 14 }, { wch: 32 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 20 },
      ];
      const dataStartRow = 11;
      for (let i = 0; i < dataRows.length; i++) {
        const cellRefB = `B${dataStartRow + i}`;
        if (ws[cellRefB]) {
          ws[cellRefB].s = { alignment: { wrapText: true, vertical: "top" } };
        }
      }
      ws["!pageSetup"] = {
        paperSize: 9,
        orientation: "portrait",
        fitToWidth: 1,
        fitToHeight: 0,
        scale: 100,
      };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "StockUpd");
      const _d = new Date();
      const _pad = (n: number) => String(n).padStart(2, "0");
      const _ts = `${_pad(_d.getDate())}${_pad(_d.getMonth() + 1)}${_d.getFullYear()} ${_pad(_d.getHours())}${_pad(_d.getMinutes())}`;
      const fileName = `Sathyam Super Store - ${_ts}.xlsx`;
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
            dialogTitle: "Export StockUpd",
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

  async function handlePdfExport() {
    if (filtered.length === 0) {
      Alert.alert("No Orders", "There are no orders to export.");
      return;
    }
    setDownloadingPdf(true);
    try {
      const cols = ["Item Description", "MRP", "UOM", "Order Qty", "Notes"];
      const rows: string[][] = [];
      const suppliersWithData = new Set<string>();
      for (const order of filtered) {
        let exportItems = activeBrands.length > 0
          ? order.items.filter((it) => it.brand != null && activeBrands.includes(it.brand))
          : order.items;
        if (activeCategories.length > 0) {
          exportItems = exportItems.filter((it) => it.category != null && activeCategories.includes(it.category));
        }
        if (itemSortLevels.length > 0) {
          exportItems = [...exportItems].sort((a, b) => {
            for (const c of itemSortLevels) {
              const def = SORT_FIELD_BY_KEY[c.key];
              const r = cmpSortVal(getItemSortValue(a, c.key), getItemSortValue(b, c.key), def.type, c.dir);
              if (r !== 0) return r;
            }
            return 0;
          });
        }
        for (const item of exportItems) {
          const desc = item.name.includes(" - ") ? item.name.split(" - ").slice(1).join(" - ") : item.name;
          rows.push([desc, String(item.unitPrice), item.unit, String(item.quantity), item.notes ?? ""]);
          suppliersWithData.add(order.supplierName);
        }
      }
      if (rows.length === 0) {
        Alert.alert("Nothing to Export", "There are no items to export.");
        setDownloadingPdf(false);
        return;
      }
      const supplierName = [...suppliersWithData].sort().join(", ");
      const exportDate = new Date().toLocaleDateString("en-IN");

      // Photos belong to a single supplier, so they only render when the
      // export is scoped to one supplier (mirrors how the My Orders PDF
      // resolves footerSupplier). Multi-supplier exports skip the photos
      // block entirely rather than mixing attachments from different
      // suppliers under one shared footer.
      const exportSupplierIds = new Set<string>();
      for (const o of filtered) exportSupplierIds.add(o.supplierId);
      const exportSupplier = exportSupplierIds.size === 1
        ? suppliers.find((s) => s.id === [...exportSupplierIds][0])
        : undefined;
      // Only inline strings that look like a real base64 image data URI.
      // Anything else is dropped so a malformed entry can't break or
      // inject into the print HTML.
      const PHOTO_URI_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
      const safePhotos = (exportSupplier?.photos ?? []).filter((p) => PHOTO_URI_RE.test(p));
      const photosHtml = safePhotos.length > 0
        ? `<div class="photos">${safePhotos
            .map((src) => `<img src="${src}" class="photo"/>`)
            .join("")}</div>`
        : "";

      const escapeHtml = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      // Supplier-level notes block in the footer. Mirrors My Orders so the
      // photos appear immediately below the notes block (and above the
      // supplier/date lines). Empty string when the supplier has no notes
      // so the layout stays unchanged for suppliers without notes/photos.
      const footerNotesRaw = (exportSupplier?.generalNotes ?? "").trim();
      const footerNotesHtml = footerNotesRaw
        ? `<div class="footer-notes">${escapeHtml(footerNotesRaw).replace(/\r?\n/g, "<br/>")}</div>`
        : "";
      const thCells = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
      const tdRows = rows.map((row, i) => {
        const bg = i % 2 === 0 ? "#ffffff" : "#f7f8fa";
        const tds = row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("");
        return `<tr style="background:${bg}">${tds}</tr>`;
      }).join("");

      const html = `<!DOCTYPE html>
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
  td:nth-child(2), td:nth-child(3), td:nth-child(4) { text-align: right; }
  .footer { margin-top: 10px; font-size: 8.5pt; }
  .footer-notes { margin-bottom: 4px; word-wrap: break-word; }
  .photos { margin: 6px 0 8px; display: flex; flex-direction: row; gap: 6px; flex-wrap: wrap; }
  .photo { width: 32%; max-height: 70mm; object-fit: contain; border: 1px solid #ccc; }
  .clearfix::after { content: ""; display: block; clear: both; }
</style>
</head>
<body>
<div class="letterhead clearfix">
  <div class="right-block">
    <div class="form-label">ORDER FORM</div>
    <img src="${LOGO_BASE64}" class="logo" alt="Logo"/>
  </div>
  <div class="store">Sathyam Super Store</div>
  <div>2A, Mettupalayam Road, Cheran Nagar</div>
  <div>Coimbatore-641029</div>
  <div>98431-44868</div>
  <div>Whatsapp: 97881-44868</div>
  <div>Accounts: 97868-64868 For sharing Credit Notes, and Vendor payment enquiry</div>
  <div>GST# : 33ADFFS5244N1ZR</div>
  <div class="notice">*** ORDER FORM MUST BE ATTACHED WITH INVOICE DURING DELIVERY ***</div>
</div>
<table>
  <thead><tr>${thCells}</tr></thead>
  <tbody>${tdRows}</tbody>
</table>
<div class="footer">
  ${footerNotesHtml}
  ${photosHtml}
  <div>Supplier : ${escapeHtml(supplierName)}</div>
  <div>Order Date : ${exportDate}</div>
</div>
</body>
</html>`;

      if (Platform.OS === "web") {
        // On web inside a nested iframe (Replit Canvas, Expo Web preview),
        // `Print.printAsync({ html })` falls back to printing the visible
        // parent frame instead of the html we passed — that's why the
        // letterhead/footer would vanish and the PDF looked like a
        // screenshot of the screen. Bypass expo-print on web and open
        // the html in a new tab ourselves; the document title becomes
        // the default "Save as PDF" filename.
        const _d2 = new Date();
        const _pad2 = (n: number) => String(n).padStart(2, "0");
        const _ts2 = `${_pad2(_d2.getDate())}${_pad2(_d2.getMonth() + 1)}${_d2.getFullYear()} ${_pad2(_d2.getHours())}${_pad2(_d2.getMinutes())}`;
        const pdfTitle = `Sathyam Super Store Order ${_ts2}`;
        const titledHtml = html.replace(
          /<head>/i,
          `<head><title>${pdfTitle}</title>`,
        );
        const win = window.open("", "_blank");
        if (!win) {
          throw new Error(
            "Popup blocked. Please allow popups for this site to export PDFs.",
          );
        }
        win.document.open();
        win.document.write(titledHtml);
        win.document.close();
        // Wait for the logo image (base64) to decode before printing so
        // the letterhead renders correctly in the print preview.
        const triggerPrint = () => {
          try {
            win.focus();
            win.print();
          } catch {
            // Some browsers throw if the window was closed before print fires.
          }
        };
        if (win.document.readyState === "complete") {
          setTimeout(triggerPrint, 300);
        } else {
          win.addEventListener("load", () => setTimeout(triggerPrint, 300));
        }
      } else {
        // expo-print's `fileName` option is ignored — it always writes
        // to a temp file with an auto-generated name like "~123.pdf".
        // To make the Share sheet show our chosen name, we generate the
        // PDF, then copy it to a fresh path in cacheDirectory using the
        // "Sathyam Super Store Order DDMMYYYY HHMM.pdf" convention, and share
        // that copy instead.
        const _d2 = new Date();
        const _pad2 = (n: number) => String(n).padStart(2, "0");
        const _ts2 = `${_pad2(_d2.getDate())}${_pad2(_d2.getMonth() + 1)}${_d2.getFullYear()} ${_pad2(_d2.getHours())}${_pad2(_d2.getMinutes())}`;
        const pdfFileName = `Sathyam Super Store Order ${_ts2}.pdf`;
        const { uri: tmpUri } = await Print.printToFileAsync({ html });
        let shareUri = tmpUri;
        const cacheDir = FileSystem.cacheDirectory;
        if (cacheDir) {
          const targetUri = cacheDir + encodeURIComponent(pdfFileName);
          try {
            // Remove any leftover file from a previous export with the
            // same minute-precision timestamp so copyAsync doesn't fail.
            await FileSystem.deleteAsync(targetUri, { idempotent: true });
            await FileSystem.copyAsync({ from: tmpUri, to: targetUri });
            shareUri = targetUri;
          } catch {
            // If the rename fails for any reason, fall back to sharing
            // the original temp file rather than blocking the export.
            shareUri = tmpUri;
          }
        }
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(shareUri, {
            mimeType: "application/pdf",
            dialogTitle: "Export PDF",
            UTI: "com.adobe.pdf",
          });
        } else {
          Alert.alert("PDF saved", `File saved to: ${shareUri}`);
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("PDF Export Failed", e?.message ?? "Unknown error");
    } finally {
      setDownloadingPdf(false);
    }
  }

  async function doClearAll() {
    try {
      await clearAllOrders();
      setActiveFilter("all");
      setActiveBrands([]);
    } catch {
      showStorageErrorAlert();
    }
  }

  function handleClearAll() {
    if (orders.length === 0) return;
    const msg = `This will permanently delete all ${orders.length} order${orders.length !== 1 ? "s" : ""}. This cannot be undone.`;
    if (Platform.OS === "web") {
      if (window.confirm(`Remove All Orders\n\n${msg}`)) {
        void doClearAll();
      }
      return;
    }
    Alert.alert(
      "Remove All Orders",
      msg,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove All",
          style: "destructive",
          onPress: () => {
            void doClearAll();
          },
        },
      ]
    );
  }

  const handleSaveOrder = useCallback(
    async (orderId: string, items: OrderItem[]): Promise<boolean> => {
      try {
        await updateOrder(orderId, { items, totalAmount: calcTotal(items) });
        return true;
      } catch {
        showStorageErrorAlert();
        return false;
      }
    },
    [updateOrder]
  );

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;
  const brandActive = activeBrands.length > 0;
  const brandBarLabel = activeBrands.length === 0
    ? "All Brands"
    : activeBrands.length === 1
    ? "1 Brand"
    : `${activeBrands.length} Brands`;
  const categoryActive = activeCategories.length > 0;
  const categoryBarLabel = activeCategories.length === 0
    ? "All Categories"
    : activeCategories.length === 1
    ? "1 Category"
    : `${activeCategories.length} Categories`;
  const vendorActive = activeVendors.length > 0;
  const vendorBarLabel = activeVendors.length === 0
    ? "All Vendors"
    : activeVendors.length === 1
    ? activeVendors[0]
    : `${activeVendors.length} Vendors`;
  const beatActive = activeBeats.length > 0;
  const beatBarLabel = activeBeats.length === 0
    ? "All Beats"
    : activeBeats.length === 1
    ? activeBeats[0]
    : `${activeBeats.length} Beats`;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>StockUpd</Text>
        <View style={styles.headerActions}>
          {orders.length > 0 && (
            <TouchableOpacity style={styles.clearAllBtn} onPress={handleClearAll}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.exportBtn}
            onPress={handleExport}
            disabled={downloading}
          >
            {downloading ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <Feather name="download" size={17} color={Colors.primary} />
            )}
            <Text style={styles.exportBtnText}>
              Export
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.pdfBtn, (downloadingPdf || filtered.length === 0) && { opacity: 0.5 }]}
            onPress={handlePdfExport}
            disabled={downloadingPdf || filtered.length === 0}
          >
            {downloadingPdf ? (
              <ActivityIndicator size="small" color="#dc2626" />
            ) : (
              <Feather name="file-text" size={16} color="#dc2626" />
            )}
            <Text style={styles.pdfBtnText}>{downloadingPdf ? "..." : "PDF"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.importBtn}
            onPress={() => router.push("/order/import")}
          >
            <Feather name="upload" size={17} color={Colors.primary} />
            <Text style={styles.importBtnText}>Import</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.driveBtn}
            onPress={() => router.push("/drive-import")}
          >
            <Feather name="hard-drive" size={17} color="#1a73e8" />
            <Text style={styles.driveBtnText}>DriveImport</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => router.push("/order/new")}
          >
            <Feather name="plus" size={20} color={Colors.textInverse} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Status + Brand filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
        style={styles.filtersScroll}
      >
        {STATUS_FILTERS.map((f) => {
          const count =
            f.key === "all"
              ? orders.length
              : orders.filter((o) => o.status === f.key).length;
          const isActive = activeFilter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              style={[styles.filter, isActive && styles.filterActive]}
              onPress={() => { setActiveFilter(f.key); setActiveBrands([]); setActiveCategories([]); setActiveBeats([]); }}
            >
              <Text style={[styles.filterText, isActive && styles.filterTextActive]}>
                {f.label}
              </Text>
              <View style={[styles.filterCount, isActive && styles.filterCountActive]}>
                <Text style={[styles.filterCountText, isActive && styles.filterCountTextActive]}>
                  {count}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Vendor + Brand row (2-col grid) */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.brandBar, styles.brandBarHalf, vendorActive && styles.brandBarActive]}
          onPress={() => { setVendorSearch(""); setShowVendorModal(true); }}
          activeOpacity={0.75}
        >
          <Feather
            name="users"
            size={14}
            color={vendorActive ? Colors.textInverse : Colors.textSecondary}
          />
          <Text
            style={[styles.brandBarText, vendorActive && styles.brandBarTextActive]}
            numberOfLines={1}
          >
            {vendorBarLabel}
          </Text>
          {vendorActive ? (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); setActiveVendors([]); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          ) : (
            <Feather name="chevron-down" size={14} color={Colors.textMuted} />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.brandBar, styles.brandBarHalf, brandActive && styles.brandBarActive]}
          onPress={() => { setBrandSearch(""); setShowBrandModal(true); }}
          activeOpacity={0.75}
        >
          <Feather
            name="tag"
            size={14}
            color={brandActive ? Colors.textInverse : Colors.textSecondary}
          />
          <Text
            style={[styles.brandBarText, brandActive && styles.brandBarTextActive]}
            numberOfLines={1}
          >
            {brandBarLabel}
          </Text>
          {brandActive ? (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); setActiveBrands([]); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          ) : (
            <Feather name="chevron-down" size={14} color={Colors.textMuted} />
          )}
        </TouchableOpacity>
      </View>

      {/* Category + Beat row (2-col grid) */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.brandBar, styles.brandBarHalf, categoryActive && styles.brandBarActive]}
          onPress={() => { setCategorySearch(""); setShowCategoryModal(true); }}
          activeOpacity={0.75}
        >
          <Feather
            name="folder"
            size={14}
            color={categoryActive ? Colors.textInverse : Colors.textSecondary}
          />
          <Text
            style={[styles.brandBarText, categoryActive && styles.brandBarTextActive]}
            numberOfLines={1}
          >
            {categoryBarLabel}
          </Text>
          {categoryActive ? (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); setActiveCategories([]); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          ) : (
            <Feather name="chevron-down" size={14} color={Colors.textMuted} />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.brandBar, styles.brandBarHalf, beatActive && styles.brandBarActive]}
          onPress={() => { setBeatSearch(""); setShowBeatModal(true); }}
          activeOpacity={0.75}
        >
          <Feather
            name="map-pin"
            size={14}
            color={beatActive ? Colors.textInverse : Colors.textSecondary}
          />
          <Text
            style={[styles.brandBarText, beatActive && styles.brandBarTextActive]}
            numberOfLines={1}
          >
            {beatBarLabel}
          </Text>
          {beatActive ? (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); setActiveBeats([]); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          ) : (
            <Feather name="chevron-down" size={14} color={Colors.textMuted} />
          )}
        </TouchableOpacity>
      </View>

      {/* Toggles row: Neg. Stock Only + Show Notes side by side */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.negStockToggle, styles.toggleHalf, negStockOnly && styles.negStockToggleActive]}
          onPress={() => setNegStockOnly((v) => !v)}
          activeOpacity={0.75}
        >
          <Feather
            name="trending-down"
            size={14}
            color={negStockOnly ? Colors.textInverse : Colors.textSecondary}
          />
          <Text style={[styles.negStockToggleText, negStockOnly && styles.negStockToggleTextActive]} numberOfLines={1}>
            Neg. Stock Only
          </Text>
          {negStockOnly && (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); setNegStockOnly(false); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.negStockToggle, styles.toggleHalf, showNotes && styles.negStockToggleActive]}
          onPress={() => setShowNotes((v) => !v)}
          activeOpacity={0.75}
        >
          <Feather
            name="edit-3"
            size={14}
            color={showNotes ? Colors.textInverse : Colors.textSecondary}
          />
          <Text style={[styles.negStockToggleText, showNotes && styles.negStockToggleTextActive]} numberOfLines={1}>
            {showNotes ? "Hide Notes" : "Show Notes"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* MultipleMRP + LastPurchRange filter row */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.negStockToggle, styles.toggleHalf, multipleMrpOnly && styles.negStockToggleActive]}
          onPress={() => setMultipleMrpOnly((v) => !v)}
          activeOpacity={0.75}
        >
          <Feather
            name="layers"
            size={14}
            color={multipleMrpOnly ? Colors.textInverse : Colors.textSecondary}
          />
          <Text style={[styles.negStockToggleText, multipleMrpOnly && styles.negStockToggleTextActive]} numberOfLines={1}>
            MultipleMRP
          </Text>
          {multipleMrpOnly && (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); setMultipleMrpOnly(false); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.negStockToggle, styles.toggleHalf, lastPurchActive && styles.negStockToggleActive]}
          onPress={() => {
            // Seed the calendar drafts from the currently committed
            // bounds when reopening, so the picker remembers what the
            // user last applied.
            setLastPurchFromDraft(lastPurchFrom ?? startOfDay(new Date()));
            setLastPurchToDraft(lastPurchTo ?? startOfDay(new Date()));
            setShowLastPurchFromPicker(false);
            setShowLastPurchToPicker(false);
            setLastPurchError(null);
            setShowLastPurchModal(true);
          }}
          activeOpacity={0.75}
        >
          <Feather
            name="calendar"
            size={14}
            color={lastPurchActive ? Colors.textInverse : Colors.textSecondary}
          />
          <Text style={[styles.negStockToggleText, lastPurchActive && styles.negStockToggleTextActive]} numberOfLines={1}>
            {lastPurchActive
              ? `${formatDDMMYYYY(lastPurchFrom!)} → ${formatDDMMYYYY(lastPurchTo!)}`
              : "LastPurchRange"}
          </Text>
          {lastPurchActive && (
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation?.();
                setLastPurchFrom(null);
                setLastPurchTo(null);
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x-circle" size={15} color={Colors.textInverse} />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </View>

      {/* Multi-level "Sort by" — opens a modal where the user can pick
          up to 3 sort criteria (e.g. Vendor → Brand → Category). When
          inactive the bar reads "Sort by"; when active it shows the
          full chain so the current order is visible at a glance. */}
      <TouchableOpacity
        style={[styles.brandBar, sortActive && styles.brandBarActive]}
        onPress={() => {
          setSortLevelsDraft(sortLevels);
          setShowSortModal(true);
        }}
        activeOpacity={0.75}
      >
        <Feather
          name="bar-chart-2"
          size={14}
          color={sortActive ? Colors.textInverse : Colors.textSecondary}
        />
        <Text
          style={[styles.brandBarText, sortActive && styles.brandBarTextActive]}
          numberOfLines={1}
        >
          {sortBarLabel}
        </Text>
        {sortActive ? (
          <TouchableOpacity
            onPress={(e) => {
              e.stopPropagation?.();
              setSortLevels(EMPTY_SORT_LEVELS);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="x-circle" size={15} color={Colors.textInverse} />
          </TouchableOpacity>
        ) : (
          <Feather name="chevron-down" size={14} color={Colors.textMuted} />
        )}
      </TouchableOpacity>

      {/* Item description search bar */}
      <View style={[styles.itemSearchBar, itemSearch.length > 0 && styles.itemSearchBarActive]}>
        <Feather name="search" size={14} color={itemSearch.length > 0 ? Colors.primary : Colors.textMuted} />
        <TextInput
          style={styles.itemSearchInput}
          value={itemSearch}
          onChangeText={setItemSearch}
          placeholder="Search by Item Description…"
          placeholderTextColor={Colors.textMuted}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {itemSearch.length > 0 && Platform.OS !== "ios" && (
          <TouchableOpacity onPress={() => setItemSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Feather name="x" size={14} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <StockUpdCard order={item} vendorCode={suppliers.find((s) => s.id === item.supplierId)?.vendorCode} supplier={suppliers.find((s) => s.id === item.supplierId)} activeBrands={activeBrands} activeCategories={activeCategories} itemSearch={itemSearch} negStockOnly={negStockOnly} showNotes={showNotes} multipleMrpOnly={multipleMrpOnly} mrpMap={mrpMap} promoMap={promoMap} itemSortLevels={itemSortLevels} onSave={handleSaveOrder} onSaveSupplierNotes={setSupplierGeneralNotes} onSaveSupplierPhotos={setSupplierPhotos} />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
          filtered.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="file-text"
            title="No orders found"
            subtitle={
              brandActive
                ? `No orders match the selected brand${activeBrands.length !== 1 ? "s" : ""}`
                : categoryActive
                ? `No orders match the selected categor${activeCategories.length !== 1 ? "ies" : "y"}`
                : activeFilter === "all"
                ? "Tap the + button to create your first order"
                : `No ${activeFilter} orders at the moment`
            }
          />
        }
        showsVerticalScrollIndicator={false}
      />

      {/* Brand filter modal */}
      <Modal
        visible={showBrandModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBrandModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowBrandModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter by Brand</Text>
            {brandActive && (
              <TouchableOpacity onPress={() => setActiveBrands([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allBrands.length > 0 && (
            <View style={styles.brandSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.brandSearchInput}
                value={brandSearch}
                onChangeText={setBrandSearch}
                placeholder="Search brands…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {brandSearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity onPress={() => setBrandSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allBrands.length === 0 ? (
            <View style={styles.noBrands}>
              <Feather name="tag" size={32} color={Colors.textMuted} />
              <Text style={styles.noBrandsTitle}>No Brands Yet</Text>
              <Text style={styles.noBrandsSub}>
                Import orders with a Brand column to filter by brand.
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.brandList} keyboardShouldPersistTaps="handled">
              {(() => {
                const q = brandSearch.trim().toLowerCase();
                const visibleBrands = q ? allBrands.filter((b) => b.toLowerCase().includes(q)) : allBrands;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[styles.brandRow, activeBrands.length === 0 && styles.brandRowActive]}
                        onPress={() => setActiveBrands([])}
                      >
                        <Text style={[styles.brandName, activeBrands.length === 0 && styles.brandNameActive]}>
                          All Brands
                        </Text>
                        <Text style={styles.brandCount}>{ordersForBrandOptions.length} orders</Text>
                        {activeBrands.length === 0 && <Feather name="check" size={16} color={Colors.primary} />}
                      </TouchableOpacity>
                    )}
                    {visibleBrands.length === 0 ? (
                      <View style={styles.noBrands}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noBrandsTitle}>No match</Text>
                        <Text style={styles.noBrandsSub}>No brands found for "{brandSearch}"</Text>
                      </View>
                    ) : (
                      visibleBrands.map((brand) => {
                        const isSelected = activeBrands.includes(brand);
                        const count = brandOrderCount(brand);
                        return (
                          <TouchableOpacity
                            key={brand}
                            style={[styles.brandRow, isSelected && styles.brandRowActive]}
                            onPress={() => toggleBrand(brand)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <Text style={[styles.brandName, isSelected && styles.brandNameActive]}>
                              {brand}
                            </Text>
                            <Text style={styles.brandCount}>{count} order{count !== 1 ? "s" : ""}</Text>
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
            onPress={() => setShowBrandModal(false)}
          >
            <Text style={styles.modalDoneBtnText}>
              {activeBrands.length === 0 ? "Close" : `Apply (${activeBrands.length} selected)`}
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
            {categoryActive && (
              <TouchableOpacity onPress={() => setActiveCategories([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allCategories.length > 0 && (
            <View style={styles.brandSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.brandSearchInput}
                value={categorySearch}
                onChangeText={setCategorySearch}
                placeholder="Search categories…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {categorySearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity onPress={() => setCategorySearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allCategories.length === 0 ? (
            <View style={styles.noBrands}>
              <Feather name="folder" size={32} color={Colors.textMuted} />
              <Text style={styles.noBrandsTitle}>No Categories Yet</Text>
              <Text style={styles.noBrandsSub}>
                Import orders with a Category column to filter by category.
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.brandList} keyboardShouldPersistTaps="handled">
              {(() => {
                const q = categorySearch.trim().toLowerCase();
                const visibleCategories = q ? allCategories.filter((c) => c.toLowerCase().includes(q)) : allCategories;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[styles.brandRow, activeCategories.length === 0 && styles.brandRowActive]}
                        onPress={() => setActiveCategories([])}
                      >
                        <Text style={[styles.brandName, activeCategories.length === 0 && styles.brandNameActive]}>
                          All Categories
                        </Text>
                        <Text style={styles.brandCount}>{ordersForCategoryOptions.length} orders</Text>
                        {activeCategories.length === 0 && <Feather name="check" size={16} color={Colors.primary} />}
                      </TouchableOpacity>
                    )}
                    {visibleCategories.length === 0 ? (
                      <View style={styles.noBrands}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noBrandsTitle}>No match</Text>
                        <Text style={styles.noBrandsSub}>No categories found for "{categorySearch}"</Text>
                      </View>
                    ) : (
                      visibleCategories.map((category) => {
                        const isSelected = activeCategories.includes(category);
                        const count = categoryOrderCount(category);
                        return (
                          <TouchableOpacity
                            key={category}
                            style={[styles.brandRow, isSelected && styles.brandRowActive]}
                            onPress={() => toggleCategory(category)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <Text style={[styles.brandName, isSelected && styles.brandNameActive]}>
                              {category}
                            </Text>
                            <Text style={styles.brandCount}>{count} order{count !== 1 ? "s" : ""}</Text>
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
              {activeCategories.length === 0 ? "Close" : `Apply (${activeCategories.length} selected)`}
            </Text>
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
            <Text style={styles.modalTitle}>Filter by Vendor</Text>
            {vendorActive && (
              <TouchableOpacity onPress={() => setActiveVendors([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allVendors.length > 0 && (
            <View style={styles.brandSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.brandSearchInput}
                value={vendorSearch}
                onChangeText={setVendorSearch}
                placeholder="Search vendors…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {vendorSearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity onPress={() => setVendorSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allVendors.length === 0 ? (
            <View style={styles.noBrands}>
              <Feather name="users" size={32} color={Colors.textMuted} />
              <Text style={styles.noBrandsTitle}>No Vendors Yet</Text>
              <Text style={styles.noBrandsSub}>
                Import or create orders to filter by vendor.
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.brandList} keyboardShouldPersistTaps="handled">
              {(() => {
                const q = vendorSearch.trim().toLowerCase();
                const visibleVendors = q ? allVendors.filter((v) => v.toLowerCase().includes(q)) : allVendors;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[styles.brandRow, activeVendors.length === 0 && styles.brandRowActive]}
                        onPress={() => setActiveVendors([])}
                      >
                        <Text style={[styles.brandName, activeVendors.length === 0 && styles.brandNameActive]}>
                          All Vendors
                        </Text>
                        <Text style={styles.brandCount}>{vendorScopedOrders.length} orders</Text>
                        {activeVendors.length === 0 && <Feather name="check" size={16} color={Colors.primary} />}
                      </TouchableOpacity>
                    )}
                    {visibleVendors.length === 0 ? (
                      <View style={styles.noBrands}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noBrandsTitle}>No match</Text>
                        <Text style={styles.noBrandsSub}>No vendors found for "{vendorSearch}"</Text>
                      </View>
                    ) : (
                      visibleVendors.map((vendor) => {
                        const isSelected = activeVendors.includes(vendor);
                        const count = vendorOrderCount(vendor);
                        return (
                          <TouchableOpacity
                            key={vendor}
                            style={[styles.brandRow, isSelected && styles.brandRowActive]}
                            onPress={() => toggleVendor(vendor)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <Text style={[styles.brandName, isSelected && styles.brandNameActive]} numberOfLines={1}>
                              {vendor}
                            </Text>
                            <Text style={styles.brandCount}>{count} order{count !== 1 ? "s" : ""}</Text>
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
              {activeVendors.length === 0 ? "Close" : `Apply (${activeVendors.length} selected)`}
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Beat filter modal — multi-select picker scoped to the beats
          present on currently visible (status + vendor scoped) orders. */}
      <Modal
        visible={showBeatModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBeatModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowBeatModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter by Beat</Text>
            {beatActive && (
              <TouchableOpacity onPress={() => setActiveBeats([])}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          {allBeats.length > 0 && (
            <View style={styles.brandSearchWrap}>
              <Feather name="search" size={15} color={Colors.textMuted} />
              <TextInput
                style={styles.brandSearchInput}
                value={beatSearch}
                onChangeText={setBeatSearch}
                placeholder="Search beats…"
                placeholderTextColor={Colors.textMuted}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {beatSearch.length > 0 && Platform.OS !== "ios" && (
                <TouchableOpacity onPress={() => setBeatSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={14} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {allBeats.length === 0 ? (
            <View style={styles.noBrands}>
              <Feather name="map-pin" size={32} color={Colors.textMuted} />
              <Text style={styles.noBrandsTitle}>No Beats Yet</Text>
              <Text style={styles.noBrandsSub}>
                Import orders with a Beat column to filter by beat.
              </Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.brandList} keyboardShouldPersistTaps="handled">
              {(() => {
                const q = beatSearch.trim().toLowerCase();
                const visibleBeats = q ? allBeats.filter((b) => b.toLowerCase().includes(q)) : allBeats;
                return (
                  <>
                    {!q && (
                      <TouchableOpacity
                        style={[styles.brandRow, activeBeats.length === 0 && styles.brandRowActive]}
                        onPress={() => setActiveBeats([])}
                      >
                        <Text style={[styles.brandName, activeBeats.length === 0 && styles.brandNameActive]}>
                          All Beats
                        </Text>
                        <Text style={styles.brandCount}>{ordersForBeatOptions.length} orders</Text>
                        {activeBeats.length === 0 && <Feather name="check" size={16} color={Colors.primary} />}
                      </TouchableOpacity>
                    )}
                    {visibleBeats.length === 0 ? (
                      <View style={styles.noBrands}>
                        <Feather name="search" size={28} color={Colors.textMuted} />
                        <Text style={styles.noBrandsTitle}>No match</Text>
                        <Text style={styles.noBrandsSub}>No beats found for "{beatSearch}"</Text>
                      </View>
                    ) : (
                      visibleBeats.map((beat) => {
                        const isSelected = activeBeats.includes(beat);
                        const count = beatOrderCount(beat);
                        return (
                          <TouchableOpacity
                            key={beat}
                            style={[styles.brandRow, isSelected && styles.brandRowActive]}
                            onPress={() => toggleBeat(beat)}
                          >
                            <Feather
                              name={isSelected ? "check-square" : "square"}
                              size={17}
                              color={isSelected ? Colors.primary : Colors.textMuted}
                            />
                            <Text style={[styles.brandName, isSelected && styles.brandNameActive]}>
                              {beat}
                            </Text>
                            <Text style={styles.brandCount}>{count} order{count !== 1 ? "s" : ""}</Text>
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
            onPress={() => setShowBeatModal(false)}
          >
            <Text style={styles.modalDoneBtnText}>
              {activeBeats.length === 0 ? "Close" : `Apply (${activeBeats.length} selected)`}
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* LastPurchRange filter modal — calendar-based From/To range picker
          that filters orders by their supplier's Latest Invoice Date
          (looked up by vendor code in the LastSupplyDate table). */}
      <Modal
        visible={showLastPurchModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLastPurchModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowLastPurchModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>LastPurchRange</Text>
            <TouchableOpacity
              onPress={() => {
                const today = startOfDay(new Date());
                setLastPurchFromDraft(today);
                setLastPurchToDraft(today);
                setLastPurchFrom(null);
                setLastPurchTo(null);
                setShowLastPurchFromPicker(false);
                setShowLastPurchToPicker(false);
                setLastPurchError(null);
              }}
            >
              <Text style={styles.modalClear}>Clear</Text>
            </TouchableOpacity>
          </View>

          {lastSupplyDates.length === 0 && (
            <View style={styles.lastPurchHint}>
              <Feather name="info" size={14} color={Colors.textMuted} />
              <Text style={styles.lastPurchHintText}>
                The LastSupplyDate table is empty. Import it from the
                Directory hub first, otherwise this filter will hide every
                order.
              </Text>
            </View>
          )}

          <View style={styles.dateRangeWrap}>
            <View style={styles.dateRangeField}>
              <Text style={styles.dateRangeLabel}>From</Text>
              <TouchableOpacity
                style={styles.dateRangeButton}
                onPress={() => {
                  setShowLastPurchToPicker(false);
                  setShowLastPurchFromPicker((v) => !v);
                  setLastPurchError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(lastPurchFromDraft)}
                </Text>
              </TouchableOpacity>
              {showLastPurchFromPicker && (
                <DateTimePicker
                  value={lastPurchFromDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    if (Platform.OS !== "ios") setShowLastPurchFromPicker(false);
                    if (selected) {
                      setLastPurchFromDraft(startOfDay(selected));
                      setLastPurchError(null);
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
                  setShowLastPurchFromPicker(false);
                  setShowLastPurchToPicker((v) => !v);
                  setLastPurchError(null);
                }}
              >
                <Feather name="calendar" size={14} color={Colors.primary} />
                <Text style={styles.dateRangeButtonText}>
                  {formatDDMMYYYY(lastPurchToDraft)}
                </Text>
              </TouchableOpacity>
              {showLastPurchToPicker && (
                <DateTimePicker
                  value={lastPurchToDraft}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={(_e, selected) => {
                    if (Platform.OS !== "ios") setShowLastPurchToPicker(false);
                    if (selected) {
                      setLastPurchToDraft(startOfDay(selected));
                      setLastPurchError(null);
                    }
                  }}
                />
              )}
            </View>
          </View>
          {lastPurchError && (
            <Text style={styles.dateRangeError}>{lastPurchError}</Text>
          )}
          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => {
              const from = startOfDay(lastPurchFromDraft);
              const to = startOfDay(lastPurchToDraft);
              if (from.getTime() > to.getTime()) {
                setLastPurchError("From date can't be after To date.");
                return;
              }
              setLastPurchFrom(from);
              setLastPurchTo(to);
              setShowLastPurchFromPicker(false);
              setShowLastPurchToPicker(false);
              setLastPurchError(null);
              setShowLastPurchModal(false);
            }}
          >
            <Text style={styles.modalDoneBtnText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Multi-level "Sort by" modal — three slots, each can pick any
          field and a direction. Edits stay in `sortLevelsDraft` and
          only commit on Apply, matching the LastPurchRange pattern. */}
      <Modal
        visible={showSortModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowSortModal(false)}
      >
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setShowSortModal(false)}
        />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16, maxHeight: "85%" }]}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Sort by</Text>
            {sortLevelsDraft.some((l) => l != null) && (
              <TouchableOpacity onPress={() => setSortLevelsDraft(EMPTY_SORT_LEVELS)}>
                <Text style={styles.modalClear}>Clear All</Text>
              </TouchableOpacity>
            )}
          </View>

          <ScrollView
            style={{ paddingHorizontal: 20 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.sortHint}>
              Pick up to 3 columns. Levels are applied in order — the
              first level groups the cards (e.g. Vendor), then within
              each group the next level orders the items, and so on.
            </Text>
            {[0, 1, 2].map((idx) => {
              const lvl = sortLevelsDraft[idx];
              const def = lvl ? SORT_FIELD_BY_KEY[lvl.key] : null;
              return (
                <View key={idx} style={styles.sortLevelBlock}>
                  <View style={styles.sortLevelHeader}>
                    <Text style={styles.sortLevelLabel}>
                      {idx === 0 ? "First by" : idx === 1 ? "Then by" : "Then by"}
                    </Text>
                    {lvl && def ? (
                      <TouchableOpacity
                        style={styles.sortDirBtn}
                        onPress={() =>
                          setSortLevelsDraft((prev) => {
                            const next = [...prev];
                            const cur = next[idx];
                            if (cur)
                              next[idx] = { ...cur, dir: cur.dir === "asc" ? "desc" : "asc" };
                            return next;
                          })
                        }
                        activeOpacity={0.75}
                      >
                        <Feather
                          name={lvl.dir === "asc" ? "arrow-up" : "arrow-down"}
                          size={13}
                          color={Colors.primary}
                        />
                        <Text style={styles.sortDirBtnText}>
                          {dirLabelFor(def.type, lvl.dir)}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={styles.sortLevelEmpty}>Not set</Text>
                    )}
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.sortChipsRow}
                  >
                    <TouchableOpacity
                      style={[styles.sortChip, !lvl && styles.sortChipActive]}
                      onPress={() =>
                        setSortLevelsDraft((prev) => {
                          const next = [...prev];
                          next[idx] = null;
                          return next;
                        })
                      }
                    >
                      <Text style={[styles.sortChipText, !lvl && styles.sortChipTextActive]}>
                        None
                      </Text>
                    </TouchableOpacity>
                    {SORT_FIELDS.map((f) => {
                      const isActive = lvl?.key === f.key;
                      // Disable the chip in this row if the same field
                      // is already used at a different level — prevents
                      // a no-op duplicate sort like "Vendor → Vendor".
                      const usedElsewhere = sortLevelsDraft.some(
                        (l, i) => i !== idx && l?.key === f.key,
                      );
                      return (
                        <TouchableOpacity
                          key={f.key}
                          style={[
                            styles.sortChip,
                            isActive && styles.sortChipActive,
                            usedElsewhere && styles.sortChipDisabled,
                          ]}
                          disabled={usedElsewhere}
                          onPress={() =>
                            setSortLevelsDraft((prev) => {
                              const next = [...prev];
                              next[idx] = { key: f.key, dir: "asc" };
                              return next;
                            })
                          }
                        >
                          <Text
                            style={[
                              styles.sortChipText,
                              isActive && styles.sortChipTextActive,
                              usedElsewhere && styles.sortChipTextDisabled,
                            ]}
                          >
                            {f.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              );
            })}
          </ScrollView>

          <TouchableOpacity
            style={styles.modalDoneBtn}
            onPress={() => {
              // Compact the draft so a Level 1 = None / Level 2 = Brand
              // case still works as a single-level sort. Keeps the UI
              // simple without forcing the user to fill earlier slots.
              const compact = sortLevelsDraft.filter(
                (l): l is NonNullable<SortLevel> => l != null,
              );
              const padded: SortLevel[] = [
                compact[0] ?? null,
                compact[1] ?? null,
                compact[2] ?? null,
              ];
              setSortLevels(padded);
              setSortLevelsDraft(padded);
              setShowSortModal(false);
            }}
          >
            <Text style={styles.modalDoneBtnText}>Apply</Text>
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
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  clearAllBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: Colors.dangerLight,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.danger + "30",
  },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.successLight ?? "#DCFCE7",
    borderWidth: 1,
    borderColor: Colors.success ? Colors.success + "40" : "#16A34A40",
  },
  exportBtnText: { fontSize: 14, fontWeight: "700", color: Colors.success ?? "#16A34A" },
  exportBtnTextDisabled: { color: Colors.textMuted },
  pdfBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca",
  },
  pdfBtnText: { fontSize: 13, fontWeight: "700", color: "#dc2626" },
  importBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  importBtnText: { fontSize: 14, fontWeight: "700", color: Colors.primary },
  driveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#e8f0fe",
    borderWidth: 1,
    borderColor: "#1a73e830",
  },
  driveBtnText: { fontSize: 14, fontWeight: "700", color: "#1a73e8" },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  filtersScroll: { maxHeight: 52 },
  filters: { paddingHorizontal: 20, paddingVertical: 8, gap: 8 },
  filter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 6,
  },
  filterActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  filterTextActive: { color: Colors.textInverse },
  filterCount: {
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  filterCountActive: { backgroundColor: "rgba(255,255,255,0.25)" },
  filterCountText: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  filterCountTextActive: { color: Colors.textInverse },
  brandBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  brandBarActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  brandBarText: { flex: 1, fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  brandBarTextActive: { color: Colors.textInverse },
  // Half-width variant so brandBar buttons can sit two-per-row inside
  // a `toggleRow` container instead of stacking full-width.
  brandBarHalf: {
    flex: 1,
    marginHorizontal: 0,
    marginBottom: 0,
  },
  itemSearchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  itemSearchBarActive: {
    borderColor: Colors.primary,
  },
  itemSearchInput: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.text,
    paddingVertical: 0,
  },
  list: { paddingHorizontal: 20, paddingTop: 8 },
  listEmpty: { flex: 1 },
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
  modalDoneBtn: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  modalDoneBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
  brandSearchWrap: {
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
  brandSearchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.text,
    paddingVertical: 0,
  },
  noBrands: {
    alignItems: "center",
    padding: 40,
    gap: 10,
  },
  noBrandsTitle: { fontSize: 16, fontWeight: "700", color: Colors.text },
  noBrandsSub: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  brandList: { paddingHorizontal: 20 },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  brandRowActive: { backgroundColor: Colors.primaryMuted + "80" },
  brandDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.warning,
  },
  brandName: { flex: 1, fontSize: 15, fontWeight: "600", color: Colors.text },
  brandNameActive: { color: Colors.primary },
  brandCount: { fontSize: 12, color: Colors.textMuted, marginRight: 4 },
  negStockToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  toggleRow: {
    flexDirection: "row",
    marginHorizontal: 20,
    marginBottom: 8,
    gap: 8,
  },
  toggleHalf: {
    flex: 1,
    marginHorizontal: 0,
    marginBottom: 0,
    justifyContent: "center",
  },
  negStockToggleActive: {
    backgroundColor: Colors.danger,
    borderColor: Colors.danger,
  },
  negStockToggleText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  negStockToggleTextActive: {
    color: Colors.textInverse,
  },
  // LastPurchRange modal — calendar-based From/To range picker.
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
  lastPurchHint: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    marginHorizontal: 20,
    marginBottom: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  lastPurchHintText: {
    flex: 1,
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  // ----- Multi-level "Sort by" modal -----
  sortHint: {
    fontSize: 12,
    color: Colors.textMuted,
    lineHeight: 17,
    marginBottom: 12,
  },
  sortLevelBlock: {
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  sortLevelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sortLevelLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    letterSpacing: 0.3,
  },
  sortLevelEmpty: {
    fontSize: 12,
    color: Colors.textMuted,
    fontStyle: "italic",
  },
  sortDirBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  sortDirBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.primary,
  },
  sortChipsRow: {
    gap: 8,
    paddingVertical: 2,
    paddingRight: 8,
  },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sortChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  sortChipDisabled: {
    opacity: 0.35,
  },
  sortChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  sortChipTextActive: {
    color: Colors.textInverse,
  },
  sortChipTextDisabled: {
    color: Colors.textMuted,
  },
});
