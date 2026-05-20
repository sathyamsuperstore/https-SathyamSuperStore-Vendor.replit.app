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

// Company / store identity printed on the bottom of the square
// showcase tag. All fields are optional strings — the renderer
// silently skips empty values so partial data still produces a
// clean layout.
export interface CompanyDetails {
  companyName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  country?: string;
  pincode?: string;
  mobile?: string;
  whatsapp?: string;
  gstNo?: string;
  fssaiNo?: string;
}
export interface TagColors {
  red: string;
  deepRed: string;
  cream: string;
  gold: string;
}

// Sathyam Super Store default palette — the hand-tuned values the
// app shipped with before the user could customize them.
export const DEFAULT_TAG_COLORS: TagColors = {
  // `red` brightened from #C8102E so the SQ Detailed promo price text
  // (red on the deepRed price box) keeps adequate contrast. Also lifts
  // the Style B/C/D/E PDF accents (borders, RED Tag badge, save chip).
  red: "#ED1C24",
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
  // Optional Limit Qty from the source Promo row. When > 0 the
  // server-side PNG renderer paints "Offer Limit Qty : N" in Gold
  // at the right-bottom of Style A / B (and the C/D/E variants
  // that wrap Style B). Internal Notes is intentionally absent —
  // it is store-private and must never appear on printed tags.
  limitQty?: string | number;
  promoSortCode?: string;
  imageUri?: string;
  promotionToDate?: string;
  customTitle?: string;
  style?: PriceTagStyle;
}
