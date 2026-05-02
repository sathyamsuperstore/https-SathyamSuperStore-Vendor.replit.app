import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Colors } from "@/constants/colors";

export type HubView = {
  key: string;
  label: string;
  render: () => React.ReactNode;
};

type Props = {
  views: HubView[];
  defaultView: string;
};

/**
 * Shared "hub" tab shell used to consolidate the 10-tab bar down to 5.
 *
 * Renders a horizontal chip bar at the top under the status bar and
 * keeps each sub-screen alive (mounted, hidden via display:none) once
 * it has been visited.
 *
 * URL is the **single source of truth** for the active sub-view. The
 * `?view=` query param drives the rendered chip; `selectView()` only
 * calls `router.setParams({view})` and never touches local state, so
 * there is no two-way-sync race between params and component state.
 * Deep links and back/forward gestures Just Work because the rendered
 * view is computed directly from `useLocalSearchParams()`.
 *
 * Sub-screens were originally written as standalone tab routes that
 * each apply their own top safe-area inset. To avoid double-padding
 * inside the hub we override SafeAreaInsetsContext for the body so
 * `useSafeAreaInsets().top` returns 0 inside sub-screens — the hub's
 * own chip bar already lives in the safe area. `bottom/left/right`
 * insets are passed through so each sub-screen's
 * `paddingBottom: insets.bottom + 100` still clears the tab bar.
 */
export function HubTab({ views, defaultView }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ view?: string | string[] }>();

  const validKeys = useMemo(() => new Set(views.map((v) => v.key)), [views]);

  // Derive the active view directly from the URL — no local mirror.
  const view = useMemo(() => {
    const raw = Array.isArray(params.view) ? params.view[0] : params.view;
    return raw && validKeys.has(raw) ? raw : defaultView;
  }, [params.view, validKeys, defaultView]);

  // Track which sub-views have been visited so we can mount-once and
  // keep alive (display:none) thereafter, preserving scroll/search/list
  // state across chip switches without paying the mount cost upfront.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([view]));
  useEffect(() => {
    setMounted((prev) => (prev.has(view) ? prev : new Set([...prev, view])));
  }, [view]);

  function selectView(next: string) {
    if (next === view) return;
    // setParams merges, so other params the sub-screen reads (e.g. `q`
    // seeded from a Stock Update item-no link into Promo) survive
    // chip switches.
    router.setParams({ view: next });
  }

  // Override the top inset for the body so sub-screens don't pad
  // again under the chip bar. Keep the real bottom/left/right insets
  // so each sub-screen's `paddingBottom: insets.bottom + 100` still
  // clears the tab bar.
  const bodyInsets = useMemo(
    () => ({
      top: 0,
      bottom: insets.bottom,
      left: insets.left,
      right: insets.right,
    }),
    [insets.bottom, insets.left, insets.right]
  );

  // Match the safe-area handling each tab screen already does (web
  // adds a 67px gap for the workspace chrome; native uses status bar).
  const chipTop = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={styles.container}>
      <View style={[styles.chipBar, { paddingTop: chipTop + 6 }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {views.map((v) => {
            const active = v.key === view;
            return (
              <TouchableOpacity
                key={v.key}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => selectView(v.key)}
                activeOpacity={0.85}
              >
                <Text
                  style={[styles.chipText, active && styles.chipTextActive]}
                >
                  {v.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <SafeAreaInsetsContext.Provider value={bodyInsets}>
        <View style={styles.body}>
          {views.map((v) => {
            if (!mounted.has(v.key)) return null;
            const active = v.key === view;
            return (
              <View
                key={v.key}
                // absoluteFill so the inactive sub-screen stays in the
                // tree (preserves scroll, search, list state) but is
                // not visible. display:none also prevents it from
                // intercepting touches while hidden.
                style={[
                  StyleSheet.absoluteFill,
                  { display: active ? "flex" : "none" },
                ]}
                pointerEvents={active ? "auto" : "none"}
              >
                {v.render()}
              </View>
            );
          })}
        </View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  chipBar: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingBottom: 8,
  },
  chipRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
  },
  chipTextActive: { color: Colors.textInverse },
  body: { flex: 1 },
});
