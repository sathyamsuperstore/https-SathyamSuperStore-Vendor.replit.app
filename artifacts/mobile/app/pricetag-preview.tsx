import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  Alert,
  ActionSheetIOS,
  Platform,
  Modal,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, type PriceTagItem, type PriceTagStyle } from "@/context/AppContext";
import { pickFont, hasTamil } from "@/constants/typography";

// PriceTag Preview screen.
//
// Two visual styles, picked by the user from a chip toggle in the
// toolbar. The same style drives the on-screen grid AND the exported
// PDF, so what you see is what prints.
//
//   "A"  Special Offer card  — image right, MRP strikethrough, big
//        OFFER PRICE, dark-red/cream tones (Protinex-style).
//   "B"  Low Prices banner   — red banner top with "LOW PRICES",
//        image+price middle, red banner bottom with description
//        (Aashirvaad-style).
//
// Modes:
//   "view"   — read-only grid, Modify + Export PDF buttons.
//   "modify" — × on every tag; Save commits removed items, Cancel
//              rolls back.
//
// All persistence (items, attached images, chosen style) flows through
// AppContext so a refresh / app restart keeps the preview intact.

type Mode = "view" | "modify";

// Style A's tile-art accent palette (matches the references).
const RED = "#C8102E";
const DEEP_RED = "#7A0F19";
const CREAM = "#F8F2E4";
const GOLD = "#B8860B";

// ----------- Price helpers -----------

// Round to whole rupees and return as a string (no decimals). The
// store's printed tags don't use paise, so 506.49 -> "506".
function fmt0(v: string | number | undefined): string {
  if (v === undefined || v === null || v === "") return "";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return String(Math.round(n));
}

function toNum(v: string | number | undefined): number {
  if (v === undefined || v === null || v === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Decide which price line to print and how to label it.
//   PromotionPrice present  -> label "Offer Price"
//   else SP                 -> label "Price"
//   else                    -> em-dash placeholder
function priceFor(item: PriceTagItem): { label: string; value: string; isOffer: boolean } {
  const p = fmt0(item.promotionPrice);
  if (p) return { label: "Offer Price", value: p, isOffer: true };
  const sp = fmt0(item.sp);
  if (sp) return { label: "Price", value: sp, isOffer: false };
  return { label: "Price", value: "—", isOffer: false };
}

// Customer savings = MRP - active price. Returns null when there's
// no real saving (no MRP, no offer line, or MRP <= offer).
function offAmount(item: PriceTagItem): string | null {
  const mrp = toNum(item.mrp);
  // Only compute "OFF" against the offer price — falling back to SP
  // would imply every regular item is "discounted" which it isn't.
  const offer = toNum(item.promotionPrice);
  if (!Number.isFinite(mrp) || !Number.isFinite(offer)) return null;
  const off = Math.round(mrp) - Math.round(offer);
  if (off <= 0) return null;
  return String(off);
}

// ----------- Drive helpers -----------

function extractDriveFileId(input: string): string | null {
  const s = input.trim();
  const fileMatch = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const openMatch = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (openMatch) return openMatch[1];
  if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) return s;
  return null;
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

// ============================================================
// Screen
// ============================================================

export default function PriceTagPreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    priceTagItems,
    savePriceTagItems,
    setPriceTagImage,
    clearPriceTagItems,
    priceTagStyle,
    setPriceTagStyle,
  } = useApp();

  const [mode, setMode] = useState<Mode>("view");
  const [workingItems, setWorkingItems] = useState<PriceTagItem[]>(priceTagItems);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [driveOpenForKey, setDriveOpenForKey] = useState<string | null>(null);
  const [driveUrl, setDriveUrl] = useState("");
  const [driveLoading, setDriveLoading] = useState(false);

  const items = mode === "modify" ? workingItems : priceTagItems;

  function enterModify() {
    setWorkingItems(priceTagItems);
    setMode("modify");
  }
  function cancelModify() {
    setWorkingItems(priceTagItems);
    setMode("view");
  }
  async function commitModify() {
    try {
      await savePriceTagItems(workingItems);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMode("view");
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message ?? "Storage error");
    }
  }
  function removeFromWorking(key: string) {
    setWorkingItems((prev) => prev.filter((i) => i.key !== key));
  }

  // -------- Image attachment (camera / gallery / drive) --------
  async function ensureLibraryPermission() {
    const r = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (r.status !== "granted") {
      Alert.alert("Permission needed", "Please allow photo library access.");
      return false;
    }
    return true;
  }
  async function ensureCameraPermission() {
    const r = await ImagePicker.requestCameraPermissionsAsync();
    if (r.status !== "granted") {
      Alert.alert("Permission needed", "Please allow camera access.");
      return false;
    }
    return true;
  }
  async function applyAsset(key: string, asset: ImagePicker.ImagePickerAsset) {
    const longerEdge = Math.max(asset.width ?? 0, asset.height ?? 0);
    const ratio = longerEdge > 1024 ? 1024 / longerEdge : 1;
    const resizeActions = ratio < 1
      ? [{ resize: { width: Math.round((asset.width ?? 0) * ratio) } }]
      : [];
    const m = await ImageManipulator.manipulateAsync(asset.uri, resizeActions, {
      compress: 0.6,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    const b64 = m.base64 ?? asset.base64;
    if (!b64) throw new Error("Could not encode image");
    const dataUri = `data:image/jpeg;base64,${b64}`;
    await setPriceTagImage(key, dataUri);
    setWorkingItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, imageUri: dataUri } : i))
    );
  }
  async function pickFromLibrary(key: string) {
    if (!(await ensureLibraryPermission())) return;
    setBusyKey(key);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.6,
        base64: true,
      });
      if (!result.canceled && result.assets?.[0]) await applyAsset(key, result.assets[0]);
    } catch (e: any) {
      Alert.alert("Couldn't add image", e?.message ?? "Unknown error");
    } finally {
      setBusyKey(null);
    }
  }
  async function takePhoto(key: string) {
    if (!(await ensureCameraPermission())) return;
    setBusyKey(key);
    try {
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 0.6,
        base64: true,
      });
      if (!result.canceled && result.assets?.[0]) await applyAsset(key, result.assets[0]);
    } catch (e: any) {
      Alert.alert("Couldn't take photo", e?.message ?? "Unknown error");
    } finally {
      setBusyKey(null);
    }
  }
  function openDriveModal(key: string) {
    setDriveUrl("");
    setDriveOpenForKey(key);
  }
  async function attachDrive() {
    if (!driveOpenForKey) return;
    const id = extractDriveFileId(driveUrl);
    if (!id) {
      Alert.alert(
        "Invalid Drive link",
        "Paste a Google Drive sharing link or file ID. The file must be shared as 'Anyone with the link'."
      );
      return;
    }
    const key = driveOpenForKey;
    setDriveLoading(true);
    try {
      const url = `https://drive.google.com/uc?export=download&id=${id}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const blob = await resp.blob();
      const dataUri = await blobToDataUri(blob);
      await setPriceTagImage(key, dataUri);
      setWorkingItems((prev) =>
        prev.map((i) => (i.key === key ? { ...i, imageUri: dataUri } : i))
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDriveOpenForKey(null);
    } catch (e: any) {
      Alert.alert(
        "Couldn't fetch from Drive",
        e?.message ?? "Make sure the file is shared as 'Anyone with the link'."
      );
    } finally {
      setDriveLoading(false);
    }
  }
  function handleAddImage(key: string) {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Take Photo", "Choose from Library", "Google Drive Link"],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) takePhoto(key);
          else if (idx === 2) pickFromLibrary(key);
          else if (idx === 3) openDriveModal(key);
        }
      );
    } else {
      Alert.alert("Add Product Image", undefined, [
        { text: "Take Photo", onPress: () => takePhoto(key) },
        { text: "Choose from Library", onPress: () => pickFromLibrary(key) },
        { text: "Google Drive Link", onPress: () => openDriveModal(key) },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }
  async function removeImage(key: string) {
    try {
      await setPriceTagImage(key, null);
      setWorkingItems((prev) =>
        prev.map((i) => (i.key === key ? { ...i, imageUri: undefined } : i))
      );
    } catch (e: any) {
      Alert.alert("Couldn't remove image", e?.message ?? "Storage error");
    }
  }

  // -------- PDF export --------
  async function exportPdf() {
    if (priceTagItems.length === 0) return;
    setExporting(true);
    try {
      const html = buildPdfHtml(priceTagItems, priceTagStyle);
      const { uri } = await Print.printToFileAsync({ html });
      if (Platform.OS === "web") return;
      const can = await Sharing.isAvailableAsync();
      if (can) {
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          dialogTitle: "Price Tags PDF",
          UTI: "com.adobe.pdf",
        });
      } else {
        Alert.alert("PDF saved", uri);
      }
    } catch (e: any) {
      Alert.alert("Export failed", e?.message ?? "Could not generate PDF");
    } finally {
      setExporting(false);
    }
  }

  function confirmClearAll() {
    Alert.alert(
      "Clear all price tags?",
      "This removes every item from the preview. Your image attachments will also be discarded.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            await clearPriceTagItems();
            setWorkingItems([]);
            setMode("view");
            router.back();
          },
        },
      ]
    );
  }

  // -------- Empty state --------
  if (priceTagItems.length === 0 && mode === "view") {
    return (
      <>
        <Stack.Screen options={{ title: "PriceTag Preview" }} />
        <View style={[styles.empty, { paddingTop: insets.top + 24 }]}>
          <Feather name="tag" size={48} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>No price tags yet</Text>
          <Text style={styles.emptyBody}>
            Open the PromoPrint tab, pick the items you want price tags for, then tap Save to bring them here.
          </Text>
          <TouchableOpacity style={styles.emptyBtn} onPress={() => router.back()}>
            <Text style={styles.emptyBtnText}>Back</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "PriceTag Preview",
          headerRight: () =>
            mode === "view" ? (
              <TouchableOpacity onPress={confirmClearAll} style={{ paddingHorizontal: 8 }}>
                <Feather name="trash-2" size={18} color={Colors.danger} />
              </TouchableOpacity>
            ) : null,
        }}
      />
      <View style={styles.container}>
        {/* Toolbar */}
        <View style={styles.toolbar}>
          <Text style={styles.toolbarText}>
            {items.length} tag{items.length === 1 ? "" : "s"}
            {mode === "modify" ? " · editing" : ""}
          </Text>
          <View style={{ flex: 1 }} />
          {mode === "view" ? (
            <>
              <TouchableOpacity style={styles.modifyBtn} onPress={enterModify}>
                <Feather name="edit-2" size={14} color={Colors.text} />
                <Text style={styles.modifyBtnText}>Modify</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.exportBtn, exporting && styles.exportBtnBusy]}
                onPress={exportPdf}
                disabled={exporting}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={Colors.textInverse} />
                ) : (
                  <Feather name="download" size={14} color={Colors.textInverse} />
                )}
                <Text style={styles.exportBtnText}>{exporting ? "Exporting…" : "Export PDF"}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity style={styles.modifyBtn} onPress={cancelModify}>
                <Text style={styles.modifyBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={commitModify}>
                <Feather name="check" size={14} color={Colors.textInverse} />
                <Text style={styles.saveBtnText}>Save</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Style picker */}
        <View style={styles.styleBar}>
          <Text style={styles.styleBarLabel}>Style</Text>
          <StyleChip
            label="A · Special Offer"
            active={priceTagStyle === "A"}
            onPress={() => setPriceTagStyle("A")}
          />
          <StyleChip
            label="B · Low Prices"
            active={priceTagStyle === "B"}
            onPress={() => setPriceTagStyle("B")}
          />
        </View>

        <ScrollView
          contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 24 }]}
        >
          {items.map((it) => {
            const isBusy = busyKey === it.key;
            const TagComponent = priceTagStyle === "B" ? StyleBTag : StyleATag;
            return (
              <View key={it.key} style={styles.tagSlot}>
                {mode === "modify" && (
                  <TouchableOpacity
                    style={styles.removeBtn}
                    onPress={() => removeFromWorking(it.key)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Feather name="x" size={14} color={Colors.textInverse} />
                  </TouchableOpacity>
                )}
                <TagComponent
                  item={it}
                  busy={isBusy}
                  onAddImage={() => handleAddImage(it.key)}
                  onRemoveImage={() => removeImage(it.key)}
                />
              </View>
            );
          })}

          {items.length === 0 && mode === "modify" && (
            <Text style={styles.noResults}>
              All items removed. Tap Save to commit, or Cancel to keep them.
            </Text>
          )}
        </ScrollView>

        {/* Drive URL modal */}
        <Modal
          visible={driveOpenForKey !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setDriveOpenForKey(null)}
        >
          <View style={styles.modalScrim}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Add image from Google Drive</Text>
              <Text style={styles.modalBody}>
                Paste the Drive sharing link. The file must be shared as “Anyone with the link”.
              </Text>
              <TextInput
                style={styles.modalInput}
                placeholder="https://drive.google.com/file/d/…"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                value={driveUrl}
                onChangeText={setDriveUrl}
              />
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={styles.modalCancel}
                  onPress={() => setDriveOpenForKey(null)}
                  disabled={driveLoading}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalConfirm, driveLoading && { opacity: 0.6 }]}
                  onPress={attachDrive}
                  disabled={driveLoading}
                >
                  {driveLoading ? (
                    <ActivityIndicator size="small" color={Colors.textInverse} />
                  ) : (
                    <Text style={styles.modalConfirmText}>Attach</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </>
  );
}

// ============================================================
// Style A — Special Offer card (Protinex-inspired)
// ============================================================
//
// Vertical layout (image on top inside a maroon panel, prices below).
// Side-by-side text+image cramped the price digits at the 48%-wide
// tile size, so we stack instead and keep heights bounded.

function StyleATag({
  item, busy, onAddImage, onRemoveImage,
}: {
  item: PriceTagItem;
  busy: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
}) {
  const { label, value, isOffer } = priceFor(item);
  const mrp = fmt0(item.mrp);
  const off = offAmount(item);

  return (
    <View style={a.card}>
      {/* Image panel on top */}
      <View style={a.imgPanel}>
        <ImageSlot
          item={item}
          busy={busy}
          onAddImage={onAddImage}
          onRemoveImage={onRemoveImage}
          tone="dark"
        />
        {isOffer && (
          <View style={a.badge}>
            <Text style={a.badgeText}>SPECIAL{"\n"}OFFER</Text>
          </View>
        )}
      </View>

      {/* Description */}
      <Text
        style={[a.desc, { fontFamily: pickFont(item.description, "bold") }]}
        numberOfLines={2}
      >
        {item.description || "(no description)"}
      </Text>

      {/* MRP strikethrough */}
      {mrp && (
        <View style={a.mrpRow}>
          <Text style={a.rupeeSm}>₹</Text>
          <Text style={a.mrpVal}>{mrp}</Text>
          <Text style={a.mrpLabel}>MRP</Text>
          <View style={a.strike} />
        </View>
      )}

      {/* Big offer price */}
      <View style={a.priceRow}>
        <Text style={a.rupeeBig}>₹</Text>
        <Text style={a.priceVal}>{value}</Text>
        <View style={a.priceLabelCol}>
          <Text style={a.priceLabel}>{label.toUpperCase().split(" ")[0]}</Text>
          <Text style={a.priceLabel}>{label.toUpperCase().split(" ")[1] || ""}</Text>
        </View>
      </View>

      {/* Savings + brand row */}
      <View style={a.footerRow}>
        {off ? <Text style={a.offText}>SAVE ₹{off}</Text> : <View />}
        <Text style={a.brandFooter}>Sathyam</Text>
      </View>

      <Text style={a.itemNoFooter}>Item No: {item.itemNo || "—"}</Text>
    </View>
  );
}

// ============================================================
// Style B — Low Prices banner (Aashirvaad-inspired)
// ============================================================
//
// Red banner top with "LOW PRICES", image+price middle row, red
// banner bottom with the (Tamil-aware) description. ₹XX OFF appears
// directly below the big price. Item No tucked in tiny under the
// banner.

function StyleBTag({
  item, busy, onAddImage, onRemoveImage,
}: {
  item: PriceTagItem;
  busy: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
}) {
  const { value } = priceFor(item);
  const off = offAmount(item);

  return (
    <View style={b.card}>
      <View style={b.topBanner}>
        <Text style={b.bannerText}>LOW PRICES</Text>
      </View>

      <View style={b.middle}>
        <View style={b.imgWrap}>
          <ImageSlot
            item={item}
            busy={busy}
            onAddImage={onAddImage}
            onRemoveImage={onRemoveImage}
            tone="light"
          />
        </View>
        <View style={b.priceCol}>
          <View style={b.priceRow}>
            <Text style={b.rupee}>₹</Text>
            <Text style={b.priceVal}>{value}</Text>
          </View>
          {off ? (
            <Text style={b.offText}>₹{off} OFF</Text>
          ) : (
            <Text style={b.offTextMuted}>OFFER PRICE</Text>
          )}
        </View>
      </View>

      <View style={b.bottomBanner}>
        <Text
          style={[b.descBanner, { fontFamily: pickFont(item.description, "bold") }]}
          numberOfLines={2}
        >
          {item.description || "(no description)"}
        </Text>
      </View>

      <Text style={b.itemNoFooter}>Item No: {item.itemNo || "—"}</Text>
    </View>
  );
}

// ----------- Image slot (shared between styles) -----------

function ImageSlot({
  item, busy, onAddImage, onRemoveImage, tone,
}: {
  item: PriceTagItem;
  busy: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
  tone: "dark" | "light";
}) {
  const slotStyle = tone === "dark" ? imgs.slotDark : imgs.slotLight;
  const emptyTextColor = tone === "dark" ? "#F4D9DC" : Colors.textSecondary;
  const emptySubColor = tone === "dark" ? "#E5B7BC" : Colors.textMuted;

  if (item.imageUri) {
    return (
      <View style={[imgs.slot, slotStyle]}>
        <Image source={{ uri: item.imageUri }} style={imgs.img} resizeMode="contain" />
        <View style={imgs.actions}>
          <TouchableOpacity style={imgs.actionChip} onPress={onAddImage}>
            <Feather name="refresh-cw" size={11} color={Colors.text} />
            <Text style={imgs.actionText}>Replace</Text>
          </TouchableOpacity>
          <TouchableOpacity style={imgs.actionChip} onPress={onRemoveImage}>
            <Feather name="trash" size={11} color={Colors.danger} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[imgs.slot, slotStyle, imgs.empty]}
      onPress={onAddImage}
      activeOpacity={0.85}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tone === "dark" ? "#FFF" : Colors.primary} />
      ) : (
        <>
          <Feather name="image" size={20} color={emptyTextColor} />
          <Text style={[imgs.emptyText, { color: emptyTextColor }]}>Add Image</Text>
          <Text style={[imgs.emptySub, { color: emptySubColor }]}>Camera · Gallery · Drive</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function StyleChip({
  label, active, onPress,
}: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.styleChip, active && styles.styleChipActive]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Text style={[styles.styleChipText, active && styles.styleChipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ============================================================
// PDF builder — emits style-specific HTML so the printed page
// matches whatever the user is previewing on screen.
// ============================================================

function buildPdfHtml(items: PriceTagItem[], style: PriceTagStyle): string {
  const tagsHtml = items
    .map((it) => (style === "B" ? renderTagBHtml(it) : renderTagAHtml(it)))
    .join("");

  const styleCss = style === "B" ? PDF_CSS_B : PDF_CSS_A;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Price Tags</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;700;800&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 12px; color: #0F172A;
  }
  h1 {
    font-size: 12px; color: #64748B; margin: 0 0 10px;
    font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
  }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .tamil { font-family: "Noto Sans Tamil", -apple-system, "Segoe UI", sans-serif; }
  @media print { @page { margin: 8mm; } }
  ${styleCss}
</style>
</head><body>
  <h1>Price Tags · Style ${style} · ${items.length} item${items.length === 1 ? "" : "s"}</h1>
  <div class="grid">${tagsHtml}</div>
</body></html>`;
}

// ----- Style A HTML / CSS -----

function renderTagAHtml(it: PriceTagItem): string {
  const { label, value, isOffer } = priceFor(it);
  const mrp = fmt0(it.mrp);
  const off = offAmount(it);
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri
    ? `<img src="${it.imageUri}" />`
    : `<div class="img-placeholder">No&nbsp;Image</div>`;

  return `
    <div class="tagA">
      <div class="imgPanelA">
        ${img}
        ${isOffer ? `<div class="badgeA">SPECIAL<br/>OFFER</div>` : ""}
      </div>
      <div class="descA">${descSpan}</div>
      ${mrp ? `
        <div class="mrpRowA">
          <span class="rupeeSm">₹</span><span class="mrpValA">${escapeHtml(mrp)}</span>
          <span class="mrpLabelA">MRP</span>
          <div class="strikeA"></div>
        </div>` : ""}
      <div class="priceRowA">
        <span class="rupeeBigA">₹</span><span class="priceValA">${escapeHtml(value)}</span>
        <span class="priceLabelA">${escapeHtml(label.toUpperCase())}</span>
      </div>
      <div class="footerA">
        ${off ? `<span class="offA">SAVE ₹${escapeHtml(off)}</span>` : `<span></span>`}
        <span class="brandA">Sathyam</span>
      </div>
      <div class="itemFooterA">Item No: ${escapeHtml(it.itemNo || "—")}</div>
    </div>
  `;
}

const PDF_CSS_A = `
  .tagA {
    position: relative;
    background: ${CREAM};
    border: 2px solid ${DEEP_RED};
    border-radius: 8px;
    padding: 10px;
    page-break-inside: avoid;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .imgPanelA {
    position: relative;
    width: 100%; height: 130px;
    background: ${DEEP_RED};
    border-radius: 6px; padding: 5px;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .imgPanelA img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .img-placeholder { color: #F4D9DC; font-size: 11px; }
  .badgeA {
    position: absolute; top: -6px; right: -6px;
    width: 54px; height: 54px; border-radius: 50%;
    background: ${DEEP_RED}; color: #FFF;
    font-size: 9px; font-weight: 800; text-align: center;
    display: flex; align-items: center; justify-content: center;
    border: 2px dashed ${GOLD};
    line-height: 11px;
  }
  .descA {
    font-size: 13px; font-weight: 800; color: #0F172A;
    line-height: 1.2; margin-bottom: 6px;
  }
  .mrpRowA {
    position: relative; display: inline-flex; align-items: baseline;
    gap: 3px; padding: 1px 4px; margin-bottom: 4px;
  }
  .rupeeSm { font-size: 11px; color: ${DEEP_RED}; font-weight: 800; }
  .mrpValA { font-size: 18px; color: ${DEEP_RED}; font-weight: 800; line-height: 1; }
  .mrpLabelA { font-size: 10px; color: ${DEEP_RED}; font-weight: 700; margin-left: 3px; letter-spacing: 0.5px; }
  .strikeA {
    position: absolute; left: 0; right: 0; top: 55%;
    height: 1.5px; background: ${DEEP_RED}; transform: rotate(-6deg);
  }
  .priceRowA { display: flex; align-items: baseline; gap: 4px; margin-top: 2px; }
  .rupeeBigA { font-size: 18px; color: ${GOLD}; font-weight: 800; }
  .priceValA { font-size: 36px; color: ${GOLD}; font-weight: 900; line-height: 1; }
  .priceLabelA {
    font-size: 11px; color: ${GOLD}; font-weight: 800;
    letter-spacing: 0.8px; margin-left: 4px;
  }
  .footerA {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 6px;
  }
  .offA {
    display: inline-block;
    background: ${DEEP_RED}; color: #FFF;
    font-size: 11px; font-weight: 800; letter-spacing: 0.5px;
    padding: 2px 8px; border-radius: 4px;
  }
  .brandA {
    font-size: 11px; font-weight: 800;
    color: ${DEEP_RED}; letter-spacing: 0.5px;
  }
  .itemFooterA {
    margin-top: 6px; padding-top: 4px;
    border-top: 1px dashed #C8B89F;
    font-size: 9px; color: #94795E; font-weight: 600; letter-spacing: 0.3px;
  }
`;

// ----- Style B HTML / CSS -----

function renderTagBHtml(it: PriceTagItem): string {
  const { value } = priceFor(it);
  const off = offAmount(it);
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri
    ? `<img src="${it.imageUri}" />`
    : `<div class="img-placeholder">No&nbsp;Image</div>`;

  return `
    <div class="tagB">
      <div class="topBannerB">LOW PRICES</div>
      <div class="middleB">
        <div class="imgWrapB">${img}</div>
        <div class="priceColB">
          <div class="priceRowB">
            <span class="rupeeB">₹</span><span class="priceValB">${escapeHtml(value)}</span>
          </div>
          ${off ? `<div class="offB">₹${escapeHtml(off)} OFF</div>` : `<div class="offBmuted">OFFER PRICE</div>`}
        </div>
      </div>
      <div class="bottomBannerB">${descSpan}</div>
      <div class="itemFooterB">Item No: ${escapeHtml(it.itemNo || "—")}</div>
    </div>
  `;
}

const PDF_CSS_B = `
  .tagB {
    background: #FFF;
    border: 1.5px solid ${RED};
    border-radius: 6px;
    overflow: hidden;
    page-break-inside: avoid;
    display: flex; flex-direction: column;
  }
  .topBannerB {
    background: ${RED}; color: #FFF;
    text-align: center;
    font-size: 22px; font-weight: 900;
    letter-spacing: 1px;
    padding: 8px 4px;
  }
  .middleB {
    display: flex; gap: 8px; padding: 10px;
    align-items: center; min-height: 110px;
  }
  .imgWrapB {
    width: 45%; height: 100px;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .imgWrapB img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .img-placeholder { color: #94A3B8; font-size: 10px; }
  .priceColB { flex: 1; text-align: right; }
  .priceRowB { display: flex; justify-content: flex-end; align-items: baseline; gap: 2px; }
  .rupeeB { font-size: 22px; color: #000; font-weight: 800; }
  .priceValB { font-size: 48px; color: #000; font-weight: 900; line-height: 1; }
  .offB {
    color: ${RED}; font-size: 16px; font-weight: 800;
    margin-top: 4px; letter-spacing: 0.5px;
  }
  .offBmuted {
    color: ${RED}; font-size: 12px; font-weight: 700;
    margin-top: 4px; letter-spacing: 0.5px;
  }
  .bottomBannerB {
    background: ${RED}; color: #FFF;
    text-align: center;
    font-size: 16px; font-weight: 800;
    letter-spacing: 0.5px;
    padding: 8px;
  }
  .itemFooterB {
    text-align: center;
    font-size: 9px; color: #94A3B8; font-weight: 600;
    padding: 4px; background: #FFF;
  }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  empty: {
    flex: 1, alignItems: "center", justifyContent: "center", padding: 24,
    backgroundColor: Colors.background,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginTop: 12 },
  emptyBody: {
    fontSize: 14, color: Colors.textSecondary, textAlign: "center",
    marginTop: 8, maxWidth: 320,
  },
  emptyBtn: {
    marginTop: 18, backgroundColor: Colors.primary,
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8,
  },
  emptyBtnText: { color: Colors.textInverse, fontWeight: "700" },
  toolbar: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  toolbarText: { color: Colors.textSecondary, fontWeight: "700", fontSize: 13 },
  modifyBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 8, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  modifyBtnText: { color: Colors.text, fontWeight: "700", fontSize: 13 },
  exportBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
    backgroundColor: Colors.primary,
  },
  exportBtnBusy: { opacity: 0.7 },
  exportBtnText: { color: Colors.textInverse, fontWeight: "800", fontSize: 13 },
  saveBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
    backgroundColor: Colors.success,
  },
  saveBtnText: { color: Colors.textInverse, fontWeight: "800", fontSize: 13 },
  styleBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  styleBarLabel: {
    fontSize: 12, fontWeight: "700",
    color: Colors.textSecondary, letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  styleChip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 999, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  styleChipActive: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
  },
  styleChipText: { color: Colors.textSecondary, fontSize: 12, fontWeight: "700" },
  styleChipTextActive: { color: Colors.textInverse },
  grid: {
    flexDirection: "row", flexWrap: "wrap",
    paddingHorizontal: 8, paddingTop: 10,
    columnGap: 8, rowGap: 12,
  },
  tagSlot: { width: "48.5%", position: "relative" },
  removeBtn: {
    position: "absolute", top: -8, right: -8, zIndex: 5,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.danger,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 }, elevation: 3,
  },
  noResults: {
    width: "100%", textAlign: "center",
    color: Colors.textMuted, fontStyle: "italic",
    marginTop: 24, padding: 16,
  },
  modalScrim: {
    flex: 1, backgroundColor: "rgba(15,23,42,0.45)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  modalCard: {
    width: "100%", maxWidth: 420,
    backgroundColor: Colors.surface, borderRadius: 12, padding: 18,
  },
  modalTitle: { fontSize: 16, fontWeight: "700", color: Colors.text, marginBottom: 6 },
  modalBody: { fontSize: 13, color: Colors.textSecondary, marginBottom: 12 },
  modalInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: Colors.text, marginBottom: 14,
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  modalCancel: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1, borderColor: Colors.border,
  },
  modalCancelText: { color: Colors.text, fontWeight: "700" },
  modalConfirm: {
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8,
    backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center",
    minWidth: 80,
  },
  modalConfirmText: { color: Colors.textInverse, fontWeight: "800" },
});

// Style A — on-screen tag styles
const a = StyleSheet.create({
  card: {
    backgroundColor: CREAM,
    borderWidth: 2, borderColor: DEEP_RED,
    borderRadius: 8, padding: 8,
    overflow: "hidden",
  },
  imgPanel: {
    width: "100%", height: 90,
    backgroundColor: DEEP_RED,
    borderRadius: 6, padding: 3,
    marginBottom: 6,
    position: "relative",
  },
  badge: {
    position: "absolute", top: -6, right: -6, zIndex: 3,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: DEEP_RED,
    borderWidth: 1.5, borderColor: GOLD, borderStyle: "dashed",
    alignItems: "center", justifyContent: "center",
  },
  badgeText: {
    color: "#FFF", fontSize: 7, fontWeight: "800",
    textAlign: "center", lineHeight: 9,
  },
  desc: {
    fontSize: 11, fontWeight: "800", color: "#0F172A",
    lineHeight: 13, marginBottom: 4, minHeight: 26,
  },
  mrpRow: {
    flexDirection: "row", alignItems: "baseline",
    alignSelf: "flex-start", marginBottom: 2,
    position: "relative", paddingHorizontal: 2,
  },
  rupeeSm: { fontSize: 9, color: DEEP_RED, fontWeight: "800" },
  mrpVal: { fontSize: 14, color: DEEP_RED, fontWeight: "800", marginLeft: 1 },
  mrpLabel: {
    fontSize: 8, color: DEEP_RED, fontWeight: "700",
    marginLeft: 3, letterSpacing: 0.4,
  },
  strike: {
    position: "absolute", left: 0, right: 0, top: "55%",
    height: 1.2, backgroundColor: DEEP_RED, transform: [{ rotate: "-6deg" }],
  },
  priceRow: {
    flexDirection: "row", alignItems: "baseline", marginTop: 2,
  },
  rupeeBig: { fontSize: 14, color: GOLD, fontWeight: "800" },
  priceVal: { fontSize: 26, color: GOLD, fontWeight: "900", lineHeight: 28 },
  priceLabelCol: {
    marginLeft: 4, justifyContent: "center",
  },
  priceLabel: {
    fontSize: 8, color: GOLD, fontWeight: "800",
    letterSpacing: 0.6, lineHeight: 10,
  },
  footerRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginTop: 4, minHeight: 16,
  },
  offText: {
    backgroundColor: DEEP_RED, color: "#FFF",
    fontSize: 9, fontWeight: "800", letterSpacing: 0.3,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3,
    overflow: "hidden",
  },
  brandFooter: {
    fontSize: 9, fontWeight: "800",
    color: DEEP_RED, letterSpacing: 0.3,
  },
  itemNoFooter: {
    marginTop: 4, paddingTop: 3,
    borderTopWidth: 1, borderTopColor: "#C8B89F", borderStyle: "dashed",
    fontSize: 8, color: "#94795E", fontWeight: "600",
  },
});

// Style B — on-screen tag styles
const b = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderWidth: 1.5, borderColor: RED,
    borderRadius: 6, overflow: "hidden",
    minHeight: 230,
  },
  topBanner: {
    backgroundColor: RED, paddingVertical: 6,
    alignItems: "center", justifyContent: "center",
  },
  bannerText: {
    color: "#FFF", fontSize: 16, fontWeight: "900",
    letterSpacing: 1,
  },
  middle: {
    flexDirection: "row", padding: 8,
    alignItems: "center", gap: 6, minHeight: 100,
  },
  imgWrap: { width: "45%", height: 90 },
  priceCol: { flex: 1, alignItems: "flex-end" },
  priceRow: { flexDirection: "row", alignItems: "baseline" },
  rupee: { fontSize: 16, color: "#000", fontWeight: "800" },
  priceVal: { fontSize: 34, color: "#000", fontWeight: "900", lineHeight: 36 },
  offText: {
    color: RED, fontSize: 13, fontWeight: "800",
    marginTop: 2, letterSpacing: 0.4,
  },
  offTextMuted: {
    color: RED, fontSize: 10, fontWeight: "700",
    marginTop: 2, letterSpacing: 0.4,
  },
  bottomBanner: {
    backgroundColor: RED, paddingVertical: 6, paddingHorizontal: 8,
  },
  descBanner: {
    color: "#FFF", fontSize: 12, fontWeight: "800",
    textAlign: "center", letterSpacing: 0.3,
  },
  itemNoFooter: {
    textAlign: "center",
    fontSize: 9, color: Colors.textMuted, fontWeight: "600",
    paddingVertical: 4, backgroundColor: "#FFF",
  },
});

// Shared image-slot styles
const imgs = StyleSheet.create({
  slot: {
    width: "100%", height: "100%",
    borderRadius: 6, overflow: "hidden",
    position: "relative",
  },
  slotDark: {
    backgroundColor: DEEP_RED, padding: 4,
    minHeight: 90,
  },
  slotLight: {
    backgroundColor: "#F8F8F8",
    borderWidth: 1, borderColor: "#E2E8F0", borderStyle: "dashed",
  },
  empty: { alignItems: "center", justifyContent: "center" },
  emptyText: { fontWeight: "700", fontSize: 11, marginTop: 2 },
  emptySub: { fontSize: 9, marginTop: 1 },
  img: { width: "100%", height: "100%" },
  actions: {
    position: "absolute", bottom: 2, right: 2,
    flexDirection: "row", gap: 3,
  },
  actionChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "rgba(255,255,255,0.92)",
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
  },
  actionText: { color: Colors.text, fontSize: 9, fontWeight: "700" },
});
