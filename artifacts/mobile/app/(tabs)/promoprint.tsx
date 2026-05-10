import React, { useMemo, useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  FlatList,
  Platform,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, type PromoEntry, type PriceTagItem } from "@/context/AppContext";
import { pickFont } from "@/constants/typography";

// Filter facets the user can narrow the Promo list by before picking
// items for the price-tag run. Beat is a synthesised facet derived from
// each row's vendor (we look the supplier up by VendorCode and use its
// `category` as the "beat") so legacy Promo imports without an explicit
// beat column still benefit.
type FacetKey = "vendor" | "brand" | "category" | "beat";
const FACETS: { key: FacetKey; label: string }[] = [
  { key: "vendor", label: "Vendor" },
  { key: "brand", label: "Brand" },
  { key: "category", label: "Category" },
  { key: "beat", label: "Beat" },
];

function s(v: string | number | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v).trim();
}

function rowKey(r: PromoEntry): string {
  return `${s(r["Item No"])}|${s(r["BatchNo"])}|${s(r["MRP"])}`;
}

function formatPrice(v: string | number | undefined): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toFixed(2);
}

export default function PromoPrintScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { promoEntries, suppliers, savePriceTagItems, priceTagItems } = useApp();

  // Map VendorCode -> supplier.category so we can synthesise a "Beat"
  // facet for Promo rows that don't have one of their own.
  const beatByVendorCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const sup of suppliers) {
      const code = (sup.vendorCode ?? "").trim();
      const cat = (sup.category ?? "").trim();
      if (code && cat) m.set(code, cat);
    }
    return m;
  }, [suppliers]);

  function beatFor(r: PromoEntry): string {
    const explicit = s(r["Beat"]);
    if (explicit) return explicit;
    const vc = s(r["VendorCode"]);
    return vc ? beatByVendorCode.get(vc) ?? "" : "";
  }

  // Selected filter values per facet (set of normalised lowercase keys).
  const [filters, setFilters] = useState<Record<FacetKey, Set<string>>>({
    vendor: new Set(),
    brand: new Set(),
    category: new Set(),
    beat: new Set(),
  });
  // Which facet's value list is open (null = none open).
  const [openFacet, setOpenFacet] = useState<FacetKey | null>(null);
  const [search, setSearch] = useState("");

  // Selected row keys. Seed with whatever's already in the saved
  // priceTagItems list so re-entering the screen shows current picks.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(priceTagItems.map((i) => i.key))
  );
  // Re-seed if the persisted list changes underneath us (e.g. after a
  // PriceTag Preview "Save" trims removed items).
  useEffect(() => {
    setSelected(new Set(priceTagItems.map((i) => i.key)));
  }, [priceTagItems]);

  function valueFor(r: PromoEntry, facet: FacetKey): string {
    if (facet === "vendor") return s(r["VendorName"]) || s(r["VendorCode"]);
    if (facet === "brand") return s(r["Brand"]);
    if (facet === "category") return s(r["Category"]);
    return beatFor(r);
  }

  // Cascading facet options: each facet's option list is computed from
  // the rows that already pass every OTHER facet's filter. So picking a
  // Vendor narrows the Brand list, picking a Brand narrows the
  // Category list, etc. Mirrors the StockUpd faceted filter pattern.
  const facetOptions = useMemo(() => {
    const out: Record<FacetKey, { value: string; count: number }[]> = {
      vendor: [], brand: [], category: [], beat: [],
    };
    for (const facet of FACETS.map((f) => f.key)) {
      const counts = new Map<string, number>();
      for (const r of promoEntries) {
        let pass = true;
        for (const other of FACETS.map((f) => f.key)) {
          if (other === facet) continue;
          const sel = filters[other];
          if (sel.size === 0) continue;
          const v = valueFor(r, other).toLowerCase();
          if (!sel.has(v)) { pass = false; break; }
        }
        if (!pass) continue;
        const v = valueFor(r, facet);
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      out[facet] = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value.localeCompare(b.value));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoEntries, filters, beatByVendorCode]);

  // Prune selected filter values that no longer appear in the
  // cascaded option list (e.g. user picked Brand X then chose a
  // Vendor that doesn't carry it). Keeps the UI honest.
  useEffect(() => {
    let changed = false;
    const next = { ...filters };
    for (const f of FACETS.map((x) => x.key)) {
      const valid = new Set(facetOptions[f].map((o) => o.value.toLowerCase()));
      const trimmed = new Set<string>();
      for (const v of filters[f]) if (valid.has(v)) trimmed.add(v);
      if (trimmed.size !== filters[f].size) {
        next[f] = trimmed;
        changed = true;
      }
    }
    if (changed) setFilters(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facetOptions]);

  // Final filtered list: rows that pass every active facet AND match
  // the free-text search. Empty filter set = "no constraint" for that
  // facet (matches all values).
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return promoEntries.filter((r) => {
      for (const f of FACETS.map((x) => x.key)) {
        const sel = filters[f];
        if (sel.size === 0) continue;
        const v = valueFor(r, f).toLowerCase();
        if (!sel.has(v)) return false;
      }
      if (!q) return true;
      return [
        s(r["Item No"]),
        s(r["Item Description"]),
        s(r["Brand"]),
        s(r["Category"]),
        s(r["VendorName"]),
      ].some((x) => x.toLowerCase().includes(q));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoEntries, filters, search, beatByVendorCode]);

  function toggleFilter(facet: FacetKey, value: string) {
    const key = value.toLowerCase();
    setFilters((prev) => {
      const next = new Set(prev[facet]);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [facet]: next };
    });
  }

  function clearFacet(facet: FacetKey) {
    setFilters((prev) => ({ ...prev, [facet]: new Set() }));
  }

  function clearAllFilters() {
    setFilters({ vendor: new Set(), brand: new Set(), category: new Set(), beat: new Set() });
    setSearch("");
  }

  function toggleRow(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of filteredRows) next.add(rowKey(r));
      return next;
    });
  }

  function deselectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of filteredRows) next.delete(rowKey(r));
      return next;
    });
  }

  async function onSave() {
    if (selected.size === 0) {
      Alert.alert("No items selected", "Pick at least one item to print a price tag for.");
      return;
    }
    // Append the selected Promo rows onto the existing PriceTag list
    // (de-duplicated by key). Items the user already had — including
    // any attached image — are kept as-is; new selections are added at
    // the end so they're easy to find on the preview screen.
    const existingByKey = new Map(priceTagItems.map((i) => [i.key, i]));
    const now = Date.now();
    const additions: PriceTagItem[] = [];
    for (const r of promoEntries) {
      const k = rowKey(r);
      if (!selected.has(k)) continue;
      if (existingByKey.has(k)) continue; // already in preview, keep prior copy
      additions.push({
        key: k,
        itemNo: s(r["Item No"]),
        description: s(r["Item Description"]),
        mrp: s(r["MRP"]),
        promotionPrice: s(r["PromotionPrice"]),
        sp: s(r["SP"]),
        brand: s(r["Brand"]) || undefined,
        category: s(r["Category"]) || undefined,
        vendorName: s(r["VendorName"]) || undefined,
        beat: beatFor(r) || undefined,
        promotionToDate: s(r["PromotionToDate"]) || undefined,
        addedAt: now,
      });
    }
    const merged = [...priceTagItems, ...additions];
    try {
      await savePriceTagItems(merged);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push("/pricetag-preview");
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message ?? "Storage error");
    }
  }

  const visibleSelectedCount = useMemo(() => {
    let n = 0;
    for (const r of filteredRows) if (selected.has(rowKey(r))) n++;
    return n;
  }, [filteredRows, selected]);

  const activeFilterCount =
    filters.vendor.size + filters.brand.size + filters.category.size + filters.beat.size;

  // Empty state — no Promo data at all.
  if (promoEntries.length === 0) {
    return (
      <View style={[styles.empty, { paddingTop: insets.top + 24 }]}>
        <Feather name="tag" size={48} color={Colors.textMuted} />
        <Text style={styles.emptyTitle}>No Promo items yet</Text>
        <Text style={styles.emptyBody}>
          Import a Promo workbook from the Promo tab first, then come back to pick which items need price tags.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 140 }]}
      >
        {/* Search */}
        <View style={styles.searchRow}>
          <Feather name="search" size={16} color={Colors.textMuted} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search item no, description, brand…"
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Feather name="x" size={16} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* Facet toggle row */}
        <View style={styles.facetBar}>
          {FACETS.map((f) => {
            const sel = filters[f.key];
            const isOpen = openFacet === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                style={[
                  styles.facetChip,
                  (sel.size > 0 || isOpen) && styles.facetChipActive,
                ]}
                onPress={() => setOpenFacet(isOpen ? null : f.key)}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.facetChipText,
                    (sel.size > 0 || isOpen) && styles.facetChipTextActive,
                  ]}
                >
                  {f.label}
                  {sel.size > 0 ? `  ·  ${sel.size}` : ""}
                </Text>
                <Feather
                  name={isOpen ? "chevron-up" : "chevron-down"}
                  size={14}
                  color={(sel.size > 0 || isOpen) ? Colors.textInverse : Colors.textSecondary}
                  style={{ marginLeft: 4 }}
                />
              </TouchableOpacity>
            );
          })}
          {activeFilterCount > 0 && (
            <TouchableOpacity onPress={clearAllFilters} style={styles.clearAllBtn}>
              <Feather name="x-circle" size={14} color={Colors.danger} />
              <Text style={styles.clearAllText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Open facet's value list */}
        {openFacet && (
          <View style={styles.facetPanel}>
            <View style={styles.facetPanelHeader}>
              <Text style={styles.facetPanelTitle}>
                {FACETS.find((x) => x.key === openFacet)?.label}
              </Text>
              {filters[openFacet].size > 0 && (
                <TouchableOpacity onPress={() => clearFacet(openFacet)}>
                  <Text style={styles.facetClearText}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>
            {facetOptions[openFacet].length === 0 ? (
              <Text style={styles.facetEmpty}>No values match the current filters.</Text>
            ) : (
              <View style={styles.facetValues}>
                {facetOptions[openFacet].map(({ value, count }) => {
                  const active = filters[openFacet].has(value.toLowerCase());
                  return (
                    <TouchableOpacity
                      key={value}
                      onPress={() => toggleFilter(openFacet, value)}
                      style={[styles.valueChip, active && styles.valueChipActive]}
                      activeOpacity={0.85}
                    >
                      <Text
                        style={[styles.valueChipText, active && styles.valueChipTextActive]}
                        numberOfLines={1}
                      >
                        {value}
                      </Text>
                      <Text
                        style={[styles.valueChipCount, active && styles.valueChipCountActive]}
                      >
                        {count}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* Result summary + bulk select */}
        <View style={styles.summaryRow}>
          <Text style={styles.summaryText}>
            {filteredRows.length} item{filteredRows.length === 1 ? "" : "s"}
            {visibleSelectedCount > 0 ? `  ·  ${visibleSelectedCount} selected` : ""}
          </Text>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <TouchableOpacity onPress={selectAllVisible}>
              <Text style={styles.linkText}>Select all</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={deselectAllVisible}>
              <Text style={styles.linkTextMuted}>Clear</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Item list */}
        {filteredRows.map((r) => {
          const k = rowKey(r);
          const checked = selected.has(k);
          const desc = s(r["Item Description"]);
          const promo = formatPrice(r["PromotionPrice"]);
          const sp = formatPrice(r["SP"]);
          const mrp = formatPrice(r["MRP"]);
          const priceLabel = promo ? "Promo" : "SP";
          const priceVal = promo || sp || "—";
          return (
            <TouchableOpacity
              key={k}
              onPress={() => toggleRow(k)}
              style={[styles.itemCard, checked && styles.itemCardChecked]}
              activeOpacity={0.85}
            >
              <View style={styles.checkbox}>
                {checked && <Feather name="check" size={16} color={Colors.textInverse} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemNo}>#{s(r["Item No"]) || "—"}</Text>
                <Text
                  style={[styles.itemDesc, { fontFamily: pickFont(desc, "semibold") }]}
                  numberOfLines={2}
                >
                  {desc || "(no description)"}
                </Text>
                <Text style={styles.itemMeta} numberOfLines={1}>
                  {[s(r["Brand"]), s(r["Category"]), s(r["VendorName"]), beatFor(r)]
                    .filter(Boolean)
                    .join("  ·  ")}
                </Text>
              </View>
              <View style={styles.priceCol}>
                {mrp ? <Text style={styles.mrpText}>MRP {mrp}</Text> : null}
                <Text style={styles.priceVal}>
                  {priceLabel} {priceVal}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}

        {filteredRows.length === 0 && (
          <Text style={styles.noResults}>No items match the current filters.</Text>
        )}
      </ScrollView>

      {/* Sticky Save bar */}
      <View style={[styles.saveBar, { paddingBottom: insets.bottom + 12 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.saveBarTitle}>{selected.size} selected</Text>
          <Text style={styles.saveBarSub}>
            {priceTagItems.length > 0
              ? `${priceTagItems.length} already in preview · new items will be appended`
              : "Tap to open Price Tag preview"}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.saveBtn, selected.size === 0 && styles.saveBtnDisabled]}
          onPress={onSave}
          disabled={selected.size === 0}
        >
          <Feather name="arrow-right" size={16} color={Colors.textInverse} />
          <Text style={styles.saveBtnText}>Save to PriceTag Preview</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingHorizontal: 12, paddingTop: 12 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: Colors.background,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
    marginTop: 12,
  },
  emptyBody: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
    marginTop: 8,
    maxWidth: 320,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.text,
    paddingVertical: 0,
  },
  facetBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 8,
    rowGap: 8,
    alignItems: "center",
    marginBottom: 8,
  },
  facetChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  facetChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  facetChipText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  facetChipTextActive: { color: Colors.textInverse },
  clearAllBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4 },
  clearAllText: { color: Colors.danger, fontWeight: "700", marginLeft: 4, fontSize: 13 },
  facetPanel: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 10,
    marginBottom: 10,
  },
  facetPanelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  facetPanelTitle: { fontSize: 13, fontWeight: "700", color: Colors.text },
  facetClearText: { color: Colors.danger, fontWeight: "700", fontSize: 13 },
  facetEmpty: { color: Colors.textMuted, fontSize: 13, fontStyle: "italic" },
  facetValues: { flexDirection: "row", flexWrap: "wrap", columnGap: 6, rowGap: 6 },
  valueChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    maxWidth: "100%",
  },
  valueChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  valueChipText: {
    fontSize: 12,
    color: Colors.text,
    fontWeight: "600",
    maxWidth: 180,
  },
  valueChipTextActive: { color: Colors.textInverse },
  valueChipCount: {
    fontSize: 11,
    color: Colors.textMuted,
    marginLeft: 6,
    fontWeight: "700",
  },
  valueChipCountActive: { color: Colors.textInverse, opacity: 0.85 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  summaryText: { color: Colors.textSecondary, fontWeight: "600", fontSize: 13 },
  linkText: { color: Colors.primary, fontWeight: "700", fontSize: 13 },
  linkTextMuted: { color: Colors.textMuted, fontWeight: "700", fontSize: 13 },
  itemCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    gap: 10,
  },
  itemCardChecked: {
    borderColor: Colors.primary,
    backgroundColor: "#F0F4FA",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Colors.primary,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  itemNo: { fontSize: 11, color: Colors.textMuted, fontWeight: "700" },
  itemDesc: { fontSize: 14, color: Colors.text, marginTop: 2 },
  itemMeta: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  priceCol: { alignItems: "flex-end", minWidth: 80 },
  mrpText: { fontSize: 11, color: Colors.textMuted, fontWeight: "700" },
  priceVal: {
    fontSize: 14,
    color: Colors.primary,
    fontWeight: "800",
    marginTop: 2,
  },
  noResults: {
    textAlign: "center",
    color: Colors.textMuted,
    marginTop: 24,
    fontStyle: "italic",
  },
  saveBar: {
    position: "absolute",
    left: 0, right: 0, bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 12,
  },
  saveBarTitle: { fontSize: 14, fontWeight: "700", color: Colors.text },
  saveBarSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    gap: 6,
  },
  saveBtnDisabled: { backgroundColor: Colors.textMuted },
  saveBtnText: { color: Colors.textInverse, fontWeight: "800", fontSize: 14 },
});
