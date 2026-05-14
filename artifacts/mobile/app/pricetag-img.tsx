import React, { useMemo } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";
import { useApp, type PriceTagStyle } from "@/context/AppContext";
import { StyleATag, StyleBTag } from "./pricetag-review";

export default function PriceTagImgScreen() {
  const insets = useSafeAreaInsets();
  const { itemKey } = useLocalSearchParams<{ itemKey?: string }>();
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
      <View style={styles.empty}>
        <Stack.Screen options={{ title: "PriceTag IMG" }} />
        <Text style={styles.emptyText}>
          Item not found. Open this screen from PriceTag Review.
        </Text>
      </View>
    );
  }

  const effStyle: PriceTagStyle = item.style ?? priceTagReviewStyle;

  const renderTag = () => {
    if (effStyle === "A") {
      return (
        <StyleATag
          item={item}
          busy={false}
          showLogo={priceTagReviewShowLogo}
          onAddImage={() => {}}
          onRemoveImage={() => {}}
          onRemoveBackground={() => {}}
          cardStyle={styles.tagFill}
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
        cardStyle={styles.tagFill}
      />
    );
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 24 },
      ]}
    >
      <Stack.Screen options={{ title: "PriceTag IMG" }} />
      <View style={styles.frame}>{renderTag()}</View>
      <Text style={styles.caption}>{item.description}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
