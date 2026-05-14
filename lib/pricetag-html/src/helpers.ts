import type { PriceTagRenderItem } from "./types";

// Round to whole rupees and return as a string (no decimals). The
// store's printed tags don't use paise, so 506.49 -> "506".
export function fmt0(v: string | number | undefined): string {
  if (v === undefined || v === null || v === "") return "";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return String(Math.round(n));
}

export function toNum(v: string | number | undefined): number {
  if (v === undefined || v === null || v === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Decide which price line to print and how to label it.
//   PromotionPrice present  -> label "Offer Price"
//   else SP                 -> label "Price"
//   else                    -> em-dash placeholder
export function priceFor(item: PriceTagRenderItem): {
  label: string;
  value: string;
  isOffer: boolean;
} {
  const p = fmt0(item.promotionPrice);
  if (p) return { label: "Offer Price", value: p, isOffer: true };
  const sp = fmt0(item.sp);
  if (sp) return { label: "Price", value: sp, isOffer: false };
  return { label: "Price", value: "—", isOffer: false };
}

// Minimum purchase qty to show on the tag. Returns the formatted
// number when EligibleQty is present and not equal to 1, otherwise
// null (single-unit promos don't need the disclaimer).
export function minPurchaseQty(item: PriceTagRenderItem): string | null {
  const raw = item.eligibleQty;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n === 1) return null;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Customer savings = MRP - active offer price. Returns null when
// there's no real saving (no MRP, no offer line, or MRP <= offer).
export function offAmount(item: PriceTagRenderItem): string | null {
  const mrp = toNum(item.mrp);
  const offer = toNum(item.promotionPrice);
  if (!Number.isFinite(mrp) || !Number.isFinite(offer)) return null;
  const off = Math.round(mrp) - Math.round(offer);
  if (off <= 0) return null;
  return String(off);
}

// Tamil Unicode block: U+0B80–U+0BFF.
const TAMIL_RE = /[\u0B80-\u0BFF]/;
export function hasTamil(text: string | null | undefined): boolean {
  if (!text) return false;
  return TAMIL_RE.test(text);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
