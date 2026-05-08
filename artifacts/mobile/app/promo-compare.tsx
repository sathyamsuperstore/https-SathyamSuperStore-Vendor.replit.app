import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import * as XLSX from "xlsx-js-style";
import { Colors } from "@/constants/colors";
import { useApp, type PromoEntry } from "@/context/AppContext";
import { LOGO_BASE64 } from "@/constants/LogoBase64";

// Fields included in the "Changed" diff. Cost / OH Qty / SoldQty
// fluctuate constantly and would create noise, so they're left out by
// design (see task brief). MRP is intentionally NOT listed here: it is
// part of the diff key (see promoKey) so an MRP swap surfaces as a
// paired Added/Removed instead of an in-place edit, which matches the
// importer's "(Item No, BatchNo, MRP) is the unique row" contract.
// SP is also excluded — the user-visible "what's different" question
// for the Promo tab is about PromotionPrice (and validity), not the
// regular shelf price, which can drift independently and would create
// noise in the Changed list.
const CHANGED_FIELDS = [
  "PromotionPrice",
  "PromotionToDate",
] as const;

const FIELD_LABELS: Record<string, string> = {
  PromotionPrice: "Promo",
  PromotionToDate: "Valid Till",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtTimestamp(ts: number): string {
  const d = new Date(ts);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${pad2(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtFileTimestamp(d: Date): string {
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// Diff key: "Item No|BatchNo|MRP". The Promo importer dedupes on this
// triple (a single batch can legitimately ship at multiple MRPs over
// time), so the diff has to mirror that or multiple rows sharing the
// same (Item No, BatchNo) would collapse and silently under-report
// changes. MRP changes themselves still surface — they just appear as
// matching add/remove rows instead of an in-place edit, which is the
// correct semantic for an MRP swap.
export function promoKey(row: PromoEntry): string {
  const itemNo = String(row["Item No"] ?? "").trim();
  const batchNo = String(row["BatchNo"] ?? "").trim();
  const mrp = String(row["MRP"] ?? "").trim();
  return `${itemNo}|${batchNo}|${mrp}`;
}

function fmtVal(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }
  return String(v);
}

// Strict numeric token: optional sign, digits, optional decimal. We use
// this instead of parseFloat() because parseFloat("01/05/2026") returns
// 1, which would cause month/year-only PromotionToDate changes to be
// silently swallowed by the diff. Anything that isn't a clean numeric
// literal falls through to a normalized string compare.
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

function asNumeric(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!NUMERIC_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Numeric-token compare so 12 and "12.00" don't false-positive as a
  // change. Date-shaped strings (e.g. "01/05/2026") are NOT considered
  // numeric — they fall through to the normalized string compare.
  const na = asNumeric(a);
  const nb = asNumeric(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a ?? "").trim() === String(b ?? "").trim();
}

type ChangedRow = {
  key: string;
  itemNo: string;
  batchNo: string;
  description: string;
  diffs: { field: string; from: unknown; to: unknown }[];
  cur: PromoEntry;
};

function computeDiff(current: PromoEntry[], prev: PromoEntry[]) {
  const curMap = new Map<string, PromoEntry>();
  for (const r of current) curMap.set(promoKey(r), r);
  const prevMap = new Map<string, PromoEntry>();
  for (const r of prev) prevMap.set(promoKey(r), r);

  const added: PromoEntry[] = [];
  const removed: PromoEntry[] = [];
  const changed: ChangedRow[] = [];

  for (const [k, r] of curMap) {
    if (!prevMap.has(k)) {
      added.push(r);
      continue;
    }
    const p = prevMap.get(k)!;
    const diffs: ChangedRow["diffs"] = [];
    for (const f of CHANGED_FIELDS) {
      if (!valuesEqual(p[f], r[f])) {
        diffs.push({ field: f, from: p[f], to: r[f] });
      }
    }
    if (diffs.length > 0) {
      const [itemNo, batchNo] = k.split("|");
      changed.push({
        key: k,
        itemNo: itemNo ?? "",
        batchNo: batchNo ?? "",
        description: String(r["Item Description"] ?? ""),
        diffs,
        cur: r,
      });
    }
  }
  for (const [k, r] of prevMap) {
    if (!curMap.has(k)) removed.push(r);
  }
  return { added, removed, changed };
}

export default function PromoCompareScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { promoEntries, promoPrevEntries, promoPrevSnapshotAt } = useApp();
  const [openSection, setOpenSection] = useState<"added" | "removed" | "changed" | null>("changed");
  const [exporting, setExporting] = useState(false);

  const { added, removed, changed } = useMemo(
    () => computeDiff(promoEntries, promoPrevEntries),
    [promoEntries, promoPrevEntries]
  );

  const hasSnapshot = promoPrevEntries.length > 0;
  const hasAnyDiff = added.length + removed.length + changed.length > 0;

  async function handleExportExcel() {
    if (!hasAnyDiff) return;
    try {
      setExporting(true);
      const wb = XLSX.utils.book_new();
      const cols = ["Item No", "BatchNo", "Brand", "VendorName", "Item Description", "MRP", "SP", "PromotionPrice", "PromotionToDate"];
      function sheetFromRows(rows: PromoEntry[], extraChangesCol = false) {
        const headers = extraChangesCol ? [...cols, "Changes"] : cols;
        const data: (string | number)[][] = [headers];
        for (const r of rows) {
          const out = cols.map((h) => {
            const v = r[h];
            if (v === undefined || v === null) return "";
            return v as string | number;
          });
          data.push(out);
        }
        return XLSX.utils.aoa_to_sheet(data);
      }
      XLSX.utils.book_append_sheet(wb, sheetFromRows(added), "Added");
      XLSX.utils.book_append_sheet(wb, sheetFromRows(removed), "Removed");
      const changedHeaders = [...cols, "Changes"];
      const changedData: (string | number)[][] = [changedHeaders];
      for (const c of changed) {
        const out = cols.map((h) => {
          const v = c.cur[h];
          if (v === undefined || v === null) return "";
          return v as string | number;
        });
        const changes = c.diffs
          .map((d) => `${FIELD_LABELS[d.field] ?? d.field} ${fmtVal(d.from)} → ${fmtVal(d.to)}`)
          .join("; ");
        out.push(changes);
        changedData.push(out);
      }
      const changedWs = XLSX.utils.aoa_to_sheet(changedData);
      XLSX.utils.book_append_sheet(wb, changedWs, "Changed");
      const ts = fmtFileTimestamp(new Date());
      const fileName = `Sathyam Super Store Promo Changes ${ts}.xlsx`;
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
        await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: "base64" });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export Promo Changes",
            UTI: "com.microsoft.excel.xlsx",
          });
        } else {
          Alert.alert("Export saved", `File saved to: ${fileUri}`);
        }
      }
    } catch (e: any) {
      Alert.alert("Export Failed", e?.message ?? "Unknown error");
    } finally {
      setExporting(false);
    }
  }

  async function handleExportPdf() {
    if (!hasAnyDiff) return;
    try {
      setExporting(true);
      function tableHtml(title: string, rows: string[][], headers: string[]) {
        if (rows.length === 0) {
          return `<h2 class="sec">${title} (0)</h2><div class="empty">None.</div>`;
        }
        const th = headers.map((h) => `<th>${h}</th>`).join("");
        const tr = rows
          .map((row, i) => {
            const bg = i % 2 === 0 ? "#ffffff" : "#f7f8fa";
            return `<tr style="background:${bg}">${row.map((c) => `<td>${c}</td>`).join("")}</tr>`;
          })
          .join("");
        return `<h2 class="sec">${title} (${rows.length})</h2><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
      }
      function esc(v: unknown): string {
        return String(v ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }
      const baseHeaders = ["Item No", "BatchNo", "Description", "MRP", "SP", "Promo", "Valid Till"];
      const addedRows = added.map((r) => [
        esc(r["Item No"]),
        esc(r["BatchNo"]),
        esc(r["Item Description"]),
        esc(fmtVal(r["MRP"])),
        esc(fmtVal(r["SP"])),
        esc(fmtVal(r["PromotionPrice"])),
        esc(fmtVal(r["PromotionToDate"])),
      ]);
      const removedRows = removed.map((r) => [
        esc(r["Item No"]),
        esc(r["BatchNo"]),
        esc(r["Item Description"]),
        esc(fmtVal(r["MRP"])),
        esc(fmtVal(r["SP"])),
        esc(fmtVal(r["PromotionPrice"])),
        esc(fmtVal(r["PromotionToDate"])),
      ]);
      const changedHeaders = ["Item No", "BatchNo", "Description", "Changes"];
      const changedRows = changed.map((c) => [
        esc(c.itemNo),
        esc(c.batchNo),
        esc(c.description),
        c.diffs
          .map((d) => `${esc(FIELD_LABELS[d.field] ?? d.field)} ${esc(fmtVal(d.from))} → ${esc(fmtVal(d.to))}`)
          .join("<br/>"),
      ]);
      const snapshotText = promoPrevSnapshotAt
        ? fmtTimestamp(promoPrevSnapshotAt)
        : "—";
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
@page { size: A4 portrait; margin: 15mm 12mm; }
body { font-family: Arial, sans-serif; font-size: 9pt; color: #111; }
.letterhead { margin-bottom: 8px; }
.letterhead .store { font-size: 13pt; font-weight: bold; }
.letterhead .notice { font-size: 8pt; color: #c00; margin-top: 4px; }
.right-block { float: right; text-align: center; }
.form-label { font-size: 12pt; font-weight: bold; }
.logo { width: 70px; margin-top: 6px; display: block; }
.clearfix::after { content: ""; display: block; clear: both; }
.snap { margin: 8px 0 4px; font-size: 9pt; color: #555; }
.sec { font-size: 11pt; margin: 14px 0 4px; color: #1a56db; }
.empty { color: #888; font-size: 9pt; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
thead tr { background: #1a56db; color: #fff; }
th, td { border: 1px solid #ccc; padding: 3px 5px; font-size: 8pt; vertical-align: top; }
th { text-align: center; }
td { text-align: left; }
</style></head><body>
<div class="letterhead clearfix">
  <div class="right-block">
    <div class="form-label">PROMO CHANGES</div>
    <img src="${LOGO_BASE64}" class="logo" alt="Logo"/>
  </div>
  <div class="store">Sathyam Super Store</div>
  <div>2A, Mettupalayam Road, Cheran Nagar</div>
  <div>Coimbatore-641029</div>
  <div>98431-44868</div>
  <div>Whatsapp: 97881-44868</div>
  <div>Accounts: 97868-64868 For sharing Credit Notes, and Vendor payment enquiry</div>
  <div>GST# : 33ADFFS5244N1ZR</div>
</div>
<div class="snap">Comparing current Promo to snapshot from <b>${snapshotText}</b></div>
${tableHtml("Added", addedRows, baseHeaders)}
${tableHtml("Removed", removedRows, baseHeaders)}
${tableHtml("Changed", changedRows, changedHeaders)}
</body></html>`;

      if (Platform.OS === "web") {
        await Print.printAsync({ html });
      } else {
        const ts = fmtFileTimestamp(new Date());
        const fileName = `Sathyam Super Store Promo Changes ${ts}.pdf`;
        // expo-print's FilePrintOptions doesn't expose a `fileName` field,
        // so we let it write to the auto-named temp file and then move
        // the result into the cache dir under our preferred name. This
        // keeps the type-checked Print API surface intact while still
        // sharing the file with the customer-facing filename.
        const { uri: tmpUri } = await Print.printToFileAsync({ html });
        const targetUri = (FileSystem.cacheDirectory ?? "") + fileName;
        try {
          // Best-effort cleanup if a previous export with the same
          // timestamp already exists (rare but possible if the user
          // hits Export twice within the same minute).
          await FileSystem.deleteAsync(targetUri, { idempotent: true });
          await FileSystem.moveAsync({ from: tmpUri, to: targetUri });
        } catch {
          // If the move fails for any reason, fall back to sharing the
          // temp URI directly — the export still works, just with the
          // OS-generated filename.
        }
        const finalUri =
          (await FileSystem.getInfoAsync(targetUri)).exists ? targetUri : tmpUri;
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(finalUri, {
            mimeType: "application/pdf",
            dialogTitle: "Export PDF",
            UTI: "com.adobe.pdf",
          });
        } else {
          Alert.alert("PDF saved", `File saved to: ${finalUri}`);
        }
      }
    } catch (e: any) {
      Alert.alert("Export Failed", e?.message ?? "Unknown error");
    } finally {
      setExporting(false);
    }
  }

  function renderSection(
    key: "added" | "removed" | "changed",
    title: string,
    count: number,
    color: string,
    icon: React.ComponentProps<typeof Feather>["name"]
  ) {
    const open = openSection === key;
    return (
      <View style={styles.section}>
        <TouchableOpacity
          style={[styles.sectionHeader, { borderLeftColor: color }]}
          onPress={() => setOpenSection(open ? null : key)}
          activeOpacity={0.8}
        >
          <Feather name={icon} size={16} color={color} />
          <Text style={styles.sectionTitle}>{title}</Text>
          <View style={[styles.countBadge, { backgroundColor: color }]}>
            <Text style={styles.countBadgeText}>{count}</Text>
          </View>
          <Feather name={open ? "chevron-up" : "chevron-down"} size={18} color={Colors.textMuted} />
        </TouchableOpacity>
        {open && (
          <View style={styles.sectionBody}>
            {key === "added" &&
              (added.length === 0 ? (
                <Text style={styles.emptyText}>No new items.</Text>
              ) : (
                added.map((r) => (
                  <View key={promoKey(r)} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowItemNo}>{String(r["Item No"] ?? "")}</Text>
                      <Text style={styles.rowBatch}>{String(r["BatchNo"] ?? "")}</Text>
                    </View>
                    <Text style={styles.rowDesc} numberOfLines={2}>
                      {String(r["Item Description"] ?? "")}
                    </Text>
                    <Text style={styles.rowMeta}>
                      MRP {fmtVal(r["MRP"])} · SP {fmtVal(r["SP"])} · Promo {fmtVal(r["PromotionPrice"])} · Valid {fmtVal(r["PromotionToDate"])}
                    </Text>
                  </View>
                ))
              ))}
            {key === "removed" &&
              (removed.length === 0 ? (
                <Text style={styles.emptyText}>Nothing was removed.</Text>
              ) : (
                removed.map((r) => (
                  <View key={promoKey(r)} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowItemNo}>{String(r["Item No"] ?? "")}</Text>
                      <Text style={styles.rowBatch}>{String(r["BatchNo"] ?? "")}</Text>
                    </View>
                    <Text style={styles.rowDesc} numberOfLines={2}>
                      {String(r["Item Description"] ?? "")}
                    </Text>
                    <Text style={styles.rowMeta}>
                      MRP {fmtVal(r["MRP"])} · SP {fmtVal(r["SP"])} · Promo {fmtVal(r["PromotionPrice"])} · Valid {fmtVal(r["PromotionToDate"])}
                    </Text>
                  </View>
                ))
              ))}
            {key === "changed" &&
              (changed.length === 0 ? (
                <Text style={styles.emptyText}>No price or validity changes.</Text>
              ) : (
                changed.map((c) => (
                  <View key={c.key} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowItemNo}>{c.itemNo}</Text>
                      <Text style={styles.rowBatch}>{c.batchNo}</Text>
                    </View>
                    <Text style={styles.rowDesc} numberOfLines={2}>{c.description}</Text>
                    {c.diffs.map((d) => (
                      <View key={d.field} style={styles.diffLine}>
                        <Text style={styles.diffLabel}>{FIELD_LABELS[d.field] ?? d.field}</Text>
                        <Text style={styles.diffFrom}>{fmtVal(d.from)}</Text>
                        <Feather name="arrow-right" size={12} color={Colors.textMuted} />
                        <Text style={styles.diffTo}>{fmtVal(d.to)}</Text>
                      </View>
                    ))}
                  </View>
                ))
              ))}
          </View>
        )}
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Promo Changes" }} />
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <View style={styles.snapshotBar}>
          <Feather name="clock" size={14} color={Colors.textMuted} />
          <Text style={styles.snapshotText}>
            {hasSnapshot
              ? promoPrevSnapshotAt
                ? `Snapshot from ${fmtTimestamp(promoPrevSnapshotAt)}`
                : "Snapshot from an earlier session"
              : "No previous snapshot yet"}
          </Text>
        </View>

        {!hasSnapshot ? (
          <View style={styles.emptyWrap}>
            <Feather name="camera-off" size={28} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>Nothing to compare yet</Text>
            <Text style={styles.emptySub}>
              Tap "Snapshot now" on the Promo screen, or import a new Promo
              file — your current Promo will be saved automatically before
              the next import.
            </Text>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
              <Text style={styles.backBtnText}>Back to Promo</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.exportRow}>
              <TouchableOpacity
                style={[styles.exportBtn, !hasAnyDiff && { opacity: 0.5 }]}
                onPress={handleExportExcel}
                disabled={exporting || !hasAnyDiff}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Feather name="grid" size={16} color={Colors.primary} />
                )}
                <Text style={styles.exportBtnText}>Excel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.exportBtn, !hasAnyDiff && { opacity: 0.5 }]}
                onPress={handleExportPdf}
                disabled={exporting || !hasAnyDiff}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Feather name="file-text" size={16} color={Colors.primary} />
                )}
                <Text style={styles.exportBtnText}>PDF</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.scrollBody}>
              {renderSection("added", "Added", added.length, "#16A34A", "plus-circle")}
              {renderSection("removed", "Removed", removed.length, Colors.danger, "minus-circle")}
              {renderSection("changed", "Changed", changed.length, "#1a56db", "edit-2")}
              {!hasAnyDiff && (
                <View style={styles.noDiff}>
                  <Feather name="check-circle" size={20} color={Colors.success ?? "#16A34A"} />
                  <Text style={styles.noDiffText}>
                    No changes since the last snapshot.
                  </Text>
                </View>
              )}
            </ScrollView>
          </>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  snapshotBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  snapshotText: { fontSize: 12, color: Colors.textSecondary, fontWeight: "600" },
  exportRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  exportBtnText: { fontSize: 13, fontWeight: "700", color: Colors.primary },
  scrollBody: { padding: 16, gap: 12 },
  section: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderLeftWidth: 4,
  },
  sectionTitle: { flex: 1, fontSize: 15, fontWeight: "800", color: Colors.text },
  countBadge: {
    minWidth: 28,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  countBadgeText: { fontSize: 12, fontWeight: "800", color: Colors.textInverse },
  sectionBody: {
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  row: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 4,
  },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowItemNo: { fontSize: 13, fontWeight: "800", color: Colors.text },
  rowBatch: { fontSize: 12, fontWeight: "600", color: Colors.textMuted },
  rowDesc: { fontSize: 13, color: Colors.text },
  rowMeta: { fontSize: 12, color: Colors.textSecondary },
  diffLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 4,
  },
  diffLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    minWidth: 60,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  diffFrom: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.danger,
    textDecorationLine: "line-through",
  },
  diffTo: { fontSize: 13, fontWeight: "800", color: "#16A34A" },
  emptyText: { fontSize: 13, color: Colors.textMuted, paddingVertical: 8 },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  emptyTitle: { fontSize: 17, fontWeight: "800", color: Colors.text },
  emptySub: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  backBtn: {
    marginTop: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: Colors.primary,
    borderRadius: 10,
  },
  backBtnText: { color: Colors.textInverse, fontWeight: "700" },
  noDiff: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 16,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noDiffText: { fontSize: 13, fontWeight: "700", color: Colors.text },
});
