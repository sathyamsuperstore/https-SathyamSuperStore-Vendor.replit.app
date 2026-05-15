import React, { useMemo, useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Platform,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, type RasiItem, type PriceTagItem } from "@/context/AppContext";
import { pickFont } from "@/constants/typography";

// Sister screen of PromoPrint, but sourced from the Rasi Items master
// catalogue instead of the Promo workbook. The Rasi sheet has no
// vendor/promo/batch columns, so the facet set is reduced to the four
// useful catalogue dimensions.
type FacetKey = "brand" | "igroup" | "godown" | "unit";
const FACETS: { key: FacetKey; label: string }[] = [
  { key: "brand",  label: "Brand" },
  { key: "igroup", label: "IGroup" },
  { key: "godown", label: "Godown" },
  { key: "unit",   label: "Unit" },
];

function s(v: string | number | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v).trim();
}

// Stable diff key used to dedupe selections + match against any prior
// PriceTagItem entries already stored. Rasi rows have no batch number,
// so we key on `${code}|${mrp}` to mirror PromoPrint's three-part key
// shape (`${itemNo}|${batchNo}|${mrp}`) with an empty batch slot.
function rowKey(r: RasiItem): string {
  return `${r.code}||${r.mrp}`;
}

function formatPrice(v: number | undefined): string {
  if (v === undefined || v === null) return "";
  if (!Number.isFinite(v) || v === 0) return "";
  return v.toFixed(2);
}

export default function RPromoPrintScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    rasiItems,
    savePriceTagItems,
    priceTagItems,
    savePriceTagReviewItems,
    priceTagReviewItems,
  } = useApp();

  const [filters, setFilters] = useState<Record<FacetKey, Set<string>>>({
    brand: new Set(),
    igroup: new Set(),
    godown: new Set(),
    unit: new Set(),
  });
  const [openFacet, setOpenFacet] = useState<FacetKey | null>(null);
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(priceTagItems.map((i) => i.key))
  );
  useEffect(() => {
    setSelected(new Set(priceTagItems.map((i) => i.key)));
  }, [priceTagItems]);

  function valueFor(r: RasiItem, facet: FacetKey): string {
    if (facet === "brand")  return r.brand;
    if (facet === "igroup") return r.igroup;
    if (facet === "godown") return r.godown;
    return r.unit;
  }

  // Cascading facet options — a facet's option list reflects the rows
  // that already pass every OTHER facet's filter, so picking a Brand
  // narrows the IGroup list, etc. Same pattern as PromoPrint.
  const facetOptions = useMemo(() => {
    const out: Record<FacetKey, { value: string; count: number }[]> = {
      brand: [], igroup: [], godown: [], unit: [],
    };
    for (const facet of FACETS.map((f) => f.key)) {
      const counts = new Map<string, number>();
      for (const r of rasiItems) {
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
  }, [rasiItems, filters]);

  // Prune selected values that no longer appear in their cascaded list.
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

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rasiItems.filter((r) => {
      for (const f of FACETS.map((x) => x.key)) {
        const sel = filters[f];
        if (sel.size === 0) continue;
        const v = valueFor(r, f).toLowerCase();
        if (!sel.has(v)) return false;
      }
      if (!q) return true;
      return [r.code, r.item, r.brand, r.igroup, r.godown]
        .some((x) => x.toLowerCase().includes(q));
    });
  }, [rasiItems, filters, search]);

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
    setFilters({ brand: new Set(), igroup: new Set(), godown: new Set(), unit: new Set() });
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
    const existingByKey = new Map(priceTagItems.map((i) => [i.key, i]));
    const now = Date.now();
    const additions: PriceTagItem[] = [];
    for (const r of rasiItems) {
      const k = rowKey(r);
      if (!selected.has(k)) continue;
      if (existingByKey.has(k)) continue;
      // Map Rasi catalogue fields onto the PriceTag schema. wrate is
      // surfaced as the promotional price and srate as the regular
      // shelf (SP) price. IGroup is surfaced as Category and Godown
      // as Beat (closest analogues).
      additions.push({
        key: k,
        itemNo: r.code,
        description: r.item,
        mrp: r.mrp,
        promotionPrice: r.wrate,
        sp: r.srate,
        brand: r.brand || undefined,
        category: r.igroup || undefined,
        beat: r.godown || undefined,
        addedAt: now,
      });
    }
    const merged = [...priceTagItems, ...additions];
    const existingReviewByKey = new Map(priceTagReviewItems.map((i) => [i.key, i]));
    const reviewAdditions = additions.filter((a) => !existingReviewByKey.has(a.key));
    const mergedReview = [...priceTagReviewItems, ...reviewAdditions];
    try {
      await Promise.all([
        savePriceTagItems(merged),
        savePriceTagReviewItems(mergedReview),
      ]);
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
    filters.brand.size + filters.igroup.size + filters.godown.size + filters.unit.size;

  if (rasiItems.length === 0) {
    return (
      <View style={[styles.empty, { paddingTop: insets.top + 24 }]}>
        <Feather name="tag" size={48} color={Colors.textMuted} />
        <Text style={styles.emptyTitle}>No Rasi items yet</Text>
        <Text style={styles.emptyBody}>
          Import the Rasi Items workbook from Directory → Rasi Items first, then come back to pick which items need price tags.
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
            placeholder="Search code, item, brand, group…"
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

        {filteredRows.map((r) => {
          const k = rowKey(r);
          const checked = selected.has(k);
          const desc = r.item;
          const mrp = formatPrice(r.mrp);
          const srate = formatPrice(r.srate);
          const wrate = formatPrice(r.wrate);
          const saveAmt =
            Number.isFinite(r.mrp) && Number.isFinite(r.srate)
              ? Math.round(r.mrp - r.srate)
              : 0;
          const saveText = saveAmt > 0 ? `SAVE ₹${saveAmt}` : "";
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
                <Text style={styles.itemNo}>#{r.code || "—"}</Text>
                <Text
                  style={[styles.itemDesc, { fontFamily: pickFont(desc, "semibold") }]}
                >
                  {desc || "(no description)"}
                </Text>
                <Text style={styles.itemMeta} numberOfLines={1}>
                  {[r.brand, r.igroup, r.godown, r.unit].filter(Boolean).join("  ·  ")}
                </Text>
              </View>
              <View style={styles.priceCol}>
                {mrp ? <Text style={styles.mrpText}>MRP {mrp}</Text> : null}
                {srate ? (
                  <Text style={styles.priceVal}>SRate {srate}</Text>
                ) : null}
                {saveText ? (
                  <Text style={styles.saveText}>{saveText}</Text>
                ) : null}
                {wrate ? (
                  <Text style={styles.mrpText}>WRate {wrate}</Text>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        })}

        {filteredRows.length === 0 && (
          <Text style={styles.noResults}>No items match the current filters.</Text>
        )}
      </ScrollView>

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
    flex: 1, alignItems: "center", justifyContent: "center",
    padding: 24, backgroundColor: Colors.background,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginTop: 12 },
  emptyBody: {
    fontSize: 14, color: Colors.textSecondary, textAlign: "center",
    marginTop: 8, maxWidth: 320,
  },
  searchRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border, borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
    marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text, paddingVertical: 0 },
  facetBar: {
    flexDirection: "row", flexWrap: "wrap", columnGap: 8, rowGap: 8,
    alignItems: "center", marginBottom: 8,
  },
  facetChip: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
  },
  facetChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  facetChipText: { fontSize: 13, fontWeight: "700", color: Colors.textSecondary },
  facetChipTextActive: { color: Colors.textInverse },
  clearAllBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4 },
  clearAllText: { color: Colors.danger, fontWeight: "700", marginLeft: 4, fontSize: 13 },
  facetPanel: {
    backgroundColor: Colors.surface,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.border,
    padding: 10, marginBottom: 10,
  },
  facetPanelHeader: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 8,
  },
  facetPanelTitle: { fontSize: 13, fontWeight: "700", color: Colors.text },
  facetClearText: { color: Colors.danger, fontWeight: "700", fontSize: 12 },
  facetEmpty: { color: Colors.textMuted, fontSize: 13, paddingVertical: 6 },
  facetValues: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  valueChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    maxWidth: "100%",
  },
  valueChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  valueChipText: { fontSize: 12, fontWeight: "600", color: Colors.text, maxWidth: 180 },
  valueChipTextActive: { color: Colors.textInverse },
  valueChipCount: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  valueChipCountActive: { color: Colors.textInverse },
  summaryRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 8,
  },
  summaryText: { fontSize: 13, color: Colors.textSecondary, fontWeight: "600" },
  linkText: { color: Colors.primary, fontWeight: "700", fontSize: 13 },
  linkTextMuted: { color: Colors.textMuted, fontWeight: "700", fontSize: 13 },
  itemCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
    borderRadius: 10, padding: 10, marginBottom: 8,
  },
  itemCardChecked: {
    borderColor: Colors.primary, backgroundColor: Colors.primary + "0D",
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 1.5, borderColor: Colors.border,
    backgroundColor: Colors.primary,
    alignItems: "center", justifyContent: "center",
    marginTop: 2,
  },
  itemNo: { fontSize: 11, fontWeight: "700", color: Colors.textMuted, marginBottom: 2 },
  itemDesc: { fontSize: 14, color: Colors.text, lineHeight: 18 },
  itemMeta: { fontSize: 11, color: Colors.textSecondary, marginTop: 4 },
  priceCol: { alignItems: "flex-end", minWidth: 92 },
  mrpText: { fontSize: 11, color: Colors.textMuted, fontWeight: "600" },
  priceVal: { fontSize: 14, color: Colors.text, fontWeight: "800", marginTop: 2 },
  saveText: { fontSize: 12, color: Colors.success ?? "#16A34A", fontWeight: "800", marginTop: 2 },
  noResults: {
    textAlign: "center", color: Colors.textMuted,
    paddingVertical: 24, fontSize: 13,
  },
  saveBar: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: Colors.surface,
    borderTopWidth: 1, borderTopColor: Colors.border,
    paddingHorizontal: 14, paddingTop: 12,
  },
  saveBarTitle: { fontSize: 14, fontWeight: "800", color: Colors.text },
  saveBarSub: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  saveBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: Colors.textInverse, fontWeight: "800", fontSize: 13 },
});
