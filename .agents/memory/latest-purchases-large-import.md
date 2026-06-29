---
name: Latest Purchases large-import render cap
description: Why the Latest Purchases preview table caps rendered rows, and which paths must stay full-dataset.
---

# Latest Purchases large GRN import

Large GRN sheets are routinely huge (a real one was ~12,858 rows). Two distinct
scale failures have hit this flow historically:

1. **Save step** (older bug): persisting the whole batch as one AsyncStorage blob
   crashed at ~95%. Fixed by migrating to atomic file-based storage in AppContext
   (tmp write + move), mirroring Suppliers/VendorPayments/RodeoItems.
2. **Render step** (this fix): the on-screen preview table in
   `app/(tabs)/latest-purchases.tsx` renders rows with nested `.map()` inside a
   non-virtualized `ScrollView` (synchronized horizontal scroll between header and
   body), NOT a FlatList. Rendering ~12k rows freezes/crashes the JS thread.

**Rule:** the preview table is capped to `PREVIEW_ROW_LIMIT` rows via a
`previewRows = filtered.slice(0, limit)` memo that feeds ONLY the `grouped` memo
(the table render). Everything else must keep using the full set:
- import/parse + `saveLatestPurchasesBatch(parsed)` (full array)
- the Excel export (`latestPurchases.map(...)`)
- stats counts (`filtered.length` / `latestPurchases.length`)
- the downstream Place Orders screen `app/order/import.tsx` (already a virtualized
  FlatList with its own PREVIEW_LIMIT — handles full data fine).

**Why:** users need to import the entire sheet for ordering; only on-device
*display* of every row is the problem. Never route `previewRows` into save/export/
navigation/filter-backing data.

**How to apply:** if you add deep inspection beyond the cap, prefer pagination or
virtualizing the preview table rather than rendering all rows. The simulated parse
of 12,858 rows is fast (~1.2s) and ~6.3 MB JSON — parsing/storage are not the
bottleneck; rendering is.
