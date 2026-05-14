import React, { useMemo, useState } from "react";
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
import { LOGO_BASE64 } from "@/constants/LogoBase64";
import {
  useApp,
  type PriceTagItem,
  type PriceTagStyle,
} from "@/context/AppContext";
import { pickFont, hasTamil } from "@/constants/typography";
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
function exportFilename(item: PriceTagItem): string {
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
  const tail = `_${mrp}_${promo}.jpg`;
  const MAX = 200;
  const trimmed =
    desc.length + tail.length > MAX
      ? desc.slice(0, Math.max(1, MAX - tail.length))
      : desc;
  return `${trimmed}${tail}`;
}

// ============================================================
// Showcase tag — visually-appealing 2:1 layout.
// ============================================================

const RED = "#C8102E";
const DEEP_RED = "#7A0F19";
const CREAM = "#FAF4E6";
const GOLD = "#B8860B";
const INK = "#1F2937";

function ShowcaseTag({ item }: { item: PriceTagItem }) {
  const desc = item.description || "(no description)";
  const mrp = fmt0(item.mrp);
  const promo = fmt0(item.promotionPrice);
  const sp = fmt0(item.sp);
  const priceValue = promo || sp || "—";
  const priceLabel = promo ? "OFFER PRICE" : "PRICE";
  const off = offAmount(item);
  const itemNo = (item.itemNo ?? "").trim();

  return (
    <View style={s.card}>
      {/* Cream background */}
      <View style={s.bg} />

      {/* Top-left diagonal corner ribbon */}
      <View pointerEvents="none" style={s.ribbon}>
        <Text style={s.ribbonText}>SPECIAL</Text>
      </View>

      {/* Logo watermark, bottom-right */}
      <View pointerEvents="none" style={s.logoWrap}>
        <Image
          source={{ uri: LOGO_BASE64 }}
          style={s.logo}
          resizeMode="contain"
        />
      </View>

      {/* Two-pane row: image left, text right */}
      <View style={s.row}>
        {/* LEFT — product image tile */}
        <View style={s.imageCol}>
          <View style={s.imageFrame}>
            {item.imageUri ? (
              <Image
                source={{ uri: item.imageUri }}
                style={s.image}
                resizeMode="contain"
              />
            ) : (
              <View style={s.imagePlaceholder}>
                <Text style={s.imagePlaceholderText}>No Image</Text>
              </View>
            )}
          </View>
        </View>

        {/* RIGHT — text column. flex:1 + justify space-between keeps
            the SAVE pill anchored to the bottom even if the
            description wraps to three lines. */}
        <View style={s.textCol}>
          {/* Description — allow up to 3 lines and auto-shrink so
              long names don't get cut off mid-word. */}
          <Text
            style={[
              s.desc,
              { fontFamily: pickFont(desc, "bold") },
              hasTamil(desc) ? { lineHeight: 20 } : null,
            ]}
            numberOfLines={3}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          >
            {desc}
          </Text>

          {/* MRP row */}
          {mrp ? (
            <View style={s.mrpRow}>
              <Text style={s.mrpLabel}>MRP</Text>
              <Text style={s.mrpValue}>₹{mrp}</Text>
            </View>
          ) : null}

          {/* Big price block */}
          <View style={s.priceBlock}>
            <Text style={s.priceLabel}>{priceLabel}</Text>
            <View style={s.priceLine}>
              <Text style={s.priceCurrency}>₹</Text>
              <Text
                style={s.priceValue}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.4}
              >
                {priceValue}
              </Text>
            </View>
          </View>

          {/* Footer — SAVE pill + item code. Reserve space at the
              bottom so the watermark logo never overlaps it. */}
          <View style={s.footer}>
            {off ? (
              <View style={s.savePill}>
                <Text style={s.saveText}>SAVE ₹{off}</Text>
              </View>
            ) : (
              <View />
            )}
            {itemNo ? <Text style={s.itemNo}>#{itemNo}</Text> : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    flex: 1,
    width: "100%",
    height: "100%",
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: DEEP_RED,
    backgroundColor: CREAM,
    position: "relative",
  },
  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: CREAM },
  ribbon: {
    position: "absolute",
    top: 12,
    left: -44,
    width: 150,
    transform: [{ rotate: "-35deg" }],
    backgroundColor: DEEP_RED,
    paddingVertical: 3,
    alignItems: "center",
    zIndex: 4,
  },
  ribbonText: {
    color: "#fff",
    fontWeight: "900",
    letterSpacing: 1.2,
    fontSize: 10,
  },
  logoWrap: {
    position: "absolute",
    right: 8,
    bottom: 4,
    width: 48,
    height: 16,
    opacity: 0.55,
    zIndex: 1,
  },
  logo: { width: "100%", height: "100%" },
  row: {
    flex: 1,
    flexDirection: "row",
    padding: 10,
    paddingBottom: 14,
    gap: 10,
  },
  imageCol: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  imageFrame: {
    width: "100%",
    height: "100%",
    borderRadius: 10,
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: GOLD,
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
  },
  image: { width: "100%", height: "100%" },
  imagePlaceholder: {
    flex: 1,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  imagePlaceholderText: {
    color: "#94A3B8",
    fontWeight: "600",
    fontSize: 12,
  },
  textCol: {
    flex: 1.2,
    justifyContent: "space-between",
    paddingTop: 2,
  },
  desc: {
    color: INK,
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 17,
  },
  mrpRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginTop: 2,
  },
  mrpLabel: {
    color: "#6B7280",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  mrpValue: {
    color: "#6B7280",
    fontSize: 12,
    fontWeight: "700",
    textDecorationLine: "line-through",
  },
  priceBlock: {
    backgroundColor: DEEP_RED,
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginTop: 4,
  },
  priceLabel: {
    color: GOLD,
    fontWeight: "900",
    letterSpacing: 1.2,
    fontSize: 10,
  },
  priceLine: {
    flexDirection: "row",
    alignItems: "baseline",
    marginTop: 0,
  },
  priceCurrency: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "900",
    marginRight: 2,
  },
  priceValue: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 34,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
  },
  savePill: {
    backgroundColor: GOLD,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  saveText: {
    color: DEEP_RED,
    fontWeight: "900",
    fontSize: 11,
    letterSpacing: 0.5,
  },
  itemNo: {
    color: "#6B7280",
    fontSize: 9,
    fontWeight: "700",
    marginRight: 56, // leave room for the logo watermark
  },
});

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

  const item = useMemo(() => {
    if (!itemKey) return null;
    const found = priceTagReviewItems.find((i) => i.key === itemKey);
    if (!found) return null;
    return { ...found, promotionToDate: undefined };
  }, [itemKey, priceTagReviewItems]);

  // ---- "Export IMG" calls the api-server's /pricetag/render endpoint
  // which renders the same HTML/CSS the PDF export uses through a
  // headless Chromium, returning a high-resolution JPEG. This avoids
  // the layout / quality issues of capturing a React Native view on
  // device. The on-screen copy here is purely for preview.
  const [exporting, setExporting] = useState(false);

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

  async function handleExport() {
    if (!item || exporting) return;
    setExporting(true);
    try {
      // The server can't reach a `file://` URI on the device — and
      // we block non-http(s) protocols server-side as an SSRF guard.
      // For local files (typical when the user picked an image from
      // the camera roll) we read the bytes here and inline them as a
      // data: URI so Chromium can render the image directly. http(s)
      // URLs and existing data: URIs are forwarded unchanged.
      const safeImageUri = await toServerImageUri(item.imageUri);

      // Server-side render. Showcase always uses Style E so the
      // user-picked TitleList banner drives design variety. The
      // server returns base64 JPEG bytes that match the PDF
      // export's HTML/CSS pixel-for-pixel.
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
          widthPx: 380,
          scale: 5,
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

      const filename = exportFilename(item);

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
    if (isShowcase) return <ShowcaseTag item={item} />;

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
          title: isShowcase ? "PriceTag IMG — Showcase" : "PriceTag IMG",
        }}
      />

      <View style={screen.frame}>{renderTag()}</View>
      <Text style={screen.caption}>{item.description}</Text>

      {isShowcase ? (
        <TouchableOpacity
          style={[screen.exportBtn, exporting && screen.exportBtnBusy]}
          onPress={handleExport}
          disabled={exporting}
          accessibilityLabel="Save the showcase tag as a JPEG image"
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
            {exporting ? "Saving…" : "Export IMG"}
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
});
