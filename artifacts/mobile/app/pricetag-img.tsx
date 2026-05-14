import React, { useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, Image } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
// Helpers (kept local so this screen stays self-contained)
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

// ============================================================
// Showcase tag — brand-new visually-appealing 2:1 layout.
// ============================================================
//
// A two-pane composition that makes a 2:1 strip read clearly at a
// glance. Left half is the product image on a soft cream tile with a
// thin gold inner border; right half is a stacked text column with
// description, MRP strikethrough, and a big OFFER PRICE block, plus
// a SAVE pill at the bottom. A deep-red diagonal corner ribbon adds
// a "promotion" feel without crowding the layout. The store logo
// sits as a small watermark in the bottom-right corner.

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
      {/* Cream background tile */}
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

        {/* RIGHT — text column */}
        <View style={s.textCol}>
          {/* Description */}
          <Text
            style={[
              s.desc,
              {
                fontFamily: pickFont(desc, "bold"),
                lineHeight: hasTamil(desc) ? 22 : 20,
              },
            ]}
            numberOfLines={2}
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
                minimumFontScale={0.5}
              >
                {priceValue}
              </Text>
            </View>
          </View>

          {/* Footer — SAVE pill + item code */}
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
  bg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: CREAM,
  },
  ribbon: {
    position: "absolute",
    top: 14,
    left: -42,
    width: 160,
    transform: [{ rotate: "-35deg" }],
    backgroundColor: DEEP_RED,
    paddingVertical: 4,
    alignItems: "center",
    zIndex: 4,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  ribbonText: {
    color: "#fff",
    fontWeight: "900",
    letterSpacing: 1.2,
    fontSize: 11,
  },
  logoWrap: {
    position: "absolute",
    right: 10,
    bottom: 8,
    width: 56,
    height: 22,
    opacity: 0.6,
    zIndex: 3,
  },
  logo: { width: "100%", height: "100%" },
  row: {
    flex: 1,
    flexDirection: "row",
    padding: 12,
    gap: 12,
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
    padding: 8,
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
    flex: 1.15,
    justifyContent: "space-between",
  },
  desc: {
    color: INK,
    fontSize: 16,
    fontWeight: "800",
  },
  mrpRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginTop: 4,
  },
  mrpLabel: {
    color: "#6B7280",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  mrpValue: {
    color: "#6B7280",
    fontSize: 13,
    fontWeight: "700",
    textDecorationLine: "line-through",
  },
  priceBlock: {
    backgroundColor: DEEP_RED,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  priceLabel: {
    color: GOLD,
    fontWeight: "900",
    letterSpacing: 1.5,
    fontSize: 11,
  },
  priceLine: {
    flexDirection: "row",
    alignItems: "baseline",
    marginTop: 2,
  },
  priceCurrency: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "900",
    marginRight: 2,
  },
  priceValue: {
    color: "#fff",
    fontSize: 40,
    fontWeight: "900",
    lineHeight: 44,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
  },
  savePill: {
    backgroundColor: GOLD,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  saveText: {
    color: DEEP_RED,
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 0.5,
  },
  itemNo: {
    color: "#6B7280",
    fontSize: 10,
    fontWeight: "700",
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
    </ScrollView>
  );
}

const screen = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, alignItems: "center" },
  // 2:1 frame mirrors the aspect used by the prior IMG export so the
  // tag has the same proportions you'd get in the saved JPEG.
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
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: Colors.background,
  },
  emptyText: { color: Colors.textSecondary, textAlign: "center" },
});
