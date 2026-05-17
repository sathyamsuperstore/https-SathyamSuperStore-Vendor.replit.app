import type {
  CompanyDetails,
  PriceTagRenderItem,
  PriceTagStyle,
  TagColors,
} from "./types";
import { DEFAULT_TAG_COLORS } from "./types";
import {
  fmt0,
  priceFor,
  minPurchaseQty,
  offAmount,
  hasTamil,
  escapeHtml,
} from "./helpers";

// Brand palette defaults — used when callers don't pass a custom
// `colors` payload. Kept as named constants so existing imports
// (`RED`, `DEEP_RED`, ...) continue to work.
export const RED = DEFAULT_TAG_COLORS.red;
export const DEEP_RED = DEFAULT_TAG_COLORS.deepRed;
export const CREAM = DEFAULT_TAG_COLORS.cream;
export const GOLD = DEFAULT_TAG_COLORS.gold;

// ----- Style A HTML / CSS -----

export function renderTagAHtml(
  it: PriceTagRenderItem,
  showLogo: boolean,
  logoDataUri: string,
  showWatermark: boolean = false,
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
  const watermarkBg = showWatermark
    ? `<img class="watermarkBg" src="${logoDataUri}" alt="" />`
    : "";

  const validTill = it.promotionToDate
    ? `<div class="validTillA"><span>Valid Till: ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}</span></div>`
    : "";

  return `
    <div class="tagA">
      ${watermarkBg}
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
export function buildPdfCssA(c: TagColors = DEFAULT_TAG_COLORS): string {
  const { red: RED, deepRed: DEEP_RED, cream: CREAM, gold: GOLD } = c;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void RED; // Style A's red accents come via DEEP_RED; RED is reserved for B/C/D/E.
  return `
  .tagA {
    position: relative;
    background: ${CREAM};
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
  .tagA .watermarkBg {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 38%; height: auto;
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagA > *:not(.watermark):not(.watermarkBg) { position: relative; z-index: 1; }
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
}

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
  showWatermark: boolean = false,
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
  const watermarkBg = showWatermark
    ? `<img class="watermarkBg" src="${logoDataUri}" alt="" />`
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
      ${watermarkBg}
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

export function buildPdfCssB(c: TagColors = DEFAULT_TAG_COLORS): string {
  const { red: RED, deepRed: DEEP_RED, cream: CREAM, gold: GOLD } = c;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void DEEP_RED; void CREAM; void GOLD; // referenced via PDF_CSS_A bundle.
  void RED;
  return `
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
    top: 30px; right: 30px;
    width: 50px; height: 50px;
    opacity: 0.45;
    pointer-events: none;
    z-index: 2;
  }
  .tagB .watermarkBg {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 38%; height: auto;
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagB > *:not(.watermark):not(.watermarkBg) { position: relative; z-index: 1; }
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
}

// Maps a (item, style) pair to the appropriate tag HTML — preserves
// the exact mapping from artifacts/mobile/app/pricetag-review.tsx.
// Style E uses the user-picked title from the TitleList.
export function renderTagHtmlForStyle(
  it: PriceTagRenderItem,
  style: PriceTagStyle,
  showLogo: boolean,
  logoDataUri: string,
  showWatermark: boolean = false,
): string {
  if (style === "B") {
    return renderTagBHtml(it, showLogo, logoDataUri, "LOW PRICES", true, true, false, false, true, false, showWatermark);
  }
  if (style === "C") {
    return renderTagBHtml(it, showLogo, logoDataUri, "Buy 1 Get 1 Free", true, false, false, false, true, false, showWatermark);
  }
  if (style === "D") {
    return renderTagBHtml(it, showLogo, logoDataUri, "RED Tag Sale", false, false, true, true, true, true, showWatermark);
  }
  if (style === "E") {
    return renderTagBHtml(
      it,
      showLogo,
      logoDataUri,
      it.customTitle?.trim() || "Edit Title",
      false, false, true, true, true, true, showWatermark,
    );
  }
  return renderTagAHtml(it, showLogo, logoDataUri, showWatermark);
}

// Multi-tag PDF wrapper (kept here for parity with the mobile PDF
// export — same layout, same CSS bundling rules).
export function buildPdfHtml(
  items: PriceTagRenderItem[],
  style: PriceTagStyle,
  showLogo: boolean,
  logoDataUri: string,
  colors: TagColors = DEFAULT_TAG_COLORS,
  showWatermark: boolean = false,
): string {
  const effStyleFor = (it: PriceTagRenderItem): PriceTagStyle =>
    it.style ?? style;
  const tagsHtml = items
    .map((it) => renderTagHtmlForStyle(it, effStyleFor(it), showLogo, logoDataUri, showWatermark))
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
  const cssA = buildPdfCssA(colors);
  const cssB = buildPdfCssB(colors);
  const styleCss =
    needsA && needsB ? `${cssA}\n${cssB}` : needsB ? cssB : cssA;

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

// ----- Square Showcase (1:1, Instagram-friendly) -----
//
// A standalone 1:1 layout used by the mobile "Showcase SQ" button.
// Distinct from the PDF tag styles (A/B/C/D/E) because it has to
// look great when posted as an Instagram square: bigger imagery,
// centered hierarchy, and a horizontally-oriented "Valid Till" line
// at the bottom (gray, no rotation).
export function renderSquareShowcaseHtml(
  it: PriceTagRenderItem,
  showLogo: boolean,
  logoDataUri: string,
  opts: {
    company?: CompanyDetails;
    whatsappLogoDataUri?: string;
    appStoreLogoDataUri?: string;
    showWatermark?: boolean;
  } = {},
): string {
  const { value } = priceFor(it);
  const mrp = fmt0(it.mrp);
  const off = offAmount(it);
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri
    ? `<img src="${it.imageUri}" />`
    : `<div class="img-placeholder">No Image</div>`;
  const title = (it.customTitle?.trim() || "SPECIAL OFFER").toUpperCase();
  const itemNo = (it.itemNo ?? "").trim();
  const validTill = it.promotionToDate
    ? `Valid Till : ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}`
    : "";
  const watermark = showLogo
    ? `<img class="watermark" src="${logoDataUri}" alt="" />`
    : "";
  const watermarkBg = opts.showWatermark
    ? `<img class="watermarkBg" src="${logoDataUri}" alt="" />`
    : "";

  // Compose the company footer band only when at least one
  // identity field is present — keeps the layout clean for callers
  // that don't supply CompanyDetails (e.g. the legacy PDF flow).
  const company = opts.company ?? {};
  const tr = (s?: string): string => (typeof s === "string" ? s.trim() : "");
  const companyName = tr(company.companyName);
  const addr1 = tr(company.address1);
  const addr2 = tr(company.address2);
  const cityLine = [tr(company.city), tr(company.state), tr(company.pincode)]
    .filter(Boolean)
    .join(", ");
  const country = tr(company.country);
  const cityCountry = [cityLine, country].filter(Boolean).join(" · ");
  const mobile = tr(company.mobile);
  const whatsapp = tr(company.whatsapp);
  const gst = tr(company.gstNo);
  const fssai = tr(company.fssaiNo);
  const hasCompany =
    !!(companyName || addr1 || addr2 || cityCountry || mobile || whatsapp ||
      gst || fssai);

  const waIcon = opts.whatsappLogoDataUri
    ? `<img class="waIcon" src="${opts.whatsappLogoDataUri}" alt="WA" />`
    : "";
  // When mobile and whatsapp are the same number we collapse to a
  // single chip with the WA icon. Otherwise show two chips: phone
  // for the landline/mobile, WA icon for the whatsapp number.
  const phoneRow =
    whatsapp && whatsapp === mobile
      ? `<span class="phoneItem">${waIcon}<span>${escapeHtml(whatsapp)}</span></span>`
      : [
          mobile
            ? `<span class="phoneItem">📞 ${escapeHtml(mobile)}</span>`
            : "",
          whatsapp
            ? `<span class="phoneItem">${waIcon}<span>${escapeHtml(whatsapp)}</span></span>`
            : "",
        ]
          .filter(Boolean)
          .join("");

  const idLine = [
    gst ? `GST: ${escapeHtml(gst)}` : "",
    fssai ? `FSSAI: ${escapeHtml(fssai)}` : "",
  ]
    .filter(Boolean)
    .join("  ·  ");

  const storesBadge = opts.appStoreLogoDataUri
    ? `<img class="storesBadge" src="${opts.appStoreLogoDataUri}" alt="Get the app" />`
    : "";

  const companyBlock = hasCompany
    ? `
      <div class="companySq">
        <div class="companyText">
          ${companyName ? `<div class="companyName">${escapeHtml(companyName)}</div>` : ""}
          ${addr1 ? `<div class="companyAddr">${escapeHtml(addr1)}</div>` : ""}
          ${addr2 ? `<div class="companyAddr">${escapeHtml(addr2)}</div>` : ""}
          ${cityCountry ? `<div class="companyAddr">${escapeHtml(cityCountry)}</div>` : ""}
          ${phoneRow ? `<div class="companyPhones">${phoneRow}</div>` : ""}
          ${idLine ? `<div class="companyIds">${idLine}</div>` : ""}
        </div>
        ${storesBadge ? `<div class="companyStores">${storesBadge}</div>` : ""}
      </div>
    `
    : "";

  return `
    <div class="tagSq">
      ${watermarkBg}
      ${watermark}
      <div class="topBarSq">${escapeHtml(title)}</div>
      <div class="imgRowSq">
        <div class="imgFrameSq">${img}</div>
      </div>
      <div class="descSq">${descSpan}</div>
      <div class="priceColSq">
        ${mrp ? `<div class="mrpLineSq">MRP <span class="strike">₹${escapeHtml(mrp)}</span></div>` : ""}
        <div class="priceBoxSq">
          <span class="priceCurrencySq">₹</span><span class="priceValueSq">${escapeHtml(value)}</span>
        </div>
        ${off ? `<div class="saveRowSq"><span class="savePillSq">SAVE ₹${escapeHtml(off)}</span></div>` : ""}
      </div>
      <div class="footerRowSq">
        <span class="itemNoSq">${itemNo ? "Item: " + escapeHtml(itemNo) : ""}</span>
        <span class="validTillSq">${validTill}</span>
      </div>
      ${companyBlock}
    </div>
  `;
}

export function buildPdfCssSq(c: TagColors = DEFAULT_TAG_COLORS): string {
  const { red: RED, deepRed: DEEP_RED, cream: CREAM, gold: GOLD } = c;
  void RED; // Banner SQ Detailed uses white/deepRed/cream/gold; RED reserved.
  return `
  .tagSq {
    width: 540px; height: 540px;
    background: linear-gradient(180deg, ${CREAM} 0%, #F2E5C2 100%);
    border: 4px solid ${DEEP_RED};
    position: relative;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .tagSq .watermark {
    position: absolute;
    top: 30px; right: 30px;
    width: 50px; height: 50px;
    opacity: 0.55;
    pointer-events: none;
    z-index: 3;
  }
  .tagSq .watermarkBg {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 60%; height: auto;
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagSq > *:not(.watermark):not(.watermarkBg) { position: relative; z-index: 1; }
  .tagSq .topBarSq {
    background: ${DEEP_RED};
    color: #FFF;
    text-align: center;
    font-size: 26px; font-weight: 900;
    letter-spacing: 1.5px;
    padding: 12px 16px;
    line-height: 1.1;
  }
  .tagSq .imgRowSq {
    flex: 1;
    min-height: 0;
    display: flex; align-items: center; justify-content: center;
    padding: 14px;
  }
  .tagSq .imgFrameSq {
    width: 200px; height: 200px;
    background: #FFFFFF;
    border: 2px solid ${GOLD};
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    padding: 10px;
    box-shadow: 0 2px 0 rgba(122, 15, 25, 0.12);
  }
  .tagSq .imgFrameSq img {
    max-width: 100%; max-height: 100%;
    object-fit: contain;
  }
  .tagSq .imgFrameSq .img-placeholder {
    color: #94A3B8; font-size: 14px; font-weight: 700;
  }
  .tagSq .descSq {
    text-align: center;
    color: #1F2937;
    font-size: 20px; font-weight: 800;
    line-height: 1.2;
    padding: 0 18px;
    margin-bottom: 6px;
    /* Cap to two lines so long descriptions don't break the layout */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tagSq .priceColSq {
    display: flex; flex-direction: column; align-items: center;
    gap: 4px;
    padding: 0 16px;
  }
  .tagSq .mrpLineSq {
    font-size: 14px; color: #6B7280; font-weight: 700;
    letter-spacing: 0.5px;
  }
  .tagSq .mrpLineSq .strike { text-decoration: line-through; }
  .tagSq .priceBoxSq {
    background: ${DEEP_RED};
    border-radius: 12px;
    padding: 8px 26px;
    display: inline-flex; align-items: baseline; gap: 6px;
  }
  /* Big promo price text → white on the deepRed pill for max contrast
     and consistency with the Minimal variant. (Earlier red-on-deepRed
     spec was reverted: ~3:1 contrast was hard to read.) */
  .tagSq .priceCurrencySq {
    color: #FFF; font-size: 26px; font-weight: 900;
  }
  .tagSq .priceValueSq {
    color: #FFF; font-size: 48px; font-weight: 900; line-height: 1;
  }
  .tagSq .saveRowSq {
    display: flex; justify-content: center;
  }
  .tagSq .savePillSq {
    background: ${GOLD};
    color: ${DEEP_RED};
    font-weight: 900; font-size: 14px;
    letter-spacing: 0.5px;
    padding: 4px 16px;
    border-radius: 999px;
  }
  .tagSq .footerRowSq {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 16px 4px;
    font-size: 12px; color: #6B7280; font-weight: 700;
    letter-spacing: 0.3px;
  }
  /* Spec: item-no chip → deepRed. Rendered as a tinted pill so it
     reads as a chip rather than plain text. */
  .tagSq .itemNoSq {
    color: ${DEEP_RED};
    background: ${DEEP_RED}1A;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 800;
  }
  /* Hide tinted background when no item number is provided. */
  .tagSq .itemNoSq:empty { background: transparent; padding: 0; }
  .tagSq .validTillSq { color: #6B7280; }
  /* Spec: footer divider → deepRed. Tinted so the band stays soft
     visually while still being theme-driven. */
  .tagSq .companySq {
    margin-top: auto;
    display: flex; align-items: center; justify-content: center;
    gap: 14px;
    padding: 8px 14px 10px;
    background: ${DEEP_RED}10;
    border-top: 1px solid ${DEEP_RED}2E;
    text-align: center;
  }
  .tagSq .companyText { text-align: center; }
  .tagSq .companyPhones { justify-content: center; }
  .tagSq .companyText {
    min-width: 0;
    color: #1F2937;
    font-size: 10px;
    line-height: 1.25;
    font-weight: 600;
  }
  .tagSq .companyName {
    font-size: 13px; font-weight: 900; color: ${DEEP_RED};
    letter-spacing: 0.3px;
    margin-bottom: 1px;
  }
  .tagSq .companyAddr { color: #374151; }
  .tagSq .companyPhones {
    margin-top: 2px;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    color: #111827;
  }
  .tagSq .phoneItem {
    display: inline-flex; align-items: center; gap: 3px;
  }
  .tagSq .waIcon {
    width: 12px; height: 12px; object-fit: contain;
    vertical-align: middle;
  }
  .tagSq .companyIds {
    margin-top: 1px;
    color: #6B7280; font-weight: 700; font-size: 9px;
    letter-spacing: 0.3px;
  }
  .tagSq .companyStores {
    flex-shrink: 0;
    display: flex; align-items: center;
  }
  .tagSq .storesBadge {
    height: 36px; width: auto; object-fit: contain;
  }
`;
}

// Square 1:1 wrapper for the server-side JPEG renderer. The body is
// sized exactly widthPx × widthPx so Chromium clips a perfect square.
export function buildSquareShowcaseHtml(
  item: PriceTagRenderItem,
  showLogo: boolean,
  logoDataUri: string,
  opts: {
    widthPx?: number;
    colors?: TagColors;
    company?: CompanyDetails;
    whatsappLogoDataUri?: string;
    appStoreLogoDataUri?: string;
    variant?: "detailed" | "minimal";
    showWatermark?: boolean;
  } = {},
): string {
  const widthPx = opts.widthPx ?? 540;
  const colors = opts.colors ?? DEFAULT_TAG_COLORS;
  const variant = opts.variant ?? "detailed";
  const tagHtml =
    variant === "minimal"
      ? renderSquareMinimalHtml(item, showLogo, logoDataUri, {
          company: opts.company,
          whatsappLogoDataUri: opts.whatsappLogoDataUri,
          appStoreLogoDataUri: opts.appStoreLogoDataUri,
          showWatermark: opts.showWatermark,
        })
      : renderSquareShowcaseHtml(item, showLogo, logoDataUri, {
          company: opts.company,
          whatsappLogoDataUri: opts.whatsappLogoDataUri,
          appStoreLogoDataUri: opts.appStoreLogoDataUri,
          showWatermark: opts.showWatermark,
        });
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Price Tag — Square</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;700;800&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; background: #FFFFFF;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #0F172A;
  }
  body { width: ${widthPx}px; height: ${widthPx}px; }
  .tamil { font-family: "Noto Sans Tamil", -apple-system, "Segoe UI", sans-serif; }
  .tagSq, .tagSqMin {
    width: ${widthPx}px !important;
    height: ${widthPx}px !important;
  }
  ${variant === "minimal" ? buildSquareMinimalCss(colors) : buildPdfCssSq(colors)}
</style>
</head><body>${tagHtml}</body></html>`;
}

// ===========================================================================
// Square 1:1 — "minimal" variant
// ---------------------------------------------------------------------------
// Same 540×540 Instagram canvas, but trades the full company-details
// footer for a slim store-name + WhatsApp bar, and stacks the
// app-store badges next to the price box. Uses the shared TagColors
// palette so brand-colour overrides flow through identically to the
// detailed variant.
// ===========================================================================
export function renderSquareMinimalHtml(
  it: PriceTagRenderItem,
  showLogo: boolean,
  logoDataUri: string,
  opts: {
    company?: CompanyDetails;
    whatsappLogoDataUri?: string;
    appStoreLogoDataUri?: string;
    showWatermark?: boolean;
  } = {},
): string {
  const { value } = priceFor(it);
  const mrp = fmt0(it.mrp);
  const off = offAmount(it);
  const desc = it.description || "";
  const tamil = hasTamil(desc);
  const descSpan = tamil
    ? `<span class="tamil">${escapeHtml(desc)}</span>`
    : escapeHtml(desc);
  const img = it.imageUri
    ? `<img src="${it.imageUri}" />`
    : `<div class="img-placeholder">No Image</div>`;
  const title = (it.customTitle?.trim() || "VALUE PACK").toUpperCase();
  const itemNo = (it.itemNo ?? "").trim();
  const validTill = it.promotionToDate
    ? `Valid Till : ${escapeHtml(
        (it.promotionToDate || "").trim().replace(/\//g, "-"),
      )}`
    : "";
  const watermark = showLogo
    ? `<img class="watermark" src="${logoDataUri}" alt="" />`
    : "";
  const watermarkBg = opts.showWatermark
    ? `<img class="watermarkBg" src="${logoDataUri}" alt="" />`
    : "";

  const tr = (s?: string): string => (typeof s === "string" ? s.trim() : "");
  const company = opts.company ?? {};
  const storeName = tr(company.companyName);
  const whatsapp = tr(company.whatsapp) || tr(company.mobile);
  const waIcon = opts.whatsappLogoDataUri
    ? `<img class="waIcon" src="${opts.whatsappLogoDataUri}" alt="WA" />`
    : "";
  const storeBar =
    storeName || whatsapp
      ? `<div class="storeBarMin">
          <span class="storeNameMin">${escapeHtml(storeName)}</span>
          ${
            whatsapp
              ? `<span class="storeWaMin">${waIcon}<span>${escapeHtml(whatsapp)}</span></span>`
              : ""
          }
        </div>`
      : "";

  const stores = opts.appStoreLogoDataUri
    ? `<img class="storesBadgeMin" src="${opts.appStoreLogoDataUri}" alt="Get the app" />`
    : "";

  return `
    <div class="tagSqMin">
      <div class="topBarMin">${escapeHtml(title)}</div>
      <div class="bodyMin">
        ${watermarkBg}
        ${watermark}
        <div class="imgRowMin">
          <div class="imgFrameMin">${img}</div>
        </div>
        <div class="descMin">${descSpan}</div>
        ${mrp ? `<div class="mrpLineMin">MRP <span class="strike">₹${escapeHtml(mrp)}</span></div>` : ""}
        <div class="priceRowMin">
          <div class="priceBoxMin">
            <span class="priceCurrencyMin">₹</span><span class="priceValueMin">${escapeHtml(value)}</span>
          </div>
          ${stores ? `<div class="priceStoresMin">${stores}</div>` : ""}
        </div>
        ${off ? `<div class="saveRowMin"><span class="savePillMin">SAVE ₹${escapeHtml(off)}</span></div>` : ""}
        <div class="footerRowMin">
          <span class="itemNoMin">${itemNo ? "Item: " + escapeHtml(itemNo) : ""}</span>
          <span class="validTillMin">${validTill}</span>
        </div>
      </div>
      ${storeBar}
    </div>
  `;
}

export function buildSquareMinimalCss(c: TagColors = DEFAULT_TAG_COLORS): string {
  const { red: RED, deepRed: DEEP_RED, cream: CREAM, gold: GOLD } = c;
  void RED;
  return `
  .tagSqMin {
    width: 540px; height: 540px;
    background: #FFFFFF;
    position: relative;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .tagSqMin .topBarMin {
    background: ${DEEP_RED};
    color: #FFF;
    text-align: center;
    font-size: 26px; font-weight: 900;
    letter-spacing: 1.5px;
    padding: 14px 16px;
    line-height: 1.1;
  }
  .tagSqMin .bodyMin {
    flex: 1;
    min-height: 0;
    position: relative;
    background: linear-gradient(180deg, #FFFFFF 0%, ${CREAM} 100%);
    display: flex; flex-direction: column;
    padding: 6px 16px 8px;
  }
  .tagSqMin .watermark {
    position: absolute;
    top: 30px; right: 30px;
    width: 50px; height: 50px;
    opacity: 0.45;
    pointer-events: none;
    z-index: 3;
  }
  .tagSqMin .watermarkBg {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 60%; height: auto;
    opacity: 0.30;
    pointer-events: none;
    z-index: 0;
  }
  .tagSqMin .bodyMin > *:not(.watermark):not(.watermarkBg) { position: relative; z-index: 1; }
  .tagSqMin .imgRowMin {
    flex: 1;
    min-height: 0;
    display: flex; align-items: center; justify-content: center;
    padding: 4px 0 8px;
  }
  .tagSqMin .imgFrameMin {
    width: 220px; height: 220px;
    background: #FFFFFF;
    border: 3px solid ${GOLD};
    border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    padding: 10px;
  }
  .tagSqMin .imgFrameMin img {
    max-width: 100%; max-height: 100%;
    object-fit: contain;
  }
  .tagSqMin .imgFrameMin .img-placeholder {
    color: #94A3B8; font-size: 14px; font-weight: 700;
  }
  .tagSqMin .descMin {
    text-align: center;
    color: #1F2937;
    font-size: 20px; font-weight: 800;
    line-height: 1.2;
    margin-bottom: 6px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tagSqMin .mrpLineMin {
    text-align: center;
    font-size: 14px; color: #6B7280; font-weight: 700;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .tagSqMin .mrpLineMin .strike { text-decoration: line-through; }
  .tagSqMin .priceRowMin {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 4px;
    min-height: 72px;
  }
  .tagSqMin .priceBoxMin {
    background: ${DEEP_RED};
    border-radius: 14px;
    padding: 10px 28px;
    display: inline-flex; align-items: baseline; gap: 6px;
  }
  .tagSqMin .priceCurrencyMin {
    color: #FFF; font-size: 28px; font-weight: 900;
  }
  .tagSqMin .priceValueMin {
    color: #FFF; font-size: 52px; font-weight: 900; line-height: 1;
  }
  /* Float the app-store badges to the right edge so the price box
     stays centred in the square frame. */
  .tagSqMin .priceStoresMin {
    position: absolute;
    right: 0; top: 50%;
    transform: translateY(-50%);
    display: flex; align-items: center;
  }
  .tagSqMin .storesBadgeMin {
    height: 60px; width: auto; object-fit: contain;
  }
  .tagSqMin .saveRowMin {
    display: flex; justify-content: center;
    margin-top: 2px;
  }
  .tagSqMin .savePillMin {
    background: ${GOLD};
    color: ${DEEP_RED};
    font-weight: 900; font-size: 14px;
    letter-spacing: 0.5px;
    padding: 4px 18px;
    border-radius: 999px;
  }
  /* Spec: footer chips → deepRed. Itemno + ValidTill rendered as
     deepRed-tinted pills. */
  .tagSqMin .footerRowMin {
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 2px 0;
    font-size: 12px; font-weight: 800;
    letter-spacing: 0.3px;
  }
  .tagSqMin .itemNoMin,
  .tagSqMin .validTillMin {
    color: ${DEEP_RED};
    background: ${DEEP_RED}1A;
    padding: 2px 8px;
    border-radius: 999px;
  }
  /* Hide the tinted background on empty chips (nothing to anchor to). */
  .tagSqMin .itemNoMin:empty,
  .tagSqMin .validTillMin:empty { background: transparent; padding: 0; }
  .tagSqMin .storeBarMin {
    background: ${DEEP_RED};
    color: #FFF;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    padding: 10px 18px;
    font-size: 16px; font-weight: 900;
    letter-spacing: 0.6px;
  }
  .tagSqMin .storeNameMin { text-transform: uppercase; }
  .tagSqMin .storeWaMin {
    display: inline-flex; align-items: center; gap: 6px;
    font-weight: 800;
  }
  .tagSqMin .waIcon {
    width: 22px; height: 22px; object-fit: contain;
    background: #FFF; border-radius: 50%;
    padding: 2px;
  }
`;
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
  opts: { widthPx?: number; colors?: TagColors; showWatermark?: boolean } = {},
): string {
  const widthPx = opts.widthPx ?? 380;
  const colors = opts.colors ?? DEFAULT_TAG_COLORS;
  const showWatermark = opts.showWatermark ?? false;
  const tagHtml = renderTagHtmlForStyle(item, style, showLogo, logoDataUri, showWatermark);
  const needsA = style === "A" || style === "D" || style === "E";
  const needsB =
    style === "B" || style === "C" || style === "D" || style === "E";
  const cssA = buildPdfCssA(colors);
  const cssB = buildPdfCssB(colors);
  const styleCss =
    needsA && needsB ? `${cssA}\n${cssB}` : needsB ? cssB : cssA;

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
