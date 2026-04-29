import React, { useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useApp } from "@/context/AppContext";
import { EmptyState } from "@/components/EmptyState";

// Top-level row in the Brand Review tab is one brand. Each brand
// carries the list of (category, vendor) combinations seen for it
// across all orders, surfaced when the user double-taps the row.
type BrandDetail = {
  key: string;
  category: string;
  vendorName: string;
  maxMin: number | null;
};

type BrandRow = {
  key: string;
  brand: string;
  details: BrandDetail[];
  occurrences: number;
  maxMin: number | null;
};

type SortMode = "brand" | "min";

// Comparison operators for the "filter by min" control. Display labels
// use unicode symbols for compactness; internal codes drive the
// arithmetic. Default is `>` so the user can spot items above a
// threshold (e.g., min > 200) at a glance.
type MinOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
const MIN_OPERATORS: { code: MinOperator; label: string }[] = [
  { code: "gt", label: ">" },
  { code: "gte", label: "≥" },
  { code: "lt", label: "<" },
  { code: "lte", label: "≤" },
  { code: "eq", label: "=" },
  { code: "neq", label: "≠" },
];

const PLACEHOLDER = "—";
// Window inside which two taps on the same brand row count as a
// double-tap. 300ms is the platform-conventional threshold and matches
// what most native components feel like.
const DOUBLE_TAP_MS = 300;

function pickPreferredSpelling(counts: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [spelling, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && spelling.localeCompare(best) < 0)
    ) {
      bestCount = count;
      best = spelling;
    }
  }
  return best;
}

function compareMin(value: number, op: MinOperator, threshold: number): boolean {
  switch (op) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
    case "neq": return value !== threshold;
  }
}

export default function BrandReviewScreen() {
  const { orders } = useApp();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("brand");
  // Default min filter: greater than 200. The user can adjust the
  // operator, change the threshold, or tap "Clear" to disable filtering.
  const [minOperator, setMinOperator] = useState<MinOperator>("gt");
  const [minThresholdText, setMinThresholdText] = useState<string>("200");
  // Set of expanded brand keys — toggled by double-tap.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Track the last tap's brand key + timestamp so we can detect a
  // double-tap without relying on platform-specific gesture libraries.
  const lastTapRef = useRef<{ key: string; time: number } | null>(null);

  // Parse the threshold once; an empty / non-numeric value disables the
  // filter so the user can toggle it off without committing to "0".
  const minThreshold: number | null = useMemo(() => {
    const trimmed = minThresholdText.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }, [minThresholdText]);
  const minFilterActive = minThreshold !== null;

  // Walk every order item once, optionally pre-filtering by the min
  // arithmetic filter, then group by brand. For each brand also
  // collect the unique (category, vendor) detail rows so they can be
  // surfaced when the user double-taps that brand.
  const rows: BrandRow[] = useMemo(() => {
    type DetailBucket = {
      categorySpellings: Map<string, number>;
      vendorSpellings: Map<string, number>;
      maxMin: number | null;
    };
    type BrandBucket = {
      brandSpellings: Map<string, number>;
      details: Map<string, DetailBucket>;
      occurrences: number;
      maxMin: number | null;
    };
    const brands = new Map<string, BrandBucket>();

    for (const order of orders) {
      const vendor = (order.supplierName ?? "").trim();
      for (const item of order.items) {
        // Apply the min filter at the item level so a brand only
        // qualifies if at least one of its items satisfies the filter.
        if (minFilterActive) {
          if (typeof item.min !== "number" || !Number.isFinite(item.min)) {
            continue;
          }
          if (!compareMin(item.min, minOperator, minThreshold!)) {
            continue;
          }
        }
        const brand = (item.brand ?? "").trim();
        const category = (item.category ?? "").trim();
        // Skip items with no brand at all — the tab is "Brand Review",
        // and a row with no brand wouldn't be reviewable.
        if (!brand) continue;

        const brandKey = brand.toLowerCase();
        let bb = brands.get(brandKey);
        if (!bb) {
          bb = {
            brandSpellings: new Map(),
            details: new Map(),
            occurrences: 0,
            maxMin: null,
          };
          brands.set(brandKey, bb);
        }
        bb.brandSpellings.set(brand, (bb.brandSpellings.get(brand) ?? 0) + 1);
        bb.occurrences += 1;
        if (typeof item.min === "number" && Number.isFinite(item.min)) {
          bb.maxMin = bb.maxMin === null ? item.min : Math.max(bb.maxMin, item.min);
        }

        const detailKey = `${category.toLowerCase()}\u0000${vendor.toLowerCase()}`;
        let db = bb.details.get(detailKey);
        if (!db) {
          db = {
            categorySpellings: new Map(),
            vendorSpellings: new Map(),
            maxMin: null,
          };
          bb.details.set(detailKey, db);
        }
        if (category) {
          db.categorySpellings.set(
            category,
            (db.categorySpellings.get(category) ?? 0) + 1
          );
        }
        if (vendor) {
          db.vendorSpellings.set(
            vendor,
            (db.vendorSpellings.get(vendor) ?? 0) + 1
          );
        }
        if (typeof item.min === "number" && Number.isFinite(item.min)) {
          db.maxMin = db.maxMin === null ? item.min : Math.max(db.maxMin, item.min);
        }
      }
    }

    const out: BrandRow[] = [];
    for (const [brandKey, bb] of brands) {
      const details: BrandDetail[] = [];
      for (const [detailKey, db] of bb.details) {
        details.push({
          key: detailKey,
          category: pickPreferredSpelling(db.categorySpellings),
          vendorName: pickPreferredSpelling(db.vendorSpellings),
          maxMin: db.maxMin,
        });
      }
      // Stable nested order: alphabetical by category, then vendor.
      details.sort(
        (a, b) =>
          a.category.localeCompare(b.category, undefined, { sensitivity: "base" }) ||
          a.vendorName.localeCompare(b.vendorName, undefined, { sensitivity: "base" })
      );
      out.push({
        key: brandKey,
        brand: pickPreferredSpelling(bb.brandSpellings),
        details,
        occurrences: bb.occurrences,
        maxMin: bb.maxMin,
      });
    }
    return out;
  }, [orders, minFilterActive, minOperator, minThreshold]);

  // Total brands IGNORING all filters — used for the "X / Y" count chip.
  const totalBrandsBeforeFilters: number = useMemo(() => {
    const seen = new Set<string>();
    for (const order of orders) {
      for (const item of order.items) {
        const brand = (item.brand ?? "").trim();
        if (!brand) continue;
        seen.add(brand.toLowerCase());
      }
    }
    return seen.size;
  }, [orders]);

  const filteredSorted: BrandRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Search matches the brand name OR any nested category/vendor —
    // this preserves the cross-field search that existed before the
    // brand-only refactor, so users can still find a brand by typing
    // a vendor or category they remember.
    const filtered = q
      ? rows.filter(
          (r) =>
            r.brand.toLowerCase().includes(q) ||
            r.details.some(
              (d) =>
                d.category.toLowerCase().includes(q) ||
                d.vendorName.toLowerCase().includes(q)
            )
        )
      : rows.slice();
    const cmpStr = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });
    // For the Min sort: highest min first, nulls (no min) at the end.
    const cmpMinDesc = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    };
    filtered.sort((a, b) => {
      if (sortMode === "min") {
        return cmpMinDesc(a.maxMin, b.maxMin) || cmpStr(a.brand, b.brand);
      }
      return cmpStr(a.brand, b.brand);
    });
    return filtered;
  }, [rows, search, sortMode]);

  function handleBrandTap(key: string) {
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && last.key === key && now - last.time < DOUBLE_TAP_MS) {
      // Second tap on the same brand within the window — toggle.
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      lastTapRef.current = null;
    } else {
      lastTapRef.current = { key, time: now };
    }
  }

  const showCountSlash = search.trim() !== "" || minFilterActive;
  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Brand Review</Text>
        <View style={styles.countChip}>
          <Text style={styles.countChipText}>
            {filteredSorted.length}
            {showCountSlash ? ` / ${totalBrandsBeforeFilters}` : ""}
          </Text>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <Feather name="search" size={16} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search brand, category or vendor"
          placeholderTextColor={Colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")} hitSlop={8}>
            <Feather name="x-circle" size={16} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.minFilterRow}>
        <Text style={styles.filterLabel}>Min</Text>
        <View style={styles.opChips}>
          {MIN_OPERATORS.map((op) => (
            <TouchableOpacity
              key={op.code}
              style={[
                styles.opChip,
                minOperator === op.code && styles.opChipActive,
              ]}
              onPress={() => setMinOperator(op.code)}
              activeOpacity={0.7}
              accessibilityLabel={`Operator ${op.label}`}
            >
              <Text
                style={[
                  styles.opChipText,
                  minOperator === op.code && styles.opChipTextActive,
                ]}
              >
                {op.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          style={styles.thresholdInput}
          placeholder="value"
          placeholderTextColor={Colors.textMuted}
          value={minThresholdText}
          onChangeText={setMinThresholdText}
          keyboardType="numeric"
          returnKeyType="done"
        />
        {minThresholdText.length > 0 && (
          <TouchableOpacity
            onPress={() => setMinThresholdText("")}
            hitSlop={8}
            style={styles.clearBtn}
            accessibilityLabel="Clear min filter"
          >
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.sortRow}>
        <Text style={styles.filterLabel}>Sort by</Text>
        {(["brand", "min"] as SortMode[]).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.sortChip, sortMode === m && styles.sortChipActive]}
            onPress={() => setSortMode(m)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.sortChipText,
                sortMode === m && styles.sortChipTextActive,
              ]}
            >
              {m === "brand" ? "Brand" : "Min"}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.hintText}>Double-tap a brand to expand</Text>
      </View>

      <View style={styles.tableHeader}>
        <Text style={[styles.tableHeaderCell, styles.colBrand]}>Brand</Text>
      </View>

      <FlatList
        data={filteredSorted}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          const isOpen = expanded.has(item.key);
          return (
            <View>
              <TouchableOpacity
                onPress={() => handleBrandTap(item.key)}
                activeOpacity={0.7}
                style={styles.row}
                accessibilityLabel={`${item.brand}, double-tap to ${
                  isOpen ? "collapse" : "expand"
                }`}
              >
                <View style={[styles.colBrand, styles.brandCellWrap]}>
                  <Feather
                    name={isOpen ? "chevron-down" : "chevron-right"}
                    size={16}
                    color={Colors.textSecondary}
                    style={styles.chevron}
                  />
                  <Text
                    style={[styles.cell, styles.cellBrand, styles.brandText]}
                    numberOfLines={2}
                  >
                    {item.brand}
                  </Text>
                </View>
              </TouchableOpacity>

              {isOpen && (
                <View style={styles.detailWrap}>
                  <View style={styles.detailHeader}>
                    <Text style={[styles.detailHeaderCell, styles.detailColCategory]}>
                      Category
                    </Text>
                    <Text style={[styles.detailHeaderCell, styles.detailColVendor]}>
                      Vendor
                    </Text>
                    <Text
                      style={[
                        styles.detailHeaderCell,
                        styles.detailColMin,
                        styles.colMinAlign,
                      ]}
                    >
                      Min
                    </Text>
                  </View>
                  {item.details.map((d) => (
                    <View key={d.key} style={styles.detailRow}>
                      <Text
                        style={[
                          styles.detailCell,
                          styles.detailColCategory,
                          !d.category && styles.cellEmpty,
                        ]}
                        numberOfLines={2}
                      >
                        {d.category || PLACEHOLDER}
                      </Text>
                      <Text
                        style={[
                          styles.detailCell,
                          styles.detailColVendor,
                          !d.vendorName && styles.cellEmpty,
                        ]}
                        numberOfLines={2}
                      >
                        {d.vendorName || PLACEHOLDER}
                      </Text>
                      <Text
                        style={[
                          styles.detailCell,
                          styles.detailColMin,
                          styles.colMinAlign,
                          styles.cellMin,
                          d.maxMin === null && styles.cellEmpty,
                        ]}
                        numberOfLines={1}
                      >
                        {d.maxMin === null ? PLACEHOLDER : String(d.maxMin)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={[
          styles.list,
          {
            paddingBottom:
              insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100,
          },
          filteredSorted.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          orders.length === 0 ? (
            <EmptyState
              icon="tag"
              title="No orders yet"
              subtitle="Import or create orders to start reviewing brands."
            />
          ) : minFilterActive ? (
            <EmptyState
              icon="filter"
              title="No matches"
              subtitle={`No brands have items with min ${
                MIN_OPERATORS.find((o) => o.code === minOperator)?.label ?? ""
              } ${minThreshold}${
                search.trim() ? ` matching "${search.trim()}"` : ""
              }.`}
            />
          ) : search.trim() ? (
            <EmptyState
              icon="search"
              title="No matches"
              subtitle={`Nothing matches "${search.trim()}".`}
            />
          ) : (
            <EmptyState
              icon="tag"
              title="Nothing to review"
              subtitle="None of your orders have brand info yet."
            />
          )
        }
        showsVerticalScrollIndicator={false}
      />
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
    paddingBottom: 12,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  countChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
  },
  countChipText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.primary,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: Colors.text,
    paddingVertical: 0,
  },
  minFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingBottom: 10,
    flexWrap: "wrap",
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textSecondary,
    marginRight: 2,
  },
  opChips: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  opChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  opChipActive: {
    backgroundColor: Colors.primary,
  },
  opChipText: {
    fontSize: 14,
    fontWeight: "800",
    color: Colors.textSecondary,
  },
  opChipTextActive: { color: Colors.textInverse },
  thresholdInput: {
    minWidth: 64,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 8 : 4,
    fontSize: 14,
    fontWeight: "700",
    color: Colors.text,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    textAlign: "center",
  },
  clearBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  clearBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexWrap: "wrap",
  },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sortChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  sortChipText: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  sortChipTextActive: { color: Colors.textInverse },
  hintText: {
    fontSize: 11,
    color: Colors.textMuted,
    fontStyle: "italic",
    marginLeft: "auto",
  },
  tableHeader: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: Colors.border,
  },
  tableHeaderCell: {
    fontSize: 11,
    fontWeight: "800",
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: Colors.surface,
  },
  brandCellWrap: { flexDirection: "row", alignItems: "center" },
  chevron: { marginRight: 8 },
  brandText: { flex: 1 },
  cell: {
    fontSize: 14,
    color: Colors.text,
    paddingRight: 8,
  },
  cellBrand: { fontWeight: "700" },
  cellMin: { fontWeight: "700" },
  cellEmpty: { color: Colors.textMuted, fontStyle: "italic", fontWeight: "400" },
  colBrand: { flex: 1 },
  colMin: { flex: 0.3 },
  colMinAlign: { textAlign: "right", paddingRight: 0 },
  separator: { height: 1, backgroundColor: Colors.border, marginLeft: 20 },
  list: {},
  listEmpty: { flex: 1, paddingTop: 40 },
  detailWrap: {
    backgroundColor: Colors.background,
    paddingLeft: 44,
    paddingRight: 20,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  detailHeader: {
    flexDirection: "row",
    paddingTop: 8,
    paddingBottom: 6,
  },
  detailHeaderCell: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  detailRow: {
    flexDirection: "row",
    paddingVertical: 8,
    alignItems: "flex-start",
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  detailCell: {
    fontSize: 13,
    color: Colors.text,
    paddingRight: 8,
  },
  detailColCategory: { flex: 1 },
  detailColVendor: { flex: 1.2 },
  detailColMin: { flex: 0.4 },
});
