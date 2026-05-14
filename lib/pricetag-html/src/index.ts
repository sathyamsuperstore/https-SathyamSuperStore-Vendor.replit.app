// @workspace/pricetag-html
//
// Shared price-tag HTML/CSS renderer used by:
//   - artifacts/mobile  (PDF export via expo-print)
//   - artifacts/api-server  (server-side JPEG render via headless Chromium)
//
// Single source of truth so the JPEG and PDF outputs always match.

export { LOGO_BASE64 } from "./logo";
export type { PriceTagStyle, PriceTagRenderItem } from "./types";
export {
  fmt0,
  toNum,
  priceFor,
  minPurchaseQty,
  offAmount,
  hasTamil,
  escapeHtml,
} from "./helpers";
export {
  RED,
  DEEP_RED,
  GOLD,
  CREAM,
  PDF_CSS_A,
  PDF_CSS_B,
  renderTagAHtml,
  renderTagBHtml,
  renderTagHtmlForStyle,
  renderSquareShowcaseHtml,
  buildPdfHtml,
  buildSingleTagHtml,
  buildSquareShowcaseHtml,
  PDF_CSS_SQ,
} from "./render";
