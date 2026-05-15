import React, { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  Pressable,
  Alert,
} from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useApp, type PriceTagItem } from "@/context/AppContext";
import { DEFAULT_TAG_COLORS, type TagColors } from "@workspace/pricetag-html";
import { StyleBTag } from "./pricetag-review";

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

const PRESETS: { name: string; colors: TagColors }[] = [
  {
    name: "Sathyam (default)",
    colors: DEFAULT_TAG_COLORS,
  },
  {
    name: "Royal Blue",
    colors: { red: "#1E3A8A", deepRed: "#0F1F4D", cream: "#F1F5F9", gold: "#D4A017" },
  },
  {
    name: "Forest Green",
    colors: { red: "#15803D", deepRed: "#14532D", cream: "#F0FDF4", gold: "#CA8A04" },
  },
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
  const { tagColors, setTagColors, resetTagColors } = useApp();

  // Local draft so the user can type freely (e.g. mid-edit "#FF") without
  // every keystroke trying to commit. We only persist when the value
  // is a valid #RRGGBB hex.
  const [draft, setDraft] = useState<TagColors>(tagColors);

  // Reseed the draft when the persisted palette changes externally
  // (e.g. preset applied, reset).
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
      Alert.alert(
        "Invalid color",
        "Each color must be a 6-digit hex code (e.g. #C8102E).",
      );
      return;
    }
    await setTagColors(draft);
  }, [draft, setTagColors, valid]);

  const applyPreset = useCallback(
    async (colors: TagColors) => {
      await setTagColors(colors);
    },
    [setTagColors],
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
              style={[styles.btn, styles.btnPrimary, !valid && styles.btnDisabled]}
              disabled={!valid}
            >
              <Feather name="check" size={16} color="#FFF" />
              <Text style={styles.btnPrimaryText}>Apply</Text>
            </Pressable>
            <Pressable onPress={reset} style={[styles.btn, styles.btnGhost]}>
              <Feather name="rotate-ccw" size={16} color={Colors.text} />
              <Text style={styles.btnGhostText}>Reset to Default</Text>
            </Pressable>
          </View>
        </View>

        {/* Presets */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Presets</Text>
          {PRESETS.map((p) => (
            <Pressable
              key={p.name}
              onPress={() => applyPreset(p.colors)}
              style={styles.presetRow}
            >
              <View style={styles.presetSwatches}>
                {(["red", "deepRed", "cream", "gold"] as const).map((k) => (
                  <View
                    key={k}
                    style={[styles.presetSwatch, { backgroundColor: p.colors[k] }]}
                  />
                ))}
              </View>
              <Text style={styles.presetName}>{p.name}</Text>
              <Feather name="chevron-right" size={18} color={Colors.textMuted} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
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
  btnPrimaryText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  btnGhost: { borderWidth: 1, borderColor: Colors.border, backgroundColor: "#FFF" },
  btnGhostText: { color: Colors.text, fontWeight: "700", fontSize: 14 },
  presetRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  presetSwatches: { flexDirection: "row" },
  presetSwatch: {
    width: 18,
    height: 24,
    borderWidth: 1,
    borderColor: Colors.border,
    marginLeft: -1,
  },
  presetName: { flex: 1, fontSize: 14, fontWeight: "700", color: Colors.text },
});
