import React, { useCallback, useEffect, useRef, useState } from "react";
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
  FlatList,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { LOGO_BASE64 } from "@/constants/LogoBase64";
import { useApp, type PriceTagItem, type PriceTagStyle } from "@/context/AppContext";
import { useAuth } from "@/context/AuthContext";
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

// Distinguish a Drive folder URL from a single-file URL so the
// "Drive Link" flow can route folders into the browse picker
// (rooted at that folder) instead of trying to download them.
function extractDriveLink(
  input: string,
): { id: string; kind: "file" | "folder" } | null {
  const s = input.trim();
  const folderMatch = s.match(/\/(?:folders|drive\/folders|drive\/u\/\d+\/folders)\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return { id: folderMatch[1], kind: "folder" };
  const id = extractDriveFileId(s);
  if (!id) return null;
  return { id, kind: "file" };
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

// -----------------------------------------------------------------------
// On-disk image storage
//
// Price-tag images used to be persisted as base64 `data:` URIs inside
// the AppContext JSON blob. AsyncStorage on Android is backed by
// SQLite (RKStorage), which has a tight default size cap; a few
// 1024x1024 PNG/JPEG data URIs would fill it and then every later
// AsyncStorage.setItem would fail with `SQLite Error code 13:
// SQLITE_FULL`, surfacing as "Couldn't add image" on this screen.
//
// To keep the AsyncStorage payload tiny we instead write the image
// bytes to the app's own document directory and only store the
// `file://` URI. Each image now costs ~80 bytes of AsyncStorage
// instead of multiple megabytes. Same RN <Image> component renders
// `file://` and `data:` URIs identically, and the print HTML embeds
// either one fine.
//
// Web has no FileSystem.documentDirectory, so on web we keep the
// data: URI behaviour (web AsyncStorage = localStorage which has a
// much larger budget and isn't subject to SQLITE_FULL).
// -----------------------------------------------------------------------
const PRICE_TAG_IMAGE_DIR =
  (FileSystem.documentDirectory ?? "") + "pricetags/";

async function ensurePriceTagDir(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const info = await FileSystem.getInfoAsync(PRICE_TAG_IMAGE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(PRICE_TAG_IMAGE_DIR, {
        intermediates: true,
      });
    }
  } catch {
    /* best effort — write below will surface a real error */
  }
}

// Decode a `data:<mime>;base64,<bytes>` URI into its parts. Returns
// null if the input isn't a recognisable data URI.
function parseDataUri(uri: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/i.exec(uri);
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2] };
}

function extForMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/heic" || mime === "image/heif") return "heic";
  return "jpg";
}

// Persist a `data:` URI to the app's document directory and return
// the new `file://` URI. On web (or if the input is already a
// `file://` URI) the input is returned unchanged.
async function persistDataUri(key: string, uri: string): Promise<string> {
  if (Platform.OS === "web") return uri;
  if (!uri.startsWith("data:")) return uri;
  const parsed = parseDataUri(uri);
  if (!parsed) return uri;
  await ensurePriceTagDir();
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${safeKey}-${Date.now()}.${extForMime(parsed.mime)}`;
  const path = PRICE_TAG_IMAGE_DIR + filename;
  await FileSystem.writeAsStringAsync(path, parsed.base64, {
    encoding: "base64" as any,
  });
  return path;
}

// Delete a previously-persisted price-tag image file. Anything other
// than a `file://` URI inside our own document dir is ignored, so
// stray data: URIs and external file paths are safe to pass in.
async function cleanupPriceTagFile(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  if (Platform.OS === "web") return;
  if (!uri.startsWith(PRICE_TAG_IMAGE_DIR)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    /* best effort */
  }
}

// Build a URL pointing at our api-server. On web (Expo running inside
// the Replit preview iframe) the same origin handles `/api/...`
// through the shared proxy, so a relative URL works. On a real
// device we need the absolute Replit dev domain that the dev script
// puts into `EXPO_PUBLIC_DOMAIN`.
function apiUrl(path: string): string {
  const dom = process.env.EXPO_PUBLIC_DOMAIN;
  if (dom) return `https://${dom}${path}`;
  return path;
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  thumbnailLink?: string;
  iconLink?: string;
};

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
    priceTagShowLogo,
    setPriceTagShowLogo,
  } = useApp();

  const [mode, setMode] = useState<Mode>("view");
  const [workingItems, setWorkingItems] = useState<PriceTagItem[]>(priceTagItems);
  // Tracks the latest working items for closure-safe lookups (e.g. the
  // previous imageUri inside async picker handlers, used for on-disk
  // cleanup when an image is replaced).
  const workingItemsRef = useRef<PriceTagItem[]>(workingItems);
  useEffect(() => {
    workingItemsRef.current = workingItems;
  }, [workingItems]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bgAllRunning, setBgAllRunning] = useState(false);
  const { token: authToken, logout } = useAuth();
  const [exporting, setExporting] = useState(false);

  const [driveOpenForKey, setDriveOpenForKey] = useState<string | null>(null);
  const [driveUrl, setDriveUrl] = useState("");
  const [driveLoading, setDriveLoading] = useState(false);

  // Drive *picker* (browse the connected Drive for an image).
  // Distinct from the Drive *link* modal above, which only takes a
  // pasted URL for an Anyone-with-the-link file.
  const [drivePickOpenForKey, setDrivePickOpenForKey] = useState<string | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [driveListLoading, setDriveListLoading] = useState(false);
  const [driveListError, setDriveListError] = useState<string | null>(null);
  const [driveSearch, setDriveSearch] = useState("");
  const [driveAttachingId, setDriveAttachingId] = useState<string | null>(null);
  // Folder-navigation breadcrumb. First entry is the virtual "Drive"
  // root (folderId=null lists everything the user can see). Tapping
  // a folder pushes onto the stack; the back chevron pops.
  const [driveFolderStack, setDriveFolderStack] = useState<
    { id: string | null; name: string }[]
  >([{ id: null, name: "Drive" }]);

  // Add-image action sheet (used on web + Android — iOS uses the
  // native ActionSheetIOS instead). Tracks which item the chosen
  // source should attach to.
  const [addImageOpenForKey, setAddImageOpenForKey] = useState<string | null>(null);

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
  // Detect whether the source is (or should be treated as) a PNG so we
  // can preserve its alpha channel. Re-encoding a transparent PNG as
  // JPEG flattens transparent pixels to solid black, which is what was
  // happening to logos/cutouts dropped onto a price tag. We sniff the
  // MIME type first, then fall back to the file extension on the URI
  // / fileName when MIME is missing (common with DocumentPicker on
  // Android and with Drive-hosted files).
  function isPngSource(opts: {
    uri?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
  }): boolean {
    const mime = (opts.mimeType ?? "").toLowerCase();
    if (mime === "image/png") return true;
    if (mime && mime !== "image/png" && mime.startsWith("image/")) return false;
    const name = (opts.fileName ?? "").toLowerCase();
    if (name.endsWith(".png")) return true;
    const uri = (opts.uri ?? "").toLowerCase().split(/[?#]/)[0] ?? "";
    return uri.endsWith(".png");
  }
  // Persist a freshly-built `data:` URI to disk and wire it through
  // AppContext + the local working-items state. Replaces (and best-
  // -effort deletes) any previously persisted file for the same key
  // so the document directory doesn't accumulate orphans.
  async function commitImageForKey(key: string, dataUri: string): Promise<void> {
    const prevUri = workingItemsRef.current.find((i) => i.key === key)?.imageUri;
    const finalUri = await persistDataUri(key, dataUri);
    await setPriceTagImage(key, finalUri);
    setWorkingItems((cur) =>
      cur.map((i) => (i.key === key ? { ...i, imageUri: finalUri } : i))
    );
    if (prevUri && prevUri !== finalUri) {
      void cleanupPriceTagFile(prevUri);
    }
  }

  // One-time, screen-mount migration. Walks any existing items that
  // still hold a `data:` URI (from before this fix shipped) and
  // moves the bytes to disk, replacing the stored value with the
  // small `file://` URI. Each rewrite shrinks the AsyncStorage JSON
  // blob, so even a phone that's currently SQLITE_FULL recovers
  // space as the migration progresses.
  const migrationDone = useRef(false);
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (migrationDone.current) return;
    migrationDone.current = true;
    void (async () => {
      const stale = priceTagItems.filter(
        (i) => typeof i.imageUri === "string" && i.imageUri.startsWith("data:"),
      );
      for (const it of stale) {
        try {
          await commitImageForKey(it.key, it.imageUri!);
        } catch {
          // If even one rewrite fails (e.g. disk genuinely full) stop
          // — the next mount will retry once the user clears space.
          break;
        }
      }
    })();
    // priceTagItems intentionally excluded — we only want this to
    // run once, against the hydrated initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyAsset(key: string, asset: ImagePicker.ImagePickerAsset) {
    // Force the saved image to a 1024x1024 square. If the source isn't
    // already square (e.g. user skipped the editor or picked something
    // weird) center-crop it first, then downscale to 1024.
    const w = asset.width ?? 0;
    const h = asset.height ?? 0;
    const actions: ImageManipulator.Action[] = [];
    if (w > 0 && h > 0 && w !== h) {
      const side = Math.min(w, h);
      actions.push({
        crop: {
          originX: Math.round((w - side) / 2),
          originY: Math.round((h - side) / 2),
          width: side,
          height: side,
        },
      });
    }
    actions.push({ resize: { width: 1024, height: 1024 } });
    const isPng = isPngSource({
      uri: asset.uri,
      mimeType: (asset as any).mimeType,
      fileName: (asset as any).fileName,
    });
    const m = await ImageManipulator.manipulateAsync(asset.uri, actions, {
      compress: isPng ? 1 : 0.6,
      format: isPng ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    const b64 = m.base64 ?? asset.base64;
    if (!b64) throw new Error("Could not encode image");
    const dataUri = isPng
      ? `data:image/png;base64,${b64}`
      : `data:image/jpeg;base64,${b64}`;
    await commitImageForKey(key, dataUri);
  }
  async function pickFromLibrary(key: string) {
    if (!(await ensureLibraryPermission())) return;
    setBusyKey(key);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        // Open the OS crop/rotate editor so the user can square-up
        // a non-square photo before we downscale it to 1024x1024.
        allowsEditing: true,
        aspect: [1, 1],
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
  // Open the OS file picker (Android Storage Access Framework /
  // iOS Files / web file dialog). On phones with the Google Drive
  // app installed, Drive shows up as a provider in this picker, so
  // the user can browse a shared Drive folder and grab any image
  // — same flow as the Suppliers tab Excel import.
  async function pickFromFiles(key: string) {
    setBusyKey(key);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) throw new Error("No file returned by picker");

      // Decide format BEFORE the probe so a transparent PNG is never
      // round-tripped through JPEG (which would bake a solid-black
      // background into the alpha pixels). We sniff MIME / filename /
      // URI extension; everything else stays JPEG to keep file sizes
      // small for the typical photo case.
      const isPng = isPngSource({
        uri: asset.uri,
        mimeType: (asset as any).mimeType,
        fileName: asset.name,
      });
      const fmt = isPng
        ? ImageManipulator.SaveFormat.PNG
        : ImageManipulator.SaveFormat.JPEG;
      // First pass: probe the image dimensions (no actions, no base64).
      // DocumentPicker can't open the OS crop editor, so we center-crop
      // non-square sources programmatically and downscale to 1024x1024.
      const probe = await ImageManipulator.manipulateAsync(asset.uri, [], {
        format: fmt,
      });
      const w = probe.width ?? 0;
      const h = probe.height ?? 0;
      const actions: ImageManipulator.Action[] = [];
      if (w > 0 && h > 0 && w !== h) {
        const side = Math.min(w, h);
        actions.push({
          crop: {
            originX: Math.round((w - side) / 2),
            originY: Math.round((h - side) / 2),
            width: side,
            height: side,
          },
        });
      }
      actions.push({ resize: { width: 1024, height: 1024 } });
      const m = await ImageManipulator.manipulateAsync(asset.uri, actions, {
        compress: isPng ? 1 : 0.6,
        format: fmt,
        base64: true,
      });
      let b64 = m.base64;
      if (!b64 && Platform.OS !== "web") {
        // Fallback: read the cached file directly.
        b64 = await FileSystem.readAsStringAsync(m.uri, {
          encoding: "base64" as any,
        });
      }
      if (!b64) throw new Error("Could not encode image");
      const dataUri = isPng
        ? `data:image/png;base64,${b64}`
        : `data:image/jpeg;base64,${b64}`;
      await commitImageForKey(key, dataUri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
        // Hand the captured photo to the phone's built-in editor
        // (crop, rotate, etc.) before returning, locked to a 1:1
        // aspect so the saved tile image is always square.
        allowsEditing: true,
        aspect: [1, 1],
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
    const link = extractDriveLink(driveUrl);
    if (!link) {
      Alert.alert(
        "Invalid Drive link",
        "Paste a Google Drive image link or folder link. Items must be shared as 'Anyone with the link'."
      );
      return;
    }
    const key = driveOpenForKey;
    // Folder link → close this modal and open the browse picker
    // rooted at that folder, so the user can navigate sub-folders
    // and pick any image inside.
    if (link.kind === "folder") {
      setDriveOpenForKey(null);
      openDrivePicker(key, { id: link.id, name: "Shared folder" });
      return;
    }
    const id = link.id;
    setDriveLoading(true);
    try {
      const url = `https://drive.google.com/uc?export=download&id=${id}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const blob = await resp.blob();
      const dataUri = await blobToDataUri(blob);
      await commitImageForKey(key, dataUri);
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
  // -------- Drive picker (browse) --------
  const fetchDriveImages = useCallback(async (
    search: string,
    folderId: string | null,
  ) => {
    setDriveListLoading(true);
    setDriveListError(null);
    try {
      const qs = new URLSearchParams({ kind: "images" });
      if (search.trim()) qs.set("search", search.trim());
      if (folderId) qs.set("folderId", folderId);
      const resp = await fetch(apiUrl(`/api/drive/files?${qs.toString()}`));
      const text = await resp.text();
      if (!resp.ok) {
        let msg = `Drive list failed (${resp.status})`;
        try {
          const j = JSON.parse(text);
          if (j?.error) msg = String(j.error);
        } catch {}
        throw new Error(msg);
      }
      const json = text ? JSON.parse(text) : {};
      setDriveFiles(Array.isArray(json.files) ? json.files : []);
    } catch (e: any) {
      setDriveFiles([]);
      setDriveListError(e?.message ?? "Could not reach Google Drive.");
    } finally {
      setDriveListLoading(false);
    }
  }, []);

  function openDrivePicker(
    key: string,
    initialFolder?: { id: string; name: string },
  ) {
    setDriveSearch("");
    setDriveFiles([]);
    setDriveListError(null);
    const stack: { id: string | null; name: string }[] = [
      { id: null, name: "Drive" },
    ];
    if (initialFolder) stack.push(initialFolder);
    setDriveFolderStack(stack);
    setDrivePickOpenForKey(key);
    fetchDriveImages("", initialFolder ? initialFolder.id : null);
  }

  function enterDriveFolder(folder: DriveFile) {
    const next = [...driveFolderStack, { id: folder.id, name: folder.name }];
    setDriveFolderStack(next);
    setDriveSearch("");
    fetchDriveImages("", folder.id);
  }

  function popDriveFolder() {
    if (driveFolderStack.length <= 1) return;
    const next = driveFolderStack.slice(0, -1);
    setDriveFolderStack(next);
    setDriveSearch("");
    fetchDriveImages("", next[next.length - 1].id);
  }

  async function attachDriveFile(file: DriveFile) {
    if (!drivePickOpenForKey) return;
    if (file.mimeType === "application/vnd.google-apps.folder") {
      enterDriveFolder(file);
      return;
    }
    const key = drivePickOpenForKey;
    setDriveAttachingId(file.id);
    try {
      const url = apiUrl(
        `/api/drive/file/${encodeURIComponent(file.id)}?mimeType=${encodeURIComponent(file.mimeType)}`
      );
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const blob = await resp.blob();
      const dataUri = await blobToDataUri(blob);
      await commitImageForKey(key, dataUri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDrivePickOpenForKey(null);
    } catch (e: any) {
      Alert.alert("Couldn't fetch from Drive", e?.message ?? "Unknown error");
    } finally {
      setDriveAttachingId(null);
    }
  }

  function handleAddImage(key: string) {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [
            "Cancel",
            "Take Photo",
            "Choose from Library",
            "Choose from Files (Drive…)",
          ],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) takePhoto(key);
          else if (idx === 2) pickFromLibrary(key);
          else if (idx === 3) pickFromFiles(key);
        }
      );
    } else {
      // Web + Android: `Alert.alert` only reliably renders 3 buttons,
      // so the Drive options were silently dropped. Use a custom
      // modal action sheet so every source is always visible.
      setAddImageOpenForKey(key);
    }
  }

  function chooseAddImageSource(
    source: "camera" | "library" | "files" | "drivePicker" | "driveLink",
  ) {
    const key = addImageOpenForKey;
    if (!key) return;
    setAddImageOpenForKey(null);
    if (source === "camera") takePhoto(key);
    else if (source === "library") pickFromLibrary(key);
    else if (source === "files") pickFromFiles(key);
    else if (source === "drivePicker") openDrivePicker(key);
    else if (source === "driveLink") openDriveModal(key);
  }
  async function removeImage(key: string) {
    try {
      const prevUri = workingItemsRef.current.find((i) => i.key === key)?.imageUri;
      await setPriceTagImage(key, null);
      setWorkingItems((prev) =>
        prev.map((i) => (i.key === key ? { ...i, imageUri: undefined } : i))
      );
      // Free the disk space too — otherwise the file lingers in the
      // app's document directory after the user clears the tag.
      if (prevUri) void cleanupPriceTagFile(prevUri);
    } catch (e: any) {
      Alert.alert("Couldn't remove image", e?.message ?? "Storage error");
    }
  }

  // -------- Background removal (Pixian) --------
  // Sends the current image to our /api/pixian/remove-bg proxy
  // (which calls Pixian.ai with our credentials) and replaces the
  // tile image with the returned transparent PNG. We then re-square
  // it to 1024x1024 so storage stays consistent.
  async function removeBackgroundFor(
    key: string,
    opts: { silent?: boolean } = {},
  ): Promise<boolean> {
    const item = workingItems.find((i) => i.key === key);
    if (!item?.imageUri) return false;
    setBusyKey(key);
    try {
      // Since the SQLITE_FULL fix, imageUri is a `file://` path (not a
      // data URI). The server expects a `data:image/...;base64,...`
      // payload, so read the file back to base64 here. Existing
      // `data:` URIs (legacy in-memory state, web platform) are passed
      // through as-is. Anything else is rejected up-front so the user
      // gets a clear message instead of a generic Pixian 400.
      let imageDataUri: string;
      if (item.imageUri.startsWith("data:")) {
        imageDataUri = item.imageUri;
      } else if (item.imageUri.startsWith("file://")) {
        const lower = item.imageUri.toLowerCase().split(/[?#]/)[0] ?? "";
        const mime = lower.endsWith(".png") ? "image/png" : "image/jpeg";
        const b64 = await FileSystem.readAsStringAsync(item.imageUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        imageDataUri = `data:${mime};base64,${b64}`;
      } else {
        throw new Error("Unsupported image source.");
      }

      const resp = await fetch(apiUrl("/api/pixian/remove-bg"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ imageDataUri }),
      });
      const text = await resp.text();
      if (resp.status === 401) {
        // Session expired or revoked — drop the stored token so the
        // PinGate re-prompts on the next render, and bail out of the
        // current run.
        await logout();
        throw new Error("Session expired. Please re-enter your PIN.");
      }
      if (!resp.ok) {
        let msg = `Background removal failed (${resp.status})`;
        try {
          const j = JSON.parse(text);
          if (j?.error) msg = String(j.error);
        } catch {}
        throw new Error(msg);
      }
      const json = text ? JSON.parse(text) : {};
      const outDataUri: string | undefined = json?.imageDataUri;
      if (!outDataUri) throw new Error("Pixian returned no image.");

      // Re-encode through ImageManipulator to keep the 1024x1024
      // square contract. PNG is preserved (transparent background).
      const m = await ImageManipulator.manipulateAsync(
        outDataUri,
        [{ resize: { width: 1024, height: 1024 } }],
        {
          compress: 1,
          format: ImageManipulator.SaveFormat.PNG,
          base64: true,
        },
      );
      const finalUri = m.base64
        ? `data:image/png;base64,${m.base64}`
        : outDataUri;
      await commitImageForKey(key, finalUri);
      return true;
    } catch (e: any) {
      if (!opts.silent) {
        Alert.alert("Couldn't remove background", e?.message ?? "Unknown error");
      }
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  async function removeBackgroundForAll() {
    const targets = workingItems.filter((i) => !!i.imageUri);
    if (targets.length === 0) {
      Alert.alert("No images", "Add at least one image before removing backgrounds.");
      return;
    }
    Alert.alert(
      "Remove background for all?",
      `This will process ${targets.length} image${targets.length === 1 ? "" : "s"} through Pixian and may take a few seconds each.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: async () => {
            setBgAllRunning(true);
            let ok = 0;
            let fail = 0;
            for (const it of targets) {
              const success = await removeBackgroundFor(it.key, { silent: true });
              if (success) ok++;
              else fail++;
            }
            setBgAllRunning(false);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert(
              "Background removal complete",
              `Processed ${ok} image${ok === 1 ? "" : "s"}` +
                (fail > 0 ? `, ${fail} failed.` : "."),
            );
          },
        },
      ],
    );
  }

  // -------- PDF export --------
  async function exportPdf() {
    if (priceTagItems.length === 0) return;
    setExporting(true);
    try {
      // Inline every image as a `data:` URI before building the PDF
      // HTML. expo-print's underlying WebView doesn't reliably load
      // arbitrary `file://` URIs from the app's document directory
      // when rendering to PDF (images come out blank), so we read
      // each persisted file back as base64 and embed it directly.
      const itemsForPdf = await Promise.all(
        priceTagItems.map(async (it) => {
          if (!it.imageUri) return it;
          if (!it.imageUri.startsWith("file://")) return it;
          try {
            const lower = it.imageUri.toLowerCase().split(/[?#]/)[0] ?? "";
            const mime =
              lower.endsWith(".png") ? "image/png" :
              lower.endsWith(".webp") ? "image/webp" :
              lower.endsWith(".heic") || lower.endsWith(".heif") ? "image/heic" :
              "image/jpeg";
            const b64 = await FileSystem.readAsStringAsync(it.imageUri, {
              encoding: "base64" as any,
            });
            return { ...it, imageUri: `data:${mime};base64,${b64}` };
          } catch {
            // If the file is missing for some reason, fall through
            // with no image rather than aborting the whole export.
            return { ...it, imageUri: undefined };
          }
        }),
      );
      const html = buildPdfHtml(itemsForPdf, priceTagStyle, priceTagShowLogo);
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

        {/* Logo watermark toggle — sits above the style bar so the
            user picks whether to brand the tags before choosing the
            visual style. Drives both the on-screen preview and the
            exported PDF. */}
        <View style={styles.logoToggleBar}>
          <Text style={styles.logoToggleLabel}>Show Logo</Text>
          <TouchableOpacity
            style={[
              styles.logoToggleSwitch,
              priceTagShowLogo && styles.logoToggleSwitchOn,
            ]}
            onPress={() => setPriceTagShowLogo(!priceTagShowLogo)}
            activeOpacity={0.85}
            accessibilityRole="switch"
            accessibilityState={{ checked: priceTagShowLogo }}
            accessibilityLabel="Show Sathyam Super Store logo watermark on price tags"
          >
            <View
              style={[
                styles.logoToggleKnob,
                priceTagShowLogo && styles.logoToggleKnobOn,
              ]}
            />
          </TouchableOpacity>
          <Text style={styles.logoToggleHint}>
            {priceTagShowLogo ? "Watermark on (30%)" : "Watermark off"}
          </Text>
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
          <TouchableOpacity
            style={[styles.bgAllBtn, bgAllRunning && styles.bgAllBtnBusy]}
            onPress={removeBackgroundForAll}
            disabled={bgAllRunning}
            activeOpacity={0.85}
          >
            {bgAllRunning ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <Feather name="scissors" size={13} color={Colors.primary} />
            )}
            <Text style={styles.bgAllBtnText}>
              {bgAllRunning ? "Removing…" : "Remove BG (all)"}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 24 }]}
        >
          {items.map((it) => {
            const isBusy = busyKey === it.key || bgAllRunning;
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
                  showLogo={priceTagShowLogo}
                  onAddImage={() => handleAddImage(it.key)}
                  onRemoveImage={() => removeImage(it.key)}
                  onRemoveBackground={() => removeBackgroundFor(it.key)}
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

        {/* Add-image source picker (web + Android). iOS uses the
            native ActionSheetIOS in `handleAddImage`. */}
        <Modal
          visible={addImageOpenForKey !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setAddImageOpenForKey(null)}
        >
          <TouchableOpacity
            style={styles.sheetScrim}
            activeOpacity={1}
            onPress={() => setAddImageOpenForKey(null)}
          >
            <TouchableOpacity activeOpacity={1} style={styles.sheetCard}>
              <Text style={styles.sheetTitle}>Add Product Image</Text>
              <TouchableOpacity
                style={styles.sheetRow}
                onPress={() => chooseAddImageSource("camera")}
              >
                <Feather name="camera" size={18} color={Colors.primary} />
                <Text style={styles.sheetRowText}>Take Photo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sheetRow}
                onPress={() => chooseAddImageSource("library")}
              >
                <Feather name="image" size={18} color={Colors.primary} />
                <Text style={styles.sheetRowText}>Choose from Library</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sheetRow}
                onPress={() => chooseAddImageSource("files")}
              >
                <Feather name="folder" size={18} color={Colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetRowText}>Choose from Files</Text>
                  <Text style={styles.sheetRowSub}>
                    Includes Google Drive and other phone storage
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sheetRow, styles.sheetCancelRow]}
                onPress={() => setAddImageOpenForKey(null)}
              >
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>

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
                Paste a Drive image link, or paste a folder link to browse it (sub-folders included). Must be shared as “Anyone with the link”.
              </Text>
              <TextInput
                style={styles.modalInput}
                placeholder="https://drive.google.com/drive/folders/…"
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

        {/* Drive picker modal — browse images from the connected
            Google Drive (uses the api-server's /drive/files endpoint
            which proxies through the Replit google-drive connector). */}
        <Modal
          visible={drivePickOpenForKey !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setDrivePickOpenForKey(null)}
        >
          <View style={styles.modalScrim}>
            <View style={[styles.modalCard, { width: "92%", maxHeight: "82%" }]}>
              <View style={styles.pickerHeader}>
                <Text style={styles.modalTitle}>Browse Google Drive</Text>
                <TouchableOpacity
                  onPress={() => setDrivePickOpenForKey(null)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="x" size={20} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>

              {/* Breadcrumb path */}
              <View style={styles.pickerCrumbs}>
                <TouchableOpacity
                  onPress={popDriveFolder}
                  disabled={driveFolderStack.length <= 1}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Feather
                    name="chevron-left"
                    size={18}
                    color={driveFolderStack.length > 1 ? Colors.primary : Colors.textMuted}
                  />
                </TouchableOpacity>
                <Text style={styles.pickerCrumbsText} numberOfLines={1}>
                  {driveFolderStack.map((f) => f.name).join("  /  ")}
                </Text>
              </View>

              <View style={styles.pickerSearchRow}>
                <Feather name="search" size={14} color={Colors.textMuted} />
                <TextInput
                  style={styles.pickerSearch}
                  placeholder={
                    driveFolderStack.length > 1
                      ? `Search in ${driveFolderStack[driveFolderStack.length - 1].name}…`
                      : "Search images by name…"
                  }
                  placeholderTextColor={Colors.textMuted}
                  value={driveSearch}
                  onChangeText={setDriveSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onSubmitEditing={() =>
                    fetchDriveImages(
                      driveSearch,
                      driveFolderStack[driveFolderStack.length - 1].id,
                    )
                  }
                />
                <TouchableOpacity
                  style={styles.pickerSearchBtn}
                  onPress={() =>
                    fetchDriveImages(
                      driveSearch,
                      driveFolderStack[driveFolderStack.length - 1].id,
                    )
                  }
                  disabled={driveListLoading}
                >
                  <Text style={styles.pickerSearchBtnText}>Go</Text>
                </TouchableOpacity>
              </View>

              {driveListLoading ? (
                <View style={styles.pickerStatus}>
                  <ActivityIndicator color={Colors.primary} />
                  <Text style={styles.pickerStatusText}>Loading from Drive…</Text>
                </View>
              ) : driveListError ? (
                <View style={styles.pickerStatus}>
                  <Feather name="alert-circle" size={20} color={Colors.danger} />
                  <Text style={[styles.pickerStatusText, { color: Colors.danger }]}>
                    {driveListError}
                  </Text>
                  <TouchableOpacity
                    style={styles.pickerRetry}
                    onPress={() =>
                      fetchDriveImages(
                        driveSearch,
                        driveFolderStack[driveFolderStack.length - 1].id,
                      )
                    }
                  >
                    <Text style={styles.pickerRetryText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : driveFiles.length === 0 ? (
                <View style={styles.pickerStatus}>
                  <Feather name="image" size={20} color={Colors.textMuted} />
                  <Text style={styles.pickerStatusText}>
                    {driveFolderStack.length > 1
                      ? "This folder has no images or sub-folders."
                      : "No images or folders found in your Google Drive."}
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={[...driveFiles].sort((a, b) => {
                    const af = a.mimeType === "application/vnd.google-apps.folder" ? 0 : 1;
                    const bf = b.mimeType === "application/vnd.google-apps.folder" ? 0 : 1;
                    if (af !== bf) return af - bf;
                    return a.name.localeCompare(b.name);
                  })}
                  keyExtractor={(it) => it.id}
                  contentContainerStyle={{ paddingVertical: 4 }}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => {
                    const isFolder = item.mimeType === "application/vnd.google-apps.folder";
                    const busy = driveAttachingId === item.id;
                    const anyBusy = driveAttachingId !== null;
                    return (
                      <TouchableOpacity
                        style={[styles.pickerRow, busy && { opacity: 0.6 }]}
                        onPress={() => attachDriveFile(item)}
                        disabled={anyBusy}
                        activeOpacity={0.7}
                      >
                        <View
                          style={[
                            styles.pickerThumb,
                            isFolder && { backgroundColor: "#FFF7E0" },
                          ]}
                        >
                          <Feather
                            name={isFolder ? "folder" : "image"}
                            size={18}
                            color={isFolder ? "#B8860B" : DEEP_RED}
                          />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.pickerName} numberOfLines={1}>
                            {item.name}
                          </Text>
                          <Text style={styles.pickerMeta} numberOfLines={1}>
                            {isFolder
                              ? "Folder"
                              : item.mimeType.replace("image/", "").toUpperCase()}
                            {item.modifiedTime
                              ? ` · ${new Date(item.modifiedTime).toLocaleDateString()}`
                              : ""}
                          </Text>
                        </View>
                        {busy ? (
                          <ActivityIndicator size="small" color={Colors.primary} />
                        ) : (
                          <Feather
                            name={isFolder ? "chevron-right" : "download"}
                            size={16}
                            color={Colors.textMuted}
                          />
                        )}
                      </TouchableOpacity>
                    );
                  }}
                  ItemSeparatorComponent={() => <View style={styles.pickerSep} />}
                />
              )}
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
  item, busy, showLogo, onAddImage, onRemoveImage, onRemoveBackground,
}: {
  item: PriceTagItem;
  busy: boolean;
  showLogo: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
  onRemoveBackground: () => void;
}) {
  const { label, value } = priceFor(item);
  const mrp = fmt0(item.mrp);
  const off = offAmount(item);

  return (
    <View style={a.card}>
      {/* Logo watermark — rendered FIRST so subsequent in-flow children
          paint on top of it. pointerEvents="none" lets taps fall through
          to the price/image controls underneath. */}
      {showLogo && (
        <View pointerEvents="none" style={watermarkStyles.layer}>
          <Image
            source={{ uri: LOGO_BASE64 }}
            style={watermarkStyles.image}
            resizeMode="contain"
          />
        </View>
      )}
      {/* Row 1 — description, full width, in the same red as MRP */}
      <Text
        style={[a.desc, { fontFamily: pickFont(item.description, "bold") }]}
        numberOfLines={2}
      >
        {item.description || "(no description)"}
      </Text>

      {/* Row 2 — prices on the left, square image on the right */}
      <View style={a.bodyRow}>
        <View style={a.bodyLeft}>
          {mrp && (
            <View style={a.mrpRow}>
              <Text style={a.rupeeSm}>₹</Text>
              <Text style={a.mrpVal}>{mrp}</Text>
              <Text style={a.mrpLabel}>MRP</Text>
            </View>
          )}
          <View style={a.priceRow}>
            <Text style={a.rupeeBig}>₹</Text>
            <Text style={a.priceVal}>{value}</Text>
            <View style={a.priceLabelCol}>
              <Text style={a.priceLabel}>{label.toUpperCase().split(" ")[0]}</Text>
              <Text style={a.priceLabel}>{label.toUpperCase().split(" ")[1] || ""}</Text>
            </View>
          </View>
          {off && (
            <View style={a.footerRow}>
              <Text style={a.offText}>SAVE ₹{off}</Text>
            </View>
          )}
        </View>
        <View style={a.bodyRight}>
          <View style={a.imgPanel}>
            <ImageSlot
              item={item}
              busy={busy}
              onAddImage={onAddImage}
              onRemoveImage={onRemoveImage}
              onRemoveBackground={onRemoveBackground}
              tone="light"
            />
          </View>
        </View>
      </View>

      <Text style={a.itemNoFooter}>Item No: {item.itemNo || "—"}</Text>

      {/* Valid Till — vertical rail on the right edge. Rendered last
          so it paints on top of the watermark and any overflow. */}
      {item.promotionToDate ? (
        <View pointerEvents="none" style={validTillStyles.railA}>
          <Text style={validTillStyles.textA}>
            Valid Till: {formatValidTill(item.promotionToDate)}
          </Text>
        </View>
      ) : null}
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
  item, busy, showLogo, onAddImage, onRemoveImage, onRemoveBackground,
}: {
  item: PriceTagItem;
  busy: boolean;
  showLogo: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
  onRemoveBackground: () => void;
}) {
  const { value } = priceFor(item);
  const off = offAmount(item);

  return (
    <View style={b.card}>
      {/* Logo watermark — see note in StyleATag. Rendered first so the
          banners and price text overlay it. */}
      {showLogo && (
        <View pointerEvents="none" style={watermarkStyles.layer}>
          <Image
            source={{ uri: LOGO_BASE64 }}
            style={watermarkStyles.image}
            resizeMode="contain"
          />
        </View>
      )}
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
            onRemoveBackground={onRemoveBackground}
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

      {/* Valid Till — vertical rail on the right edge. */}
      {item.promotionToDate ? (
        <View pointerEvents="none" style={validTillStyles.railB}>
          <Text style={validTillStyles.textB}>
            Valid Till: {formatValidTill(item.promotionToDate)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ----------- Image slot (shared between styles) -----------

function ImageSlot({
  item, busy, onAddImage, onRemoveImage, onRemoveBackground, tone,
}: {
  item: PriceTagItem;
  busy: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
  onRemoveBackground: () => void;
  tone: "dark" | "light";
}) {
  const slotStyle = tone === "dark" ? imgs.slotDark : imgs.slotLight;
  const emptyTextColor = tone === "dark" ? "#F4D9DC" : Colors.textSecondary;
  const emptySubColor = tone === "dark" ? "#E5B7BC" : Colors.textMuted;

  if (item.imageUri) {
    return (
      <View style={[imgs.slot, slotStyle]}>
        <Image source={{ uri: item.imageUri }} style={imgs.img} resizeMode="contain" />
        {busy && (
          <View style={imgs.busyOverlay}>
            <ActivityIndicator size="small" color="#FFF" />
          </View>
        )}
        <View style={imgs.actions}>
          <TouchableOpacity
            style={imgs.actionChip}
            onPress={onRemoveBackground}
            disabled={busy}
          >
            <Feather name="scissors" size={11} color={Colors.primary} />
            <Text style={imgs.actionText}>BG</Text>
          </TouchableOpacity>
          <TouchableOpacity style={imgs.actionChip} onPress={onAddImage} disabled={busy}>
            <Feather name="refresh-cw" size={11} color={Colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={imgs.actionChip} onPress={onRemoveImage} disabled={busy}>
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

function buildPdfHtml(
  items: PriceTagItem[],
  style: PriceTagStyle,
  showLogo: boolean,
): string {
  const tagsHtml = items
    .map((it) => (style === "B" ? renderTagBHtml(it, showLogo) : renderTagAHtml(it, showLogo)))
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
  .grid { display: grid; grid-template-columns: 1fr 1fr; row-gap: 30px; column-gap: 10px; }
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

function renderTagAHtml(it: PriceTagItem, showLogo: boolean): string {
  const { label, value } = priceFor(it);
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

  // Split the price label across two lines (e.g. "OFFER" / "PRICE")
  // so the PDF matches the two-line on-screen layout.
  const labelParts = label.toUpperCase().split(" ");
  const labelLine1 = escapeHtml(labelParts[0] || "");
  const labelLine2 = escapeHtml(labelParts[1] || "");

  const watermark = showLogo
    ? `<img class="watermark" src="${LOGO_BASE64}" alt="" />`
    : "";

  const validTill = it.promotionToDate
    ? `<div class="validTillA"><span>Valid Till: ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}</span></div>`
    : "";

  return `
    <div class="tagA">
      ${watermark}
      ${validTill}
      <div class="descA">${descSpan}</div>
      <div class="bodyRowA">
        <div class="bodyLeftA">
          ${mrp ? `
            <div class="mrpRowA">
              <span class="rupeeSm">₹</span><span class="mrpValA">${escapeHtml(mrp)}</span>
              <span class="mrpLabelA">MRP</span>
            </div>` : ""}
          <div class="priceRowA">
            <span class="rupeeBigA">₹</span><span class="priceValA">${escapeHtml(value)}</span>
            <span class="priceLabelColA">
              <span class="priceLabelA">${labelLine1}</span>
              <span class="priceLabelA">${labelLine2}</span>
            </span>
          </div>
          ${off ? `<div class="footerA"><span class="offA">SAVE ₹${escapeHtml(off)}</span></div>` : ""}
        </div>
        <div class="bodyRightA">
          <div class="imgPanelA">${img}</div>
        </div>
      </div>
      <div class="itemFooterA">Item No: ${escapeHtml(it.itemNo || "—")}</div>
    </div>
  `;
}

// Printer-friendly: white background, no large solid color fills
// (the maroon image panel and red savings pill are the only colored
// fills, and the savings pill is small enough to keep ink usage low).
const PDF_CSS_A = `
  .tagA {
    position: relative;
    background: #FFFFFF;
    border: 1.5px solid ${DEEP_RED};
    border-radius: 8px;
    padding: 10px;
    page-break-inside: avoid;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  /* Centered Sathyam-Super-Store logo watermark behind the tag content.
     Sized to ~24% of the tag width and nudged right by 1/20 of the
     tag width (left:55% with the -50%/-50% translate). */
  .tagA .watermark {
    position: absolute;
    top: 50%; left: 55%;
    width: 24%; height: auto;
    transform: translate(-50%, -50%);
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagA > *:not(.watermark) { position: relative; z-index: 1; }
  /* Vertical "Valid Till" rail — narrow column on the right edge
     with the text rotated 90deg so it reads top-to-bottom. */
  .tagA .validTillA {
    position: absolute;
    top: 0; right: 2px; bottom: 0;
    width: 14px;
    display: flex; align-items: center; justify-content: center;
    z-index: 2; pointer-events: none;
  }
  .tagA .validTillA span {
    display: inline-block;
    transform: rotate(90deg);
    white-space: nowrap;
    font-size: 8px; color: #94795E; font-weight: 600;
    letter-spacing: 0.3px;
  }
  .descA {
    font-size: 13px; font-weight: 800; color: ${DEEP_RED};
    line-height: 1.25; margin-bottom: 8px;
  }
  .bodyRowA {
    display: flex; flex-direction: row; align-items: center;
    gap: 10px;
  }
  .bodyLeftA { flex: 1; min-width: 0; }
  .bodyRightA { width: 120px; flex-shrink: 0; }
  .imgPanelA {
    position: relative;
    width: 120px; height: 120px;
    background: transparent;
    border-radius: 6px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .imgPanelA img { width: 100%; height: 100%; object-fit: contain; }
  .img-placeholder {
    color: ${DEEP_RED}; font-size: 11px;
    border: 1px dashed ${DEEP_RED}; border-radius: 6px;
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
  }
  .mrpRowA {
    display: inline-flex; align-items: baseline;
    gap: 3px; padding: 1px 4px; margin-bottom: 4px;
  }
  .rupeeSm { font-size: 11px; color: ${DEEP_RED}; font-weight: 800; }
  .mrpValA { font-size: 18px; color: ${DEEP_RED}; font-weight: 800; line-height: 1; }
  .mrpLabelA { font-size: 10px; color: ${DEEP_RED}; font-weight: 700; margin-left: 3px; letter-spacing: 0.5px; }
  .priceRowA {
    display: flex; align-items: center; gap: 4px; margin-top: 2px;
  }
  .rupeeBigA { font-size: 18px; color: ${GOLD}; font-weight: 800; line-height: 1; }
  .priceValA { font-size: 36px; color: ${GOLD}; font-weight: 900; line-height: 1; }
  .priceLabelColA {
    display: inline-flex; flex-direction: column;
    justify-content: center; align-items: flex-start;
    margin-left: 5px; line-height: 1;
  }
  .priceLabelA {
    font-size: 11px; color: ${GOLD}; font-weight: 800;
    letter-spacing: 0.8px; line-height: 1.1;
  }
  .footerA {
    display: flex; justify-content: flex-start; align-items: center;
    margin-top: 6px;
  }
  .offA {
    display: inline-block;
    background: ${DEEP_RED}; color: #FFF;
    font-size: 11px; font-weight: 800; letter-spacing: 0.5px;
    padding: 2px 8px; border-radius: 4px;
  }
  .itemFooterA {
    margin-top: 8px; padding-top: 4px;
    border-top: 1px dashed #C8B89F;
    font-size: 9px; color: #94795E; font-weight: 600; letter-spacing: 0.3px;
  }
`;

// ----- Style B HTML / CSS -----

function renderTagBHtml(it: PriceTagItem, showLogo: boolean): string {
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

  const watermark = showLogo
    ? `<img class="watermark" src="${LOGO_BASE64}" alt="" />`
    : "";

  const validTill = it.promotionToDate
    ? `<div class="validTillB"><span>Valid Till: ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}</span></div>`
    : "";

  return `
    <div class="tagB">
      ${watermark}
      ${validTill}
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
    position: relative;
    background: #FFF;
    border: 1.5px solid ${RED};
    border-radius: 6px;
    overflow: hidden;
    page-break-inside: avoid;
    display: flex; flex-direction: column;
  }
  /* Same sizing/offset treatment as Style A. */
  .tagB .watermark {
    position: absolute;
    top: 50%; left: 55%;
    width: 24%; height: auto;
    transform: translate(-50%, -50%);
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagB > *:not(.watermark) { position: relative; z-index: 1; }
  /* "Valid Till" rail for Style B — left edge, rotated -90deg so
     the text reads bottom-to-top (natural for a left-edge label). */
  .tagB .validTillB {
    position: absolute;
    top: 0; left: 2px; bottom: 0;
    width: 14px;
    display: flex; align-items: center; justify-content: center;
    z-index: 2; pointer-events: none;
  }
  .tagB .validTillB span {
    display: inline-block;
    transform: rotate(-90deg);
    white-space: nowrap;
    font-size: 9px; color: #6B7280; font-weight: 600;
    letter-spacing: 0.3px;
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
  logoToggleBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  logoToggleLabel: {
    fontSize: 12, fontWeight: "700",
    color: Colors.textSecondary, letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  // Custom switch so we don't pull in another RN core component just
  // for one toggle. Width / knob sizes mirror the RN Switch defaults.
  logoToggleSwitch: {
    width: 40, height: 22, borderRadius: 11,
    backgroundColor: Colors.border,
    padding: 2, justifyContent: "center",
  },
  logoToggleSwitchOn: { backgroundColor: Colors.primary },
  logoToggleKnob: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: "#FFF",
    shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  logoToggleKnobOn: { alignSelf: "flex-end" },
  logoToggleHint: {
    fontSize: 11, color: Colors.textMuted, fontWeight: "600",
    marginLeft: "auto",
  },
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
  bgAllBtn: {
    marginLeft: "auto",
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999, borderWidth: 1, borderColor: Colors.primary,
    backgroundColor: Colors.primary + "12",
  },
  bgAllBtnBusy: { opacity: 0.7 },
  bgAllBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },
  grid: {
    flexDirection: "row", flexWrap: "wrap",
    paddingHorizontal: 8, paddingTop: 10,
    columnGap: 8, rowGap: 36,
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
  sheetScrim: {
    flex: 1, backgroundColor: "rgba(15,23,42,0.45)",
    justifyContent: "flex-end",
  },
  sheetCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24,
  },
  sheetTitle: {
    fontSize: 13, fontWeight: "700", color: Colors.textMuted,
    textTransform: "uppercase", letterSpacing: 0.5,
    paddingHorizontal: 8, paddingVertical: 12, textAlign: "center",
  },
  sheetRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 14, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  sheetRowText: { fontSize: 15, color: Colors.text, fontWeight: "600" },
  sheetRowSub: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  sheetCancelRow: {
    justifyContent: "center", marginTop: 8,
    borderTopWidth: 0,
    backgroundColor: Colors.background, borderRadius: 10,
  },
  sheetCancelText: { fontSize: 15, color: Colors.danger, fontWeight: "700" },
  modalConfirm: {
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8,
    backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center",
    minWidth: 80,
  },
  modalConfirmText: { color: Colors.textInverse, fontWeight: "800" },
  pickerHeader: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 8,
  },
  pickerCrumbs: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 4, paddingVertical: 6, marginBottom: 6,
    backgroundColor: Colors.surfaceSecondary, borderRadius: 8,
  },
  pickerCrumbsText: {
    flex: 1, fontSize: 12, fontWeight: "600",
    color: Colors.textSecondary,
  },
  pickerSearchRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 10, paddingVertical: 4, marginBottom: 10,
  },
  pickerSearch: {
    flex: 1, fontSize: 13, color: Colors.text, paddingVertical: 8,
  },
  pickerSearchBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
  },
  pickerSearchBtnText: {
    color: Colors.textInverse, fontWeight: "800", fontSize: 12,
  },
  pickerStatus: {
    paddingVertical: 24, alignItems: "center", gap: 8,
  },
  pickerStatusText: {
    fontSize: 13, color: Colors.textMuted, textAlign: "center",
  },
  pickerRetry: {
    marginTop: 4, paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 6, backgroundColor: Colors.primary,
  },
  pickerRetryText: { color: Colors.textInverse, fontWeight: "800", fontSize: 12 },
  pickerRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 8, paddingHorizontal: 4,
  },
  pickerThumb: {
    width: 36, height: 36, borderRadius: 6,
    backgroundColor: CREAM,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: DEEP_RED,
  },
  pickerName: { fontSize: 13, fontWeight: "700", color: Colors.text },
  pickerMeta: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  pickerSep: { height: 1, backgroundColor: Colors.border },
});

// Style A — on-screen tag styles
const a = StyleSheet.create({
  card: {
    backgroundColor: CREAM,
    borderWidth: 2, borderColor: DEEP_RED,
    borderRadius: 8, padding: 8,
    overflow: "hidden",
  },
  bodyRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  bodyLeft: { flex: 1, justifyContent: "center" },
  bodyRight: { width: 92 },
  imgPanel: {
    width: "100%", aspectRatio: 1,
    backgroundColor: "transparent",
    borderRadius: 6, padding: 0,
    position: "relative",
    overflow: "hidden",
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
    fontSize: 12, fontWeight: "800", color: DEEP_RED,
    lineHeight: 14, marginBottom: 6, minHeight: 28,
  },
  mrpRow: {
    flexDirection: "row", alignItems: "baseline",
    alignSelf: "flex-start", marginBottom: 2,
    paddingHorizontal: 2,
  },
  rupeeSm: { fontSize: 9, color: DEEP_RED, fontWeight: "800" },
  mrpVal: { fontSize: 14, color: DEEP_RED, fontWeight: "800", marginLeft: 1 },
  mrpLabel: {
    fontSize: 8, color: DEEP_RED, fontWeight: "700",
    marginLeft: 3, letterSpacing: 0.4,
  },
  priceRow: {
    flexDirection: "row", alignItems: "center", marginTop: 2,
  },
  rupeeBig: { fontSize: 14, color: GOLD, fontWeight: "800" },
  priceVal: { fontSize: 26, color: GOLD, fontWeight: "900", lineHeight: 28 },
  priceLabelCol: {
    marginLeft: 4, justifyContent: "center", alignItems: "flex-start",
  },
  priceLabel: {
    fontSize: 9, color: GOLD, fontWeight: "800",
    letterSpacing: 0.6, lineHeight: 11,
  },
  footerRow: {
    flexDirection: "row", justifyContent: "flex-start",
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

// "Valid Till" vertical rail. A narrow, full-height column pinned to
// the right edge of each tag card; the inner Text is rotated 90deg
// so the date reads top-to-bottom. Font sizes mirror each style's
// `itemNoFooter` so the new label matches the existing footer
// typography.
const validTillStyles = StyleSheet.create({
  railA: {
    position: "absolute",
    top: 0, bottom: 0, right: 2,
    width: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  textA: {
    fontSize: 8, color: "#94795E", fontWeight: "600",
    letterSpacing: 0.3,
    transform: [{ rotate: "90deg" }],
    width: 200,
    textAlign: "center",
  },
  // Style B: rail on the LEFT edge. Text rotated -90deg so it reads
  // bottom-to-top — the natural orientation for a left-edge label
  // (reader tilts head to the left).
  railB: {
    position: "absolute",
    top: 0, bottom: 0, left: 2,
    width: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  textB: {
    fontSize: 9, color: Colors.textMuted, fontWeight: "600",
    letterSpacing: 0.3,
    transform: [{ rotate: "-90deg" }],
    width: 200,
    textAlign: "center",
  },
});

// Normalises a PromotionToDate string for display. The Promo importer
// stores values as "DD/MM/YYYY" (occasionally with stray whitespace),
// but the user wants "DD-MM-YYYY" on the tag. Anything we don't
// recognise is returned as-is so an unexpected format still shows
// something useful instead of a blank.
function formatValidTill(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\//g, "-");
}

// Logo watermark layer. An absolutely-positioned, centered image at
// 30% opacity that spans the whole tag card. Rendered as the first
// child of each tag so subsequent in-flow children paint on top of it
// (RN paints children in declared order when zIndex isn't set).
const watermarkStyles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0, right: 0, bottom: 0, left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "24%",
    height: "24%",
    opacity: 0.30,
    // Nudge right by 1/20 of the tag's width so the watermark sits a
    // touch off-center, away from the price digits which dominate the
    // left half of the card.
    marginLeft: "5%",
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
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center", justifyContent: "center",
    borderRadius: 6,
  },
});
