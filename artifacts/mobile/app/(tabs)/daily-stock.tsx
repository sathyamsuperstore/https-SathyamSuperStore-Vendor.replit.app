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
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as XLSX from "xlsx-js-style";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Print from "expo-print";
import { Colors } from "@/constants/colors";
import { useApp, type DailyStockItem } from "@/context/AppContext";
import { LOGO_BASE64 } from "@/constants/LogoBase64";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(2).replace(/\.?0+$/, "");
}

function fmtDiff(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const s = Number(n).toFixed(2).replace(/\.?0+$/, "");
  return n > 0 ? `+${s}` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unique(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean))).sort();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

type SortField =
  | "desc"
  | "weight"
  | "stock"
  | "physicalStock"
  | "stockDiff"
  | "inventoryCode"
  | "categoryCode"
  | "subCategoryCode"
  | "brandCode"
  | "autoPOAllowed"
  | "lapVendorC"
  | "lapVendorN"
  | "vendorCode";

type SortFieldDef = {
  key: SortField;
  label: string;
  type: "string" | "number";
};

type SortDir = "asc" | "desc";
type SortLevel = { key: SortField; dir: SortDir } | null;
const EMPTY_SORT_LEVELS: SortLevel[] = [null, null, null];

const SORT_FIELDS: SortFieldDef[] = [
  { key: "desc", label: "Description", type: "string" },
  { key: "weight", label: "Weight", type: "number" },
  { key: "stock", label: "Stock", type: "number" },
  { key: "physicalStock", label: "Physical Stock", type: "number" },
  { key: "stockDiff", label: "Stock Diff", type: "number" },
  { key: "inventoryCode", label: "InventoryCode", type: "string" },
  { key: "categoryCode", label: "CategoryCode", type: "string" },
  { key: "subCategoryCode", label: "SubCategoryCode", type: "string" },
  { key: "brandCode", label: "BrandCode", type: "string" },
  { key: "autoPOAllowed", label: "AutoPOAllowed", type: "string" },
  { key: "lapVendorC", label: "LAPVendorC", type: "string" },
  { key: "lapVendorN", label: "LAPVendorN", type: "string" },
  { key: "vendorCode", label: "VendorCode", type: "string" },
];

const SORT_FIELD_BY_KEY: Record<SortField, SortFieldDef> = SORT_FIELDS.reduce(
  (acc, field) => {
    acc[field.key] = field;
    return acc;
  },
  {} as Record<SortField, SortFieldDef>,
);

function getSortValue(
  item: DailyStockItem,
  field: SortField,
  physicalStock = item.physicalStock,
): string | number | null {
  switch (field) {
    case "desc": return item.desc;
    case "weight": return item.weight;
    case "stock": return item.stock;
    case "physicalStock": return physicalStock;
    case "stockDiff": {
      if (item.stock === null || physicalStock === null) return null;
      return item.stock - physicalStock;
    }
    case "inventoryCode": return item.inventoryCode;
    case "categoryCode": return item.categoryCode;
    case "subCategoryCode": return item.subCategoryCode;
    case "brandCode": return item.brandCode;
    case "autoPOAllowed": return item.autoPOAllowed ? "Yes" : "No";
    case "lapVendorC": return item.lapVendorC;
    case "lapVendorN": return item.lapVendorN;
    case "vendorCode": return item.vendorCode;
  }
}

function cmpSortVal(
  a: string | number | null,
  b: string | number | null,
  type: "string" | "number",
  dir: SortDir,
): number {
  const aBlank = a == null || (type === "string" && String(a).trim() === "");
  const bBlank = b == null || (type === "string" && String(b).trim() === "");
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;

  let result: number;
  if (type === "number") {
    result = Number(a) - Number(b);
  } else {
    result = String(a).localeCompare(String(b), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  }
  return dir === "desc" ? -result : result;
}

function dirLabelFor(type: "string" | "number", dir: SortDir): string {
  if (type === "string") return dir === "asc" ? "A→Z" : "Z→A";
  return dir === "asc" ? "Low→High" : "High→Low";
}

function shortDirLabelFor(type: "string" | "number", dir: SortDir): string {
  if (type === "string") return dir === "asc" ? "A→Z" : "Z→A";
  return dir === "asc" ? "↑" : "↓";
}

function sortItems(
  items: { item: DailyStockItem; origIdx: number }[],
  levels: SortLevel[],
  getPhysicalStock: (item: DailyStockItem, origIdx: number) => number | null,
): { item: DailyStockItem; origIdx: number }[] {
  return [...items].sort((a, b) => {
    for (const level of levels) {
      if (!level) continue;
      const def = SORT_FIELD_BY_KEY[level.key];
      const cmp = cmpSortVal(
        getSortValue(a.item, level.key, getPhysicalStock(a.item, a.origIdx)),
        getSortValue(b.item, level.key, getPhysicalStock(b.item, b.origIdx)),
        def.type,
        level.dir,
      );
      if (cmp !== 0) return cmp;
    }
    return a.origIdx - b.origIdx;
  });
}

// ─── Multi-select modal ────────────────────────────────────────────────────────

interface MultiSelectModalProps {
  visible: boolean;
  title: string;
  options: string[];
  selected: string[];
  onApply: (selected: string[]) => void;
  onClose: () => void;
}

function MultiSelectModal({
  visible,
  title,
  options,
  selected,
  onApply,
  onClose,
}: MultiSelectModalProps) {
  const [draft, setDraft] = useState<string[]>(selected);
  const [search, setSearch] = useState("");

  const filteredOpts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, search]);

  function toggle(v: string) {
    setDraft((d) => (d.includes(v) ? d.filter((x) => x !== v) : [...d, v]));
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onShow={() => { setDraft(selected); setSearch(""); }}
      onRequestClose={onClose}
    >
      <View style={msStyles.container}>
        <View style={msStyles.header}>
          <TouchableOpacity onPress={onClose} style={msStyles.cancelBtn}>
            <Text style={msStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={msStyles.title}>{title}</Text>
          <TouchableOpacity
            onPress={() => { onApply(draft); onClose(); }}
            style={msStyles.applyBtn}
          >
            <Text style={msStyles.applyText}>Apply</Text>
          </TouchableOpacity>
        </View>
        <View style={msStyles.searchWrap}>
          <Feather name="search" size={14} color={Colors.textMuted} />
          <TextInput
            style={msStyles.searchInput}
            placeholder="Search…"
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Feather name="x" size={14} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        <View style={msStyles.clearRow}>
          <TouchableOpacity onPress={() => setDraft([])} style={msStyles.clearBtn}>
            <Text style={msStyles.clearText}>Clear all</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDraft(options)} style={msStyles.clearBtn}>
            <Text style={msStyles.clearText}>Select all</Text>
          </TouchableOpacity>
        </View>
        <FlatList
          data={filteredOpts}
          keyExtractor={(item) => item}
          renderItem={({ item }) => {
            const checked = draft.includes(item);
            return (
              <TouchableOpacity style={msStyles.row} onPress={() => toggle(item)} activeOpacity={0.7}>
                <View style={[msStyles.checkbox, checked && msStyles.checkboxOn]}>
                  {checked && <Feather name="check" size={12} color="#fff" />}
                </View>
                <Text style={msStyles.rowText}>{item || "(blank)"}</Text>
              </TouchableOpacity>
            );
          }}
          ItemSeparatorComponent={() => <View style={msStyles.sep} />}
        />
      </View>
    </Modal>
  );
}

const msStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: Platform.OS === "ios" ? 20 : 16,
    paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title: { fontSize: 17, fontWeight: "700", color: Colors.text },
  cancelBtn: { padding: 4 },
  cancelText: { fontSize: 16, color: Colors.textMuted },
  applyBtn: { padding: 4 },
  applyText: { fontSize: 16, fontWeight: "700", color: Colors.primary },
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8, margin: 12,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: Colors.surface, borderRadius: 10, borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text },
  clearRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  clearBtn: { paddingVertical: 4 },
  clearText: { fontSize: 13, color: Colors.primary, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 13, gap: 12 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  checkboxOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  rowText: { flex: 1, fontSize: 14, color: Colors.text },
  sep: { height: 1, backgroundColor: Colors.borderLight, marginLeft: 50 },
});

// ─── Sort modal ───────────────────────────────────────────────────────────────

interface SortModalProps {
  visible: boolean;
  levels: SortLevel[];
  bottomInset: number;
  onApply: (levels: SortLevel[]) => void;
  onClose: () => void;
}

function SortModal({ visible, levels, bottomInset, onApply, onClose }: SortModalProps) {
  const [draftLevels, setDraftLevels] = useState<SortLevel[]>(levels);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={sortStyles.modalRoot}>
        <TouchableOpacity
          style={sortStyles.modalBackdrop}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={[sortStyles.modalSheet, { paddingBottom: bottomInset + 16 }]}>
          <View style={sortStyles.modalHandle} />
          <View style={sortStyles.modalHeader}>
            <TouchableOpacity onPress={onClose} style={sortStyles.cancelBtn}>
              <Text style={sortStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={sortStyles.title}>Sort by</Text>
            {draftLevels.some((level) => level != null) ? (
              <TouchableOpacity onPress={() => setDraftLevels([...EMPTY_SORT_LEVELS])} style={sortStyles.clearBtn}>
                <Text style={sortStyles.clearText}>Clear All</Text>
              </TouchableOpacity>
            ) : (
              <View style={sortStyles.headerSpacer} />
            )}
          </View>

          <ScrollView
            style={sortStyles.modalScroll}
            contentContainerStyle={sortStyles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={sortStyles.hint}>
              Pick up to 3 columns. Sort priorities are applied in order.
            </Text>
            {[0, 1, 2].map((idx) => {
              const level = draftLevels[idx];
              const fieldDef = level ? SORT_FIELD_BY_KEY[level.key] : null;
              return (
                <View key={idx} style={sortStyles.levelBlock}>
                  <View style={sortStyles.levelHeader}>
                    <Text style={sortStyles.levelLabel}>{idx === 0 ? "First by" : "Then by"}</Text>
                    {level && fieldDef ? (
                      <TouchableOpacity
                        style={sortStyles.directionButton}
                        onPress={() => setDraftLevels((previous) => {
                          const next = [...previous];
                          const current = next[idx];
                          if (current) {
                            next[idx] = { ...current, dir: current.dir === "asc" ? "desc" : "asc" };
                          }
                          return next;
                        })}
                        activeOpacity={0.75}
                      >
                        <Feather
                          name={level.dir === "asc" ? "arrow-up" : "arrow-down"}
                          size={13}
                          color={Colors.primary}
                        />
                        <Text style={sortStyles.directionButtonText}>
                          {dirLabelFor(fieldDef.type, level.dir)}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={sortStyles.levelEmpty}>Not set</Text>
                    )}
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={sortStyles.chipsRow}
                  >
                    <TouchableOpacity
                      style={[sortStyles.fieldChip, !level && sortStyles.fieldChipActive]}
                      onPress={() => setDraftLevels((previous) => {
                        const next = [...previous];
                        next[idx] = null;
                        return next;
                      })}
                      activeOpacity={0.75}
                    >
                      <Text style={[sortStyles.fieldChipText, !level && sortStyles.fieldChipTextActive]}>
                        None
                      </Text>
                    </TouchableOpacity>
                    {SORT_FIELDS.map((field) => {
                      const selected = level?.key === field.key;
                      const usedElsewhere = draftLevels.some(
                        (other, otherIdx) => otherIdx !== idx && other?.key === field.key,
                      );
                      return (
                        <TouchableOpacity
                          key={field.key}
                          style={[
                            sortStyles.fieldChip,
                            selected && sortStyles.fieldChipActive,
                            usedElsewhere && sortStyles.fieldChipDisabled,
                          ]}
                          disabled={usedElsewhere}
                          onPress={() => setDraftLevels((previous) => {
                            const next = [...previous];
                            next[idx] = { key: field.key, dir: "asc" };
                            return next;
                          })}
                          activeOpacity={0.75}
                        >
                          <Text
                            style={[
                              sortStyles.fieldChipText,
                              selected && sortStyles.fieldChipTextActive,
                              usedElsewhere && sortStyles.fieldChipTextDisabled,
                            ]}
                          >
                            {field.label}
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
            style={sortStyles.applyButton}
            onPress={() => {
              const compact = draftLevels.filter(
                (level): level is NonNullable<SortLevel> => level != null,
              );
              const nextLevels: SortLevel[] = [
                compact[0] ?? null,
                compact[1] ?? null,
                compact[2] ?? null,
              ];
              onApply(nextLevels);
              onClose();
            }}
            activeOpacity={0.85}
          >
            <Text style={sortStyles.applyButtonText}>Apply Sort</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const sortStyles = StyleSheet.create({
  modalRoot: { flex: 1 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  modalSheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    maxHeight: "88%",
    overflow: "hidden",
  },
  modalHandle: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 4,
    marginTop: 9,
    marginBottom: 5,
    backgroundColor: Colors.border,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontSize: 17, fontWeight: "700", color: Colors.text },
  cancelBtn: { padding: 4 },
  cancelText: { fontSize: 16, color: Colors.textMuted },
  clearBtn: { padding: 4 },
  clearText: { fontSize: 14, fontWeight: "700", color: Colors.primary },
  headerSpacer: { width: 55 },
  modalScroll: { paddingHorizontal: 20 },
  modalScrollContent: { paddingTop: 14, paddingBottom: 8 },
  hint: {
    fontSize: 12,
    color: Colors.textMuted,
    lineHeight: 17,
    marginBottom: 12,
  },
  levelBlock: {
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  levelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  levelLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    letterSpacing: 0.3,
  },
  levelEmpty: { fontSize: 12, color: Colors.textMuted, fontStyle: "italic" },
  directionButton: {
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
  directionButtonText: { fontSize: 12, fontWeight: "700", color: Colors.primary },
  chipsRow: { flexDirection: "row", gap: 8, paddingVertical: 2, paddingRight: 8 },
  fieldChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  fieldChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  fieldChipDisabled: { opacity: 0.35 },
  fieldChipText: { fontSize: 12, fontWeight: "600", color: Colors.textSecondary },
  fieldChipTextActive: { color: Colors.textInverse },
  fieldChipTextDisabled: { color: Colors.textMuted },
  applyButton: {
    marginHorizontal: 20,
    marginTop: 4,
    paddingVertical: 12,
    borderRadius: 11,
    alignItems: "center",
    backgroundColor: Colors.primary,
  },
  applyButtonText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────

type AutoPOFilter = "all" | "yes" | "no";

export default function DailyStockScreen() {
  const { dailyStockItems, saveDailyStockBatch, clearDailyStock } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  // ── Search / Filters ─────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [selCategory, setSelCategory] = useState<string[]>([]);
  const [selSubCategory, setSelSubCategory] = useState<string[]>([]);
  const [selBrand, setSelBrand] = useState<string[]>([]);
  const [selWeight, setSelWeight] = useState<string[]>([]);
  const [selLAPVendorN, setSelLAPVendorN] = useState<string[]>([]);
  const [autoPOFilter, setAutoPOFilter] = useState<AutoPOFilter>("all");

  // ── Sort ─────────────────────────────────────────────────────────────
  // The committed chain drives the table. The draft chain is edited inside
  // the modal and is only committed when the user taps Apply.
  const [sortLevels, setSortLevels] = useState<SortLevel[]>([...EMPTY_SORT_LEVELS]);
  const [sortLevelsDraft, setSortLevelsDraft] = useState<SortLevel[]>([...EMPTY_SORT_LEVELS]);

  // ── Modal visibility ─────────────────────────────────────────────────
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showSubCategoryModal, setShowSubCategoryModal] = useState(false);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [showLAPVendorNModal, setShowLAPVendorNModal] = useState(false);
  const [showSortModal, setShowSortModal] = useState(false);

  // ── Physical Stock edits: key = String(origIdx), value = raw text ────
  // Changes are held in-memory until the user taps Save.
  const [physEdits, setPhysEdits] = useState<Record<string, string>>({});
  const isDirty = Object.keys(physEdits).length > 0;

  // ── Async operation flags ─────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [exportingXl, setExportingXl] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  // ── Option lists ─────────────────────────────────────────────────────
  const categoryOptions = useMemo(() => unique(dailyStockItems.map((i) => i.categoryCode)), [dailyStockItems]);
  const subCategoryOptions = useMemo(() => unique(dailyStockItems.map((i) => i.subCategoryCode)), [dailyStockItems]);
  const brandOptions = useMemo(() => unique(dailyStockItems.map((i) => i.brandCode)), [dailyStockItems]);
  const weightOptions = useMemo(() => unique(dailyStockItems.map((i) => i.weight !== null ? String(i.weight) : "")), [dailyStockItems]);
  const lapVendorNOptions = useMemo(() => unique(dailyStockItems.map((i) => i.lapVendorN)), [dailyStockItems]);

  // ── Filtered + sorted list (with original indices) ───────────────────
  const filteredWithIdx = useMemo(() => {
    const q = search.trim().toLowerCase();
    const withIdx = dailyStockItems.map((item, idx) => ({ item, origIdx: idx }));
    const result = withIdx.filter(({ item }) => {
      if (selCategory.length > 0 && !selCategory.includes(item.categoryCode)) return false;
      if (selSubCategory.length > 0 && !selSubCategory.includes(item.subCategoryCode)) return false;
      if (selBrand.length > 0 && !selBrand.includes(item.brandCode)) return false;
      if (selWeight.length > 0 && !selWeight.includes(item.weight !== null ? String(item.weight) : "")) return false;
      if (selLAPVendorN.length > 0 && !selLAPVendorN.includes(item.lapVendorN)) return false;
      if (autoPOFilter === "yes" && !item.autoPOAllowed) return false;
      if (autoPOFilter === "no" && item.autoPOAllowed) return false;
      if (q) {
        return (
          item.desc.toLowerCase().includes(q) ||
          item.inventoryCode.toLowerCase().includes(q) ||
          item.brandCode.toLowerCase().includes(q) ||
          item.vendorCode.toLowerCase().includes(q) ||
          item.categoryCode.toLowerCase().includes(q) ||
          item.subCategoryCode.toLowerCase().includes(q) ||
          item.lapVendorN.toLowerCase().includes(q)
        );
      }
      return true;
    });
    return sortItems(result, sortLevels, effectivePhysStock);
  }, [
    dailyStockItems,
    search,
    selCategory,
    selSubCategory,
    selBrand,
    selWeight,
    selLAPVendorN,
    autoPOFilter,
    sortLevels,
    physEdits,
  ]);

  // ── Effective physical stock for a row (edit draft > stored) ─────────
  function effectivePhysStock(item: DailyStockItem, origIdx: number): number | null {
    const key = String(origIdx);
    if (key in physEdits) {
      const raw = physEdits[key].trim();
      if (raw === "") return null;
      const v = parseFloat(raw);
      return Number.isFinite(v) ? v : item.physicalStock;
    }
    return item.physicalStock;
  }

  function stockDiffForRow(item: DailyStockItem, origIdx: number): number | null {
    const ps = effectivePhysStock(item, origIdx);
    if (item.stock === null || ps === null) return null;
    return item.stock - ps;
  }

  // ── Active filter count ───────────────────────────────────────────────
  const activeFilterCount =
    (selCategory.length > 0 ? 1 : 0) +
    (selSubCategory.length > 0 ? 1 : 0) +
    (selBrand.length > 0 ? 1 : 0) +
    (selWeight.length > 0 ? 1 : 0) +
    (selLAPVendorN.length > 0 ? 1 : 0) +
    (autoPOFilter !== "all" ? 1 : 0);

  function clearAllFilters() {
    setSelCategory([]); setSelSubCategory([]); setSelBrand([]);
    setSelWeight([]); setSelLAPVendorN([]); setAutoPOFilter("all"); setSearch("");
  }

  // ── Save physical stock edits ─────────────────────────────────────────
  async function handleSave() {
    if (!isDirty) return;
    setSaving(true);
    try {
      const updated = dailyStockItems.map((item, idx) => {
        const key = String(idx);
        if (key in physEdits) {
          const raw = physEdits[key].trim();
          const parsed = raw === "" ? null : parseFloat(raw);
          const val = raw === "" ? null : (Number.isFinite(parsed!) ? parsed : item.physicalStock);
          return { ...item, physicalStock: val };
        }
        return item;
      });
      await saveDailyStockBatch(updated);
      setPhysEdits({});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Couldn't Save", e?.message ?? "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  // ── Delete all ────────────────────────────────────────────────────────
  function handleClear() {
    if (dailyStockItems.length === 0) return;
    const msg = `Remove all ${dailyStockItems.length} DailyStock row${dailyStockItems.length === 1 ? "" : "s"}? This cannot be undone.`;
    const run = async () => {
      try {
        await clearDailyStock();
        setPhysEdits({});
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        Alert.alert("Couldn't Delete", e?.message ?? "Unknown error");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete All DailyStock?\n\n${msg}`)) void run();
    } else {
      Alert.alert("Delete All DailyStock?", msg, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void run() },
      ]);
    }
  }

  // ── Excel export (filtered rows only) ────────────────────────────────
  async function handleExcelExport() {
    if (filteredWithIdx.length === 0) {
      Alert.alert("Nothing to Export", "No rows match the current filters.");
      return;
    }
    setExportingXl(true);
    try {
      const header = [
        "S.No", "Description", "Weight", "Stock", "Physical Stock", "Stock Diff",
        "InventoryCode", "CategoryCode", "SubCategoryCode", "BrandCode",
        "AutoPOAllowed", "LAPVendorC", "LAPVendorN", "VendorCode",
      ];
      const dataRows: (string | number | null)[][] = filteredWithIdx.map(({ item, origIdx }, i) => {
        const ps = effectivePhysStock(item, origIdx);
        const diff = item.stock !== null && ps !== null ? item.stock - ps : null;
        return [
          i + 1,
          item.desc,
          item.weight ?? "",
          item.stock ?? "",
          ps ?? "",
          diff ?? "",
          item.inventoryCode,
          item.categoryCode,
          item.subCategoryCode,
          item.brandCode,
          item.autoPOAllowed ? "Yes" : "No",
          item.lapVendorC,
          item.lapVendorN,
          item.vendorCode,
        ];
      });

      const exportDate = new Date().toLocaleDateString("en-IN");
      const sheetData: (string | number | null)[][] = [
        ["Sathyam Super Store", "", "DAILY STOCK REPORT", "", "", "", "", "", "", "", "", "", "", ""],
        ["2A, Mettupalayam Road, Cheran Nagar", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["Coimbatore-641029", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["Export Date : " + exportDate, "", "", "", "", "", "", "", "", "", "", "", "", ""],
        [`Rows : ${filteredWithIdx.length}`, "", "", "", "", "", "", "", "", "", "", "", "", ""],
        [],
        header,
        ...dataRows,
      ];

      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws["!cols"] = [
        { wch: 6 }, { wch: 36 }, { wch: 8 }, { wch: 10 }, { wch: 14 },
        { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
        { wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 12 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "DailyStock");

      const _d = new Date();
      const _ts = `${pad2(_d.getDate())}${pad2(_d.getMonth() + 1)}${_d.getFullYear()} ${pad2(_d.getHours())}${pad2(_d.getMinutes())}`;
      const fileName = `DailyStock ${_ts}.xlsx`;

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
            dialogTitle: "Export DailyStock",
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
      setExportingXl(false);
    }
  }

  // ── PDF export (filtered rows only, landscape A4) ─────────────────────
  async function handlePdfExport() {
    if (filteredWithIdx.length === 0) {
      Alert.alert("Nothing to Export", "No rows match the current filters.");
      return;
    }
    setExportingPdf(true);
    try {
      const exportDate = new Date().toLocaleDateString("en-IN");

      const thCells = [
        "S.No", "Description", "Weight", "Stock", "Physical Stock", "Stock Diff",
        "InventoryCode", "CategoryCode", "SubCategoryCode", "BrandCode",
        "AutoPOAllowed", "LAPVendorC", "LAPVendorN", "VendorCode",
      ].map((h) => `<th>${escapeHtml(h)}</th>`).join("");

      const tdRows = filteredWithIdx.map(({ item, origIdx }, i) => {
        const ps = effectivePhysStock(item, origIdx);
        const diff = item.stock !== null && ps !== null ? item.stock - ps : null;
        const diffStr = diff === null ? "—" : fmtDiff(diff);
        const diffColor = diff === null ? "#111" : diff < 0 ? "#c00" : diff > 0 ? "#060" : "#111";
        const cells = [
          String(i + 1),
          escapeHtml(item.desc),
          fmtNum(item.weight),
          fmtNum(item.stock),
          ps !== null ? fmtNum(ps) : "—",
          `<span style="color:${diffColor};font-weight:700">${escapeHtml(diffStr)}</span>`,
          escapeHtml(item.inventoryCode || "—"),
          escapeHtml(item.categoryCode || "—"),
          escapeHtml(item.subCategoryCode || "—"),
          escapeHtml(item.brandCode || "—"),
          item.autoPOAllowed ? "Yes" : "No",
          escapeHtml(item.lapVendorC || "—"),
          escapeHtml(item.lapVendorN || "—"),
          escapeHtml(item.vendorCode || "—"),
        ];
        const bg = i % 2 === 0 ? "" : 'style="background:#f5f7ff"';
        return `<tr ${bg}>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
      }).join("\n");

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { size: A4 landscape; margin: 10mm 10mm; }
  body { font-family: Arial, sans-serif; font-size: 8.5pt; color: #111; }
  .letterhead { margin-bottom: 8px; }
  .letterhead .store { font-size: 13pt; font-weight: bold; }
  .right-block { float: right; text-align: center; }
  .form-label { font-size: 12pt; font-weight: bold; }
  .logo { width: 60px; margin-top: 4px; display: block; }
  .clearfix::after { content: ""; display: block; clear: both; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  thead tr { background: #1a56db; color: #fff; }
  th, td { border: 1px solid #ccc; padding: 3px 5px; font-size: 7.5pt; }
  th { text-align: center; }
  td { text-align: left; }
  td:nth-child(1) { width: 26px; text-align: center; }
  td:nth-child(3), td:nth-child(4), td:nth-child(5), td:nth-child(6) { text-align: right; }
  td:nth-child(11) { text-align: center; }
  .footer { margin-top: 8px; font-size: 8pt; }
</style>
</head>
<body>
<div class="letterhead clearfix">
  <div class="right-block">
    <div class="form-label">DAILY STOCK REPORT</div>
    <img src="${LOGO_BASE64}" class="logo" alt="Logo"/>
  </div>
  <div class="store">Sathyam Super Store</div>
  <div>2A, Mettupalayam Road, Cheran Nagar</div>
  <div>Coimbatore-641029</div>
  <div>98431-44868 &nbsp;|&nbsp; Whatsapp: 97881-44868</div>
  <div>GST# : 33ADFFS5244N1ZR</div>
</div>
<table>
  <thead><tr>${thCells}</tr></thead>
  <tbody>${tdRows}</tbody>
</table>
<div class="footer">
  <div>Export Date : ${escapeHtml(exportDate)}</div>
  <div>Total Rows : ${filteredWithIdx.length}</div>
</div>
</body>
</html>`;

      if (Platform.OS === "web") {
        const _d = new Date();
        const _ts = `${pad2(_d.getDate())}${pad2(_d.getMonth() + 1)}${_d.getFullYear()} ${pad2(_d.getHours())}${pad2(_d.getMinutes())}`;
        const pdfTitle = `DailyStock ${_ts}`;
        const titledHtml = html.replace(/<head>/i, `<head><title>${pdfTitle}</title>`);
        const win = window.open("", "_blank");
        if (!win) throw new Error("Popup blocked. Please allow popups for this site to export PDFs.");
        win.document.open();
        win.document.write(titledHtml);
        win.document.close();
        const triggerPrint = () => { try { win.focus(); win.print(); } catch { /* ignore */ } };
        if (win.document.readyState === "complete") {
          setTimeout(triggerPrint, 300);
        } else {
          win.addEventListener("load", () => setTimeout(triggerPrint, 300));
        }
      } else {
        const _d = new Date();
        const _ts = `${pad2(_d.getDate())}${pad2(_d.getMonth() + 1)}${_d.getFullYear()} ${pad2(_d.getHours())}${pad2(_d.getMinutes())}`;
        const pdfFileName = `DailyStock ${_ts}.pdf`;
        const { uri: tmpUri } = await Print.printToFileAsync({ html });
        let shareUri = tmpUri;
        const cacheDir = FileSystem.cacheDirectory;
        if (cacheDir) {
          const targetUri = cacheDir + encodeURIComponent(pdfFileName);
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
      setExportingPdf(false);
    }
  }

  // ── Filter chip label ─────────────────────────────────────────────────
  function chipLabel(label: string, selected: string[]): string {
    if (selected.length === 0) return label;
    if (selected.length === 1) return selected[0] || label;
    return `${label} (${selected.length})`;
  }

  const activeSortLevels = sortLevels.filter(
    (level): level is NonNullable<SortLevel> => level != null,
  );
  const sortLabel = activeSortLevels.length === 0
    ? "Sort by"
    : activeSortLevels
        .map((level) => {
          const field = SORT_FIELD_BY_KEY[level.key];
          return `${field.label} ${shortDirLabelFor(field.type, level.dir)}`;
        })
        .join("  ›  ");

  // ─────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.content,
          { paddingTop: topPt + 16, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ── */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>Inventory</Text>
            <Text style={styles.title}>Daily Stock</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => router.push("/daily-stock/import" as any)}
              activeOpacity={0.85}
            >
              <Feather name="upload" size={15} color={Colors.primary} />
              <Text style={styles.iconBtnText}>Import</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.iconBtn, styles.iconBtnDanger, dailyStockItems.length === 0 && styles.iconBtnDisabled]}
              onPress={handleClear}
              disabled={dailyStockItems.length === 0}
              activeOpacity={0.85}
            >
              <Feather name="trash-2" size={15} color={dailyStockItems.length === 0 ? Colors.textMuted : Colors.danger} />
              <Text style={[styles.iconBtnText, styles.iconBtnTextDanger, dailyStockItems.length === 0 && styles.iconBtnTextDisabled]}>
                Clear
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Save + Export bar ── */}
        {dailyStockItems.length > 0 && (
          <View style={styles.actionBar}>
            {isDirty && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.saveBtn, saving && styles.actionBtnDisabled]}
                onPress={handleSave}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator size="small" color={Colors.textInverse} />
                  : <Feather name="save" size={15} color={Colors.textInverse} />
                }
                <Text style={styles.saveBtnText}>{saving ? "Saving…" : "Save Changes"}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.actionBtn, styles.exportBtn, exportingXl && styles.actionBtnDisabled]}
              onPress={handleExcelExport}
              disabled={exportingXl}
              activeOpacity={0.85}
            >
              {exportingXl
                ? <ActivityIndicator size="small" color={Colors.primary} />
                : <Feather name="file-text" size={15} color={Colors.primary} />
              }
              <Text style={styles.exportBtnText}>Excel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.exportBtn, exportingPdf && styles.actionBtnDisabled]}
              onPress={handlePdfExport}
              disabled={exportingPdf}
              activeOpacity={0.85}
            >
              {exportingPdf
                ? <ActivityIndicator size="small" color={Colors.primary} />
                : <Feather name="book-open" size={15} color={Colors.primary} />
              }
              <Text style={styles.exportBtnText}>PDF</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Stats ── */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{dailyStockItems.length.toLocaleString()}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: Colors.success }]}>
              {dailyStockItems.filter((i) => i.autoPOAllowed).length.toLocaleString()}
            </Text>
            <Text style={styles.statLabel}>AutoPO</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: Colors.primary }]}>
              {filteredWithIdx.length.toLocaleString()}
            </Text>
            <Text style={styles.statLabel}>Shown</Text>
          </View>
          {isDirty && (
            <>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: Colors.warning }]}>
                  {Object.keys(physEdits).length}
                </Text>
                <Text style={styles.statLabel}>Unsaved</Text>
              </View>
            </>
          )}
        </View>

        {/* ── Search ── */}
        <View style={styles.searchBar}>
          <Feather name="search" size={15} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search desc, inv code, brand, vendor…"
            placeholderTextColor={Colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Feather name="x" size={15} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* ── Filter chips ── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
          <TouchableOpacity style={[styles.filterChip, selCategory.length > 0 && styles.filterChipActive]} onPress={() => setShowCategoryModal(true)} activeOpacity={0.8}>
            <Text style={[styles.filterChipText, selCategory.length > 0 && styles.filterChipTextActive]} numberOfLines={1}>{chipLabel("Category", selCategory)}</Text>
            <Feather name="chevron-down" size={13} color={selCategory.length > 0 ? Colors.primary : Colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterChip, selSubCategory.length > 0 && styles.filterChipActive]} onPress={() => setShowSubCategoryModal(true)} activeOpacity={0.8}>
            <Text style={[styles.filterChipText, selSubCategory.length > 0 && styles.filterChipTextActive]} numberOfLines={1}>{chipLabel("SubCategory", selSubCategory)}</Text>
            <Feather name="chevron-down" size={13} color={selSubCategory.length > 0 ? Colors.primary : Colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterChip, selBrand.length > 0 && styles.filterChipActive]} onPress={() => setShowBrandModal(true)} activeOpacity={0.8}>
            <Text style={[styles.filterChipText, selBrand.length > 0 && styles.filterChipTextActive]} numberOfLines={1}>{chipLabel("BrandCode", selBrand)}</Text>
            <Feather name="chevron-down" size={13} color={selBrand.length > 0 ? Colors.primary : Colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterChip, selWeight.length > 0 && styles.filterChipActive]} onPress={() => setShowWeightModal(true)} activeOpacity={0.8}>
            <Text style={[styles.filterChipText, selWeight.length > 0 && styles.filterChipTextActive]} numberOfLines={1}>{chipLabel("Weight", selWeight)}</Text>
            <Feather name="chevron-down" size={13} color={selWeight.length > 0 ? Colors.primary : Colors.textMuted} />
          </TouchableOpacity>
          {(["all", "yes", "no"] as AutoPOFilter[]).map((v) => (
            <TouchableOpacity
              key={v}
              style={[styles.filterChip, autoPOFilter === v && v !== "all" && styles.filterChipActive, autoPOFilter === v && v === "all" && styles.filterChipNeutral]}
              onPress={() => setAutoPOFilter(v)}
              activeOpacity={0.8}
            >
              <Text style={[styles.filterChipText, autoPOFilter === v && v !== "all" && styles.filterChipTextActive]}>
                {v === "all" ? "AutoPO: All" : v === "yes" ? "AutoPO ✓" : "AutoPO ✗"}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.filterChip, selLAPVendorN.length > 0 && styles.filterChipActive]} onPress={() => setShowLAPVendorNModal(true)} activeOpacity={0.8}>
            <Text style={[styles.filterChipText, selLAPVendorN.length > 0 && styles.filterChipTextActive]} numberOfLines={1}>{chipLabel("LAP Vendor", selLAPVendorN)}</Text>
            <Feather name="chevron-down" size={13} color={selLAPVendorN.length > 0 ? Colors.primary : Colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.filterChip, styles.filterChipSort]} onPress={() => {
            setSortLevelsDraft(sortLevels.map((level) => level ? { ...level } : null));
            setShowSortModal(true);
          }} activeOpacity={0.8}>
            <Feather name="bar-chart-2" size={13} color={Colors.primary} />
            <Text style={styles.filterChipTextActive} numberOfLines={1}>{sortLabel}</Text>
            {activeSortLevels.length > 0 && (
              <TouchableOpacity
                onPress={(event) => {
                  event.stopPropagation();
                  setSortLevels([...EMPTY_SORT_LEVELS]);
                  setSortLevelsDraft([...EMPTY_SORT_LEVELS]);
                }}
                hitSlop={8}
                accessibilityLabel="Clear sort"
              >
                <Feather name="x" size={14} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
          {activeFilterCount > 0 && (
            <TouchableOpacity style={styles.clearFiltersChip} onPress={clearAllFilters} activeOpacity={0.8}>
              <Feather name="x" size={13} color={Colors.danger} />
              <Text style={styles.clearFiltersText}>Clear ({activeFilterCount})</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {/* ── Result count ── */}
        {dailyStockItems.length > 0 && (
          <Text style={styles.resultCount}>
            {filteredWithIdx.length.toLocaleString()} of {dailyStockItems.length.toLocaleString()} rows
            {isDirty ? " · tap Save to commit physical stock changes" : ""}
          </Text>
        )}

        {/* ── Empty states ── */}
        {dailyStockItems.length === 0 ? (
          <View style={styles.emptyBox}>
            <Feather name="inbox" size={36} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No DailyStock data</Text>
            <Text style={styles.emptyHint}>Tap Import to load an OUT_STOCK workbook.</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push("/daily-stock/import" as any)} activeOpacity={0.85}>
              <Feather name="upload" size={16} color={Colors.textInverse} />
              <Text style={styles.emptyBtnText}>Import Excel</Text>
            </TouchableOpacity>
          </View>
        ) : filteredWithIdx.length === 0 ? (
          <View style={styles.emptyBox}>
            <Feather name="filter" size={36} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>No results</Text>
            <Text style={styles.emptyHint}>Try adjusting your filters or search.</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={clearAllFilters} activeOpacity={0.85}>
              <Text style={styles.emptyBtnText}>Clear Filters</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* ── Horizontally scrollable table ── */
          <View style={styles.tableCard}>
            <ScrollView horizontal showsHorizontalScrollIndicator={true}>
              <View>
                {/* Table header */}
                <View style={[styles.tableRow, styles.tableHeader]}>
                  <Text style={[styles.th, { width: 40 }]}>S.No</Text>
                  <Text style={[styles.th, { width: 180 }]}>Description</Text>
                  <Text style={[styles.th, { width: 50 }]}>Weight</Text>
                  <Text style={[styles.th, { width: 60 }]}>Stock</Text>
                  {/* Phy Stock is editable — label shows pencil icon */}
                  <Text style={[styles.th, styles.thEditable, { width: 90 }]}>✏ Physical Stock</Text>
                  <Text style={[styles.th, { width: 70 }]}>Stock Diff</Text>
                  <Text style={[styles.th, { width: 90 }]}>InventoryCode</Text>
                  <Text style={[styles.th, { width: 80 }]}>CategoryCode</Text>
                  <Text style={[styles.th, { width: 90 }]}>SubCategoryCode</Text>
                  <Text style={[styles.th, { width: 80 }]}>BrandCode</Text>
                  <Text style={[styles.th, { width: 90 }]}>AutoPOAllowed</Text>
                  <Text style={[styles.th, { width: 80 }]}>LAPVendorC</Text>
                  <Text style={[styles.th, { width: 130 }]}>LAPVendorN</Text>
                  <Text style={[styles.th, { width: 70 }]}>VendorCode</Text>
                </View>

                {/* Table rows */}
                {filteredWithIdx.map(({ item, origIdx }, i) => {
                  const key = String(origIdx);
                  const psVal = key in physEdits
                    ? physEdits[key]
                    : (item.physicalStock !== null ? String(item.physicalStock) : "");
                  const diff = stockDiffForRow(item, origIdx);
                  const diffColor =
                    diff === null ? Colors.textMuted
                    : diff < 0 ? Colors.danger
                    : diff > 0 ? Colors.success
                    : Colors.text;

                  return (
                    <View
                      key={`${origIdx}-${i}`}
                      style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}
                    >
                      <Text style={[styles.td, { width: 40 }]} numberOfLines={1}>{i + 1}</Text>
                      <Text style={[styles.td, { width: 180 }]} numberOfLines={2}>{item.desc}</Text>
                      <Text style={[styles.td, { width: 50 }]} numberOfLines={1}>{fmtNum(item.weight)}</Text>
                      <Text style={[styles.td, { width: 60 }]} numberOfLines={1}>{fmtNum(item.stock)}</Text>

                      {/* Editable Physical Stock */}
                      <TextInput
                        style={[styles.editInput, { width: 90 }, key in physEdits && styles.editInputDirty]}
                        value={psVal}
                        onChangeText={(v) => setPhysEdits((prev) => ({ ...prev, [key]: v }))}
                        keyboardType="numeric"
                        placeholder="—"
                        placeholderTextColor={Colors.textMuted}
                        returnKeyType="done"
                      />

                      {/* Stock Diff */}
                      <Text style={[styles.td, { width: 70, color: diffColor, fontWeight: diff !== null && diff !== 0 ? "700" : "400" }]} numberOfLines={1}>
                        {diff === null ? "—" : fmtDiff(diff)}
                      </Text>

                      <Text style={[styles.td, { width: 90 }]} numberOfLines={1}>{item.inventoryCode || "—"}</Text>
                      <Text style={[styles.td, { width: 80 }]} numberOfLines={1}>{item.categoryCode || "—"}</Text>
                      <Text style={[styles.td, { width: 90 }]} numberOfLines={1}>{item.subCategoryCode || "—"}</Text>
                      <Text style={[styles.td, { width: 80 }]} numberOfLines={1}>{item.brandCode || "—"}</Text>
                      <View style={[styles.statusPill, { width: 90 }, item.autoPOAllowed ? styles.statusPillOk : styles.statusPillNo]}>
                        <Text style={[styles.statusPillText, { color: item.autoPOAllowed ? Colors.success : Colors.textMuted }]}>
                          {item.autoPOAllowed ? "Yes" : "No"}
                        </Text>
                      </View>
                      <Text style={[styles.td, { width: 80 }]} numberOfLines={1}>{item.lapVendorC || "—"}</Text>
                      <Text style={[styles.td, { width: 130 }]} numberOfLines={1}>{item.lapVendorN || "—"}</Text>
                      <Text style={[styles.td, { width: 70 }]} numberOfLines={1}>{item.vendorCode || "—"}</Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* ── Modals ── */}
      <MultiSelectModal visible={showCategoryModal} title="Category" options={categoryOptions} selected={selCategory} onApply={setSelCategory} onClose={() => setShowCategoryModal(false)} />
      <MultiSelectModal visible={showSubCategoryModal} title="SubCategory" options={subCategoryOptions} selected={selSubCategory} onApply={setSelSubCategory} onClose={() => setShowSubCategoryModal(false)} />
      <MultiSelectModal visible={showBrandModal} title="BrandCode" options={brandOptions} selected={selBrand} onApply={setSelBrand} onClose={() => setShowBrandModal(false)} />
      <MultiSelectModal visible={showWeightModal} title="Weight" options={weightOptions} selected={selWeight} onApply={setSelWeight} onClose={() => setShowWeightModal(false)} />
      <MultiSelectModal visible={showLAPVendorNModal} title="LAP Vendor Name" options={lapVendorNOptions} selected={selLAPVendorN} onApply={setSelLAPVendorN} onClose={() => setShowLAPVendorNModal(false)} />
      <SortModal
        visible={showSortModal}
        levels={sortLevels}
        bottomInset={insets.bottom}
        onApply={(levels) => setSortLevels(levels)}
        onClose={() => setShowSortModal(false)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: 16 },

  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  greeting: { fontSize: 13, color: Colors.textMuted, marginBottom: 2 },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  headerActions: { flexDirection: "row", gap: 8 },
  iconBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: Colors.primary + "30" },
  iconBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  iconBtnDanger: { backgroundColor: Colors.dangerLight, borderColor: Colors.danger + "30" },
  iconBtnTextDanger: { color: Colors.danger },
  iconBtnDisabled: { backgroundColor: Colors.background, borderColor: Colors.border },
  iconBtnTextDisabled: { color: Colors.textMuted },

  // Action bar (Save / Excel / PDF)
  actionBar: { flexDirection: "row", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  actionBtnDisabled: { opacity: 0.6 },
  saveBtn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  saveBtnText: { fontSize: 13, fontWeight: "700", color: Colors.textInverse },
  exportBtn: { backgroundColor: Colors.primaryMuted, borderColor: Colors.primary + "40" },
  exportBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },

  statsRow: { flexDirection: "row", backgroundColor: Colors.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, padding: 14, marginBottom: 12 },
  statItem: { flex: 1, alignItems: "center" },
  statValue: { fontSize: 18, fontWeight: "800", color: Colors.text },
  statLabel: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  statDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: 8 },

  searchBar: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: Colors.surface, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 10 },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text },

  chipScroll: { marginBottom: 10 },
  chipRow: { flexDirection: "row", gap: 8, paddingRight: 16 },
  filterChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  filterChipActive: { backgroundColor: Colors.primaryMuted, borderColor: Colors.primary + "50" },
  filterChipNeutral: { backgroundColor: Colors.surfaceSecondary, borderColor: Colors.border },
  filterChipSort: { backgroundColor: Colors.primaryMuted, borderColor: Colors.primary + "50" },
  filterChipText: { fontSize: 13, fontWeight: "500", color: Colors.textSecondary },
  filterChipTextActive: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  clearFiltersChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: Colors.dangerLight, borderWidth: 1, borderColor: Colors.danger + "30" },
  clearFiltersText: { fontSize: 13, fontWeight: "700", color: Colors.danger },

  resultCount: { fontSize: 12, color: Colors.textMuted, marginBottom: 10, fontWeight: "500" },

  tableCard: { backgroundColor: Colors.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  tableHeader: { backgroundColor: Colors.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tableRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: Colors.borderLight, gap: 8 },
  tableRowAlt: { backgroundColor: Colors.background },
  th: { fontSize: 11, fontWeight: "700", color: Colors.textMuted },
  thEditable: { color: Colors.primary },
  td: { fontSize: 12, color: Colors.text },

  // Editable physical stock cell
  editInput: {
    fontSize: 12, color: Colors.text,
    borderWidth: 1, borderColor: Colors.border, borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 3,
    backgroundColor: Colors.surface,
    textAlign: "right",
  },
  editInputDirty: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },

  statusPill: { paddingVertical: 3, borderRadius: 20, alignItems: "center" },
  statusPillOk: { backgroundColor: Colors.successLight },
  statusPillNo: { backgroundColor: Colors.surfaceSecondary },
  statusPillText: { fontSize: 10, fontWeight: "700" },

  emptyBox: { alignItems: "center", paddingVertical: 60, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  emptyHint: { fontSize: 14, color: Colors.textMuted, textAlign: "center" },
  emptyBtn: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: Colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  emptyBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textInverse },
});
