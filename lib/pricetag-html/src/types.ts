export type PriceTagStyle = "A" | "B" | "C" | "D" | "E";

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
