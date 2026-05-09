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
import { useApp, type PriceTagItem } from "@/context/AppContext";
import { pickFont, hasTamil } from "@/constants/typography";

// PriceTag Preview screen.
//
// Two modes:
// - "view": read-only grid of tags, with an Export PDF button. Each
//   tag still allows attaching/replacing a product image (the user
//   wanted a "second opportunity" to add images).
// - "modify": shows a Remove (×) button on every tag. Tapping Save
//   commits the visible list (i.e. drops removed items) and flips back
//   to view mode.
//
// All persistence goes through AppContext so a refresh / app restart
// keeps the user's selection and attached images.

type Mode = "view" | "modify";

function fmtPrice(v: string | number | undefined): string {
  if (v === undefined || v === null || v === "") return "";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toFixed(2);
}

// Decide which price line to print and how to label it.
//   PromotionPrice present  -> "Promotion Price"
//   else SP                 -> "Price"
//   else                    -> blank line (still draws the row)
function priceFor(item: PriceTagItem): { label: string; value: string } {
  const p = fmtPrice(item.promotionPrice);
  if (p) return { label: "Promotion Price", value: p };
  const sp = fmtPrice(item.sp);
  if (sp) return { label: "Price", value: sp };
  return { label: "Price", value: "—" };
}

// Pull a Google Drive file ID out of a paste — same heuristics as
// drive-import.tsx but inlined here so we can fetch the public image
// blob and inline it into the tag without round-tripping Drive's
// authenticated APIs (this image picker only supports public files).
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

export default function PriceTagPreviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    priceTagItems,
    savePriceTagItems,
    setPriceTagImage,
    clearPriceTagItems,
  } = useApp();

  const [mode, setMode] = useState<Mode>("view");
  // Working copy used in modify mode — mirrors priceTagItems but allows
  // the user to "remove" without persisting until they tap Save.
  const [workingItems, setWorkingItems] = useState<PriceTagItem[]>(priceTagItems);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Drive URL paste modal state. Stores which item the URL is being
  // attached to so the same modal serves every tag.
  const [driveOpenForKey, setDriveOpenForKey] = useState<string | null>(null);
  const [driveUrl, setDriveUrl] = useState("");
  const [driveLoading, setDriveLoading] = useState(false);

  // The list we render. In view mode it's the persisted list; in
  // modify mode it's the working copy that can shrink as the user
  // taps remove buttons.
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

  // ---------------------------------------------------------------
  // Image attachment
  //
  // Supports three sources in both view and modify modes (the user
  // wanted a "second opportunity" to add images on the preview).
  //   - Camera (expo-image-picker)
  //   - Photo library / file picker (expo-image-picker)
  //   - Google Drive URL paste (public file -> data URI fetch)
  //
  // For all three we resize to ≤1024px on the long edge and re-encode
  // as JPEG q=0.6 before storing as a data URI. Keeps AsyncStorage and
  // the eventual PDF export sizes manageable even with full-res photos.
  // ---------------------------------------------------------------
  async function ensureLibraryPermission(): Promise<boolean> {
    const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (res.status !== "granted") {
      Alert.alert("Permission needed", "Please allow photo library access.");
      return false;
    }
    return true;
  }

  async function ensureCameraPermission(): Promise<boolean> {
    const res = await ImagePicker.requestCameraPermissionsAsync();
    if (res.status !== "granted") {
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
    const manipulated = await ImageManipulator.manipulateAsync(
      asset.uri,
      resizeActions,
      {
        compress: 0.6,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );
    const b64 = manipulated.base64 ?? asset.base64;
    if (!b64) throw new Error("Could not encode image");
    const dataUri = `data:image/jpeg;base64,${b64}`;
    await setPriceTagImage(key, dataUri);
    // If we're in modify mode, mirror the change into the working copy
    // so the user sees the image without needing to commit yet.
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
      if (!result.canceled && result.assets?.[0]) {
        await applyAsset(key, result.assets[0]);
      }
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
      if (!result.canceled && result.assets?.[0]) {
        await applyAsset(key, result.assets[0]);
      }
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
        "Paste a Google Drive sharing link or file ID. Make sure the file is shared as 'Anyone with the link'."
      );
      return;
    }
    const key = driveOpenForKey;
    setDriveLoading(true);
    try {
      // Public download endpoint — works for files shared with
      // "Anyone with the link" without an OAuth token.
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

  // ---------------------------------------------------------------
  // PDF export — renders a 2-column grid of price tags with the same
  // visual hierarchy the on-screen cards use. Tamil descriptions are
  // wrapped in a span that loads Noto Sans Tamil from Google Fonts so
  // the printed PDF renders the script correctly even on systems
  // without a local Tamil font installed.
  // ---------------------------------------------------------------
  function buildPdfHtml(): string {
    const tagsHtml = priceTagItems
      .map((it) => {
        const { label, value } = priceFor(it);
        const mrp = fmtPrice(it.mrp);
        const desc = it.description || "";
        const tamil = hasTamil(desc);
        const descSpan = tamil
          ? `<span class="tamil">${escapeHtml(desc)}</span>`
          : escapeHtml(desc);
        const img = it.imageUri
          ? `<div class="img"><img src="${it.imageUri}" /></div>`
          : `<div class="img empty">No Image</div>`;
        return `
          <div class="tag">
            ${img}
            <div class="body">
              <div class="row1">
                <span class="itemno">#${escapeHtml(it.itemNo || "—")}</span>
                ${mrp ? `<span class="mrp">MRP&nbsp;₹${escapeHtml(mrp)}</span>` : ""}
              </div>
              <div class="desc">${descSpan}</div>
              <div class="price">
                <span class="plabel">${escapeHtml(label)}</span>
                <span class="pval">₹${escapeHtml(value)}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Price Tags</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 14px;
    color: #0F172A;
  }
  h1 {
    font-size: 14px;
    color: #64748B;
    margin: 0 0 12px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .tag {
    border: 1.5px solid #1A3A5C;
    border-radius: 8px;
    padding: 10px;
    page-break-inside: avoid;
    display: flex;
    flex-direction: column;
    min-height: 220px;
  }
  .img {
    width: 100%;
    height: 110px;
    border: 1px dashed #CBD5E1;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .img img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .img.empty { color: #94A3B8; font-size: 11px; }
  .body { flex: 1; display: flex; flex-direction: column; }
  .row1 { display: flex; justify-content: space-between; align-items: center; }
  .itemno { font-size: 11px; color: #64748B; font-weight: 700; letter-spacing: 0.3px; }
  .mrp { font-size: 11px; color: #64748B; font-weight: 700; }
  .desc {
    font-size: 13px;
    font-weight: 700;
    color: #0F172A;
    margin-top: 4px;
    line-height: 1.25;
    flex: 1;
  }
  .tamil {
    font-family: "Noto Sans Tamil", -apple-system, "Segoe UI", sans-serif;
    font-weight: 700;
  }
  .price {
    margin-top: 8px;
    border-top: 1px solid #E2E8F0;
    padding-top: 6px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .plabel { font-size: 11px; color: #64748B; font-weight: 700; text-transform: uppercase; }
  .pval { font-size: 22px; color: #1A3A5C; font-weight: 800; }
  @media print { @page { margin: 10mm; } }
</style>
</head><body>
  <h1>Price Tags · ${priceTagItems.length} item${priceTagItems.length === 1 ? "" : "s"}</h1>
  <div class="grid">${tagsHtml}</div>
</body></html>`;
  }

  async function exportPdf() {
    if (priceTagItems.length === 0) return;
    setExporting(true);
    try {
      const html = buildPdfHtml();
      const { uri } = await Print.printToFileAsync({ html });
      if (Platform.OS === "web") {
        // expo-print on web opens the system print dialog directly,
        // so we don't need an extra share step.
        return;
      }
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

  // -------------------- Empty state --------------------
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
                <Text style={styles.exportBtnText}>
                  {exporting ? "Exporting…" : "Export PDF"}
                </Text>
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

        <ScrollView
          contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 24 }]}
        >
          {items.map((it) => {
            const { label, value } = priceFor(it);
            const mrp = fmtPrice(it.mrp);
            const isBusy = busyKey === it.key;
            return (
              <View key={it.key} style={styles.tag}>
                {/* Remove button (modify mode only) */}
                {mode === "modify" && (
                  <TouchableOpacity
                    style={styles.removeBtn}
                    onPress={() => removeFromWorking(it.key)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Feather name="x" size={14} color={Colors.textInverse} />
                  </TouchableOpacity>
                )}

                {/* Image slot */}
                <View style={styles.imgSlot}>
                  {it.imageUri ? (
                    <>
                      <Image source={{ uri: it.imageUri }} style={styles.img} resizeMode="contain" />
                      <View style={styles.imgActions}>
                        <TouchableOpacity
                          style={styles.imgActionChip}
                          onPress={() => handleAddImage(it.key)}
                        >
                          <Feather name="refresh-cw" size={11} color={Colors.text} />
                          <Text style={styles.imgActionText}>Replace</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.imgActionChip, styles.imgActionDanger]}
                          onPress={() => removeImage(it.key)}
                        >
                          <Feather name="trash" size={11} color={Colors.danger} />
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : (
                    <TouchableOpacity
                      style={styles.imgEmpty}
                      onPress={() => handleAddImage(it.key)}
                      activeOpacity={0.85}
                    >
                      {isBusy ? (
                        <ActivityIndicator size="small" color={Colors.primary} />
                      ) : (
                        <>
                          <Feather name="image" size={20} color={Colors.textMuted} />
                          <Text style={styles.imgEmptyText}>Add Image</Text>
                          <Text style={styles.imgEmptySub}>Camera · Gallery · Drive</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>

                {/* Body */}
                <View style={styles.row1}>
                  <Text style={styles.itemNo}>#{it.itemNo || "—"}</Text>
                  {mrp ? <Text style={styles.mrp}>MRP ₹{mrp}</Text> : <View />}
                </View>
                <Text
                  style={[styles.desc, { fontFamily: pickFont(it.description, "bold") }]}
                  numberOfLines={3}
                >
                  {it.description || "(no description)"}
                </Text>
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>{label}</Text>
                  <Text style={styles.priceValue}>₹{value}</Text>
                </View>
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  grid: {
    flexDirection: "row", flexWrap: "wrap",
    paddingHorizontal: 8, paddingTop: 10,
    columnGap: 8, rowGap: 10,
  },
  tag: {
    width: "48.5%",
    backgroundColor: Colors.surface,
    borderWidth: 1.5, borderColor: Colors.primary,
    borderRadius: 10, padding: 10,
    position: "relative",
  },
  removeBtn: {
    position: "absolute", top: -8, right: -8, zIndex: 2,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.danger,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  imgSlot: {
    width: "100%", height: 110, marginBottom: 8,
    borderRadius: 6, overflow: "hidden",
    backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border, borderStyle: "dashed",
    position: "relative",
  },
  img: { width: "100%", height: "100%" },
  imgEmpty: {
    flex: 1, alignItems: "center", justifyContent: "center",
  },
  imgEmptyText: { color: Colors.textSecondary, fontWeight: "700", fontSize: 12, marginTop: 4 },
  imgEmptySub: { color: Colors.textMuted, fontSize: 10, marginTop: 2 },
  imgActions: {
    position: "absolute", bottom: 4, right: 4, flexDirection: "row", gap: 4,
  },
  imgActionChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: Colors.surface,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
    borderWidth: 1, borderColor: Colors.border,
  },
  imgActionDanger: { backgroundColor: Colors.surface },
  imgActionText: { color: Colors.text, fontSize: 10, fontWeight: "700" },
  row1: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  itemNo: { fontSize: 11, color: Colors.textMuted, fontWeight: "700", letterSpacing: 0.3 },
  mrp: { fontSize: 11, color: Colors.textMuted, fontWeight: "700" },
  desc: {
    fontSize: 13, color: Colors.text, marginTop: 4, lineHeight: 17, minHeight: 34,
  },
  priceRow: {
    marginTop: 8, paddingTop: 6,
    borderTopWidth: 1, borderTopColor: Colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "baseline",
  },
  priceLabel: {
    fontSize: 10, color: Colors.textSecondary,
    fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4,
  },
  priceValue: { fontSize: 20, color: Colors.primary, fontWeight: "800" },
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
  modalActions: {
    flexDirection: "row", justifyContent: "flex-end", gap: 8,
  },
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
