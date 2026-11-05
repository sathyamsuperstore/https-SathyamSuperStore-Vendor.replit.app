import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  /**
   * How the chip row should lay out when there are more chips than fit
   * on a single line.
   *
   * - `"scroll"` (default) keeps the original behaviour: chips render
   *   in a single horizontally-scrollable row.
   * - `"wrap"` lays chips out in a flex-wrap container so they flow
   *   onto a second (or third) row instead. Used by the Directory hub
   *   where we want all five chips visible at a glance without a
   *   horizontal swipe. Other hubs should leave this unset to avoid
   *   regressing their existing single-row layout.
   */
  chipLayout?: "scroll" | "wrap";
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
export function HubTab({ views, defaultView, chipLayout = "scroll" }: Props) {
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

  // Visual feedback when switching to a heavy sub-screen (e.g. PriceTag
  // Review). Tapping a chip used to look frozen because the chip's
  // active state couldn't paint until the new screen finished its first
  // render on the JS thread. We now optimistically mark the tapped chip
  // active and overlay a spinner, then defer the actual route update
  // one frame so the press visual paints first.
  const [pending, setPending] = useState<string | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Clear the pending indicator once the URL has caught up.
    if (pending && pending === view) {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      setPending(null);
    }
  }, [view, pending]);
  useEffect(() => () => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
  }, []);

  function selectView(next: string) {
    if (next === view || pending === next) return;
    // Show the optimistic active state + overlay spinner immediately.
    setPending(next);
    // Defer the actual nav so the spinner paints first; otherwise the
    // heavy sub-screen's mount blocks the JS thread before React has a
    // chance to commit our pending state.
    requestAnimationFrame(() => {
      setTimeout(() => {
      // setParams merges, so other params the sub-screen reads (e.g.
      // `q` seeded from a Stock Update item-no link into Promo)
      // survive chip switches.
        router.setParams({ view: next });
      }, 0);
    });
    // Hard timeout: if the new screen never commits (e.g. the user
    // taps a different chip first), drop the pending state after 6s
    // so the UI doesn't get stuck spinning.
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      setPending((p) => (p === next ? null : p));
    }, 6000);
  }

  // The chip we should *show* as active — pending wins so the user
  // sees their tap take effect immediately.
  const visualActive = pending ?? view;

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
        {chipLayout === "wrap" ? (
          // Wrap layout: chips flow onto multiple rows. Used when there
          // are too many chips to fit on a single phone-width row and
          // we'd rather show them all than force a horizontal swipe.
          <View style={styles.chipWrap}>
            {views.map((v) => {
              const active = v.key === visualActive;
              const loading = pending === v.key;
              return (
                <TouchableOpacity
                  key={v.key}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => selectView(v.key)}
                  activeOpacity={0.85}
                  disabled={pending != null}
                >
                  <View style={styles.chipInner}>
                    {loading ? (
                      <ActivityIndicator
                        size="small"
                        color={Colors.textInverse}
                      />
                    ) : null}
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                      ]}
                    >
                      {v.label}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {views.map((v) => {
              const active = v.key === visualActive;
              const loading = pending === v.key;
              return (
                <TouchableOpacity
                  key={v.key}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => selectView(v.key)}
                  activeOpacity={0.85}
                  disabled={pending != null}
                >
                  <View style={styles.chipInner}>
                    {loading ? (
                      <ActivityIndicator
                        size="small"
                        color={Colors.textInverse}
                      />
                    ) : null}
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                      ]}
                    >
                      {v.label}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>

      <SafeAreaInsetsContext.Provider value={bodyInsets}>
        <View style={styles.body}>
          {views.map((v) => {
            if (!mounted.has(v.key)) return null;
            const active = v.key === view;
            // The actual rendered active screen still tracks `view`
            // (the URL) — we don't swap the body until the route
            // updates. The pending overlay below covers the gap.
            return (
              <View
                key={v.key}
                // absoluteFill so the inactive sub-screen stays in the
                // tree (preserves scroll, search, list state) but is
                // not visible. `display:none` hides it visually and
                // `pointerEvents:none` (in `style`, not as a prop —
                // the prop form is deprecated and silently ignored on
                // RN Web 0.74+, which caused taps to bleed through to
                // the inactive sibling's list rows underneath) makes
                // sure no stray touches reach it either.
                style={[
                  StyleSheet.absoluteFill,
                  {
                    display: active ? "flex" : "none",
                    pointerEvents: active ? "auto" : "none",
                  },
                ]}
              >
                {v.render()}
              </View>
            );
          })}
          {pending && pending !== view ? (
            <View
              pointerEvents="auto"
              style={[StyleSheet.absoluteFill, styles.pendingOverlay]}
            >
              <View style={styles.pendingCard}>
                <ActivityIndicator size="large" color={Colors.primary} />
                <Text style={styles.pendingText}>
                  Loading {views.find((v) => v.key === pending)?.label ?? ""}…
                </Text>
              </View>
            </View>
          ) : null}
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
  // Wrap variant: same horizontal padding as the scroll variant, but
  // chips can flow onto multiple rows. `rowGap` puts a small vertical
  // gap between wrapped rows so the second row doesn't sit flush
  // against the first.
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 8,
    rowGap: 8,
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
  chipInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  body: { flex: 1 },
  pendingOverlay: {
    backgroundColor: "rgba(15,23,42,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  pendingCard: {
    backgroundColor: Colors.surface,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pendingText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.text,
  },
});
