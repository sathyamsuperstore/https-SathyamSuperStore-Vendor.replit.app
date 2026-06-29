---
name: Large promo/purchase datasets — render vs. data
description: Durable rules for handling very large imported datasets in the mobile app's list/preview screens.
---

# Large datasets in the mobile app

Imported sheets (GRN / promo / purchases) can be very large (tens of
thousands of rows). Parsing and atomic file-based storage handle this fine;
the recurring failure mode is **rendering**, not data volume.

**Rule 1 — never render an unbounded dataset in a non-virtualized
`ScrollView`.** Some preview tables build rows with nested `.map()` inside a
synchronized horizontal `ScrollView` (not a FlatList); rendering all rows
freezes the JS thread on-device. Cap what is *displayed* (e.g. a preview
limit) while keeping import/save/export/downstream using the full set. Never
route the capped subset into save, export, navigation, or filter-backing data.

**Why:** users need the entire sheet for ordering/exports; only on-device
display of every row is the bottleneck.

**Rule 2 — keep "option source" filters semantically identical to the main
row filter.** When picker lists (vendor/brand/category) are cross-scoped by
other active filters, they must apply the same predicates in the same order
as the main filtered-rows memo (e.g. multi-MRP before missing-promo before
has-sort-code), or option lists drift out of sync with visible rows.

**How to apply:** if you add a new toggle/filter, update both the row filter
and the picker-scope function together, and watch for temporal-dead-zone
ordering when one memo references another.
