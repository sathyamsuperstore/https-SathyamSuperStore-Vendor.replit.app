export type PriceTagStyle = "A" | "B" | "C" | "D" | "E";

// User-customizable brand palette for the price tags. Each field is
// a CSS hex color string (e.g. "#C8102E"). Used by both the on-screen
// preview, the PDF export, and the server-rendered JPEG so the three
// outputs stay in sync.
//
//   red       — Style B/C/E top + bottom banners, "₹XX OFF" text,
//               square topbar accents.
//   deepRed   — Style A/D card border, MRP value, SAVE pill, square
//               border + price block background.
//   cream     — Style A/D card background and the square showcase
//               background gradient base.
//   gold      — Style A/D big price digits, square frame border,
//               square SAVE pill background.
export interface TagColors {
  red: string;
  deepRed: string;
  cream: string;
  gold: string;
}

// Sathyam Super Store default palette — the hand-tuned values the
// app shipped with before the user could customize them.
export const DEFAULT_TAG_COLORS: TagColors = {
  red: "#C8102E",
  deepRed: "#7A0F19",
  cream: "#F8F2E4",
  gold: "#B8860B",
};

// Minimal structural shape needed by the renderer. The mobile app's
// fuller `PriceTagItem` (with `key`, `addedAt`, `brand`, etc.) is
// assignable to this — extra fields are simply ignored at render time.
export interface PriceTagRenderItem {
  itemNo: string;
  description: string;
  mrp: string | number;
  promotionPrice: string | number;
  sp: string | number;
  eligibleQty?: string | number;
  promoSortCode?: string;
  imageUri?: string;
  promotionToDate?: string;
  customTitle?: string;
  style?: PriceTagStyle;
}
