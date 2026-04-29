import React, { useMemo, useState } from "react";
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

// Each row in the Brand Review tab is one unique combination of
// (brand, category, vendor) seen across every item in every order.
// Display strings preserve the original casing of the most common
// spelling we've seen for a given normalized key, so "Acme" and
// "acme " collapse without losing the user's preferred capitalization.
type BrandReviewRow = {
  key: string;
  brand: string;
  category: string;
  vendorName: string;
  occurrences: number;
};

type SortMode = "brand" | "category" | "vendor";

const PLACEHOLDER = "—";

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

export default function BrandReviewScreen() {
  const { orders } = useApp();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("brand");

  // Walk every order item once, group by (brand|category|vendor) using
  // lowercased/trimmed keys so trivial casing differences collapse, and
  // remember the most common spelling for display. Counting occurrences
  // lets us also surface "how often this combo shows up" if useful later.
  const rows: BrandReviewRow[] = useMemo(() => {
    type Bucket = {
      brandSpellings: Map<string, number>;
      categorySpellings: Map<string, number>;
      vendorSpellings: Map<string, number>;
      occurrences: number;
    };
    const buckets = new Map<string, Bucket>();

    for (const order of orders) {
      const vendor = (order.supplierName ?? "").trim();
      for (const item of order.items) {
        const brand = (item.brand ?? "").trim();
        const category = (item.category ?? "").trim();
        // Skip the truly-empty row (no brand, no category, no vendor) —
        // it's noise, not a reviewable entry.
        if (!brand && !category && !vendor) continue;
        const key = [
          brand.toLowerCase(),
          category.toLowerCase(),
          vendor.toLowerCase(),
        ].join("\u0000");
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            brandSpellings: new Map(),
            categorySpellings: new Map(),
            vendorSpellings: new Map(),
            occurrences: 0,
          };
          buckets.set(key, bucket);
        }
        if (brand) {
          bucket.brandSpellings.set(
            brand,
            (bucket.brandSpellings.get(brand) ?? 0) + 1
          );
        }
        if (category) {
          bucket.categorySpellings.set(
            category,
            (bucket.categorySpellings.get(category) ?? 0) + 1
          );
        }
        if (vendor) {
          bucket.vendorSpellings.set(
            vendor,
            (bucket.vendorSpellings.get(vendor) ?? 0) + 1
          );
        }
        bucket.occurrences += 1;
      }
    }

    const out: BrandReviewRow[] = [];
    for (const [key, b] of buckets) {
      out.push({
        key,
        brand: pickPreferredSpelling(b.brandSpellings),
        category: pickPreferredSpelling(b.categorySpellings),
        vendorName: pickPreferredSpelling(b.vendorSpellings),
        occurrences: b.occurrences,
      });
    }
    return out;
  }, [orders]);

  const filteredSorted: BrandReviewRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter(
          (r) =>
            r.brand.toLowerCase().includes(q) ||
            r.category.toLowerCase().includes(q) ||
            r.vendorName.toLowerCase().includes(q)
        )
      : rows.slice();
    // Empty values sort to the end so populated rows lead the list.
    const cmp = (a: string, b: string) => {
      const aEmpty = a === "";
      const bEmpty = b === "";
      if (aEmpty && !bEmpty) return 1;
      if (!aEmpty && bEmpty) return -1;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    };
    filtered.sort((a, b) => {
      if (sortMode === "brand") {
        return (
          cmp(a.brand, b.brand) ||
          cmp(a.category, b.category) ||
          cmp(a.vendorName, b.vendorName)
        );
      }
      if (sortMode === "category") {
        return (
          cmp(a.category, b.category) ||
          cmp(a.brand, b.brand) ||
          cmp(a.vendorName, b.vendorName)
        );
      }
      return (
        cmp(a.vendorName, b.vendorName) ||
        cmp(a.brand, b.brand) ||
        cmp(a.category, b.category)
      );
    });
    return filtered;
  }, [rows, search, sortMode]);

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Brand Review</Text>
        <View style={styles.countChip}>
          <Text style={styles.countChipText}>
            {filteredSorted.length}
            {search.trim() ? ` / ${rows.length}` : ""}
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

      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>Sort by</Text>
        {(["brand", "category", "vendor"] as SortMode[]).map((m) => (
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
              {m === "brand" ? "Brand" : m === "category" ? "Category" : "Vendor"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.tableHeader}>
        <Text style={[styles.tableHeaderCell, styles.colBrand]}>Brand</Text>
        <Text style={[styles.tableHeaderCell, styles.colCategory]}>Category</Text>
        <Text style={[styles.tableHeaderCell, styles.colVendor]}>Vendor</Text>
      </View>

      <FlatList
        data={filteredSorted}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text
              style={[
                styles.cell,
                styles.colBrand,
                styles.cellBrand,
                !item.brand && styles.cellEmpty,
              ]}
              numberOfLines={2}
            >
              {item.brand || PLACEHOLDER}
            </Text>
            <Text
              style={[
                styles.cell,
                styles.colCategory,
                !item.category && styles.cellEmpty,
              ]}
              numberOfLines={2}
            >
              {item.category || PLACEHOLDER}
            </Text>
            <Text
              style={[
                styles.cell,
                styles.colVendor,
                !item.vendorName && styles.cellEmpty,
              ]}
              numberOfLines={2}
            >
              {item.vendorName || PLACEHOLDER}
            </Text>
          </View>
        )}
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
              subtitle="Import or create orders to start reviewing brands and categories."
            />
          ) : search.trim() ? (
            <EmptyState
              icon="search"
              title="No matches"
              subtitle={`Nothing in the orders matches "${search.trim()}".`}
            />
          ) : (
            <EmptyState
              icon="tag"
              title="Nothing to review"
              subtitle="None of your orders have brand, category, or vendor info yet."
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
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexWrap: "wrap",
  },
  sortLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textSecondary,
    marginRight: 2,
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
    paddingVertical: 12,
    alignItems: "flex-start",
    backgroundColor: Colors.surface,
  },
  cell: {
    fontSize: 13,
    color: Colors.text,
    paddingRight: 8,
  },
  cellBrand: { fontWeight: "700" },
  cellEmpty: { color: Colors.textMuted, fontStyle: "italic", fontWeight: "400" },
  colBrand: { flex: 1.1 },
  colCategory: { flex: 1 },
  colVendor: { flex: 1.3 },
  separator: { height: 1, backgroundColor: Colors.border, marginLeft: 20 },
  list: {},
  listEmpty: { flex: 1, paddingTop: 40 },
});
