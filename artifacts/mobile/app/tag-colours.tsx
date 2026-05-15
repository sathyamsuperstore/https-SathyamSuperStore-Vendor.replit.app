import React, { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  Pressable,
  Alert,
  Platform,
  Modal,
  ActivityIndicator,
} from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as XLSX from "xlsx-js-style";
import { Colors } from "@/constants/colors";
import {
  useApp,
  type PriceTagItem,
  type TagColorPreset,
} from "@/context/AppContext";
import { DEFAULT_TAG_COLORS, type TagColors } from "@workspace/pricetag-html";
import { StyleBTag } from "./pricetag-review";

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

// 25 built-in palettes. The first is the Sathyam default; the rest are
// curated retail-friendly brand palettes covering warm, cool, neutral
// and seasonal tones so the user has something punchy to start from.
const BUILTIN_PRESETS: TagColorPreset[] = [
  { name: "Sathyam (default)", colors: DEFAULT_TAG_COLORS },
  { name: "Royal Blue",       colors: { red: "#1E3A8A", deepRed: "#0F1F4D", cream: "#F1F5F9", gold: "#D4A017" } },
  { name: "Forest Green",     colors: { red: "#15803D", deepRed: "#14532D", cream: "#F0FDF4", gold: "#CA8A04" } },
  { name: "Crimson Bold",     colors: { red: "#DC2626", deepRed: "#7F1D1D", cream: "#FEF2F2", gold: "#F59E0B" } },
  { name: "Sunset Orange",    colors: { red: "#EA580C", deepRed: "#9A3412", cream: "#FFF7ED", gold: "#FACC15" } },
  { name: "Tropical Teal",    colors: { red: "#0D9488", deepRed: "#134E4A", cream: "#F0FDFA", gold: "#EAB308" } },
  { name: "Midnight Purple",  colors: { red: "#7C3AED", deepRed: "#4C1D95", cream: "#F5F3FF", gold: "#FBBF24" } },
  { name: "Charcoal Mono",    colors: { red: "#374151", deepRed: "#111827", cream: "#F3F4F6", gold: "#9CA3AF" } },
  { name: "Festive Maroon",   colors: { red: "#9F1239", deepRed: "#4C0519", cream: "#FFF1F2", gold: "#D4A017" } },
  { name: "Mango Yellow",     colors: { red: "#F59E0B", deepRed: "#78350F", cream: "#FFFBEB", gold: "#B45309" } },
  { name: "Ocean Cyan",       colors: { red: "#0891B2", deepRed: "#164E63", cream: "#ECFEFF", gold: "#EAB308" } },
  { name: "Rose Pink",        colors: { red: "#E11D48", deepRed: "#881337", cream: "#FFF1F2", gold: "#F59E0B" } },
  { name: "Fresh Lime",       colors: { red: "#65A30D", deepRed: "#365314", cream: "#F7FEE7", gold: "#CA8A04" } },
  { name: "Indigo Sky",       colors: { red: "#4F46E5", deepRed: "#312E81", cream: "#EEF2FF", gold: "#FACC15" } },
  { name: "Brick Red",        colors: { red: "#B91C1C", deepRed: "#7F1D1D", cream: "#FEF7ED", gold: "#D97706" } },
  { name: "Olive Earth",      colors: { red: "#84CC16", deepRed: "#3F6212", cream: "#F7FEE7", gold: "#A16207" } },
  { name: "Slate Steel",      colors: { red: "#475569", deepRed: "#1E293B", cream: "#F8FAFC", gold: "#CA8A04" } },
  { name: "Coral Reef",       colors: { red: "#F43F5E", deepRed: "#9F1239", cream: "#FFF7ED", gold: "#FBBF24" } },
  { name: "Emerald Lux",      colors: { red: "#059669", deepRed: "#064E3B", cream: "#ECFDF5", gold: "#D4A017" } },
  { name: "Berry Blast",      colors: { red: "#A21CAF", deepRed: "#581C87", cream: "#FAF5FF", gold: "#FACC15" } },
  { name: "Dijon Mustard",    colors: { red: "#CA8A04", deepRed: "#713F12", cream: "#FEFCE8", gold: "#A16207" } },
  { name: "Aqua Mint",        colors: { red: "#14B8A6", deepRed: "#115E59", cream: "#F0FDFA", gold: "#CA8A04" } },
  { name: "Sky Blue",         colors: { red: "#0EA5E9", deepRed: "#0C4A6E", cream: "#F0F9FF", gold: "#F59E0B" } },
  { name: "Holiday Red",      colors: { red: "#C8102E", deepRed: "#5B0A14", cream: "#FFF8F0", gold: "#FFD700" } },
  { name: "Espresso",         colors: { red: "#92400E", deepRed: "#451A03", cream: "#FAF6F0", gold: "#D4A017" } },
];

const SLOTS: { key: keyof TagColors; label: string; hint: string }[] = [
  { key: "red", label: "Red", hint: "Banner / border (Style B/C/D/E)" },
  { key: "deepRed", label: "Deep Red", hint: "Border + MRP (Style A)" },
  { key: "cream", label: "Cream", hint: "Card background (Style A)" },
  { key: "gold", label: "Gold", hint: "Big price text" },
];

const PREVIEW_ITEM: PriceTagItem = {
  key: "preview|tag-colours|240",
  itemNo: "12345",
  description: "Sample Item Preview",
  mrp: 240,
  promotionPrice: 199,
  sp: 199,
  eligibleQty: "1",
  promoSortCode: "",
  addedAt: 0,
};

export default function TagColoursScreen() {
  const insets = useSafeAreaInsets();
  const {
    tagColors,
    setTagColors,
    resetTagColors,
    customTagPresets,
    saveCustomTagPreset,
    deleteCustomTagPreset,
    replaceCustomTagPresets,
  } = useApp();

  const [draft, setDraft] = useState<TagColors>(tagColors);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [appliedAt, setAppliedAt] = useState<number | null>(null);
  const [saveModalVisible, setSaveModalVisible] = useState(false);
  const [saveName, setSaveName] = useState("");
  // Tracks which preset row is mid-apply (spinner) and which was most
  // recently applied (green check + row highlight). Without these the
  // tap on a preset looks like nothing happens because the rest of the
  // page only re-syncs `draft` via a useEffect a moment later.
  const [applyingPreset, setApplyingPreset] = useState<string | null>(null);
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);

  // Auto-clear the "Applied" confirmation after 2.5s so the button
  // returns to its normal state without the user having to do anything.
  React.useEffect(() => {
    if (appliedAt == null) return;
    const t = setTimeout(() => setAppliedAt(null), 2500);
    return () => clearTimeout(t);
  }, [appliedAt]);

  // Same auto-clear for the per-preset "Applied" highlight.
  React.useEffect(() => {
    if (appliedPreset == null) return;
    const t = setTimeout(() => setAppliedPreset(null), 2500);
    return () => clearTimeout(t);
  }, [appliedPreset]);

  React.useEffect(() => {
    setDraft(tagColors);
  }, [tagColors]);

  const valid = useMemo(
    () =>
      HEX_RE.test(draft.red) &&
      HEX_RE.test(draft.deepRed) &&
      HEX_RE.test(draft.cream) &&
      HEX_RE.test(draft.gold),
    [draft],
  );

  const onChangeSlot = useCallback((key: keyof TagColors, raw: string) => {
    const v = raw.startsWith("#") ? raw : `#${raw}`;
    setDraft((d) => ({ ...d, [key]: v.slice(0, 7).toUpperCase() }));
  }, []);

  const apply = useCallback(async () => {
    if (!valid) {
      Alert.alert("Invalid color", "Each color must be a 6-digit hex code (e.g. #C8102E).");
      return;
    }
    if (applying) return;
    try {
      setApplying(true);
      setAppliedAt(null);
      await setTagColors(draft);
      setAppliedAt(Date.now());
    } catch (e) {
      Alert.alert("Apply failed", e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [applying, draft, setTagColors, valid]);

  const applyPreset = useCallback(
    async (name: string, colors: TagColors) => {
      if (applyingPreset) return;
      try {
        setApplyingPreset(name);
        setAppliedPreset(null);
        // Sync the draft swatches/inputs immediately so the user sees
        // the new colors flow into the editor on the same frame as the
        // tap, rather than waiting for the tagColors useEffect.
        setDraft(colors);
        await setTagColors(colors);
        setAppliedPreset(name);
      } catch (e) {
        Alert.alert(
          "Apply failed",
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        setApplyingPreset(null);
      }
    },
    [applyingPreset, setTagColors],
  );

  const reset = useCallback(() => {
    Alert.alert("Reset palette", "Restore the default Sathyam brand colors?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: () => {
          void resetTagColors();
        },
      },
    ]);
  }, [resetTagColors]);

  // Combined list rendered in the scrollable presets container.
  const allPresets = useMemo(
    () => [
      ...BUILTIN_PRESETS.map((p) => ({ ...p, isCustom: false })),
      ...customTagPresets.map((p) => ({ ...p, isCustom: true })),
    ],
    [customTagPresets],
  );

  function openSaveModal() {
    if (!valid) {
      Alert.alert("Invalid color", "Fix the hex codes before saving.");
      return;
    }
    setSaveName("");
    setSaveModalVisible(true);
  }

  async function confirmSave() {
    const clean = saveName.trim();
    if (!clean) {
      Alert.alert("Name required", "Give the preset a name.");
      return;
    }
    const dup = customTagPresets.find(
      (p) => p.name.toLowerCase() === clean.toLowerCase(),
    );
    const builtinDup = BUILTIN_PRESETS.find(
      (p) => p.name.toLowerCase() === clean.toLowerCase(),
    );
    if (builtinDup) {
      Alert.alert(
        "Reserved name",
        "That name matches a built-in preset. Pick another.",
      );
      return;
    }
    const doSave = async () => {
      await saveCustomTagPreset(clean, draft);
      setSaveModalVisible(false);
    };
    if (dup) {
      Alert.alert("Replace preset?", `"${clean}" already exists. Overwrite it?`, [
        { text: "Cancel", style: "cancel" },
        { text: "Overwrite", style: "destructive", onPress: () => void doSave() },
      ]);
    } else {
      await doSave();
    }
  }

  function confirmDeleteCustom(name: string) {
    Alert.alert("Delete preset", `Remove "${name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void deleteCustomTagPreset(name),
      },
    ]);
  }

  async function onExport() {
    try {
      setBusy(true);
      // Export ALL presets (built-in + custom) so the user has a full
      // record they can edit and re-import.
      const rows = allPresets.map((p) => ({
        Name: p.name,
        Red: p.colors.red,
        DeepRed: p.colors.deepRed,
        Cream: p.colors.cream,
        Gold: p.colors.gold,
        Type: p.isCustom ? "Custom" : "Built-in",
      }));
      const ws = XLSX.utils.json_to_sheet(rows, {
        header: ["Name", "Red", "DeepRed", "Cream", "Gold", "Type"],
      });
      ws["!cols"] = [{ wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "TagColourPresets");

      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const filename = `TagColourPresets_${stamp}.xlsx`;

      if (Platform.OS === "web") {
        const wbout = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        const blob = new Blob([wbout], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
        const path = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(path, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, {
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export Tag Colour Presets",
            UTI: "org.openxmlformats.spreadsheetml.sheet",
          });
        } else {
          Alert.alert("Saved", `Exported to ${path}`);
        }
      }
    } catch (e) {
      Alert.alert("Export failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel",
          "*/*",
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      setBusy(true);
      const asset = result.assets[0];
      if (!asset) return;

      let workbook: XLSX.WorkBook;
      if (Platform.OS === "web") {
        const resp = await fetch(asset.uri);
        const arrayBuffer = await resp.arrayBuffer();
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        workbook = XLSX.read(base64, { type: "base64" });
      }
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        Alert.alert("Import failed", "The file has no sheets.");
        return;
      }
      const sheet = workbook.Sheets[firstSheetName];
      if (!sheet) {
        Alert.alert("Import failed", "Could not read the first sheet.");
        return;
      }
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      // Drop built-in names so the user's custom list never shadows
      // the canned ones (those always render from BUILTIN_PRESETS).
      const builtinLower = new Set(
        BUILTIN_PRESETS.map((p) => p.name.toLowerCase()),
      );
      const seen = new Set<string>();
      const parsed: TagColorPreset[] = [];
      let skipped = 0;

      const norm = (s: unknown): string =>
        s == null ? "" : String(s).trim();
      const normHex = (s: unknown): string => {
        const v = norm(s);
        const withHash = v.startsWith("#") ? v : `#${v}`;
        return withHash.toUpperCase();
      };

      for (const r of rows) {
        const name = norm(r["Name"] ?? r["name"] ?? r["NAME"]).slice(0, 60);
        const red = normHex(r["Red"] ?? r["red"] ?? r["RED"]);
        const deepRed = normHex(
          r["DeepRed"] ?? r["deepRed"] ?? r["Deep Red"] ?? r["deep_red"] ?? r["DEEPRED"],
        );
        const cream = normHex(r["Cream"] ?? r["cream"] ?? r["CREAM"]);
        const gold = normHex(r["Gold"] ?? r["gold"] ?? r["GOLD"]);
        if (!name) {
          skipped++;
          continue;
        }
        if (builtinLower.has(name.toLowerCase())) {
          skipped++;
          continue;
        }
        if (
          !HEX_RE.test(red) ||
          !HEX_RE.test(deepRed) ||
          !HEX_RE.test(cream) ||
          !HEX_RE.test(gold)
        ) {
          skipped++;
          continue;
        }
        const lower = name.toLowerCase();
        if (seen.has(lower)) {
          skipped++;
          continue;
        }
        seen.add(lower);
        parsed.push({ name, colors: { red, deepRed, cream, gold } });
      }

      if (parsed.length === 0) {
        Alert.alert(
          "Nothing imported",
          `No valid rows found. Expect columns: Name, Red, DeepRed, Cream, Gold (each color a #RRGGBB hex).${
            skipped > 0 ? ` Skipped ${skipped} row(s).` : ""
          }`,
        );
        return;
      }

      Alert.alert(
        "Replace custom presets?",
        `Found ${parsed.length} valid preset(s)${
          skipped > 0 ? ` (${skipped} skipped)` : ""
        }. Replace your current custom presets with this list?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Replace",
            style: "destructive",
            onPress: () => void replaceCustomTagPresets(parsed),
          },
        ],
      );
    } catch (e) {
      Alert.alert("Import failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Tag Colours</Text>
        <Text style={styles.subtitle}>
          Customize the brand palette used by every Style A/B/C/D/E pricetag
          (preview, PDF, and shareable JPEG).
        </Text>

        {/* Live preview */}
        <View style={styles.previewWrap}>
          <Text style={styles.sectionLabel}>Live preview (Style B)</Text>
          <View style={styles.previewCard}>
            <StyleBTag
              item={PREVIEW_ITEM}
              busy={false}
              showLogo={false}
              onAddImage={() => {}}
              onRemoveImage={() => {}}
              onRemoveBackground={() => {}}
              bannerLabel="LOW PRICES"
            />
          </View>
        </View>

        {/* HEX inputs */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Custom palette</Text>
          {SLOTS.map((slot) => {
            const value = draft[slot.key];
            const ok = HEX_RE.test(value);
            return (
              <View key={slot.key} style={styles.slotRow}>
                <View
                  style={[
                    styles.swatch,
                    { backgroundColor: ok ? value : "#E5E7EB" },
                  ]}
                />
                <View style={styles.slotMeta}>
                  <Text style={styles.slotLabel}>{slot.label}</Text>
                  <Text style={styles.slotHint}>{slot.hint}</Text>
                </View>
                <TextInput
                  style={[styles.hexInput, !ok && styles.hexInputBad]}
                  value={value}
                  onChangeText={(t) => onChangeSlot(slot.key, t)}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={7}
                  placeholder="#RRGGBB"
                  placeholderTextColor={Colors.textMuted}
                />
              </View>
            );
          })}

          <View style={styles.actionRow}>
            <Pressable
              onPress={apply}
              style={[
                styles.btn,
                appliedAt != null ? styles.btnApplied : styles.btnPrimary,
                (!valid || applying) && styles.btnDisabled,
              ]}
              disabled={!valid || applying}
            >
              {applying ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <Feather
                  name={appliedAt != null ? "check-circle" : "check"}
                  size={16}
                  color="#FFF"
                />
              )}
              <Text style={styles.btnPrimaryText}>
                {applying ? "Applying…" : appliedAt != null ? "Applied" : "Apply"}
              </Text>
            </Pressable>
            <Pressable
              onPress={openSaveModal}
              style={[styles.btn, styles.btnAccent, !valid && styles.btnDisabled]}
              disabled={!valid}
            >
              <Feather name="bookmark" size={16} color="#FFF" />
              <Text style={styles.btnPrimaryText}>Save as Preset</Text>
            </Pressable>
            <Pressable onPress={reset} style={[styles.btn, styles.btnGhost]}>
              <Feather name="rotate-ccw" size={16} color={Colors.text} />
              <Text style={styles.btnGhostText}>Reset</Text>
            </Pressable>
          </View>
        </View>

        {/* Presets — fixed-height inner scroll so the user can browse
            25+ palettes without bloating the page. */}
        <View style={styles.section}>
          <View style={styles.presetsHeader}>
            <Text style={styles.sectionLabel}>
              Presets ({allPresets.length})
            </Text>
            <View style={styles.ioRow}>
              <Pressable
                onPress={onImport}
                style={[styles.iconBtn, busy && styles.btnDisabled]}
                disabled={busy}
              >
                <Feather name="upload" size={14} color={Colors.text} />
                <Text style={styles.iconBtnText}>Import</Text>
              </Pressable>
              <Pressable
                onPress={onExport}
                style={[styles.iconBtn, busy && styles.btnDisabled]}
                disabled={busy}
              >
                <Feather name="download" size={14} color={Colors.text} />
                <Text style={styles.iconBtnText}>Export</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView
            style={styles.presetScroll}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            {allPresets.map((p) => (
              <View
                key={`${p.isCustom ? "c" : "b"}|${p.name}`}
                style={[
                  styles.presetRow,
                  appliedPreset === p.name && styles.presetRowApplied,
                  applyingPreset === p.name && styles.presetRowApplying,
                ]}
              >
                <Pressable
                  onPress={() => applyPreset(p.name, p.colors)}
                  style={styles.presetMain}
                  disabled={applyingPreset != null}
                >
                  <View style={styles.presetSwatches}>
                    {(["red", "deepRed", "cream", "gold"] as const).map((k) => (
                      <View
                        key={k}
                        style={[styles.presetSwatch, { backgroundColor: p.colors[k] }]}
                      />
                    ))}
                  </View>
                  <View style={styles.presetMeta}>
                    <Text style={styles.presetName} numberOfLines={1}>
                      {p.name}
                    </Text>
                    {p.isCustom ? (
                      <Text style={styles.presetTag}>Custom</Text>
                    ) : null}
                  </View>
                </Pressable>
                {applyingPreset === p.name ? (
                  <ActivityIndicator size="small" color={Colors.text} />
                ) : appliedPreset === p.name ? (
                  <View style={styles.appliedBadge}>
                    <Feather name="check-circle" size={14} color="#FFF" />
                    <Text style={styles.appliedBadgeText}>Applied</Text>
                  </View>
                ) : p.isCustom ? (
                  <Pressable
                    onPress={() => confirmDeleteCustom(p.name)}
                    style={styles.deleteBtn}
                    hitSlop={8}
                  >
                    <Feather name="trash-2" size={16} color="#DC2626" />
                  </Pressable>
                ) : (
                  <Feather name="chevron-right" size={18} color={Colors.textMuted} />
                )}
              </View>
            ))}
          </ScrollView>
          <Text style={styles.helper}>
            Tap a preset to apply it. Excel template columns:
            Name, Red, DeepRed, Cream, Gold (each a #RRGGBB hex).
          </Text>
        </View>
      </ScrollView>

      {/* Save-as-preset modal */}
      <Modal
        visible={saveModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSaveModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Save as Preset</Text>
            <Text style={styles.modalSubtitle}>
              Give this palette a name. You can apply it any time from the
              Presets list.
            </Text>
            <View style={styles.modalSwatches}>
              {(["red", "deepRed", "cream", "gold"] as const).map((k) => (
                <View
                  key={k}
                  style={[styles.modalSwatch, { backgroundColor: draft[k] }]}
                />
              ))}
            </View>
            <TextInput
              style={styles.modalInput}
              value={saveName}
              onChangeText={setSaveName}
              placeholder="e.g. Diwali 2026"
              placeholderTextColor={Colors.textMuted}
              autoFocus
              maxLength={60}
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setSaveModalVisible(false)}
                style={[styles.btn, styles.btnGhost]}
              >
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmSave}
                style={[styles.btn, styles.btnPrimary]}
              >
                <Feather name="check" size={16} color="#FFF" />
                <Text style={styles.btnPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, paddingBottom: 80 },
  title: { fontSize: 22, fontWeight: "800", color: Colors.text },
  subtitle: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 4,
    marginBottom: 16,
    lineHeight: 18,
  },
  previewWrap: { marginBottom: 16 },
  previewCard: {
    backgroundColor: "#FFF",
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  section: {
    marginBottom: 20,
    backgroundColor: "#FFF",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  slotRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    gap: 10,
  },
  swatch: {
    width: 36,
    height: 36,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  slotMeta: { flex: 1 },
  slotLabel: { fontSize: 14, fontWeight: "700", color: Colors.text },
  slotHint: { fontSize: 11, color: Colors.textMuted },
  hexInput: {
    width: 110,
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 6,
    backgroundColor: "#FAFAFA",
    fontVariant: ["tabular-nums"],
  },
  hexInputBad: {
    borderColor: "#DC2626",
    backgroundColor: "#FEF2F2",
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    flexWrap: "wrap",
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 6,
  },
  btnPrimary: { backgroundColor: "#16A34A" },
  btnApplied: { backgroundColor: "#15803D" },
  btnAccent: { backgroundColor: "#2563EB" },
  btnPrimaryText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  btnGhost: { borderWidth: 1, borderColor: Colors.border, backgroundColor: "#FFF" },
  btnGhostText: { color: Colors.text, fontWeight: "700", fontSize: 14 },
  presetsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  ioRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
  iconBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 6,
    backgroundColor: "#FFF",
  },
  iconBtnText: { fontSize: 12, fontWeight: "700", color: Colors.text },
  presetScroll: {
    maxHeight: 360,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    backgroundColor: "#FAFAFA",
  },
  presetRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  presetRowApplying: {
    backgroundColor: "#EEF2FF",
  },
  presetRowApplied: {
    backgroundColor: "#ECFDF5",
  },
  appliedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#16A34A",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  appliedBadgeText: {
    color: "#FFF",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  presetMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  presetSwatches: { flexDirection: "row" },
  presetSwatch: {
    width: 18,
    height: 24,
    borderWidth: 1,
    borderColor: Colors.border,
    marginLeft: -1,
  },
  presetMeta: { flex: 1 },
  presetName: { fontSize: 14, fontWeight: "700", color: Colors.text },
  presetTag: {
    fontSize: 10,
    color: "#2563EB",
    fontWeight: "700",
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  deleteBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  helper: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 8,
    lineHeight: 15,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#FFF",
    borderRadius: 12,
    padding: 18,
    gap: 10,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: Colors.text },
  modalSubtitle: { fontSize: 13, color: Colors.textMuted, lineHeight: 18 },
  modalSwatches: { flexDirection: "row", marginVertical: 4 },
  modalSwatch: {
    width: 28,
    height: 28,
    borderWidth: 1,
    borderColor: Colors.border,
    marginLeft: -1,
  },
  modalInput: {
    fontSize: 15,
    color: Colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    backgroundColor: "#FAFAFA",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
});
