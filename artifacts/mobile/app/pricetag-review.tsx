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
  Linking,
  type StyleProp,
  type ViewStyle,
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
import * as MediaLibrary from "expo-media-library";
import { captureRef } from "react-native-view-shot";
import { Colors } from "@/constants/colors";
import { LOGO_BASE64 } from "@/constants/LogoBase64";
import { useApp, type PriceTagItem, type PriceTagStyle } from "@/context/AppContext";
import { DEFAULT_TAG_COLORS, type TagColors } from "@workspace/pricetag-html";
import { TitlePickerModal } from "@/components/TitlePickerModal";
import { useAuth } from "@/context/AuthContext";
import { pickFont, hasTamil } from "@/constants/typography";

// PriceTag Review screen.
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
// Default brand palette. The on-screen tags + PDF CSS now read from
// the user-customizable `tagColors` in AppContext (TagColours tab),
// but a few non-tag UI elements (Feather icons, picker thumbs) still
// reference these constants directly so the rest of the screen looks
// consistent regardless of the user's tag palette.
const RED = DEFAULT_TAG_COLORS.red;
const DEEP_RED = DEFAULT_TAG_COLORS.deepRed;
const CREAM = DEFAULT_TAG_COLORS.cream;
const GOLD = DEFAULT_TAG_COLORS.gold;

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
// Minimum purchase qty to show on the tag. Returns the formatted
// number when EligibleQty is present and not equal to 1, otherwise
// null (single-unit promos don't need the disclaimer).
function minPurchaseQty(item: PriceTagItem): string | null {
  const raw = item.eligibleQty;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n === 1) return null;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

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

export default function PriceTagReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    priceTagReviewItems,
    savePriceTagReviewItems,
    setPriceTagReviewImage,
    clearPriceTagReviewItems,
    priceTagReviewStyle,
    setPriceTagReviewStyle,
    priceTagReviewShowLogo,
    setPriceTagReviewShowLogo,
    priceTagReviewShowWatermark,
    setPriceTagReviewShowWatermark,
    priceTagSquareVariant,
    setPriceTagSquareVariant,
    priceTagReviewTitle,
    setPriceTagReviewTitle,
    tagColors,
    titleList,
  } = useApp();

  // Style E ("Customize Me") banner-title picker. While non-null we
  // show the TitlePickerModal anchored to that working item; on pick
  // we write `customTitle` onto the working item so SAVE flushes the
  // choice into AppContext together with the rest of the working
  // edits.
  const [titlePickerKey, setTitlePickerKey] = useState<string | null>(null);

  function setItemCustomTitle(key: string, title: string | undefined) {
    setWorkingItems((prev) =>
      prev.map((i) =>
        i.key === key
          ? title === undefined
            ? (() => {
                const { customTitle: _drop, ...rest } = i;
                return rest as PriceTagItem;
              })()
            : { ...i, customTitle: title }
          : i,
      ),
    );
  }

  // Title editor modal — opens via "Add Title" / "Modify Title".
  // `titleDraft` holds the in-progress text so cancelling doesn't
  // commit, matching the pattern used elsewhere on this screen.
  const [showTitleModal, setShowTitleModal] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const [mode, setMode] = useState<Mode>("view");
  const [workingItems, setWorkingItems] = useState<PriceTagItem[]>(priceTagReviewItems);
  // Tracks the latest working items for closure-safe lookups (e.g. the
  // previous imageUri inside async picker handlers, used for on-disk
  // cleanup when an image is replaced).
  const workingItemsRef = useRef<PriceTagItem[]>(workingItems);
  useEffect(() => {
    workingItemsRef.current = workingItems;
  }, [workingItems]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Snapshot of `priceTagReviewItems` taken right before "Sort by Code"
  // applies its ordering. While non-null, the toolbar button flips
  // to "Undo Sort" and tapping it restores this snapshot. Cleared
  // whenever the underlying item set changes (add / remove / Modify
  // commit) so we never restore a stale, mismatched ordering.
  const [preSortSnapshot, setPreSortSnapshot] = useState<
    PriceTagItem[] | null
  >(null);
  const [bgAllRunning, setBgAllRunning] = useState(false);
  const { token: authToken, logout } = useAuth();
  const [exporting, setExporting] = useState(false);

  // ----- PNG export ("PNG's" red button) -----
  // Two-step modal: step 1 picks the item, step 2 picks Phone vs
  // Drive. We keep both flags + the selected key local — they only
  // affect the modal stack and the off-screen capture container.
  const [pngPickerOpen, setPngPickerOpen] = useState(false);
  // Which IMG screen layout the picker is targeting. "default" routes
  // to the existing tag layout; "showcase" routes to the new
  // visually-redesigned 2:1 layout opened by the "Showcase" button.
  const [imgPickerLayout, setImgPickerLayout] = useState<
    "default" | "showcase" | "showcase-sq"
  >("default");
  const [pngExportItem, setPngExportItem] = useState<PriceTagItem | null>(null);
  const [pngBusy, setPngBusy] = useState<null | "phone" | "drive">(null);
  const pngCaptureRef = useRef<View>(null);

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

  const items = mode === "modify" ? workingItems : priceTagReviewItems;

  function enterModify() {
    setWorkingItems(priceTagReviewItems);
    setMode("modify");
  }
  function cancelModify() {
    setWorkingItems(priceTagReviewItems);
    setMode("view");
  }
  async function commitModify() {
    try {
      await savePriceTagReviewItems(workingItems);
      // The user has just established a new manual order — discard
      // any "Undo Sort" snapshot so the toolbar button reverts to
      // "Sort by Code" instead of restoring the pre-sort layout.
      setPreSortSnapshot(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMode("view");
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message ?? "Storage error");
    }
  }
  function removeFromWorking(key: string) {
    setWorkingItems((prev) => prev.filter((i) => i.key !== key));
  }

  // Per-item style override used by the chips rendered under each tag
  // in Modify mode. Writes the chosen style onto the working copy of
  // this item only; persists when the user taps Save (commitModify).
  function setItemStyle(key: string, style: PriceTagStyle) {
    setWorkingItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, style } : i)),
    );
  }

  // Manual reorder used by the up/down chevrons rendered on each tile
  // while Modify mode is on. Swaps the tile with its previous (`-1`)
  // or next (`+1`) neighbour. Order is committed to storage when the
  // user taps Save (commitModify), so cancelling discards the
  // reordering along with any other in-progress edits.
  function moveInWorking(key: string, dir: -1 | 1) {
    setWorkingItems((prev) => {
      const i = prev.findIndex((x) => x.key === key);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // "Sort by Code" — re-orders the saved tag list by PromoSortCode
  // ascending (numeric-aware so "A2" < "A10"). Items whose sort code
  // is empty/missing fall to the bottom of the list, ordered by the
  // original `addedAt` timestamp so the most-recently-appended items
  // stay at the very bottom (matching the "appended time" rule the
  // user asked for). The new order is persisted immediately so PDF
  // export and the on-screen grid both reflect it.
  async function sortByPromoSortCode() {
    // Second tap = undo: restore the snapshot taken before the last
    // sort and clear it so the next tap will sort again.
    if (preSortSnapshot) {
      try {
        await savePriceTagReviewItems(preSortSnapshot);
        setPreSortSnapshot(null);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: any) {
        Alert.alert("Couldn't restore", e?.message ?? "Storage error");
      }
      return;
    }
    // First tap = remember the current order, then apply the sort.
    const snapshot = priceTagReviewItems.slice();
    const sorted = [...priceTagReviewItems].sort((a, b) => {
      const ac = (a.promoSortCode ?? "").trim();
      const bc = (b.promoSortCode ?? "").trim();
      if (ac && bc) {
        const cmp = ac.localeCompare(bc, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        if (cmp !== 0) return cmp;
        return (a.addedAt ?? 0) - (b.addedAt ?? 0);
      }
      if (ac) return -1; // non-empty before empty
      if (bc) return 1;
      return (a.addedAt ?? 0) - (b.addedAt ?? 0);
    });
    try {
      await savePriceTagReviewItems(sorted);
      setPreSortSnapshot(snapshot);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Couldn't sort", e?.message ?? "Storage error");
    }
  }

  // Invalidate the undo snapshot any time the item set itself
  // changes (additions from PromoPrint, removals, Modify commits).
  // We compare the key-set rather than full equality so a mere
  // image-attachment edit doesn't drop the snapshot.
  useEffect(() => {
    if (!preSortSnapshot) return;
    const a = new Set(preSortSnapshot.map((i) => i.key));
    const b = new Set(priceTagReviewItems.map((i) => i.key));
    if (a.size !== b.size) {
      setPreSortSnapshot(null);
      return;
    }
    for (const k of a) {
      if (!b.has(k)) {
        setPreSortSnapshot(null);
        return;
      }
    }
  }, [priceTagReviewItems, preSortSnapshot]);

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
    await setPriceTagReviewImage(key, finalUri);
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
      const stale = priceTagReviewItems.filter(
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
    // priceTagReviewItems intentionally excluded — we only want this to
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
      const resp = await fetch(apiUrl(`/api/drive/files?${qs.toString()}`), {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
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
  }, [authToken]);

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
      const resp = await fetch(url, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
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
      await setPriceTagReviewImage(key, null);
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
    if (priceTagReviewItems.length === 0) return;
    setExporting(true);
    try {
      // Inline every image as a `data:` URI before building the PDF
      // HTML. expo-print's underlying WebView doesn't reliably load
      // arbitrary `file://` URIs from the app's document directory
      // when rendering to PDF (images come out blank), so we read
      // each persisted file back as base64 and embed it directly.
      const itemsForPdf = await Promise.all(
        priceTagReviewItems.map(async (it) => {
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
      // PriceTag Review honours per-item style overrides on export:
      // each item rendered with `it.style ?? priceTagReviewStyle`. The
      // PDF builder reads `it.style` directly so we just pass the
      // screen-wide style as the fallback.
      const html = buildPdfHtml(itemsForPdf, priceTagReviewStyle, priceTagReviewShowLogo, tagColors, priceTagReviewShowWatermark);
      const { uri } = await Print.printToFileAsync({ html });
      if (Platform.OS === "web") return;

      // Build the export filename per spec:
      //   "Sathyam Super Store Promo -" + <Title?> + "DDMMYY HHMM" + ".pdf"
      // The title is optional. We strip filesystem-unsafe characters
      // (slashes, colons, control chars, etc.) before splicing it
      // in so the rename never trips on path separators.
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}` +
        ` ${pad(d.getHours())}${pad(d.getMinutes())}`;
      const safeTitle = priceTagReviewTitle
        .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
        .trim();
      const filename = safeTitle
        ? `Sathyam Super Store Promo -${safeTitle} ${stamp}.pdf`
        : `Sathyam Super Store Promo - ${stamp}.pdf`;

      // expo-print writes to a fixed temp uri; copy it to a new
      // path with the desired filename so the share-sheet / saved
      // file picks up the human-readable name. If the copy fails
      // for any reason, fall through to sharing the original uri.
      let shareUri = uri;
      try {
        const dir = FileSystem.cacheDirectory ?? "";
        if (dir) {
          const target = dir + filename;
          await FileSystem.deleteAsync(target, { idempotent: true });
          await FileSystem.copyAsync({ from: uri, to: target });
          shareUri = target;
        }
      } catch {
        // Use the unrenamed uri as a fallback.
      }

      const can = await Sharing.isAvailableAsync();
      if (can) {
        await Sharing.shareAsync(shareUri, {
          mimeType: "application/pdf",
          dialogTitle: filename,
          UTI: "com.adobe.pdf",
        });
      } else {
        Alert.alert("PDF saved", shareUri);
      }
    } catch (e: any) {
      Alert.alert("Export failed", e?.message ?? "Could not generate PDF");
    } finally {
      setExporting(false);
    }
  }

  // -------- PNG export (768×384, ≤295 KB) --------
  //
  // Filename contract:
  //   {Item Description}_{MRP}_{PromoPrice}_{DDMMYYYY}.png
  // Date is the item's `promotionToDate` (Valid till) flattened to
  // DDMMYYYY with no separators. Filesystem-unsafe characters
  //   / \ : * ? " < > |
  // get squashed to "_", and runs of underscores collapse to one so
  // we don't end up with "Foo___Bar".
  function pngFilenameFor(item: PriceTagItem): string {
    const cleanField = (raw: string): string => {
      const stripped = raw
        .replace(/[\/\\:*?"<>|\r\n\t\u0000-\u001F]+/g, "_")
        .replace(/_+/g, "_")
        .trim();
      return stripped.replace(/^_+|_+$/g, "") || "_";
    };
    // Strict fallback contract: missing MRP / PromoPrice / Valid Till
    // segments are emitted as empty strings, preserving the four
    // underscore separators. So a tag with only a description and
    // valid-till date becomes `Foo___10052026.png`.
    const descRaw = (item.description ?? "").trim();
    const desc = descRaw ? cleanField(descRaw) : "PriceTag";
    const mrp = item.mrp !== undefined && item.mrp !== ""
      ? cleanField(fmt0(item.mrp))
      : "";
    const promo =
      item.promotionPrice !== undefined && item.promotionPrice !== ""
        ? cleanField(fmt0(item.promotionPrice))
        : "";
    // Flatten the Valid Till date to DDMMYYYY. The importer emits
    // DD/MM/YYYY most of the time, but we also tolerate
    // DD-MM-YYYY and ISO YYYY-MM-DD. Missing date → empty segment.
    const date = (() => {
      const raw = (item.promotionToDate ?? "").trim();
      if (!raw) return "";
      const parts = raw.split(/[\/\-\.]/).map((s) => s.trim());
      if (parts.length === 3) {
        const looksIso = parts[0].length === 4;
        const dd = looksIso ? parts[2] : parts[0];
        const mm = parts[1];
        const yyyy = looksIso ? parts[0] : parts[2];
        const pad2 = (s: string) => s.padStart(2, "0");
        const yyyyFull =
          yyyy.length === 2 ? `20${yyyy}` : yyyy.padStart(4, "0");
        return `${pad2(dd)}${pad2(mm)}${yyyyFull}`;
      }
      return cleanField(raw);
    })();
    // Trim the description if the assembled name would exceed common
    // filesystem limits (~200 chars before extension). The other
    // segments are short enough that only the description can blow
    // the budget.
    const tail = `_${mrp}_${promo}_${date}.jpg`;
    const MAX = 200;
    const descTrimmed =
      desc.length + tail.length > MAX
        ? desc.slice(0, Math.max(1, MAX - tail.length))
        : desc;
    return `${descTrimmed}${tail}`;
  }

  // High-quality capture for evaluation:
  //   - Renders the off-screen tag in a 2:1 frame (1900×950) and
  //     stretches the tag to fill it, so the captured bitmap matches
  //     a tag cropped from the PDF (no whitespace bands).
  //   - Captures at the device's pixel density.
  //   - Encodes as JPEG at quality 0.95 over a white background —
  //     this gave noticeably crisper text on device than PNG and
  //     keeps the file size reasonable. No 295 KB cap, no resize.
  // We can re-introduce the size/pixel restrictions once the user
  // has decided on the visual target.
  async function capturePngForItem(): Promise<{
    uri: string;
    base64: string;
    bytes: number;
    filename: string;
  } | null> {
    const item = pngExportItem;
    if (!item) return null;
    const filename = pngFilenameFor(item);
    const ref = pngCaptureRef.current;
    if (!ref) {
      throw new Error("Renderer not mounted yet — try again.");
    }

    // Give RN a frame to settle off-screen layout (images, fonts).
    await new Promise((r) => setTimeout(r, 150));

    const uri = await captureRef(ref, {
      format: "jpg",
      quality: 0.95,
      result: "tmpfile",
    });

    let bytes = 0;
    try {
      const info = (await FileSystem.getInfoAsync(uri)) as {
        size?: number;
        exists?: boolean;
      };
      bytes = info.exists ? info.size ?? 0 : 0;
    } catch {
      bytes = 0;
    }

    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: "base64" as any,
    });
    return { uri, base64, bytes, filename };
  }

  async function savePngToPhone(): Promise<void> {
    if (!pngExportItem || pngBusy) return;
    setPngBusy("phone");
    try {
      const captured = await capturePngForItem();
      if (!captured) return;

      if (Platform.OS === "web") {
        // Web has no photo library — trigger a normal browser
        // download so the user gets the same PNG file with the same
        // contract filename. We rebuild the blob from the base64 we
        // already have, which avoids fetching the file:// URL (web
        // fs APIs vary across browsers).
        const bytes = Uint8Array.from(atob(captured.base64), (c) =>
          c.charCodeAt(0),
        );
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = captured.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Give Safari a moment to start the download before revoking.
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        Alert.alert(
          "Downloaded",
          `${captured.filename}\n${(captured.bytes / 1024).toFixed(0)} KB`,
        );
        setPngExportItem(null);
        return;
      }

      // Copy to a stable file with the desired filename so the
      // gallery shows the human-readable name (some Android galleries
      // honour the source filename).
      const dir = FileSystem.cacheDirectory ?? "";
      let saveUri = captured.uri;
      if (dir) {
        const target = dir + captured.filename;
        try {
          await FileSystem.deleteAsync(target, { idempotent: true });
          await FileSystem.copyAsync({ from: captured.uri, to: target });
          saveUri = target;
        } catch {
          /* fall back to original temp uri */
        }
      }

      // Try the native MediaLibrary path first — that's what writes
      // straight into the "Sathyam PriceTags" album. If we're inside
      // Expo Go on Android 14+, MediaLibrary is now blocked and
      // throws; we fall back to the system share sheet so the user
      // can still get the PNG out (Save to Files / Photos / etc.).
      let savedViaLibrary = false;
      try {
        const perm = await MediaLibrary.requestPermissionsAsync(false, [
          "photo",
        ]);
        if (!perm.granted) {
          Alert.alert(
            "Permission needed",
            "Allow access to your photo library so the PNG can be saved.",
          );
          return;
        }
        const asset = await MediaLibrary.createAssetAsync(saveUri);
        const ALBUM = "Sathyam PriceTags";
        try {
          const album = await MediaLibrary.getAlbumAsync(ALBUM);
          if (album) {
            await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
          } else {
            await MediaLibrary.createAlbumAsync(ALBUM, asset, false);
          }
        } catch {
          // Album writes can fail on locked-down setups; the asset
          // is still in the library so don't surface this.
        }
        savedViaLibrary = true;
      } catch (libErr: any) {
        // Expo Go on Android 14+ throws here. Fall back to the share
        // sheet so the export still works.
        const canShare = await Sharing.isAvailableAsync().catch(() => false);
        if (!canShare) throw libErr;
        await Sharing.shareAsync(saveUri, {
          mimeType: "image/jpeg",
          dialogTitle: captured.filename,
          UTI: "public.jpeg",
        });
      }

      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
      Alert.alert(
        savedViaLibrary ? "Saved to Photos" : "Saved",
        savedViaLibrary
          ? `${captured.filename}\nAlbum: Sathyam PriceTags\n${(captured.bytes / 1024).toFixed(0)} KB`
          : `${captured.filename}\nUse the share sheet to save to Photos or Files.\n${(captured.bytes / 1024).toFixed(0)} KB`,
      );
      setPngExportItem(null);
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save PNG.");
    } finally {
      setPngBusy(null);
    }
  }

  async function savePngToDrive(): Promise<void> {
    if (!pngExportItem || pngBusy) return;
    if (!authToken) {
      Alert.alert("Sign in required", "Please sign in to upload to Drive.");
      return;
    }
    setPngBusy("drive");
    try {
      const captured = await capturePngForItem();
      if (!captured) return;

      const resp = await fetch(apiUrl("/api/drive/upload"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          filename: captured.filename,
          mimeType: "image/jpeg",
          dataBase64: captured.base64,
          folderName: "Sathyam PriceTags",
        }),
      });
      const text = await resp.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!resp.ok) {
        const msg =
          (body && typeof body.error === "string" && body.error) ||
          `Drive upload failed (${resp.status}).`;
        throw new Error(msg);
      }
      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
      const webViewLink: string | undefined =
        body && typeof body.webViewLink === "string"
          ? body.webViewLink
          : undefined;
      const buttons: any[] = [{ text: "Done", style: "cancel" }];
      if (webViewLink) {
        buttons.push({
          text: "Open in Drive",
          onPress: () => {
            Linking.openURL(webViewLink).catch(() => {});
          },
        });
      }
      Alert.alert(
        "Uploaded to Google Drive",
        `${captured.filename}\nSaved in “Sathyam PriceTags” · ${(captured.bytes / 1024).toFixed(0)} KB`,
        buttons,
      );
      setPngExportItem(null);
    } catch (e: any) {
      Alert.alert("Drive upload failed", e?.message ?? "Could not upload PNG.");
    } finally {
      setPngBusy(null);
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
            await clearPriceTagReviewItems();
            setWorkingItems([]);
            setMode("view");
            router.back();
          },
        },
      ]
    );
  }

  // -------- Empty state --------
  if (priceTagReviewItems.length === 0 && mode === "view") {
    return (
      <>
        <Stack.Screen options={{ title: "PriceTag Review" }} />
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
          title: "PriceTag Review",
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
          {/* When the toolbar wraps onto two rows we don't want a
              flex spacer eating the whole first row — push buttons
              with marginLeft:auto on the first one instead. */}
          {mode === "view" ? (
            <>
              <TouchableOpacity
                style={[styles.modifyBtn, { marginLeft: "auto" }]}
                onPress={sortByPromoSortCode}
                disabled={priceTagReviewItems.length < 2}
              >
                <Feather
                  name={preSortSnapshot ? "rotate-ccw" : "bar-chart-2"}
                  size={14}
                  color={Colors.text}
                />
                <Text style={styles.modifyBtnText}>
                  {preSortSnapshot ? "Undo Sort" : "Sort by Code"}
                </Text>
              </TouchableOpacity>
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
              {/* "Banner 2:1" / "Banner SQ" — only meaningful for
                  Style B/C/D/E. Style A has its own self-contained
                  card layout that does NOT have the banner header the
                  showcase layouts depend on, so we disable both buttons
                  while Style A is selected. */}
              <TouchableOpacity
                style={[
                  styles.exportBtn,
                  (priceTagReviewItems.length === 0 ||
                    priceTagReviewStyle === "A") && styles.exportBtnDisabled,
                ]}
                onPress={() => {
                  setImgPickerLayout("showcase");
                  setPngPickerOpen(true);
                }}
                disabled={
                  priceTagReviewItems.length === 0 ||
                  priceTagReviewStyle === "A"
                }
                accessibilityLabel={
                  priceTagReviewStyle === "A"
                    ? "Banner 2:1 is only available for Styles B–E"
                    : "Open a single tag in the 2:1 banner layout"
                }
              >
                <Feather name="star" size={14} color={Colors.textInverse} />
                <Text style={styles.exportBtnText}>Banner 2:1</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.exportBtn,
                  (priceTagReviewItems.length === 0 ||
                    priceTagReviewStyle === "A") && styles.exportBtnDisabled,
                ]}
                onPress={() => {
                  setImgPickerLayout("showcase-sq");
                  setPngPickerOpen(true);
                }}
                disabled={
                  priceTagReviewItems.length === 0 ||
                  priceTagReviewStyle === "A"
                }
                accessibilityLabel={
                  priceTagReviewStyle === "A"
                    ? "Banner SQ is only available for Styles B–E"
                    : "Open a single tag in the square (1:1) banner layout"
                }
              >
                <Feather name="square" size={14} color={Colors.textInverse} />
                <Text style={styles.exportBtnText}>Banner SQ</Text>
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
              priceTagReviewShowLogo && styles.logoToggleSwitchOn,
            ]}
            onPress={() => setPriceTagReviewShowLogo(!priceTagReviewShowLogo)}
            activeOpacity={0.85}
            accessibilityRole="switch"
            accessibilityState={{ checked: priceTagReviewShowLogo }}
            accessibilityLabel="Show Sathyam Super Store logo watermark on price tags"
          >
            <View
              style={[
                styles.logoToggleKnob,
                priceTagReviewShowLogo && styles.logoToggleKnobOn,
              ]}
            />
          </TouchableOpacity>
          <Text style={styles.logoToggleHint}>
            {priceTagReviewShowLogo ? "Logo on" : "Logo off"}
          </Text>
          {/* Independent second toggle — adds a big centered 30%-opacity
              watermark behind every Style A tag (preview + PDF). */}
          <Text style={[styles.logoToggleLabel, { marginLeft: 12 }]}>Watermark</Text>
          <TouchableOpacity
            style={[
              styles.logoToggleSwitch,
              priceTagReviewShowWatermark && styles.logoToggleSwitchOn,
            ]}
            onPress={() => setPriceTagReviewShowWatermark(!priceTagReviewShowWatermark)}
            activeOpacity={0.85}
            accessibilityRole="switch"
            accessibilityState={{ checked: priceTagReviewShowWatermark }}
            accessibilityLabel="Show centered watermark behind Style A price tags"
          >
            <View
              style={[
                styles.logoToggleKnob,
                priceTagReviewShowWatermark && styles.logoToggleKnobOn,
              ]}
            />
          </TouchableOpacity>
          <Text style={styles.logoToggleHint}>
            {priceTagReviewShowWatermark ? "30% bg" : "Off"}
          </Text>
        </View>

        {/* Square (1:1) layout variant — Detailed shows the full
            company-details footer; Minimal swaps it for a slim
            store-name + WhatsApp bar with stacked app-store badges.
            Only affects "Banner SQ" exports. */}
        <View style={styles.logoToggleBar}>
          <Text style={styles.logoToggleLabel}>Square Layout</Text>
          <View style={styles.sqVariantPill}>
            <TouchableOpacity
              style={[
                styles.sqVariantBtn,
                priceTagSquareVariant === "detailed" &&
                  styles.sqVariantBtnActive,
              ]}
              onPress={() => setPriceTagSquareVariant("detailed")}
              accessibilityRole="button"
              accessibilityLabel="Use detailed square layout with full company details"
            >
              <Text
                style={[
                  styles.sqVariantBtnText,
                  priceTagSquareVariant === "detailed" &&
                    styles.sqVariantBtnTextActive,
                ]}
              >
                Detailed
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.sqVariantBtn,
                priceTagSquareVariant === "minimal" &&
                  styles.sqVariantBtnActive,
              ]}
              onPress={() => setPriceTagSquareVariant("minimal")}
              accessibilityRole="button"
              accessibilityLabel="Use minimal square layout with store name and WhatsApp"
            >
              <Text
                style={[
                  styles.sqVariantBtnText,
                  priceTagSquareVariant === "minimal" &&
                    styles.sqVariantBtnTextActive,
                ]}
              >
                Minimal
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.logoToggleHint}>
            {priceTagSquareVariant === "minimal"
              ? "Store name + WhatsApp bar"
              : "Address, GST, FSSAI"}
          </Text>
        </View>

        {/* Optional PDF title bar — feeds the export filename and
            doubles as a quick-glance label of what this print run is
            for. Empty by default; persists across sessions. */}
        <View style={styles.titleBar}>
          <Text style={styles.titleBarLabel}>Title</Text>
          {priceTagReviewTitle ? (
            <Text style={styles.titleBarValue} numberOfLines={1}>
              {priceTagReviewTitle}
            </Text>
          ) : (
            <Text style={styles.titleBarHint}>No title set (optional)</Text>
          )}
          <TouchableOpacity
            style={[styles.modifyBtn, { marginLeft: "auto" }]}
            onPress={() => {
              setTitleDraft(priceTagReviewTitle);
              setShowTitleModal(true);
            }}
          >
            <Feather
              name={priceTagReviewTitle ? "edit-3" : "plus"}
              size={14}
              color={Colors.text}
            />
            <Text style={styles.modifyBtnText}>
              {priceTagReviewTitle ? "Modify Title" : "Add Title"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Style picker — chips scroll horizontally so the row stays
            compact as more styles are added; the Style label and the
            Remove-BG-all button are pinned outside the scroll view so
            they stay reachable with one tap regardless of scroll
            position. */}
        <View style={styles.styleBar}>
          <Text style={styles.styleBarLabel}>Style</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.styleChipsRow}
            style={styles.styleChipsScroll}
          >
            <StyleChip
              label="A · Special Offer"
              active={priceTagReviewStyle === "A"}
              onPress={() => setPriceTagReviewStyle("A")}
            />
            <StyleChip
              label="B · Low Prices"
              active={priceTagReviewStyle === "B"}
              onPress={() => setPriceTagReviewStyle("B")}
            />
            <StyleChip
              label="C · Buy 1 Get 1"
              active={priceTagReviewStyle === "C"}
              onPress={() => setPriceTagReviewStyle("C")}
            />
            <StyleChip
              label="D · RED Tag Sale"
              active={priceTagReviewStyle === "D"}
              onPress={() => setPriceTagReviewStyle("D")}
            />
            <StyleChip
              label="E · Custom Title"
              active={priceTagReviewStyle === "E"}
              onPress={() => setPriceTagReviewStyle("E")}
            />
          </ScrollView>
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
          {items.map((it, idx) => {
            const isBusy = busyKey === it.key || bgAllRunning;
            // PriceTag Review supports per-item style overrides: each
            // tag may carry its own `style` (set in Modify mode) and
            // we fall back to the screen-wide `priceTagReviewStyle`
            // when no override is set. Every prop derived from the
            // style below uses this effective value so per-item
            // overrides flow through to the on-screen render.
            const effStyle: PriceTagStyle = it.style ?? priceTagReviewStyle;
            const TagComponent =
              effStyle === "B" ||
              effStyle === "C" ||
              effStyle === "D" ||
              effStyle === "E"
                ? StyleBTag
                : StyleATag;
            const bannerLabel =
              effStyle === "C"
                ? "Buy 1 Get 1 Free"
                : effStyle === "D"
                  ? "RED Tag Sale"
                  : effStyle === "E"
                    ? it.customTitle?.trim() || "Edit Title"
                    : "LOW PRICES";
            return (
              <View key={it.key} style={styles.tagSlot}>
                {mode === "modify" && (
                  <>
                    <TouchableOpacity
                      style={styles.removeBtn}
                      onPress={() => removeFromWorking(it.key)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Feather name="x" size={14} color={Colors.textInverse} />
                    </TouchableOpacity>
                    {/* Manual reorder controls (up / down). Used in lieu
                        of a true drag-and-drop affordance so the grid
                        layout works reliably on both native and web
                        without pulling in another gesture library. */}
                    <View style={styles.reorderBar}>
                      <TouchableOpacity
                        style={[
                          styles.reorderBtn,
                          idx === 0 && styles.reorderBtnDisabled,
                        ]}
                        onPress={() => moveInWorking(it.key, -1)}
                        disabled={idx === 0}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Feather
                          name="chevron-up"
                          size={14}
                          color={
                            idx === 0 ? Colors.textMuted : Colors.textInverse
                          }
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.reorderBtn,
                          idx === items.length - 1 && styles.reorderBtnDisabled,
                        ]}
                        onPress={() => moveInWorking(it.key, 1)}
                        disabled={idx === items.length - 1}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Feather
                          name="chevron-down"
                          size={14}
                          color={
                            idx === items.length - 1
                              ? Colors.textMuted
                              : Colors.textInverse
                          }
                        />
                      </TouchableOpacity>
                    </View>
                  </>
                )}
                <TagComponent
                  item={it}
                  busy={isBusy}
                  showLogo={priceTagReviewShowLogo}
                  showWatermark={priceTagReviewShowWatermark}
                  onAddImage={() => handleAddImage(it.key)}
                  onRemoveImage={() => removeImage(it.key)}
                  onRemoveBackground={() => removeBackgroundFor(it.key)}
                  bannerLabel={bannerLabel}
                  showPriceRow={effStyle !== "D" && effStyle !== "E"}
                  showOffBadge={effStyle !== "D" && effStyle !== "C" && effStyle !== "E"}
                  showStyleAMrpRow={effStyle === "D" || effStyle === "E"}
                  showStyleAPriceRow={effStyle === "D" || effStyle === "E"}
                  showStyleASaveBadge={effStyle === "D" || effStyle === "E"}
                  validTillTopLeft={effStyle === "B" || effStyle === "C" || effStyle === "D" || effStyle === "E"}
                  onEditTitle={
                    mode === "modify" && effStyle === "E"
                      ? () => setTitlePickerKey(it.key)
                      : undefined
                  }
                />
                {mode === "modify" && (
                  // Per-item style chips. Tapping a chip writes the
                  // chosen style onto this single working item only,
                  // so the user can mix A/B/C/D within one list.
                  // Saved on Save tap together with the rest of the
                  // working state.
                  <View style={styles.perItemStyleRow}>
                    {(["A", "B", "C", "D", "E"] as PriceTagStyle[]).map((s) => {
                      const active = effStyle === s;
                      return (
                        <TouchableOpacity
                          key={s}
                          style={[
                            styles.perItemStyleChip,
                            active && styles.perItemStyleChipActive,
                          ]}
                          onPress={() => setItemStyle(it.key, s)}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                          accessibilityLabel={`Set style ${s} for this item`}
                        >
                          <Text
                            style={[
                              styles.perItemStyleChipText,
                              active && styles.perItemStyleChipTextActive,
                            ]}
                          >
                            {s}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
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

        {/* Style E per-item title picker — only opens in modify mode
            via the green pencil button overlaid on the banner. Writes
            `customTitle` onto the working item; the global Save flushes
            it through to AppContext + PDF export. */}
        <TitlePickerModal
          visible={titlePickerKey !== null}
          titles={titleList}
          currentTitle={
            titlePickerKey
              ? workingItems.find((i) => i.key === titlePickerKey)?.customTitle
              : undefined
          }
          onPick={(t) => {
            if (titlePickerKey) setItemCustomTitle(titlePickerKey, t);
            setTitlePickerKey(null);
          }}
          onClear={() => {
            if (titlePickerKey) setItemCustomTitle(titlePickerKey, undefined);
            setTitlePickerKey(null);
          }}
          onClose={() => setTitlePickerKey(null)}
        />

        {/* Title editor modal — opens via Add/Modify Title. Persists
            on Save to AppContext (AsyncStorage-backed) and feeds the
            PDF export filename. Cap matches the storage cap (256). */}
        <Modal
          visible={showTitleModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowTitleModal(false)}
        >
          <View style={styles.modalScrim}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {priceTagReviewTitle ? "Modify Title" : "Add Title"}
              </Text>
              <TextInput
                style={styles.titleInput}
                value={titleDraft}
                onChangeText={(t) => setTitleDraft(t.slice(0, 256))}
                placeholder="Title for this print run (optional)"
                placeholderTextColor={Colors.textMuted}
                maxLength={256}
                autoFocus
                multiline
              />
              <Text style={styles.titleCharCount}>
                {titleDraft.length} / 256
              </Text>
              <View style={styles.titleModalBtnRow}>
                <TouchableOpacity
                  style={styles.modifyBtn}
                  onPress={() => setShowTitleModal(false)}
                >
                  <Text style={styles.modifyBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={async () => {
                    try {
                      await setPriceTagReviewTitle(titleDraft.trim());
                      setShowTitleModal(false);
                      Haptics.notificationAsync(
                        Haptics.NotificationFeedbackType.Success,
                      );
                    } catch (e: any) {
                      Alert.alert(
                        "Couldn't save",
                        e?.message ?? "Storage error",
                      );
                    }
                  }}
                >
                  <Feather name="check" size={14} color={Colors.textInverse} />
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
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

        {/* PNG export — item picker.
            Step 1: pick which item from priceTagReviewItems to export.
            Step 2 (after pngExportItem is set): destination chooser. */}
        <Modal
          visible={pngPickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setPngPickerOpen(false)}
        >
          <View style={styles.modalScrim}>
            <View
              style={[styles.modalCard, { width: "92%", maxHeight: "80%" }]}
            >
              <View style={styles.pickerHeader}>
                <Text style={styles.modalTitle}>Pick a tag to export as PNG</Text>
                <TouchableOpacity
                  onPress={() => setPngPickerOpen(false)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="x" size={20} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>
              <Text style={styles.modalBody}>
                Each export is one PNG sized exactly 768×384 px (≤295 KB).
              </Text>
              {priceTagReviewItems.length === 0 ? (
                <Text style={styles.noResults}>
                  No items in this preview yet.
                </Text>
              ) : (
                <FlatList
                  data={priceTagReviewItems}
                  keyExtractor={(it) => it.key}
                  contentContainerStyle={{ paddingVertical: 4 }}
                  keyboardShouldPersistTaps="handled"
                  ItemSeparatorComponent={() => (
                    <View style={styles.pickerSep} />
                  )}
                  renderItem={({ item }) => {
                    const mrp = fmt0(item.mrp);
                    // Show the *effective* style — per-item override
                    // takes precedence over the review-wide selection.
                    const effStyle: PriceTagStyle =
                      item.style ?? priceTagReviewStyle;
                    const brand = (item.brand ?? "").trim();
                    return (
                      <TouchableOpacity
                        style={styles.pickerRow}
                        onPress={() => {
                          setPngPickerOpen(false);
                          // New flow (May 2026): instead of capturing
                          // a JPEG inline, navigate to the dedicated
                          // "PriceTag IMG" screen and show the chosen
                          // tag at full size. The screen looks the
                          // tag up by `key` from AppContext.
                          router.push({
                            pathname: "/pricetag-img",
                            params: {
                              itemKey: item.key,
                              layout: imgPickerLayout,
                            },
                          });
                        }}
                        activeOpacity={0.7}
                      >
                        <View style={styles.pickerThumb}>
                          {item.imageUri ? (
                            <Image
                              source={{ uri: item.imageUri }}
                              style={{ width: 32, height: 32, borderRadius: 4 }}
                              resizeMode="cover"
                            />
                          ) : (
                            <Feather name="tag" size={18} color={DEEP_RED} />
                          )}
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.pickerName} numberOfLines={2}>
                            {item.description || "(no description)"}
                          </Text>
                          <Text style={styles.pickerMeta} numberOfLines={1}>
                            {brand ? `${brand} · ` : ""}
                            {mrp ? `MRP ₹${mrp}` : "MRP —"}
                          </Text>
                        </View>
                        <View style={styles.pickerStyleChip}>
                          <Text style={styles.pickerStyleChipText}>
                            {effStyle}
                          </Text>
                        </View>
                        <Feather
                          name="chevron-right"
                          size={16}
                          color={Colors.textMuted}
                        />
                      </TouchableOpacity>
                    );
                  }}
                />
              )}
            </View>
          </View>
        </Modal>

        {/* PNG export — destination chooser. */}
        <Modal
          visible={pngExportItem !== null}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!pngBusy) setPngExportItem(null);
          }}
        >
          <View style={styles.sheetScrim}>
            <View style={styles.sheetCard}>
              <Text style={styles.sheetTitle}>
                Save “{pngExportItem?.description?.slice(0, 48) || "Tag"}”
              </Text>
              <TouchableOpacity
                style={styles.sheetRow}
                onPress={savePngToPhone}
                disabled={pngBusy !== null}
                activeOpacity={0.7}
              >
                {pngBusy === "phone" ? (
                  <ActivityIndicator color={Colors.primary} />
                ) : (
                  <Feather name="smartphone" size={20} color={Colors.text} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetRowText}>
                    {pngBusy === "phone" ? "Saving…" : "Save to Phone"}
                  </Text>
                  <Text style={styles.sheetRowSub}>
                    Adds the PNG to your photo library.
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sheetRow}
                onPress={savePngToDrive}
                disabled={pngBusy !== null}
                activeOpacity={0.7}
              >
                {pngBusy === "drive" ? (
                  <ActivityIndicator color={Colors.primary} />
                ) : (
                  <Feather name="cloud" size={20} color={Colors.text} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetRowText}>
                    {pngBusy === "drive"
                      ? "Uploading…"
                      : "Save to Google Drive"}
                  </Text>
                  <Text style={styles.sheetRowSub}>
                    Uploads to “Sathyam PriceTags” folder.
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sheetRow, styles.sheetCancelRow]}
                onPress={() => {
                  if (!pngBusy) setPngExportItem(null);
                }}
                disabled={pngBusy !== null}
                activeOpacity={0.7}
              >
                <Text style={styles.sheetCancelText}>
                  {pngBusy ? "Working…" : "Cancel"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Off-screen 768×384 capture canvas. We render the chosen
            tag here so react-native-view-shot can snapshot it at
            exactly the spec resolution without disturbing the
            on-screen grid. The container is positioned far off
            screen rather than `display:none` because hidden views
            don't paint and view-shot would capture an empty image. */}
        {pngExportItem ? (
          <View
            pointerEvents="none"
            style={styles.pngCaptureHost}
            collapsable={false}
          >
            <View
              ref={pngCaptureRef}
              collapsable={false}
              style={styles.pngCaptureCanvas}
            >
              {(() => {
                // Mirror the *exact* prop derivation used by the
                // on-screen grid (see effStyle/bannerLabel block
                // around line 1611). Keep this in lock-step with the
                // visible tile so the exported PNG matches what the
                // user sees.
                // Strip promotionToDate so the "Valid Till" overlay
                // (side rail on Style A, top-left line on Style B/C/D/E)
                // is omitted from the exported JPEG. The on-screen
                // grid still shows the date — only the capture is bare.
                const it = { ...pngExportItem, promotionToDate: undefined };
                const effStyle: PriceTagStyle =
                  it.style ?? priceTagReviewStyle;
                if (effStyle === "A") {
                  return (
                    <StyleATag
                      item={it}
                      busy={false}
                      showLogo={priceTagReviewShowLogo}
                      showWatermark={priceTagReviewShowWatermark}
                      onAddImage={() => {}}
                      onRemoveImage={() => {}}
                      onRemoveBackground={() => {}}
                      cardStyle={styles.pngStretchCard}
                    />
                  );
                }
                const bannerLabel =
                  effStyle === "C"
                    ? "Buy 1 Get 1 Free"
                    : effStyle === "D"
                      ? "RED Tag Sale"
                      : effStyle === "E"
                        ? it.customTitle?.trim() || "Edit Title"
                        : "LOW PRICES";
                return (
                  <StyleBTag
                    item={it}
                    busy={false}
                    showLogo={priceTagReviewShowLogo}
                    showWatermark={priceTagReviewShowWatermark}
                    onAddImage={() => {}}
                    onRemoveImage={() => {}}
                    onRemoveBackground={() => {}}
                    bannerLabel={bannerLabel}
                    showPriceRow={effStyle !== "D" && effStyle !== "E"}
                    showOffBadge={
                      effStyle !== "D" &&
                      effStyle !== "C" &&
                      effStyle !== "E"
                    }
                    showStyleAMrpRow={effStyle === "D" || effStyle === "E"}
                    showStyleAPriceRow={effStyle === "D" || effStyle === "E"}
                    showStyleASaveBadge={effStyle === "D" || effStyle === "E"}
                    validTillTopLeft={
                      effStyle === "B" ||
                      effStyle === "C" ||
                      effStyle === "D" ||
                      effStyle === "E"
                    }
                    cardStyle={styles.pngStretchCard}
                  />
                );
              })()}
            </View>
          </View>
        ) : null}
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

export function StyleATag({
  item, busy, showLogo, showWatermark, onAddImage, onRemoveImage, onRemoveBackground,
  cardStyle,
}: {
  item: PriceTagItem;
  busy: boolean;
  showLogo: boolean;
  showWatermark?: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
  onRemoveBackground: () => void;
  // Optional outer-card style override. Used by the off-screen PNG
  // exporter to stretch the tag to fill the 2:1 capture frame.
  cardStyle?: StyleProp<ViewStyle>;
}) {
  const { tagColors } = useApp();
  const a = React.useMemo(() => makeAStyles(tagColors), [tagColors]);
  const { label, value } = priceFor(item);
  const mrp = fmt0(item.mrp);
  const off = offAmount(item);
  const minQty = minPurchaseQty(item);

  return (
    <View style={[a.card, cardStyle]}>
      {/* Centered background watermark — drawn first so it sits
          behind all other content. 30% opacity. */}
      {showWatermark && (
        <View pointerEvents="none" style={watermarkStyles.layerACenter}>
          <Image
            source={{ uri: LOGO_BASE64 }}
            style={watermarkStyles.imageABg}
            resizeMode="contain"
          />
        </View>
      )}
      {/* Show-Logo badge — moved from the top-right corner to the
          gap between the description row and the MRP row, slightly
          left of center. Size bumped 50% (28 → 42). */}
      {showLogo && (
        <View pointerEvents="none" style={watermarkStyles.layerA}>
          <Image
            source={{ uri: LOGO_BASE64 }}
            style={watermarkStyles.imageA}
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

      {/* Minimum purchase qty disclaimer — only when EligibleQty > 1.
          Sits flush to the left edge directly under the description. */}
      {minQty ? (
        <Text style={a.minQty}>* Minimum Purchase Qty: {minQty}</Text>
      ) : null}

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
            <Text style={a.priceVal}>{value}{minQty ? "*" : ""}</Text>
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

      {/* Valid Till — placed above the dotted Item-No footer with
          no rotation, per design. */}
      {item.promotionToDate ? (
        <Text style={validTillStyles.inlineA}>
          Valid Till: {formatValidTill(item.promotionToDate)}
        </Text>
      ) : null}

      <Text style={a.itemNoFooter}>
        Item No: {item.itemNo || "—"}
        {item.eligibleQty !== undefined && item.eligibleQty !== "" ? `   ·   Elig Qty: ${fmt0(item.eligibleQty)}` : ""}
        {item.promoSortCode ? `   ·   Sort: ${item.promoSortCode}` : ""}
      </Text>
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

export function StyleBTag({
  item, busy, showLogo, showWatermark = false, onAddImage, onRemoveImage, onRemoveBackground,
  bannerLabel = "LOW PRICES",
  onEditTitle,
  showPriceRow = true,
  showOffBadge = true,
  showStyleAMrpRow = false,
  showStyleAPriceRow = false,
  showStyleASaveBadge = false,
  validTillTopLeft = false,
  cardStyle,
}: {
  item: PriceTagItem;
  busy: boolean;
  showLogo: boolean;
  showWatermark?: boolean;
  onAddImage: () => void;
  onRemoveImage: () => void;
  onRemoveBackground: () => void;
  bannerLabel?: string;
  // Style E only — when set, renders a small green pencil button
  // overlaying the right side of the top banner so the user can
  // pick a title from the TitleList catalogue. Undefined means
  // "no editor" (view mode, or non-E styles).
  onEditTitle?: () => void;
  // Style D drops the big ₹ price row and the ₹XX OFF / OFFER PRICE
  // badge entirely. Defaulting both to true keeps B and C unchanged.
  showPriceRow?: boolean;
  showOffBadge?: boolean;
  // Style D borrows Style A's compact MRP row (DEEP_RED) and the
  // GOLD price row with the two-line OFFER / PRICE label. Default
  // off so B and C are unaffected.
  showStyleAMrpRow?: boolean;
  showStyleAPriceRow?: boolean;
  // Style D's "SAVE ₹XX" call-out: re-uses Style A's filled
  // DEEP_RED rectangle pill (a.footerRow + a.offText). Off when
  // false so B/C aren't affected.
  showStyleASaveBadge?: boolean;
  // Styles C/D render Valid Till as a horizontal gray line under the
  // top banner instead of the rotated left-edge rail used by Style B.
  validTillTopLeft?: boolean;
  // Optional outer-card style override. Used by the off-screen PNG
  // exporter to stretch the tag to fill the 2:1 capture frame.
  cardStyle?: StyleProp<ViewStyle>;
}) {
  const { tagColors } = useApp();
  const a = React.useMemo(() => makeAStyles(tagColors), [tagColors]);
  const b = React.useMemo(() => makeBStyles(tagColors), [tagColors]);
  const { label, value } = priceFor(item);
  const mrp = fmt0(item.mrp);
  const off = offAmount(item);
  const minQtyB = minPurchaseQty(item);
  const labelParts = label.toUpperCase().split(" ");

  return (
    <View style={[b.card, cardStyle]}>
      {/* Centered background watermark — same big faded logo as
          Style A's Watermark toggle, rendered behind the tag content. */}
      {showWatermark && (
        <View pointerEvents="none" style={watermarkStyles.layerACenter}>
          <Image
            source={{ uri: LOGO_BASE64 }}
            style={watermarkStyles.imageABg}
            resizeMode="contain"
          />
        </View>
      )}
      {/* Top-right corner logo — sized 50×50, offset 30px from the
          top-right so it sits comfortably inside the red top banner
          area without dominating the tag. */}
      {showLogo && (
        <View pointerEvents="none" style={watermarkStyles.layerB}>
          <Image
            source={{ uri: LOGO_BASE64 }}
            style={watermarkStyles.imageB}
            resizeMode="contain"
          />
        </View>
      )}
      <View style={b.topBanner}>
        <Text style={b.bannerText} numberOfLines={1}>{bannerLabel}</Text>
        {onEditTitle && (
          <TouchableOpacity
            style={b.bannerEditBtn}
            onPress={onEditTitle}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Pick title from TitleList"
          >
            <Feather name="edit-2" size={12} color={Colors.textInverse} />
          </TouchableOpacity>
        )}
      </View>

      {validTillTopLeft && item.promotionToDate ? (
        <Text style={b.validTillTopLeft}>
          Valid Till: {formatValidTill(item.promotionToDate)}
        </Text>
      ) : null}

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
        <View
          style={[
            b.priceCol,
            // Style D — left-align the price column so MRP, GOLD
            // promotion price and the SAVE pill share a clean left
            // edge instead of the default right edge used by B/C.
            showStyleASaveBadge && { alignItems: "flex-start" },
          ]}
        >
          {showStyleAMrpRow && mrp ? (
            // a.mrpRow already has alignSelf:flex-start, which is what
            // we want for Style D's left-aligned column.
            <View style={a.mrpRow}>
              <Text style={a.rupeeSm}>₹</Text>
              <Text style={a.mrpVal}>{mrp}</Text>
              <Text style={a.mrpLabel}>MRP</Text>
            </View>
          ) : null}
          {showStyleAPriceRow ? (
            <View style={a.priceRow}>
              <Text style={a.rupeeBig}>₹</Text>
              <Text style={a.priceVal}>{value}{minQtyB ? "*" : ""}</Text>
              <View style={a.priceLabelCol}>
                <Text style={a.priceLabel}>{labelParts[0] || ""}</Text>
                <Text style={a.priceLabel}>{labelParts[1] || ""}</Text>
              </View>
            </View>
          ) : null}
          {showPriceRow ? (
            <View style={b.priceRow}>
              <Text style={b.rupee}>₹</Text>
              <Text style={b.priceVal}>{value}{minQtyB ? "*" : ""}</Text>
            </View>
          ) : null}
          {showOffBadge ? (
            off ? (
              <Text style={b.offText}>₹{off} OFF</Text>
            ) : (
              <Text style={b.offTextMuted}>OFFER PRICE</Text>
            )
          ) : null}
          {showStyleASaveBadge && off ? (
            // Style D SAVE badge — same filled DEEP_RED pill as Style
            // A's footer (a.offText). The wrapper view shrinks to its
            // content, so within Style B's right-aligned price column
            // it visually aligns under the price.
            <View style={b.saveBadgeRow}>
              <Text style={a.offText}>SAVE ₹{off}</Text>
            </View>
          ) : null}
          {minQtyB ? (
            <Text style={b.minQty}>* Minimum Purchase Qty: {minQtyB}</Text>
          ) : null}
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

      <Text style={b.itemNoFooter}>
        Item No: {item.itemNo || "—"}
        {item.eligibleQty !== undefined && item.eligibleQty !== "" ? `   ·   Elig Qty: ${fmt0(item.eligibleQty)}` : ""}
        {item.promoSortCode ? `   ·   Sort: ${item.promoSortCode}` : ""}
      </Text>

      {/* Valid Till — vertical rail on the left edge (Style B only).
          Styles C/D render the date as a horizontal line under the
          banner instead, so we suppress the rail here. */}
      {!validTillTopLeft && item.promotionToDate ? (
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

// Renders a single tag's HTML using the requested style. Factored out
// so the PriceTag Review export can dispatch per-item — each item may
// carry its own `style` override — instead of forcing one style across
// the whole document.
function renderTagHtmlForStyle(
  it: PriceTagItem,
  style: PriceTagStyle,
  showLogo: boolean,
  showWatermark: boolean = false,
): string {
  if (style === "B") {
    return renderTagBHtml(
      it,
      showLogo,
      "LOW PRICES",
      true,  // showPriceRow
      true,  // showOffBadge
      false, // showStyleAMrpRow
      false, // showStyleAPriceRow
      true,  // validTillTopLeft — match Style C orientation
      false, // showStyleASaveBadge
      showWatermark,
    );
  }
  if (style === "C") {
    return renderTagBHtml(
      it,
      showLogo,
      "Buy 1 Get 1 Free",
      true,  // showPriceRow
      false, // showOffBadge
      false, // showStyleAMrpRow
      false, // showStyleAPriceRow
      true,  // validTillTopLeft
      false, // showStyleASaveBadge
      showWatermark,
    );
  }
  if (style === "D") {
    return renderTagBHtml(
      it,
      showLogo,
      "RED Tag Sale",
      false, // showPriceRow (Style B price)
      false, // showOffBadge
      true,  // showStyleAMrpRow
      true,  // showStyleAPriceRow
      true,  // validTillTopLeft
      true,  // showStyleASaveBadge
      showWatermark,
    );
  }
  if (style === "E") {
    return renderTagBHtml(
      it,
      showLogo,
      it.customTitle?.trim() || "Edit Title",
      false, // showPriceRow
      false, // showOffBadge
      true,  // showStyleAMrpRow
      true,  // showStyleAPriceRow
      true,  // validTillTopLeft
      true,  // showStyleASaveBadge
      showWatermark,
    );
  }
  return renderTagAHtml(it, showLogo, showWatermark);
}

function buildPdfHtml(
  items: PriceTagItem[],
  style: PriceTagStyle,
  showLogo: boolean,
  colors: TagColors = DEFAULT_TAG_COLORS,
  showWatermark: boolean = false,
): string {
  // Per-item style support (PriceTag Review): each item can carry its
  // own `style` override. Items without an override fall back to the
  // screen-wide `style` parameter.
  const effStyleFor = (it: PriceTagItem): PriceTagStyle => it.style ?? style;
  const tagsHtml = items
    .map((it) => renderTagHtmlForStyle(it, effStyleFor(it), showLogo, showWatermark))
    .join("");

  // CSS bundling — work out which stylesheets the document actually
  // needs from the styles in use. Style A needs PDF_CSS_A; styles B/C
  // need PDF_CSS_B; style D needs both (it reuses Style B's chrome but
  // borrows Style A's MRP + GOLD price classes). The .tagA / .tagB
  // selectors are scoped, so concatenating both is safe.
  const stylesInUse = new Set<PriceTagStyle>(items.map(effStyleFor));
  if (items.length === 0) stylesInUse.add(style);
  const needsA =
    stylesInUse.has("A") || stylesInUse.has("D") || stylesInUse.has("E");
  const needsB =
    stylesInUse.has("B") ||
    stylesInUse.has("C") ||
    stylesInUse.has("D") ||
    stylesInUse.has("E");
  const cssA = buildPdfCssA(colors);
  const cssB = buildPdfCssB(colors);
  const styleCss =
    needsA && needsB ? `${cssA}\n${cssB}` : needsB ? cssB : cssA;

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

function renderTagAHtml(it: PriceTagItem, showLogo: boolean, showWatermark: boolean = false): string {
  const { label, value } = priceFor(it);
  const mrp = fmt0(it.mrp);
  const off = offAmount(it);
  const minQtyA = minPurchaseQty(it);
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri ? `<img src="${it.imageUri}" />` : "";

  // Split the price label across two lines (e.g. "OFFER" / "PRICE")
  // so the PDF matches the two-line on-screen layout.
  const labelParts = label.toUpperCase().split(" ");
  const labelLine1 = escapeHtml(labelParts[0] || "");
  const labelLine2 = escapeHtml(labelParts[1] || "");

  const watermark = showLogo
    ? `<img class="watermark" src="${LOGO_BASE64}" alt="" />`
    : "";
  const watermarkBg = showWatermark
    ? `<img class="watermarkBg" src="${LOGO_BASE64}" alt="" />`
    : "";

  const validTill = it.promotionToDate
    ? `<div class="validTillA">Valid Till: ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}</div>`
    : "";

  return `
    <div class="tagA">
      ${watermarkBg}
      ${watermark}
      <div class="descA">${descSpan}</div>
      ${minQtyA ? `<div class="minQtyA">* Minimum Purchase Qty: ${escapeHtml(minQtyA)}</div>` : ""}
      <div class="bodyRowA">
        <div class="bodyLeftA">
          ${mrp ? `
            <div class="mrpRowA">
              <span class="rupeeSm">₹</span><span class="mrpValA">${escapeHtml(mrp)}</span>
              <span class="mrpLabelA">MRP</span>
            </div>` : ""}
          <div class="priceRowA">
            <span class="rupeeBigA">₹</span><span class="priceValA">${escapeHtml(value)}${minQtyA ? "*" : ""}</span>
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
      ${validTill}
      <div class="itemFooterA">Item No: ${escapeHtml(it.itemNo || "—")}${it.eligibleQty !== undefined && it.eligibleQty !== "" ? `   ·   Elig Qty: ${escapeHtml(fmt0(it.eligibleQty))}` : ""}${it.promoSortCode ? `   ·   Sort: ${escapeHtml(it.promoSortCode)}` : ""}</div>
    </div>
  `;
}

// Printer-friendly: white background, no large solid color fills
// (the maroon image panel and red savings pill are the only colored
// fills, and the savings pill is small enough to keep ink usage low).
function buildPdfCssA(c: TagColors = DEFAULT_TAG_COLORS): string {
  const { red: RED, deepRed: DEEP_RED, cream: CREAM, gold: GOLD } = c;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void RED;
  return `
  .tagA {
    position: relative;
    background: ${CREAM};
    border: 1.5px solid ${DEEP_RED};
    border-radius: 8px;
    padding: 10px;
    page-break-inside: avoid;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  /* Sathyam-Super-Store logo — tucked into the gap between the
     description row and the MRP row, slightly right of center. */
  .tagA .watermark {
    position: absolute;
    top: 23%; left: 33.5%;
    width: 12.5%; height: auto;
    opacity: 0.45;
    pointer-events: none;
    z-index: 2;
  }
  /* Independent centered background watermark (Watermark toggle).
     Sits behind everything at 30% opacity. */
  .tagA .watermarkBg {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 38%; height: auto;
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagA > *:not(.watermark):not(.watermarkBg) { position: relative; z-index: 1; }
  /* "Valid Till" — inline, sits just above the dotted Item-No
     footer with no rotation. */
  .tagA .validTillA {
    font-size: 8px; color: #94795E; font-weight: 600;
    letter-spacing: 0.3px;
    margin-top: 4px;
  }
  .descA {
    font-size: 13px; font-weight: 800; color: ${DEEP_RED};
    line-height: 1.25; margin-bottom: 8px;
  }
  .minQtyA {
    font-size: 10px; font-weight: 700; color: ${DEEP_RED};
    margin: -4px 0 6px 0; text-align: left;
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
}

// ----- Style B HTML / CSS -----

function renderTagBHtml(
  it: PriceTagItem,
  showLogo: boolean,
  bannerLabel: string = "LOW PRICES",
  // Style D drops the big ₹ price row and the ₹XX OFF / OFFER PRICE
  // badge. Defaults keep B and C output unchanged.
  showPriceRow: boolean = true,
  showOffBadge: boolean = true,
  // Style D borrows Style A's MRP row + GOLD price row.
  showStyleAMrpRow: boolean = false,
  showStyleAPriceRow: boolean = false,
  // Styles C/D show Valid Till as a horizontal gray line below the
  // top banner instead of the rotated left-edge rail.
  // (showStyleASaveBadge param appended after validTillTopLeft below)
  validTillTopLeft: boolean = false,
  // Style D "SAVE ₹XX" pill — re-uses Style A's filled DEEP_RED
  // .offA badge. Off by default so B/C output is unchanged.
  showStyleASaveBadge: boolean = false,
  // Watermark toggle — adds a large centered low-opacity logo
  // behind the tag content (independent of the corner `showLogo`).
  showWatermark: boolean = false,
): string {
  const { label, value } = priceFor(it);
  const mrp = fmt0(it.mrp);
  const off = offAmount(it);
  const minQtyB = minPurchaseQty(it);
  const labelParts = label.toUpperCase().split(" ");
  const labelLine1 = escapeHtml(labelParts[0] || "");
  const labelLine2 = escapeHtml(labelParts[1] || "");
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri ? `<img src="${it.imageUri}" />` : "";

  const watermark = showLogo
    ? `<img class="watermark" src="${LOGO_BASE64}" alt="" />`
    : "";
  const watermarkBg = showWatermark
    ? `<img class="watermarkBg" src="${LOGO_BASE64}" alt="" />`
    : "";

  const validTillText = it.promotionToDate
    ? `Valid Till: ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}`
    : "";
  const validTillRail =
    !validTillTopLeft && validTillText
      ? `<div class="validTillB"><span>${validTillText}</span></div>`
      : "";
  const validTillTop =
    validTillTopLeft && validTillText
      ? `<div class="validTillTopB">${validTillText}</div>`
      : "";

  return `
    <div class="tagB">
      ${watermarkBg}
      ${watermark}
      ${validTillRail}
      <div class="topBannerB">${escapeHtml(bannerLabel)}</div>
      ${validTillTop}
      <div class="middleB">
        <div class="imgWrapB">${img}</div>
        <div class="priceColB${showStyleASaveBadge ? " leftAlign" : ""}">
          ${showStyleAMrpRow && mrp ? `
          <div class="mrpRowA">
            <span class="rupeeSm">₹</span><span class="mrpValA">${escapeHtml(mrp)}</span>
            <span class="mrpLabelA">MRP</span>
          </div>` : ""}
          ${showStyleAPriceRow ? `
          <div class="priceRowA">
            <span class="rupeeBigA">₹</span><span class="priceValA">${escapeHtml(value)}${minQtyB ? "*" : ""}</span>
            <span class="priceLabelColA">
              <span class="priceLabelA">${labelLine1}</span>
              <span class="priceLabelA">${labelLine2}</span>
            </span>
          </div>` : ""}
          ${showPriceRow ? `
          <div class="priceRowB">
            <span class="rupeeB">₹</span><span class="priceValB">${escapeHtml(value)}${minQtyB ? "*" : ""}</span>
          </div>` : ""}
          ${showOffBadge ? (off ? `<div class="offB">₹${escapeHtml(off)} OFF</div>` : `<div class="offBmuted">OFFER PRICE</div>`) : ""}
          ${showStyleASaveBadge && off ? `<div class="saveBadgeRowB"><span class="offA">SAVE ₹${escapeHtml(off)}</span></div>` : ""}
          ${minQtyB ? `<div class="minQtyB">* Minimum Purchase Qty: ${escapeHtml(minQtyB)}</div>` : ""}
        </div>
      </div>
      <div class="bottomBannerB">${descSpan}</div>
      <div class="itemFooterB">Item No: ${escapeHtml(it.itemNo || "—")}${it.eligibleQty !== undefined && it.eligibleQty !== "" ? `   ·   Elig Qty: ${escapeHtml(fmt0(it.eligibleQty))}` : ""}${it.promoSortCode ? `   ·   Sort: ${escapeHtml(it.promoSortCode)}` : ""}</div>
    </div>
  `;
}

function buildPdfCssB(c: TagColors = DEFAULT_TAG_COLORS): string {
  const { red: RED, deepRed: DEEP_RED, cream: CREAM, gold: GOLD } = c;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void DEEP_RED; void CREAM; void GOLD;
  void RED;
  return `
  .tagB {
    position: relative;
    background: #FFF;
    border: 1.5px solid ${RED};
    border-radius: 6px;
    overflow: hidden;
    page-break-inside: avoid;
    display: flex; flex-direction: column;
  }
  /* Logo for Styles B/C/D — top-right corner, offset down so it
     sits just under the red top banner without overlapping it. */
  .tagB .watermark {
    position: absolute;
    top: 45px; right: 20px;
    width: 50px; height: 50px;
    opacity: 1.0;
    pointer-events: none;
    z-index: 2;
  }
  .tagB .watermarkBg {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 25%; height: auto;
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagB > *:not(.watermark):not(.watermarkBg) { position: relative; z-index: 1; }
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
  /* Horizontal Valid Till line for Styles C/D — pinned to the top-left
     edge directly under the red top banner, no rotation, gray. */
  .tagB .validTillTopB {
    align-self: flex-start;
    padding: 2px 6px;
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
  /* Style D — when the Style A MRP/Price rows are reused inside the
     right-aligned Style B price column, force them to right-align so
     the MRP row, GOLD price row and SAVE pill share a clean right
     edge. (.mrpRowA is inline-flex, so text-align:right on .priceColB
     handles it; .priceRowA is block-level flex, so it needs its own
     justify-content override here.) */
  .priceColB .priceRowA { justify-content: flex-end; }
  /* Style D override — flip the price column to left alignment so
     MRP / GOLD price / SAVE pill share a clean left edge instead. */
  .priceColB.leftAlign { text-align: left; }
  .priceColB.leftAlign .priceRowA { justify-content: flex-start; }
  .priceColB.leftAlign .saveBadgeRowB { text-align: left; }
  /* Style D SAVE pill wrapper — sits in the right-aligned priceColB,
     so the inline-block .offA pill naturally aligns to the right
     under the GOLD price. Margin matches the on-screen 6px gap. */
  .saveBadgeRowB { margin-top: 6px; text-align: right; }
  .priceRowB { display: flex; justify-content: flex-end; align-items: baseline; gap: 2px; }
  .rupeeB { font-size: 22px; color: #000; font-weight: 800; }
  .priceValB { font-size: 48px; color: #000; font-weight: 900; line-height: 1; }
  .offB {
    color: ${RED}; font-size: 16px; font-weight: 800;
    margin-top: 4px; letter-spacing: 0.5px;
  }
  .minQtyB {
    font-size: 10px; font-weight: 700; color: #B00020;
    text-align: right; margin-top: 4px;
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
}

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
    flexWrap: "wrap",
    paddingHorizontal: 12, paddingVertical: 10,
    rowGap: 8, columnGap: 8,
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
  exportBtnDisabled: { opacity: 0.4 },
  exportBtnText: { color: Colors.textInverse, fontWeight: "800", fontSize: 13 },
  // Off-screen high-res capture host. 2:1 frame (1900×950) matches
  // the user-requested wide aspect for the saved JPEG. The inner
  // canvas is a flex column so the tag (passed cardStyle={{flex:1}})
  // stretches edge-to-edge — no whitespace bands above/below.
  // Positioned far above the viewport so the layout actually paints
  // (view-shot needs a real layout) without being visible.
  pngCaptureHost: {
    position: "absolute",
    top: -100000, left: 0,
    width: 1900, height: 950,
    opacity: 0,
  },
  pngCaptureCanvas: {
    width: 1900, height: 950,
    backgroundColor: "#FFFFFF",
    padding: 16,
  },
  // Spread on the outer card View of StyleATag/StyleBTag during the
  // off-screen capture so the tag fills the 2:1 frame edge-to-edge.
  pngStretchCard: {
    flex: 1,
    width: "100%",
    height: "100%",
  },
  // Small "A/B/C/D/E" chip on the picker row so the user can see at
  // a glance which style each item will be exported in.
  pickerStyleChip: {
    minWidth: 24, paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 10, backgroundColor: "#F2E9D8",
    borderWidth: 1, borderColor: "#D4B97A",
    alignItems: "center", justifyContent: "center",
  },
  pickerStyleChipText: {
    color: "#7A4F00", fontSize: 11, fontWeight: "800",
  },
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
  sqVariantPill: {
    flexDirection: "row",
    backgroundColor: Colors.border,
    borderRadius: 14,
    padding: 2,
  },
  sqVariantBtn: {
    paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 12,
  },
  sqVariantBtnActive: { backgroundColor: Colors.primary },
  sqVariantBtnText: {
    fontSize: 12, fontWeight: "800",
    color: Colors.textSecondary, letterSpacing: 0.4,
  },
  sqVariantBtnTextActive: { color: Colors.textInverse },
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
  styleChipsScroll: {
    flex: 1,
  },
  styleChipsRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingRight: 8,
  },
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
  // Per-item style chip strip rendered under each tag in Modify mode.
  // Compact A/B/C/D chips so all four fit comfortably under the
  // narrow 48.5%-wide tag tile.
  perItemStyleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 2,
  },
  perItemStyleChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  perItemStyleChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  perItemStyleChipText: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
  },
  perItemStyleChipTextActive: { color: Colors.textInverse },
  removeBtn: {
    position: "absolute", top: -8, right: -8, zIndex: 5,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.danger,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 }, elevation: 3,
  },
  reorderBar: {
    position: "absolute", top: -8, left: -8, zIndex: 5,
    flexDirection: "row", gap: 4,
  },
  reorderBtn: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 }, elevation: 3,
  },
  reorderBtnDisabled: {
    backgroundColor: Colors.border,
  },
  titleBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  titleBarLabel: {
    fontSize: 12, fontWeight: "700",
    color: Colors.textSecondary, letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  titleBarValue: {
    flex: 1, fontSize: 13, fontWeight: "700",
    color: Colors.text,
  },
  titleBarHint: {
    flex: 1, fontSize: 12, color: Colors.textMuted, fontStyle: "italic",
  },
  titleInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    fontSize: 14, color: Colors.text, backgroundColor: Colors.background,
    marginTop: 8, marginBottom: 6,
  },
  titleCharCount: {
    fontSize: 11, color: Colors.textMuted, textAlign: "right",
    marginBottom: 12,
  },
  titleModalBtnRow: {
    flexDirection: "row", justifyContent: "flex-end", gap: 8,
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

// Style A — on-screen tag styles. Factory so the StyleATag component
// can re-derive the StyleSheet whenever the user's tag palette
// changes (TagColours tab). Default = DEFAULT_TAG_COLORS so any
// non-component caller still gets the original look.
function makeAStyles(c: TagColors = DEFAULT_TAG_COLORS) {
  const { red: _RED, deepRed: DEEP_RED, cream: CREAM, gold: GOLD } = c;
  void _RED;
  return StyleSheet.create({
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
  minQty: {
    fontSize: 9, fontWeight: "700", color: DEEP_RED,
    marginTop: -2, marginBottom: 4, textAlign: "left",
  },
  });
}
const a = makeAStyles();

// Style B — on-screen tag styles. Factory; see makeAStyles note.
function makeBStyles(c: TagColors = DEFAULT_TAG_COLORS) {
  const { red: RED, deepRed: _DEEP_RED, cream: _CREAM, gold: _GOLD } = c;
  void _DEEP_RED; void _CREAM; void _GOLD;
  return StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderWidth: 1.5, borderColor: RED,
    borderRadius: 6, overflow: "hidden",
    minHeight: 230,
  },
  topBanner: {
    backgroundColor: RED, paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center", justifyContent: "center",
    // Symmetric horizontal padding keeps the title+edit-button pair
    // optically centered. The green edit button now sits inline next
    // to the title (centered as a group) instead of pinned to the
    // right edge, so it can never collide with the red ✕ remove
    // button at the slot's top-right corner.
    paddingHorizontal: 28,
    gap: 8,
  },
  bannerEditBtn: {
    // Inline next to the centered title text — visually anchored to
    // the middle of the banner, far from the red ✕ remove button at
    // the slot's top-right corner.
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "#16A34A",
    borderWidth: 1, borderColor: "#FFFFFF",
    alignItems: "center", justifyContent: "center",
  },
  bannerText: {
    color: "#FFF", fontSize: 16, fontWeight: "900",
    letterSpacing: 1,
    flexShrink: 1,
    textAlign: "center",
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
  minQty: {
    color: RED, fontSize: 9, fontWeight: "700",
    marginTop: 3, textAlign: "right",
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
  // Horizontal Valid Till line for Styles C/D — sits flush against
  // the top-left edge directly below the red top banner.
  validTillTopLeft: {
    alignSelf: "flex-start",
    fontSize: 9, color: Colors.textMuted, fontWeight: "600",
    letterSpacing: 0.3,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  // Wrapper for the Style D "SAVE ₹XX" pill so it sits with a small
  // gap below the GOLD price row. Empty row that just provides the
  // top margin; the pill itself is rendered with Style A's a.offText.
  saveBadgeRow: { marginTop: 6 },
  });
}
const b = makeBStyles();

// "Valid Till" vertical rail. A narrow, full-height column pinned to
// the right edge of each tag card; the inner Text is rotated 90deg
// so the date reads top-to-bottom. Font sizes mirror each style's
// `itemNoFooter` so the new label matches the existing footer
// typography.
const validTillStyles = StyleSheet.create({
  // Style A: inline label placed just above the dotted Item-No
  // footer. No rotation per latest design.
  inlineA: {
    fontSize: 8, color: "#94795E", fontWeight: "600",
    letterSpacing: 0.3,
    marginTop: 4,
    textAlign: "left",
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

// Logo watermark layer. Absolutely-positioned, pinned to the
// top-right of each tag card so it sits just under the red banner
// without colliding with the price digits or the product image.
// Two variants:
//   - layerA: Style A has no top banner, so the logo tucks into the
//     top-right corner with a tiny inset.
//   - layerB: Styles B/C/D have a red banner across the top, so the
//     logo is offset down to clear it.
// Width was reduced to 6% (~25% of the previous 24%) per design.
const watermarkStyles = StyleSheet.create({
  // Style A — moved out of the top-right corner into the gap between
  // the description row and the MRP row, slightly left of center.
  layerA: {
    position: "absolute",
    top: 30, left: 134,
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  // Centered full-card overlay for the new Watermark toggle.
  layerACenter: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  layerB: {
    position: "absolute",
    top: 45, right: 20,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  image: {
    width: 28,
    height: 28,
    opacity: 0.45,
  },
  // Style A badge — sized 50×50 and tucked into the gap between
  // the description row and the MRP row, slightly right of center.
  imageA: {
    width: 50,
    height: 50,
    opacity: 0.45,
  },
  // Style B/C/D/E corner badge — sized 50×50 at top:45/right:20.
  imageB: {
    width: 50,
    height: 50,
    opacity: 1.0,
  },
  // Centered watermark — ~25% of card width (card ≈ 380px) + faded.
  imageABg: {
    width: 95,
    height: 95,
    opacity: 0.30,
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
