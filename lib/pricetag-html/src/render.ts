import type { PriceTagRenderItem, PriceTagStyle } from "./types";
import {
  fmt0,
  priceFor,
  minPurchaseQty,
  offAmount,
  hasTamil,
  escapeHtml,
} from "./helpers";

// Brand palette — kept verbatim from the mobile PriceTag Review screen
// so the JPEG output matches the PDF exactly.
export const RED = "#C8102E";
export const DEEP_RED = "#7A0F19";
export const CREAM = "#F8F2E4";
export const GOLD = "#B8860B";

// ----- Style A HTML / CSS -----

export function renderTagAHtml(
  it: PriceTagRenderItem,
  showLogo: boolean,
  logoDataUri: string,
): string {
  const { label, value } = priceFor(it);
  const mrp = fmt0(it.mrp);
  const off = offAmount(it);
  const minQtyA = minPurchaseQty(it);
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri ? `<img src="${it.imageUri}" />` : "";

  // Split the price label across two lines (e.g. "OFFER" / "PRICE")
  // so the PDF matches the two-line on-screen layout.
  const labelParts = label.toUpperCase().split(" ");
  const labelLine1 = escapeHtml(labelParts[0] || "");
  const labelLine2 = escapeHtml(labelParts[1] || "");

  const watermark = showLogo
    ? `<img class="watermark" src="${logoDataUri}" alt="" />`
    : "";

  const validTill = it.promotionToDate
    ? `<div class="validTillA"><span>Valid Till: ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}</span></div>`
    : "";

  return `
    <div class="tagA">
      ${watermark}
      ${validTill}
      <div class="descA">${descSpan}</div>
      ${minQtyA ? `<div class="minQtyA">* Minimum Purchase Qty: ${escapeHtml(minQtyA)}</div>` : ""}
      <div class="bodyRowA">
        <div class="bodyLeftA">
          ${mrp ? `
            <div class="mrpRowA">
              <span class="rupeeSm">₹</span><span class="mrpValA">${escapeHtml(mrp)}</span>
              <span class="mrpLabelA">MRP</span>
            </div>` : ""}
          <div class="priceRowA">
            <span class="rupeeBigA">₹</span><span class="priceValA">${escapeHtml(value)}${minQtyA ? "*" : ""}</span>
            <span class="priceLabelColA">
              <span class="priceLabelA">${labelLine1}</span>
              <span class="priceLabelA">${labelLine2}</span>
            </span>
          </div>
          ${off ? `<div class="footerA"><span class="offA">SAVE ₹${escapeHtml(off)}</span></div>` : ""}
        </div>
        <div class="bodyRightA">
          <div class="imgPanelA">${img}</div>
        </div>
      </div>
      <div class="itemFooterA">Item No: ${escapeHtml(it.itemNo || "—")}${it.eligibleQty !== undefined && it.eligibleQty !== "" ? `   ·   Elig Qty: ${escapeHtml(fmt0(it.eligibleQty))}` : ""}${it.promoSortCode ? `   ·   Sort: ${escapeHtml(it.promoSortCode)}` : ""}</div>
    </div>
  `;
}

// Printer-friendly: white background, no large solid color fills.
export const PDF_CSS_A = `
  .tagA {
    position: relative;
    background: #FFFFFF;
    border: 1.5px solid ${DEEP_RED};
    border-radius: 8px;
    padding: 10px;
    page-break-inside: avoid;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .tagA .watermark {
    position: absolute;
    top: 4px; right: 4px;
    width: 6%; height: auto;
    opacity: 0.45;
    pointer-events: none;
    z-index: 2;
  }
  .tagA > *:not(.watermark) { position: relative; z-index: 1; }
  .tagA .validTillA {
    position: absolute;
    top: 0; right: 2px; bottom: 0;
    width: 14px;
    display: flex; align-items: center; justify-content: center;
    z-index: 2; pointer-events: none;
  }
  .tagA .validTillA span {
    display: inline-block;
    transform: rotate(90deg);
    white-space: nowrap;
    font-size: 8px; color: #94795E; font-weight: 600;
    letter-spacing: 0.3px;
  }
  .descA {
    font-size: 13px; font-weight: 800; color: ${DEEP_RED};
    line-height: 1.25; margin-bottom: 8px;
  }
  .minQtyA {
    font-size: 10px; font-weight: 700; color: ${DEEP_RED};
    margin: -4px 0 6px 0; text-align: left;
  }
  .bodyRowA {
    display: flex; flex-direction: row; align-items: center;
    gap: 10px;
  }
  .bodyLeftA { flex: 1; min-width: 0; }
  .bodyRightA { width: 120px; flex-shrink: 0; }
  .imgPanelA {
    position: relative;
    width: 120px; height: 120px;
    background: transparent;
    border-radius: 6px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .imgPanelA img { width: 100%; height: 100%; object-fit: contain; }
  .img-placeholder {
    color: ${DEEP_RED}; font-size: 11px;
    border: 1px dashed ${DEEP_RED}; border-radius: 6px;
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
  }
  .mrpRowA {
    display: inline-flex; align-items: baseline;
    gap: 3px; padding: 1px 4px; margin-bottom: 4px;
  }
  .rupeeSm { font-size: 11px; color: ${DEEP_RED}; font-weight: 800; }
  .mrpValA { font-size: 18px; color: ${DEEP_RED}; font-weight: 800; line-height: 1; }
  .mrpLabelA { font-size: 10px; color: ${DEEP_RED}; font-weight: 700; margin-left: 3px; letter-spacing: 0.5px; }
  .priceRowA {
    display: flex; align-items: center; gap: 4px; margin-top: 2px;
  }
  .rupeeBigA { font-size: 18px; color: ${GOLD}; font-weight: 800; line-height: 1; }
  .priceValA { font-size: 36px; color: ${GOLD}; font-weight: 900; line-height: 1; }
  .priceLabelColA {
    display: inline-flex; flex-direction: column;
    justify-content: center; align-items: flex-start;
    margin-left: 5px; line-height: 1;
  }
  .priceLabelA {
    font-size: 11px; color: ${GOLD}; font-weight: 800;
    letter-spacing: 0.8px; line-height: 1.1;
  }
  .footerA {
    display: flex; justify-content: flex-start; align-items: center;
    margin-top: 6px;
  }
  .offA {
    display: inline-block;
    background: ${DEEP_RED}; color: #FFF;
    font-size: 11px; font-weight: 800; letter-spacing: 0.5px;
    padding: 2px 8px; border-radius: 4px;
  }
  .itemFooterA {
    margin-top: 8px; padding-top: 4px;
    border-top: 1px dashed #C8B89F;
    font-size: 9px; color: #94795E; font-weight: 600; letter-spacing: 0.3px;
  }
`;

// ----- Style B HTML / CSS -----

export function renderTagBHtml(
  it: PriceTagRenderItem,
  showLogo: boolean,
  logoDataUri: string,
  bannerLabel: string = "LOW PRICES",
  showPriceRow: boolean = true,
  showOffBadge: boolean = true,
  showStyleAMrpRow: boolean = false,
  showStyleAPriceRow: boolean = false,
  validTillTopLeft: boolean = false,
  showStyleASaveBadge: boolean = false,
): string {
  const { label, value } = priceFor(it);
  const mrp = fmt0(it.mrp);
  const off = offAmount(it);
  const minQtyB = minPurchaseQty(it);
  const labelParts = label.toUpperCase().split(" ");
  const labelLine1 = escapeHtml(labelParts[0] || "");
  const labelLine2 = escapeHtml(labelParts[1] || "");
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri ? `<img src="${it.imageUri}" />` : "";

  const watermark = showLogo
    ? `<img class="watermark" src="${logoDataUri}" alt="" />`
    : "";

  const validTillText = it.promotionToDate
    ? `Valid Till: ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}`
    : "";
  const validTillRail =
    !validTillTopLeft && validTillText
      ? `<div class="validTillB"><span>${validTillText}</span></div>`
      : "";
  const validTillTop =
    validTillTopLeft && validTillText
      ? `<div class="validTillTopB">${validTillText}</div>`
      : "";

  return `
    <div class="tagB">
      ${watermark}
      ${validTillRail}
      <div class="topBannerB">${escapeHtml(bannerLabel)}</div>
      ${validTillTop}
      <div class="middleB">
        <div class="imgWrapB">${img}</div>
        <div class="priceColB${showStyleASaveBadge ? " leftAlign" : ""}">
          ${showStyleAMrpRow && mrp ? `
          <div class="mrpRowA">
            <span class="rupeeSm">₹</span><span class="mrpValA">${escapeHtml(mrp)}</span>
            <span class="mrpLabelA">MRP</span>
          </div>` : ""}
          ${showStyleAPriceRow ? `
          <div class="priceRowA">
            <span class="rupeeBigA">₹</span><span class="priceValA">${escapeHtml(value)}${minQtyB ? "*" : ""}</span>
            <span class="priceLabelColA">
              <span class="priceLabelA">${labelLine1}</span>
              <span class="priceLabelA">${labelLine2}</span>
            </span>
          </div>` : ""}
          ${showPriceRow ? `
          <div class="priceRowB">
            <span class="rupeeB">₹</span><span class="priceValB">${escapeHtml(value)}${minQtyB ? "*" : ""}</span>
          </div>` : ""}
          ${showOffBadge ? (off ? `<div class="offB">₹${escapeHtml(off)} OFF</div>` : `<div class="offBmuted">OFFER PRICE</div>`) : ""}
          ${showStyleASaveBadge && off ? `<div class="saveBadgeRowB"><span class="offA">SAVE ₹${escapeHtml(off)}</span></div>` : ""}
          ${minQtyB ? `<div class="minQtyB">* Minimum Purchase Qty: ${escapeHtml(minQtyB)}</div>` : ""}
        </div>
      </div>
      <div class="bottomBannerB">${descSpan}</div>
      <div class="itemFooterB">Item No: ${escapeHtml(it.itemNo || "—")}${it.eligibleQty !== undefined && it.eligibleQty !== "" ? `   ·   Elig Qty: ${escapeHtml(fmt0(it.eligibleQty))}` : ""}${it.promoSortCode ? `   ·   Sort: ${escapeHtml(it.promoSortCode)}` : ""}</div>
    </div>
  `;
}

export const PDF_CSS_B = `
  .tagB {
    position: relative;
    background: #FFF;
    border: 1.5px solid ${RED};
    border-radius: 6px;
    overflow: hidden;
    page-break-inside: avoid;
    display: flex; flex-direction: column;
  }
  .tagB .watermark {
    position: absolute;
    top: 44px; right: 4px;
    width: 6%; height: auto;
    opacity: 0.45;
    pointer-events: none;
    z-index: 2;
  }
  .tagB > *:not(.watermark) { position: relative; z-index: 1; }
  .tagB .validTillB {
    position: absolute;
    top: 0; left: 2px; bottom: 0;
    width: 14px;
    display: flex; align-items: center; justify-content: center;
    z-index: 2; pointer-events: none;
  }
  .tagB .validTillB span {
    display: inline-block;
    transform: rotate(-90deg);
    white-space: nowrap;
    font-size: 9px; color: #6B7280; font-weight: 600;
    letter-spacing: 0.3px;
  }
  .tagB .validTillTopB {
    align-self: flex-start;
    padding: 2px 6px;
    font-size: 9px; color: #6B7280; font-weight: 600;
    letter-spacing: 0.3px;
  }
  .topBannerB {
    background: ${RED}; color: #FFF;
    text-align: center;
    font-size: 22px; font-weight: 900;
    letter-spacing: 1px;
    padding: 8px 4px;
  }
  .middleB {
    display: flex; gap: 8px; padding: 10px;
    align-items: center; min-height: 110px;
  }
  .imgWrapB {
    width: 45%; height: 100px;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .imgWrapB img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .img-placeholder { color: #94A3B8; font-size: 10px; }
  .priceColB { flex: 1; text-align: right; }
  .priceColB .priceRowA { justify-content: flex-end; }
  .priceColB.leftAlign { text-align: left; }
  .priceColB.leftAlign .priceRowA { justify-content: flex-start; }
  .priceColB.leftAlign .saveBadgeRowB { text-align: left; }
  .saveBadgeRowB { margin-top: 6px; text-align: right; }
  .priceRowB { display: flex; justify-content: flex-end; align-items: baseline; gap: 2px; }
  .rupeeB { font-size: 22px; color: #000; font-weight: 800; }
  .priceValB { font-size: 48px; color: #000; font-weight: 900; line-height: 1; }
  .offB {
    color: ${RED}; font-size: 16px; font-weight: 800;
    margin-top: 4px; letter-spacing: 0.5px;
  }
  .minQtyB {
    font-size: 10px; font-weight: 700; color: #B00020;
    text-align: right; margin-top: 4px;
  }
  .offBmuted {
    color: ${RED}; font-size: 12px; font-weight: 700;
    margin-top: 4px; letter-spacing: 0.5px;
  }
  .bottomBannerB {
    background: ${RED}; color: #FFF;
    text-align: center;
    font-size: 16px; font-weight: 800;
    letter-spacing: 0.5px;
    padding: 8px;
  }
  .itemFooterB {
    text-align: center;
    font-size: 9px; color: #94A3B8; font-weight: 600;
    padding: 4px; background: #FFF;
  }
`;

// Maps a (item, style) pair to the appropriate tag HTML — preserves
// the exact mapping from artifacts/mobile/app/pricetag-review.tsx.
// Style E uses the user-picked title from the TitleList.
export function renderTagHtmlForStyle(
  it: PriceTagRenderItem,
  style: PriceTagStyle,
  showLogo: boolean,
  logoDataUri: string,
): string {
  if (style === "B") {
    return renderTagBHtml(it, showLogo, logoDataUri, "LOW PRICES", true, true, false, false, true);
  }
  if (style === "C") {
    return renderTagBHtml(it, showLogo, logoDataUri, "Buy 1 Get 1 Free", true, false, false, false, true);
  }
  if (style === "D") {
    return renderTagBHtml(it, showLogo, logoDataUri, "RED Tag Sale", false, false, true, true, true, true);
  }
  if (style === "E") {
    return renderTagBHtml(
      it,
      showLogo,
      logoDataUri,
      it.customTitle?.trim() || "Edit Title",
      false, false, true, true, true, true,
    );
  }
  return renderTagAHtml(it, showLogo, logoDataUri);
}

// Multi-tag PDF wrapper (kept here for parity with the mobile PDF
// export — same layout, same CSS bundling rules).
export function buildPdfHtml(
  items: PriceTagRenderItem[],
  style: PriceTagStyle,
  showLogo: boolean,
  logoDataUri: string,
): string {
  const effStyleFor = (it: PriceTagRenderItem): PriceTagStyle =>
    it.style ?? style;
  const tagsHtml = items
    .map((it) => renderTagHtmlForStyle(it, effStyleFor(it), showLogo, logoDataUri))
    .join("");

  const stylesInUse = new Set<PriceTagStyle>(items.map(effStyleFor));
  if (items.length === 0) stylesInUse.add(style);
  const needsA =
    stylesInUse.has("A") || stylesInUse.has("D") || stylesInUse.has("E");
  const needsB =
    stylesInUse.has("B") ||
    stylesInUse.has("C") ||
    stylesInUse.has("D") ||
    stylesInUse.has("E");
  const styleCss =
    needsA && needsB
      ? `${PDF_CSS_A}\n${PDF_CSS_B}`
      : needsB
        ? PDF_CSS_B
        : PDF_CSS_A;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Price Tags</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;700;800&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 12px; color: #0F172A;
  }
  h1 {
    font-size: 12px; color: #64748B; margin: 0 0 10px;
    font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
  }
  .grid { display: grid; grid-template-columns: 1fr 1fr; row-gap: 30px; column-gap: 10px; }
  .tamil { font-family: "Noto Sans Tamil", -apple-system, "Segoe UI", sans-serif; }
  @media print { @page { margin: 8mm; } }
  ${styleCss}
</style>
</head><body>
  <h1>Price Tags · Style ${style} · ${items.length} item${items.length === 1 ? "" : "s"}</h1>
  <div class="grid">${tagsHtml}</div>
</body></html>`;
}

// Single-tag wrapper for the server-side JPEG renderer. The body is
// sized to the natural tag width (380px ≈ one column of the PDF
// grid). The api-server screenshots at deviceScaleFactor>=3 to get
// a high-resolution output without re-tuning every px-based size.
export function buildSingleTagHtml(
  item: PriceTagRenderItem,
  style: PriceTagStyle,
  showLogo: boolean,
  logoDataUri: string,
  opts: { widthPx?: number } = {},
): string {
  const widthPx = opts.widthPx ?? 380;
  const tagHtml = renderTagHtmlForStyle(item, style, showLogo, logoDataUri);
  const needsA = style === "A" || style === "D" || style === "E";
  const needsB =
    style === "B" || style === "C" || style === "D" || style === "E";
  const styleCss =
    needsA && needsB
      ? `${PDF_CSS_A}\n${PDF_CSS_B}`
      : needsB
        ? PDF_CSS_B
        : PDF_CSS_A;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Price Tag</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;700;800&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; background: #FFFFFF;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #0F172A;
  }
  body { width: ${widthPx}px; }
  .tamil { font-family: "Noto Sans Tamil", -apple-system, "Segoe UI", sans-serif; }
  ${styleCss}
</style>
</head><body>${tagHtml}</body></html>`;
}
