import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  TouchableOpacity,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";

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

// Map a local file:// (or content://) URI to a self-contained data:
// URI. The server-side renderer can't fetch device-local URIs and
// rejects non-http(s) protocols on purpose, so we have to inline
// the bytes ourselves. http(s) and data: inputs pass through.
async function toServerImageUri(
  uri: string | undefined | null,
): Promise<string | undefined> {
  if (!uri) return undefined;
  if (uri.startsWith("data:")) return uri;
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: "base64" as any,
    });
    // Pick a sensible mime type from the file extension. Chromium
    // is forgiving about jpeg vs png but a wrong type can break
    // some encoders, so we default to jpeg (most common from
    // expo-image-picker) and only override on a clear .png/.webp.
    const lower = uri.toLowerCase();
    const mime = lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    return `data:${mime};base64,${base64}`;
  } catch {
    // If we can't read it, omit the image rather than failing the
    // whole render — the tag still looks fine without a photo.
    return undefined;
  }
}

import { Colors } from "@/constants/colors";
import {
  useApp,
  type PriceTagItem,
  type PriceTagStyle,
} from "@/context/AppContext";
import { StyleATag, StyleBTag } from "./pricetag-review";

// ============================================================
// Helpers
// ============================================================

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

function offAmount(item: PriceTagItem): string | null {
  const mrp = toNum(item.mrp);
  const promo = toNum(item.promotionPrice);
  if (!Number.isFinite(mrp) || !Number.isFinite(promo)) return null;
  if (mrp <= promo) return null;
  return String(Math.round(mrp - promo));
}

// Filename for the exported JPEG. Mirrors the contract used by the
// review-screen export: `Description_MRP_Promo.jpg` with filesystem-
// unsafe characters squashed to underscores.
function exportFilename(
  item: PriceTagItem,
  opts?: { square?: boolean },
): string {
  const clean = (raw: string) =>
    raw
      .replace(/[\/\\:*?"<>|\r\n\t\u0000-\u001F]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "_";
  const desc = clean((item.description ?? "PriceTag").trim() || "PriceTag");
  const mrp = item.mrp !== "" && item.mrp !== undefined ? clean(fmt0(item.mrp)) : "";
  const promo =
    item.promotionPrice !== "" && item.promotionPrice !== undefined
      ? clean(fmt0(item.promotionPrice))
      : "";
  // For square (1:1) exports the user wants "SQUARE" baked into the
  // filename so they can tell at a glance which file is meant for
  // Instagram and which is the wide banner.
  const squareTag = opts?.square ? "_SQUARE" : "";
  const tail = `_${mrp}_${promo}${squareTag}.jpg`;
  const MAX = 200;
  const trimmed =
    desc.length + tail.length > MAX
      ? desc.slice(0, Math.max(1, MAX - tail.length))
      : desc;
  return `${trimmed}${tail}`;
}

// ============================================================
// Showcase preview — the on-screen image is the actual JPEG
// produced by the server, not a hand-coded RN approximation.
// See PriceTagImgScreen for the render-on-mount logic.
// ============================================================

// ============================================================
// Screen
// ============================================================

export default function PriceTagImgScreen() {
  const insets = useSafeAreaInsets();
  const { itemKey, layout } = useLocalSearchParams<{
    itemKey?: string;
    layout?: string;
  }>();
  const {
    priceTagReviewItems,
    priceTagReviewStyle,
    priceTagReviewShowLogo,
  } = useApp();

  // The 2:1 banner Showcase strips promotionToDate so the side rail
  // doesn't render. The 1:1 Showcase SQ explicitly *wants* the date,
  // shown horizontally at the bottom in gray.
  const isShowcaseSq = layout === "showcase-sq";
  const item = useMemo(() => {
    if (!itemKey) return null;
    const found = priceTagReviewItems.find((i) => i.key === itemKey);
    if (!found) return null;
    if (isShowcaseSq) return { ...found };
    return { ...found, promotionToDate: undefined };
  }, [itemKey, priceTagReviewItems, isShowcaseSq]);

  // The server-side renderer is the single source of truth for the
  // Showcase / Showcase SQ images. We render once on mount and reuse
  // the same JPEG bytes for both the on-screen preview AND the file
  // the user downloads — so what they see is exactly what they save.
  const [exporting, setExporting] = useState(false);
  const [rendered, setRendered] = useState<{
    base64: string;
    mimeType: string;
    widthPx: number;
    heightPx: number;
  } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  // Bumping this triggers a re-render on the server (used by the
  // "Try again" button after a failed render).
  const [renderNonce, setRenderNonce] = useState(0);
  const renderSeq = useRef(0);

  if (!item) {
    return (
      <View style={screen.empty}>
        <Stack.Screen options={{ title: "PriceTag IMG" }} />
        <Text style={screen.emptyText}>
          Item not found. Open this screen from PriceTag Review.
        </Text>
      </View>
    );
  }

  const isShowcase = layout === "showcase";
  // Either Showcase variant exposes the Download button.
  const isShowcaseAny = isShowcase || isShowcaseSq;

  // Fetch the server-rendered JPEG once per (item / aspect / logo
  // / nonce). Stored in state and used both for preview and download.
  const renderOnServer = useCallback(async () => {
    if (!item) return;
    const seq = ++renderSeq.current;
    setRendering(true);
    setRenderError(null);
    // Drop any previously cached bytes so the user can't see or
    // download a stale preview while the new render is in flight.
    setRendered(null);
    try {
      const safeImageUri = await toServerImageUri(item.imageUri);
      const renderRes = await fetch(apiUrl("/api/pricetag/render"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: {
            itemNo: item.itemNo,
            description: item.description,
            mrp: item.mrp,
            promotionPrice: item.promotionPrice,
            sp: item.sp,
            eligibleQty: item.eligibleQty,
            promoSortCode: item.promoSortCode,
            imageUri: safeImageUri,
            promotionToDate: item.promotionToDate,
            customTitle: item.customTitle,
          },
          style: "E",
          showLogo: priceTagReviewShowLogo,
          // Square: 540 × scale 2 → 1080×1080 (Instagram).
          // Banner: 380 × scale 5 → 1900×~ (matches existing flow).
          widthPx: isShowcaseSq ? 540 : 380,
          scale: isShowcaseSq ? 2 : 5,
          aspect: isShowcaseSq ? "square" : "banner",
        }),
      });
      if (!renderRes.ok) {
        const text = await renderRes.text().catch(() => "");
        throw new Error(
          `Render failed (${renderRes.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        );
      }
      const payload = (await renderRes.json()) as {
        base64: string;
        mimeType: string;
        widthPx: number;
        heightPx: number;
      };
      if (!payload?.base64) throw new Error("Server returned no image bytes");
      // Drop stale responses if a newer render started.
      if (seq !== renderSeq.current) return;
      setRendered(payload);
    } catch (e: any) {
      if (seq !== renderSeq.current) return;
      setRendered(null);
      setRenderError(e?.message ?? "Could not render the image.");
    } finally {
      if (seq === renderSeq.current) setRendering(false);
    }
  }, [item, isShowcaseSq, priceTagReviewShowLogo]);

  useEffect(() => {
    if (!isShowcaseAny) return;
    void renderOnServer();
  }, [isShowcaseAny, renderOnServer, renderNonce]);

  async function handleExport() {
    if (!item || exporting) return;
    if (!rendered) {
      Alert.alert(
        "Preview not ready",
        renderError ?? "Please wait for the preview to finish rendering.",
      );
      return;
    }
    setExporting(true);
    try {
      const payload = rendered;
      const filename = exportFilename(item, { square: isShowcaseSq });

      if (Platform.OS === "web") {
        const bytes = Uint8Array.from(atob(payload.base64), (c) =>
          c.charCodeAt(0),
        );
        const blob = new Blob([bytes], { type: payload.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        Alert.alert("Downloaded", filename);
        return;
      }

      // Native: write base64 to a stable cache file, then push it into
      // the photo library via the existing MediaLibrary flow below.
      const dir = FileSystem.cacheDirectory ?? "";
      if (!dir) throw new Error("No writable cache directory available.");
      const saveUri = dir + filename;
      try {
        await FileSystem.deleteAsync(saveUri, { idempotent: true });
      } catch {
        /* ignore */
      }
      await FileSystem.writeAsStringAsync(saveUri, payload.base64, {
        encoding: "base64" as any,
      });

      let savedViaLibrary = false;
      try {
        const perm = await MediaLibrary.requestPermissionsAsync(false, [
          "photo",
        ]);
        if (!perm.granted) {
          Alert.alert(
            "Permission needed",
            "Allow access to your photo library so the image can be saved.",
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
          /* album write failed; asset is still in library */
        }
        savedViaLibrary = true;
      } catch (libErr: any) {
        const canShare = await Sharing.isAvailableAsync().catch(() => false);
        if (!canShare) throw libErr;
        await Sharing.shareAsync(saveUri, {
          mimeType: "image/jpeg",
          dialogTitle: filename,
          UTI: "public.jpeg",
        });
      }

      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
      Alert.alert(
        savedViaLibrary ? "Saved to Photos" : "Saved",
        savedViaLibrary
          ? `${filename}\nAlbum: Sathyam PriceTags`
          : `${filename}\nUse the share sheet to save to Photos or Files.`,
      );
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save image.");
    } finally {
      setExporting(false);
    }
  }

  const renderTag = () => {
    // Showcase / Showcase SQ: the preview IS the server-rendered
    // JPEG, so what the user sees on screen is exactly the file
    // they will download. While the render is in flight we show a
    // spinner; on failure we show an error + Try again button.
    if (isShowcaseAny) {
      if (rendered) {
        return (
          <Image
            source={{ uri: `data:${rendered.mimeType};base64,${rendered.base64}` }}
            style={screen.tagFill}
            resizeMode="contain"
          />
        );
      }
      if (rendering) {
        return (
          <View style={screen.previewBusy}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={screen.previewBusyText}>Generating preview…</Text>
          </View>
        );
      }
      return (
        <View style={screen.previewBusy}>
          <Feather name="alert-triangle" size={28} color={Colors.danger} />
          <Text style={screen.previewErrorText}>
            {renderError ?? "Could not generate preview."}
          </Text>
          <TouchableOpacity
            style={screen.retryBtn}
            onPress={() => setRenderNonce((n) => n + 1)}
          >
            <Feather name="refresh-cw" size={14} color={Colors.textInverse} />
            <Text style={screen.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const effStyle: PriceTagStyle = item.style ?? priceTagReviewStyle;
    if (effStyle === "A") {
      return (
        <StyleATag
          item={item}
          busy={false}
          showLogo={priceTagReviewShowLogo}
          onAddImage={() => {}}
          onRemoveImage={() => {}}
          onRemoveBackground={() => {}}
          cardStyle={screen.tagFill}
        />
      );
    }
    const bannerLabel =
      effStyle === "C"
        ? "Buy 1 Get 1 Free"
        : effStyle === "D"
          ? "RED Tag Sale"
          : effStyle === "E"
            ? item.customTitle?.trim() || "Edit Title"
            : "LOW PRICES";
    return (
      <StyleBTag
        item={item}
        busy={false}
        showLogo={priceTagReviewShowLogo}
        onAddImage={() => {}}
        onRemoveImage={() => {}}
        onRemoveBackground={() => {}}
        bannerLabel={bannerLabel}
        showPriceRow={effStyle !== "D" && effStyle !== "E"}
        showOffBadge={
          effStyle !== "D" && effStyle !== "C" && effStyle !== "E"
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
        cardStyle={screen.tagFill}
      />
    );
  };

  return (
    <ScrollView
      style={screen.scroll}
      contentContainerStyle={[
        screen.content,
        { paddingBottom: insets.bottom + 24 },
      ]}
    >
      <Stack.Screen
        options={{
          title: isShowcaseSq
            ? "PriceTag IMG — Showcase SQ"
            : isShowcase
              ? "PriceTag IMG — Showcase"
              : "PriceTag IMG",
        }}
      />

      <View
        style={[
          screen.frame,
          // Square frame for Showcase SQ so the preview matches the
          // 1:1 file the user will get.
          isShowcaseSq ? screen.frameSquare : null,
        ]}
      >
        {renderTag()}
      </View>
      <Text style={screen.caption}>{item.description}</Text>

      {isShowcaseAny ? (
        <TouchableOpacity
          style={[
            screen.exportBtn,
            (exporting || !rendered) && screen.exportBtnBusy,
          ]}
          onPress={handleExport}
          disabled={exporting || !rendered}
          accessibilityLabel={
            isShowcaseSq
              ? "Save the square (1:1) showcase tag as a JPEG image"
              : "Save the showcase tag as a JPEG image"
          }
        >
          {exporting ? (
            <ActivityIndicator size="small" color={Colors.textInverse} />
          ) : (
            <Feather
              name="download"
              size={16}
              color={Colors.textInverse}
            />
          )}
          <Text style={screen.exportBtnText}>
            {exporting
              ? "Saving…"
              : isShowcaseSq
                ? "Download Square"
                : "Download Banner"}
          </Text>
        </TouchableOpacity>
      ) : null}

    </ScrollView>
  );
}

const screen = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, alignItems: "center" },
  frame: {
    width: "100%",
    aspectRatio: 2,
    backgroundColor: "#fff",
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  frameSquare: { aspectRatio: 1 },
  tagFill: { flex: 1, width: "100%", height: "100%" },
  caption: {
    marginTop: 12,
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  exportBtn: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: Colors.primary,
  },
  exportBtnBusy: { opacity: 0.7 },
  exportBtnText: {
    color: Colors.textInverse,
    fontWeight: "800",
    fontSize: 14,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: Colors.background,
  },
  emptyText: { color: Colors.textSecondary, textAlign: "center" },
  previewBusy: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    gap: 10,
  },
  previewBusyText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  previewErrorText: {
    color: Colors.danger,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 12,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Colors.primary,
    marginTop: 4,
  },
  retryBtnText: {
    color: Colors.textInverse,
    fontWeight: "800",
    fontSize: 13,
  },
});
