import React, { useMemo, useState } from "react";
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
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

  // Visible rows: matches (Rodeo has Offer Price, side-by-side
  // compare) + items missing from Rodeo entirely (flagged so the
  // user can decide whether to add the product). "missing-offer" is
  // intentionally hidden — those are the rows the Export button
  // surfaces so the user can plan offer additions in Rodeo.
  const visibleRows = useMemo(() => {
    const base = allRows.filter((r) => r.status !== "missing-offer");
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((r) => {
      const haystack = [
        fmtText(r.promo["Item No"]),
        fmtText(r.promo["Item Description"]),
        fmtText(r.promo["Brand"]),
        fmtText(r.promo["Category"]),
        fmtText(r.rodeo?.itemCode),
        fmtText(r.rodeo?.productName),
      ]
        .join(" | ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allRows, search]);

  const exportableRows = useMemo(
    () => allRows.filter((r) => r.status === "missing-offer"),
    [allRows],
  );

  const counts = useMemo(() => {
    let match = 0;
    let missingOffer = 0;
    let notInRodeo = 0;
    for (const r of allRows) {
      if (r.status === "match") match += 1;
      else if (r.status === "missing-offer") missingOffer += 1;
      else notInRodeo += 1;
    }
    return { match, missingOffer, notInRodeo, total: allRows.length };
  }, [allRows]);

  async function handleExportMissingOffers() {
    if (exportableRows.length === 0) {
      const msg =
        "No Unipro promo items found whose matching RodeoItem has an empty Offer Price.";
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
            (exportableRows.length === 0 || exporting) && styles.exportBtnDisabled,
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
          Rodeo.
        </Text>

        <View style={styles.searchWrap}>
          <Feather name="search" size={14} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search Item No, Description, Brand…"
            placeholderTextColor={Colors.textMuted}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Feather name="x" size={14} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 100 : 24) },
        ]}
      >
        {visibleRows.length === 0 ? (
          <View style={styles.emptyInline}>
            <Text style={styles.emptyInlineText}>
              No rows match. {counts.missingOffer > 0
                ? `${counts.missingOffer} item${counts.missingOffer === 1 ? "" : "s"} are hidden because their matching RodeoItem has no Offer Price — use the Export button above to surface them.`
                : ""}
            </Text>
          </View>
        ) : (
          visibleRows.map((r, i) => <CompareCard key={i} row={r} />)
        )}
      </ScrollView>
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
  listContent: { padding: 12, gap: 12 },
  emptyInline: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyInlineText: { fontSize: 13, color: Colors.textMuted, lineHeight: 19 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
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
});
