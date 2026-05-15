import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_TITLES } from "@/data/defaultTitles";
import { DEFAULT_TAG_COLORS, type TagColors } from "@workspace/pricetag-html";
import { Alert, Platform } from "react-native";

const SESSION_KEY = "@currentUserId";

export type OrderStatus = "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";
export type UserType = "Admin" | "Vendor" | "Manager" | "Staff";

export interface AppUser {
  id: string;
  userId: string;
  password: string;
  userType: UserType;
  vendorCode: string;
  vendorName: string;
  vendorMobileNo1: string;
  vendorMobileNo2: string;
  createdAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  vendorCode: string;
  vendorGstNo: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  category: string;
  // Free-text supplier-level notes the user wants to surface to the supplier
  // on PDF exports (not the Excel export). Optional so existing suppliers
  // already in AsyncStorage hydrate cleanly without a migration step.
  generalNotes?: string;
  // Up to 3 reference photos (invoice, shelf, packaging…) attached to the
  // supplier. Stored as `data:image/...;base64,...` strings so the PDF
  // exporter can embed them inline without a file fetch. Optional so
  // existing suppliers hydrate cleanly without a migration step.
  photos?: string[];
  createdAt: string;
}

// A supplier is treated as "incomplete" (a placeholder that still needs
// finishing) when both phone AND email are missing. The bulk
// "Create suppliers from codes" import path produces exactly this shape,
// so the suppliers list can flag and filter them without a schema change.
// Single source of truth so the card badge and the list filter agree.
export function isSupplierIncomplete(s: Supplier): boolean {
  const phone = (s.phone ?? "").trim();
  const email = (s.email ?? "").trim();
  return phone === "" && email === "";
}

export interface OrderItem {
  id: string;
  name: string;
  brand?: string;
  category?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  stock?: number;
  min?: number;
  sortNo?: number;
  newStockQty?: number;
  notes?: string;
}

// Brand and Category are free-text fields, so "Acme", "acme", and "Acme " can
// all show up as separate values. These helpers normalize them so suggestion
// pools and filter pills collapse near-duplicates without migrating any data.
export function normalizeFilterKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

// Collapses an iterable of raw brand/category strings into a sorted list of
// canonical spellings — one per normalized key — preferring the spelling that
// appears most often (ties broken alphabetically for a stable display).
export function collapseToCanonical(values: Iterable<string | null | undefined>): string[] {
  const groups = new Map<string, Map<string, number>>();
  for (const raw of values) {
    if (raw == null) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    let inner = groups.get(key);
    if (!inner) {
      inner = new Map();
      groups.set(key, inner);
    }
    inner.set(trimmed, (inner.get(trimmed) ?? 0) + 1);
  }
  const canonical: string[] = [];
  for (const inner of groups.values()) {
    let best = "";
    let bestCount = -1;
    for (const [spelling, count] of inner) {
      if (
        count > bestCount ||
        (count === bestCount && spelling.localeCompare(best) < 0)
      ) {
        bestCount = count;
        best = spelling;
      }
    }
    canonical.push(best);
  }
  return canonical.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

export interface Order {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  status: OrderStatus;
  items: OrderItem[];
  totalAmount: number;
  notes: string;
  expectedDelivery: string;
  syncDate?: string;
  beat?: string;
  // ISO date the source Excel file was created (read from the workbook's
  // own metadata at import time; falls back to the file's lastModified
  // if the workbook has no Created prop). Optional: orders created
  // manually or imported from a file without props won't have it.
  fileCreatedDate?: string;
  createdAt: string;
  updatedAt: string;
}

interface AppContextType {
  suppliers: Supplier[];
  orders: Order[];
  appUsers: AppUser[];
  currentUser: AppUser | null;
  login: (userId: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  addSupplier: (supplier: Omit<Supplier, "id" | "createdAt">) => Promise<void>;
  updateSupplier: (id: string, supplier: Partial<Supplier>) => Promise<void>;
  setSupplierGeneralNotes: (id: string, generalNotes: string) => Promise<void>;
  setSupplierPhotos: (id: string, photos: string[]) => Promise<void>;
  deleteSupplier: (id: string) => Promise<void>;
  addOrder: (order: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">) => Promise<void>;
  addOrdersBatch: (orders: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[]) => Promise<void>;
  addOrdersBatchAsync: (
    orders: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[],
    onProgress?: (processed: number, total: number) => void | Promise<void>,
    shouldCancel?: () => boolean
  ) => Promise<{ saved: number; canceled: boolean }>;
  updateOrder: (id: string, order: Partial<Order>) => Promise<void>;
  deleteOrder: (id: string) => Promise<void>;
  clearAllOrders: () => Promise<void>;
  updateOrderStatus: (id: string, status: OrderStatus) => Promise<void>;
  addAppUser: (user: Omit<AppUser, "id" | "createdAt">) => Promise<void>;
  updateAppUser: (id: string, user: Partial<AppUser>) => Promise<void>;
  deleteAppUser: (id: string) => Promise<void>;
  addSuppliersBatch: (
    items: Omit<Supplier, "id" | "createdAt">[]
  ) => Promise<{ added: number; skipped: string[]; addedSuppliers: Supplier[] }>;
  deleteSuppliersBatch: (ids: string[]) => Promise<void>;
  addUsersBatch: (
    items: Omit<AppUser, "id" | "createdAt">[]
  ) => Promise<{ added: number; skipped: string[] }>;
  // Bulk wipes used by the Admn hub. Each clears the whole table for
  // the corresponding entity, mirroring the write-first pattern used
  // by `clearAllOrders` / `clearMrpBatch` / `clearLatestPurchases`.
  clearAllSuppliers: () => Promise<void>;
  clearAllAppUsers: () => Promise<void>;
  mrpEntries: MrpEntry[];
  saveMrpBatch: (entries: MrpEntry[]) => Promise<void>;
  clearMrpBatch: () => Promise<void>;
  rasiItems: RasiItem[];
  saveRasiItems: (entries: RasiItem[]) => Promise<void>;
  clearRasiItems: () => Promise<void>;
  latestPurchases: LatestPurchaseEntry[];
  saveLatestPurchasesBatch: (entries: LatestPurchaseEntry[]) => Promise<void>;
  clearLatestPurchases: () => Promise<void>;
  promoEntries: PromoEntry[];
  // Rolling "previous" snapshot of the Promo list, captured automatically
  // before each savePromoBatch (and on demand via snapshotPromoNow). Used
  // by the PromoPrev viewer and the Compare diff view to surface what
  // changed since the last import.
  promoPrevEntries: PromoEntry[];
  promoPrevSnapshotAt: number | null;
  // Persist a fresh batch and auto-snapshot whatever was previously
  // there into promoPrevEntries (unless the current list is empty —
  // there's nothing meaningful to snapshot on first import).
  savePromoBatch: (entries: PromoEntry[]) => Promise<void>;
  // Manual snapshot — copies the current promoEntries into the prev
  // bucket without replacing live data. No-op if promoEntries is empty.
  snapshotPromoNow: () => Promise<void>;
  clearPromoBatch: () => Promise<void>;
  // Wipes only the prev snapshot; leaves live promoEntries alone.
  clearPromoPrev: () => Promise<void>;
  lastSupplyDates: LastSupplyDateEntry[];
  saveLastSupplyDateBatch: (entries: LastSupplyDateEntry[]) => Promise<void>;
  clearLastSupplyDates: () => Promise<void>;
  // RodeoItems — flat product catalogue imported from Excel. Each
  // import replaces the entire list (mirrors the MRP / Promo "fresh
  // snapshot" behaviour) so the table always reflects the latest sheet.
  rodeoItems: RodeoItem[];
  saveRodeoItemsBatch: (entries: RodeoItem[]) => Promise<void>;
  clearRodeoItems: () => Promise<void>;
  // User-entered "New Qty" overrides per Promo row. Map key is
  // `${itemNo}|${batchNo}`. Setter accepts `undefined` to clear a row.
  promoNewQty: Record<string, number>;
  setPromoNewQtyValue: (key: string, value: number | undefined) => Promise<void>;
  // PriceTag workflow — items the user picked on PromoPrint and is
  // previewing / exporting on PriceTag Preview. Persisted so the user
  // can leave the screen and come back without losing their selection.
  priceTagItems: PriceTagItem[];
  savePriceTagItems: (items: PriceTagItem[]) => Promise<void>;
  removePriceTagItem: (key: string) => Promise<void>;
  setPriceTagImage: (key: string, imageUri: string | null) => Promise<void>;
  clearPriceTagItems: () => Promise<void>;
  // Visual style applied to every price tag (on-screen + PDF export).
  // Persisted so the user's last choice sticks across app restarts.
  priceTagStyle: PriceTagStyle;
  setPriceTagStyle: (style: PriceTagStyle) => Promise<void>;
  // Whether to overlay the Sathyam Super Store logo as a 30%-opacity
  // watermark on every price tag (on-screen + PDF). Persisted so the
  // user's last choice sticks across app restarts. Default: true.
  priceTagShowLogo: boolean;
  setPriceTagShowLogo: (show: boolean) => Promise<void>;
  // Optional free-text title prepended to the PDF export filename
  // ("Sathyam Super Store Promo - <title> DDMMYY HHMM.pdf"). Empty
  // string means no title set. Persisted so it survives app restarts.
  priceTagTitle: string;
  setPriceTagTitle: (title: string) => Promise<void>;
  // PriceTag Review — independent clone of the PriceTag Preview state.
  // Same shape, different storage so the user can fork the preview at
  // save time and edit the two lists separately later.
  priceTagReviewItems: PriceTagItem[];
  savePriceTagReviewItems: (items: PriceTagItem[]) => Promise<void>;
  removePriceTagReviewItem: (key: string) => Promise<void>;
  setPriceTagReviewImage: (key: string, imageUri: string | null) => Promise<void>;
  clearPriceTagReviewItems: () => Promise<void>;
  priceTagReviewStyle: PriceTagStyle;
  setPriceTagReviewStyle: (style: PriceTagStyle) => Promise<void>;
  priceTagReviewShowLogo: boolean;
  setPriceTagReviewShowLogo: (show: boolean) => Promise<void>;
  // Square (1:1) showcase layout variant. "detailed" prints the
  // full company-details footer (address, GST, FSSAI). "minimal"
  // prints just a slim store-name + WhatsApp bar at the bottom and
  // stacks the app-store badges next to the price box.
  priceTagSquareVariant: "detailed" | "minimal";
  setPriceTagSquareVariant: (v: "detailed" | "minimal") => Promise<void>;
  priceTagReviewTitle: string;
  setPriceTagReviewTitle: (title: string) => Promise<void>;
  // Brand-color palette applied to all Style A/B/C/D/E pricetags
  // (on-screen preview, PDF export, and server-rendered JPEG). Empty
  // / corrupt values fall back to DEFAULT_TAG_COLORS.
  tagColors: TagColors;
  setTagColors: (colors: TagColors) => Promise<void>;
  resetTagColors: () => Promise<void>;
  // User-saved palette presets, surfaced on the TagColours screen
  // alongside the built-in presets. Persisted as JSON; corrupt entries
  // are dropped on load.
  customTagPresets: TagColorPreset[];
  saveCustomTagPreset: (name: string, colors: TagColors) => Promise<void>;
  deleteCustomTagPreset: (name: string) => Promise<void>;
  replaceCustomTagPresets: (presets: TagColorPreset[]) => Promise<void>;
  // User-managed catalogue of punchy banner titles, surfaced on the
  // TitleList tab. Seeded with ~400 defaults on first launch and then
  // freely editable (add / edit / delete + Excel import / export).
  titleList: TitleListItem[];
  saveTitleList: (items: TitleListItem[]) => Promise<void>;
  addTitle: (title: string, category?: string) => Promise<void>;
  updateTitle: (id: string, title: string, category?: string) => Promise<void>;
  deleteTitle: (id: string) => Promise<void>;
  // Wall-clock timestamp (Unix ms) recorded the last time the user
  // refreshed the upstream data snapshot. Driven by the "DownloadTime"
  // button on the Admin tab and auto-stamped after a successful Promo
  // import. Surfaced on the Dashboard so users always know how fresh
  // the numbers they're looking at really are. `null` until the user
  // records the first download.
  dataDownloadTime: number | null;
  setDataDownloadTimeNow: () => Promise<void>;
  // Persist an explicit timestamp (Unix ms). Used by the Excel
  // importer on the Data Download Time tab so the saved value comes
  // straight from the upstream sheet rather than the device clock.
  setDataDownloadTimeValue: (ms: number) => Promise<void>;
  clearDataDownloadTime: () => Promise<void>;
  // Company / store identity (name, address, GST, etc.) shown on
  // headers, exports and invoices. Edited from the "Company Details"
  // tab and persisted as JSON. Falls back to DEFAULT_COMPANY_DETAILS
  // when the stored value is missing or corrupt.
  companyDetails: CompanyDetails;
  setCompanyDetails: (details: CompanyDetails) => Promise<void>;
  resetCompanyDetails: () => Promise<void>;
  // CompanyR — second store-identity profile (same shape as
  // companyDetails, separate AsyncStorage slot + defaults).
  companyDetailsR: CompanyDetails;
  setCompanyDetailsR: (details: CompanyDetails) => Promise<void>;
  resetCompanyDetailsR: () => Promise<void>;
  // True once the initial AsyncStorage hydration has finished (success or
  // failure). Screens that key off `orders`/`suppliers` use this to avoid
  // flashing an empty/"not found" state on a browser refresh while the
  // first load is still in flight.
  hydrated: boolean;
}

// Company / store identity captured on the Company Details tab. All
// fields are free-text strings — phone numbers stay strings so the
// "+91…" prefix is preserved, and IDs like GST / FSSAI keep leading
// zeros. Optional fields default to empty strings (never undefined)
// so consumers don't need to null-check.
export interface CompanyDetails {
  companyName: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
  mobile: string;
  whatsapp: string;
  gstNo: string;
  fssaiNo: string;
}

export const DEFAULT_COMPANY_DETAILS: CompanyDetails = {
  companyName: "Sathyam Super Store",
  address1: "2A Mettupalayam Road",
  address2: "Cheran Nagar",
  city: "Coimbatore",
  state: "TN",
  country: "India",
  pincode: "641029",
  mobile: "+919788144868",
  whatsapp: "+919788144868",
  gstNo: "",
  fssaiNo: "",
};

// "CompanyR" — second store-identity profile, structurally identical
// to CompanyDetails. Edited from the "CompanyR Details" tab and kept
// in its own AsyncStorage slot so neither profile clobbers the other.
export const DEFAULT_COMPANY_DETAILS_R: CompanyDetails = {
  companyName: "Rasi Super Store",
  address1: "",
  address2: "",
  city: "Coimbatore",
  state: "TN",
  country: "India",
  pincode: "",
  mobile: "",
  whatsapp: "",
  gstNo: "",
  fssaiNo: "",
};

export interface MrpEntry {
  itemNo: string;
  mrp: number;
}

// "Rasi Items" master catalog row. Imported from an Excel sheet whose
// columns are: code, item, igroup, unit, godown, mrp, wrate, srate,
// Brand, UNITSPER, MULFACTOR (header matching is case- and
// whitespace-insensitive — see rasi-items.tsx).
export interface RasiItem {
  code: string;
  item: string;
  igroup: string;
  unit: string;
  godown: string;
  mrp: number;
  wrate: number;
  srate: number;
  brand: string;
  unitsPer: number;
  mulFactor: number;
}

// Canonical column order for the Latest Purchases sheet. Used by the
// importer (header lookup), the table view (column order), and the
// exporter (output column order) so the three never drift apart.
// Header matching is whitespace-insensitive, so spreadsheets that label
// the column "Sort No" (with a space) still map correctly to "SortNo".
// Column order chosen by the user for both the on-screen table and the
// exported workbook. The Latest Purchases tab also injects a synthetic
// "Vendor Name" column immediately after VendorCode at display time;
// that column is NOT exported, so it doesn't appear here.
// Import header matching is by name (whitespace-insensitive), so this
// order can be reshuffled without breaking parsing.
export const LATEST_PURCHASES_FIELDS = [
  "VendorCode",
  "DODate",
  "Brand",
  "Category",
  "Item No",
  "Item Description",
  "MRP",
  "Purchase Qty",
  "Free Qty",
  "NetCost",
  "Tax",
  "Weight",
  "GidNo",
  "SortNo",
  "DONo",
  "GidDate",
  "CreatedDate",
] as const;

// Each row is a flexible map: numeric-looking cells get parsed to number,
// everything else (dates, IDs, text) stays as the original string. This
// keeps imports forgiving when a sheet has odd cells in numeric columns.
export type LatestPurchaseEntry = Record<string, string | number>;

// Canonical column order for the Promo (PromotionMaster) sheet. Order
// matches the Promo tab's table layout and the export workbook so the
// importer (header lookup), the viewer (column order), and any future
// exporter never drift apart. Header matching at import time is
// whitespace-insensitive, so spreadsheets that label the column
// "ItemNo" and "Item No" both map correctly.
export const PROMO_FIELDS = [
  "PromotionToDate",
  "Category",
  "Item No",
  "Brand",
  "NoofBatches",
  "Item Description",
  "SP",
  "SoldQty",
  "PromotionPrice",
  // Quantity of this batch eligible for the promotional price. Stored
  // as a decimal so fractional units of measure (kg, ltr) survive the
  // round trip through Excel. Optional — existing imports without
  // this column hydrate with the cell blank.
  "EligibleQty",
  // Optional free-text sort/grouping code from upstream. Used to
  // order or bucket promo rows in print runs and exports. Stored as
  // a string so leading zeros, alpha prefixes (e.g. "A01") and
  // dashes survive the Excel round trip.
  "PromoSortCode",
  "Latest MRP",
  "MRP",
  "BatchNo",
  "VendorCode",
  "VendorName",
  "OH Qty",
  // Wholesale / purchase cost per unit. Stored as a decimal so values
  // like 12.50 round-trip correctly through Excel and JSON. Optional —
  // existing imports without this column hydrate with the cell blank.
  "Cost",
  // Promo CR Date — date the promo was created upstream. Optional;
  // imported from the Excel header "Promo CR Date". Stored as a
  // "DD/MM/YYYY" string by the Promo importer.
  "Promo CR Date",
] as const;

// Same flexible row shape as Latest Purchases — numbers stay numbers,
// dates land as "DD/MM/YYYY" strings, everything else is left as the
// raw string from the cell.
export type PromoEntry = Record<string, string | number>;

// Snapshot of a single price tag the user is editing / printing. Built
// from a Promo row when the user taps Save on the PromoPrint picker.
// Stored in AppContext (and AsyncStorage) so the preview survives
// navigation and app restarts.
export interface PriceTagItem {
  // Stable diff key — `${itemNo}|${batchNo}|${mrp}`. Mirrors the Promo
  // importer's uniqueness contract so re-saving the same item replaces
  // its previous selection cleanly instead of duplicating.
  key: string;
  itemNo: string;
  description: string;
  mrp: string | number;
  promotionPrice: string | number;
  // EligibleQty from the source Promo row — quantity of this batch
  // eligible for the promotional price. Optional so legacy items
  // pre-dating this field still load.
  eligibleQty?: string | number;
  // Optional free-text sort/grouping code from the source Promo row.
  // Carried through so the printed tag and the picker can show it
  // without re-querying the Promo entries.
  promoSortCode?: string;
  // SP (regular shelf price) — used as a fallback when promotionPrice
  // is empty so the printed tag always has a price line.
  sp: string | number;
  brand?: string;
  category?: string;
  vendorName?: string;
  beat?: string;
  // Optional product image as a data URI (jpeg base64). Added on the
  // PriceTag Preview screen via camera / gallery / Drive URL.
  imageUri?: string;
  // PromotionToDate from the source Promo row. Stored as the raw
  // string the importer produced (typically "DD/MM/YYYY"); the
  // PriceTag Preview formatter swaps "/" for "-" before rendering.
  // Optional so legacy items pre-dating this field still load.
  promotionToDate?: string;
  // Optional per-item visual style override. Used by PriceTag Review to
  // let the user assign a different style (A/B/C/D) to each individual
  // tag instead of applying one style to the whole list. PriceTag
  // Preview ignores this field — it always renders every item with its
  // single global `priceTagStyle`. Undefined means "fall back to the
  // screen's currently selected style".
  style?: PriceTagStyle;
  // Optional per-item custom banner title. Only consumed when the
  // effective style is "E" ("Customize Me") — the user picks one
  // from the TitleList catalogue via a green edit button on the
  // banner (modify mode). When absent we fall back to the Style E
  // default banner ("Edit Title").
  customTitle?: string;
  addedAt: number;
}

// Available visual styles for the printed price tag. Kept open as a
// string union so adding a new layout later only requires touching
// the renderer + this type.
export type PriceTagStyle = "A" | "B" | "C" | "D" | "E";

// One row in the user-managed banner-title catalogue (the "TitleList"
// tab). Lives in AsyncStorage and seeded with ~400 punchy defaults
// on first launch via `DEFAULT_TITLES`. Exported so the screen and
// helpers can share the shape.
export interface TitleListItem {
  id: string;
  title: string;
  category: string;
}

// One row in the Last Supply Date table. The date is stored as a
// "DD/MM/YYYY" string (normalised at import time) so it is safe to
// sort and display without further parsing.
export interface LastSupplyDateEntry {
  vendorName: string;
  vendorCode: string;
  latestInvoiceDate: string;
}

// One row in the RodeoItems table. Imported from Excel and stored in
// AsyncStorage. Numeric fields are nullable so blank cells round-trip
// as `null` instead of NaN. Date fields are normalised to "DD/MM/YYYY"
// strings at import time so they sort and display without further
// parsing. `active` is coerced from common truthy/falsy spellings
// (Yes/No, Y/N, 1/0, true/false) to a strict boolean.
export interface RodeoItem {
  productId: number | null;
  skuId: number | null;
  productName: string;
  barCode: string;
  itemCode: string;
  gst: number | null;
  mrp: number | null;
  purchasePrice: number | null;
  sellingPrice: number | null;
  offerPrice: number | null;
  offerStartDate: string;
  offerEndDate: string;
  active: boolean;
}

const AppContext = createContext<AppContextType | null>(null);

const SUPPLIERS_KEY = "@suppliers";
const ORDERS_KEY = "@orders";
const USERS_KEY = "@appUsers";
const MRP_KEY = "@mrpBatch";
const RASI_ITEMS_KEY = "@rasiItems";
const LATEST_PURCHASES_KEY = "@latestPurchases";
const PROMO_KEY = "@promoBatch";
// Stored separately from @promoBatch so a corrupted live import can never
// poison the previous snapshot — they're independent payloads.
const PROMO_PREV_KEY = "@promoPrev";
const PROMO_PREV_AT_KEY = "@promoPrevAt";
const LAST_SUPPLY_DATE_KEY = "@lastSupplyDate";
const RODEO_ITEMS_KEY = "@rodeoItems";
// User-entered "New Qty" overrides per Promo row, keyed by
// `${itemNo}|${batchNo}`. Stored as a separate map so importing a fresh
// Promo workbook (which replaces every row) doesn't blow away the
// quantities the user typed in. Cleared together with the Promo batch.
const PROMO_NEW_QTY_KEY = "@promoNewQty";
// PromoPrint / PriceTag state. Each entry is a snapshot of a Promo
// row the user picked plus an optional product image (data URI), so
// the PriceTag Preview screen and PDF export keep working even if
// the underlying Promo data is later re-imported or cleared.
const PRICE_TAG_KEY = "@priceTagItems";
// Persisted user choice of which price-tag visual style to render
// (and export to PDF). Two options for now: "A" = Special-Offer card
// (Protinex-style), "B" = Low-Prices banner (Aashirvaad-style).
const PRICE_TAG_STYLE_KEY = "@priceTagStyle";
// Persisted user choice for the optional centered logo watermark on
// each price tag. Stored as the literal string "1" (show) or "0"
// (hide); anything missing/unknown falls back to the default (show).
const PRICE_TAG_SHOW_LOGO_KEY = "@priceTagShowLogo";
// Optional free-text PDF export title. Stored as the raw user
// string (trimmed); empty string == "no title set".
const PRICE_TAG_TITLE_KEY = "@priceTagTitle";
// PriceTag Review — parallel storage namespace for the cloned screen.
const PRICE_TAG_REVIEW_KEY = "@priceTagReviewItems";
const PRICE_TAG_REVIEW_STYLE_KEY = "@priceTagReviewStyle";
const PRICE_TAG_REVIEW_SHOW_LOGO_KEY = "@priceTagReviewShowLogo";
const PRICE_TAG_SQUARE_VARIANT_KEY = "@priceTagSquareVariant";
const PRICE_TAG_REVIEW_TITLE_KEY = "@priceTagReviewTitle";
// Brand palette JSON: { red, deepRed, cream, gold } as #RRGGBB.
const TAG_COLORS_KEY = "@tagColors";
const CUSTOM_TAG_PRESETS_KEY = "@customTagPresets";

export interface TagColorPreset {
  name: string;
  colors: TagColors;
}
// Persisted user-managed banner-title catalogue. Seeded once with the
// 400 defaults; after that the user owns the list (add / edit /
// delete / Excel import). A separate "@titleListSeeded" flag stops
// us from re-seeding (and clobbering the user's edits) on every
// launch — we only seed when both keys are missing.
const TITLE_LIST_KEY = "@titleList";
const TITLE_LIST_SEEDED_KEY = "@titleListSeeded";
// Wall-clock timestamp (Unix ms, stored as a string) for the last
// upstream data refresh. Written by the Admin "DownloadTime" button
// and after a successful Promo Excel import. Surfaced on the
// Dashboard so users see the data snapshot age at a glance.
const DATA_DOWNLOAD_TIME_KEY = "@dataDownloadTime";
// Company / store identity JSON. See CompanyDetails for the shape.
const COMPANY_DETAILS_KEY = "@companyDetails";
// CompanyR — second store-identity profile, same shape as
// COMPANY_DETAILS_KEY. Stored in its own slot so it persists
// independently.
const COMPANY_DETAILS_R_KEY = "@companyDetailsR";

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function generateOrderNumber(): string {
  const prefix = "ORD";
  const num = Math.floor(Math.random() * 90000) + 10000;
  return `${prefix}-${num}`;
}

// User-facing message shown by callers when a write to AsyncStorage fails.
// Phones with full storage are the most common cause; we surface that
// specifically because the user can act on it (free up space and retry).
export const STORAGE_ERROR_TITLE = "Couldn't Save";
export const STORAGE_ERROR_MESSAGE =
  "Your phone may be out of storage. Please free up some space and try again.";

// Helper for callers to surface a save failure consistently across web
// (window.alert) and native (Alert.alert).
export function showStorageErrorAlert(title: string = STORAGE_ERROR_TITLE) {
  if (Platform.OS === "web") {
    window.alert(`${title}\n\n${STORAGE_ERROR_MESSAGE}`);
  } else {
    Alert.alert(title, STORAGE_ERROR_MESSAGE);
  }
}


export function AppProvider({ children }: { children: ReactNode }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  // Mirror of the latest orders for async paths that may run long enough
  // for `orders` from the closure to become stale (e.g. addOrdersBatchAsync).
  // Without this, a concurrent order mutation during a large import could be
  // overwritten by the stale closure value at commit time.
  const ordersRef = useRef<Order[]>([]);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);
  // Same pattern for suppliers: the targeted setters (notes, photos) are
  // saved from different screens and can fire close together. Reading the
  // latest array from a ref at commit time prevents one update from
  // overwriting the other when the closures haven't re-rendered yet.
  const suppliersRef = useRef<Supplier[]>([]);
  useEffect(() => {
    suppliersRef.current = suppliers;
  }, [suppliers]);
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [mrpEntries, setMrpEntries] = useState<MrpEntry[]>([]);
  const [rasiItems, setRasiItems] = useState<RasiItem[]>([]);
  const [latestPurchases, setLatestPurchases] = useState<LatestPurchaseEntry[]>([]);
  const [promoEntries, setPromoEntries] = useState<PromoEntry[]>([]);
  const [promoPrevEntries, setPromoPrevEntries] = useState<PromoEntry[]>([]);
  const [promoPrevSnapshotAt, setPromoPrevSnapshotAt] = useState<number | null>(null);
  // Mirror so snapshotPromoNow / savePromoBatch can read the latest live
  // entries without depending on a possibly-stale closure (matches the
  // ordersRef / suppliersRef pattern above).
  const promoEntriesRef = useRef<PromoEntry[]>([]);
  useEffect(() => {
    promoEntriesRef.current = promoEntries;
  }, [promoEntries]);
  const [promoNewQty, setPromoNewQty] = useState<Record<string, number>>({});
  const [priceTagItems, setPriceTagItems] = useState<PriceTagItem[]>([]);
  const [priceTagStyle, setPriceTagStyleState] = useState<PriceTagStyle>("A");
  const [priceTagShowLogo, setPriceTagShowLogoState] = useState<boolean>(true);
  const [priceTagTitle, setPriceTagTitleState] = useState<string>("");
  // Mirror so the per-item helpers (image set, remove) can read the
  // latest list without depending on a possibly-stale closure.
  const priceTagItemsRef = useRef<PriceTagItem[]>([]);
  useEffect(() => {
    priceTagItemsRef.current = priceTagItems;
  }, [priceTagItems]);
  // PriceTag Review — clone state with its own storage.
  const [priceTagReviewItems, setPriceTagReviewItems] = useState<PriceTagItem[]>([]);
  const [priceTagReviewStyle, setPriceTagReviewStyleState] = useState<PriceTagStyle>("A");
  const [priceTagReviewShowLogo, setPriceTagReviewShowLogoState] = useState<boolean>(true);
  const [priceTagSquareVariant, setPriceTagSquareVariantState] = useState<
    "detailed" | "minimal"
  >("minimal");
  const [priceTagReviewTitle, setPriceTagReviewTitleState] = useState<string>("");
  const [tagColors, setTagColorsState] = useState<TagColors>(DEFAULT_TAG_COLORS);
  const [customTagPresets, setCustomTagPresetsState] = useState<TagColorPreset[]>([]);
  const [titleList, setTitleListState] = useState<TitleListItem[]>([]);
  const titleListRef = useRef<TitleListItem[]>([]);
  useEffect(() => {
    titleListRef.current = titleList;
  }, [titleList]);
  const priceTagReviewItemsRef = useRef<PriceTagItem[]>([]);
  useEffect(() => {
    priceTagReviewItemsRef.current = priceTagReviewItems;
  }, [priceTagReviewItems]);
  const [lastSupplyDates, setLastSupplyDates] = useState<LastSupplyDateEntry[]>([]);
  const [rodeoItems, setRodeoItems] = useState<RodeoItem[]>([]);
  const [dataDownloadTime, setDataDownloadTime] = useState<number | null>(null);
  const [companyDetails, setCompanyDetailsState] = useState<CompanyDetails>(DEFAULT_COMPANY_DETAILS);
  const [companyDetailsR, setCompanyDetailsRState] = useState<CompanyDetails>(DEFAULT_COMPANY_DETAILS_R);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [suppliersData, ordersData, usersData, sessionData, mrpData, latestPurchasesData, promoData, promoPrevData, promoPrevAtData, promoNewQtyData, lastSupplyDateData, rodeoItemsData, priceTagData, priceTagStyleData, priceTagShowLogoData, priceTagTitleData, priceTagReviewData, priceTagReviewStyleData, priceTagReviewShowLogoData, priceTagReviewTitleData, tagColorsData, customTagPresetsData, titleListData, titleListSeededData, dataDownloadTimeData, companyDetailsData, priceTagSquareVariantData, rasiItemsData, companyDetailsRData] = await Promise.all([
        AsyncStorage.getItem(SUPPLIERS_KEY),
        AsyncStorage.getItem(ORDERS_KEY),
        AsyncStorage.getItem(USERS_KEY),
        AsyncStorage.getItem(SESSION_KEY),
        AsyncStorage.getItem(MRP_KEY),
        AsyncStorage.getItem(LATEST_PURCHASES_KEY),
        AsyncStorage.getItem(PROMO_KEY),
        AsyncStorage.getItem(PROMO_PREV_KEY),
        AsyncStorage.getItem(PROMO_PREV_AT_KEY),
        AsyncStorage.getItem(PROMO_NEW_QTY_KEY),
        AsyncStorage.getItem(LAST_SUPPLY_DATE_KEY),
        AsyncStorage.getItem(RODEO_ITEMS_KEY),
        AsyncStorage.getItem(PRICE_TAG_KEY),
        AsyncStorage.getItem(PRICE_TAG_STYLE_KEY),
        AsyncStorage.getItem(PRICE_TAG_SHOW_LOGO_KEY),
        AsyncStorage.getItem(PRICE_TAG_TITLE_KEY),
        AsyncStorage.getItem(PRICE_TAG_REVIEW_KEY),
        AsyncStorage.getItem(PRICE_TAG_REVIEW_STYLE_KEY),
        AsyncStorage.getItem(PRICE_TAG_REVIEW_SHOW_LOGO_KEY),
        AsyncStorage.getItem(PRICE_TAG_REVIEW_TITLE_KEY),
        AsyncStorage.getItem(TAG_COLORS_KEY),
        AsyncStorage.getItem(CUSTOM_TAG_PRESETS_KEY),
        AsyncStorage.getItem(TITLE_LIST_KEY),
        AsyncStorage.getItem(TITLE_LIST_SEEDED_KEY),
        AsyncStorage.getItem(DATA_DOWNLOAD_TIME_KEY),
        AsyncStorage.getItem(COMPANY_DETAILS_KEY),
        AsyncStorage.getItem(PRICE_TAG_SQUARE_VARIANT_KEY),
        AsyncStorage.getItem(RASI_ITEMS_KEY),
        AsyncStorage.getItem(COMPANY_DETAILS_R_KEY),
      ]);

      const loadedSuppliers = suppliersData ? JSON.parse(suppliersData) : [];
      const loadedOrders = ordersData ? JSON.parse(ordersData) : [];
      const loadedUsers: AppUser[] = usersData ? JSON.parse(usersData) : [];
      const loadedMrp: MrpEntry[] = mrpData ? JSON.parse(mrpData) : [];
      const loadedRasiItems: RasiItem[] = rasiItemsData ? JSON.parse(rasiItemsData) : [];
      const loadedLatestPurchases: LatestPurchaseEntry[] = latestPurchasesData
        ? JSON.parse(latestPurchasesData)
        : [];
      const loadedPromo: PromoEntry[] = promoData ? JSON.parse(promoData) : [];
      const loadedPromoPrev: PromoEntry[] = promoPrevData ? JSON.parse(promoPrevData) : [];
      const loadedPromoPrevAt: number | null = promoPrevAtData
        ? Number(promoPrevAtData) || null
        : null;
      const loadedLastSupplyDates: LastSupplyDateEntry[] = lastSupplyDateData
        ? JSON.parse(lastSupplyDateData)
        : [];

      setSuppliers(loadedSuppliers);
      setOrders(loadedOrders);
      setAppUsers(loadedUsers);
      setMrpEntries(loadedMrp);
      setRasiItems(loadedRasiItems);
      setLatestPurchases(loadedLatestPurchases);
      setPromoEntries(loadedPromo);
      setPromoPrevEntries(loadedPromoPrev);
      setPromoPrevSnapshotAt(loadedPromoPrevAt);
      setLastSupplyDates(loadedLastSupplyDates);
      const loadedRodeoItems: RodeoItem[] = rodeoItemsData
        ? JSON.parse(rodeoItemsData)
        : [];
      setRodeoItems(loadedRodeoItems);
      const loadedPromoNewQty: Record<string, number> = promoNewQtyData
        ? JSON.parse(promoNewQtyData)
        : {};
      setPromoNewQty(loadedPromoNewQty);

      const loadedPriceTagItems: PriceTagItem[] = priceTagData
        ? JSON.parse(priceTagData)
        : [];
      setPriceTagItems(loadedPriceTagItems);

      // Style is a tiny enum; reject anything that doesn't match the
      // current valid set so a corrupted/legacy value falls back to the
      // default instead of bricking the screen.
      if (
        priceTagStyleData === "A" ||
        priceTagStyleData === "B" ||
        priceTagStyleData === "C" ||
        priceTagStyleData === "D" ||
        priceTagStyleData === "E"
      ) {
        setPriceTagStyleState(priceTagStyleData);
      }

      // Watermark toggle — only override the default when an explicit
      // "0" or "1" was previously written. Anything else (missing,
      // legacy, garbled) falls through to the default-on state.
      if (priceTagShowLogoData === "0") {
        setPriceTagShowLogoState(false);
      } else if (priceTagShowLogoData === "1") {
        setPriceTagShowLogoState(true);
      }

      // Optional PDF title. Cap at the same 256-char limit the UI
      // enforces so a tampered storage value can't blow past it.
      if (typeof priceTagTitleData === "string") {
        setPriceTagTitleState(priceTagTitleData.slice(0, 256));
      }

      // ----- PriceTag Review (clone) hydration -----
      const loadedPriceTagReviewItems: PriceTagItem[] = priceTagReviewData
        ? JSON.parse(priceTagReviewData)
        : [];
      setPriceTagReviewItems(loadedPriceTagReviewItems);
      if (
        priceTagReviewStyleData === "A" ||
        priceTagReviewStyleData === "B" ||
        priceTagReviewStyleData === "C" ||
        priceTagReviewStyleData === "D" ||
        priceTagReviewStyleData === "E"
      ) {
        setPriceTagReviewStyleState(priceTagReviewStyleData);
      }

      // ----- TitleList hydration / first-launch seeding -----
      // We only seed the 400 defaults when the seeded flag is missing
      // AND the existing list is empty, so a user who deletes every
      // entry on purpose isn't re-flooded with defaults next launch.
      let loadedTitles: TitleListItem[] = [];
      if (titleListData) {
        try {
          const parsed = JSON.parse(titleListData);
          if (Array.isArray(parsed)) {
            loadedTitles = parsed.filter(
              (t: unknown): t is TitleListItem =>
                !!t &&
                typeof (t as TitleListItem).id === "string" &&
                typeof (t as TitleListItem).title === "string",
            );
          }
        } catch {
          loadedTitles = [];
        }
      }
      if (!titleListSeededData && loadedTitles.length === 0) {
        loadedTitles = DEFAULT_TITLES.map((t, idx) => ({
          id: `seed-${idx}-${t.title.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 24)}`,
          title: t.title,
          category: t.category,
        }));
        try {
          await AsyncStorage.setItem(TITLE_LIST_KEY, JSON.stringify(loadedTitles));
          await AsyncStorage.setItem(TITLE_LIST_SEEDED_KEY, "1");
        } catch {
          // Non-fatal: the user just won't see defaults this launch.
        }
      }
      setTitleListState(loadedTitles);
      if (priceTagReviewShowLogoData === "0") {
        setPriceTagReviewShowLogoState(false);
      } else if (priceTagReviewShowLogoData === "1") {
        setPriceTagReviewShowLogoState(true);
      }
      if (
        priceTagSquareVariantData === "detailed" ||
        priceTagSquareVariantData === "minimal"
      ) {
        setPriceTagSquareVariantState(priceTagSquareVariantData);
      }
      if (typeof priceTagReviewTitleData === "string") {
        setPriceTagReviewTitleState(priceTagReviewTitleData.slice(0, 256));
      }

      // Tag-color palette. Validate every key is a #RRGGBB hex string;
      // any drift falls back to the default for that slot so a corrupt
      // value can't break tag rendering.
      if (tagColorsData) {
        try {
          const parsed = JSON.parse(tagColorsData);
          const hex = /^#[0-9A-Fa-f]{6}$/;
          const pick = (k: keyof TagColors): string =>
            typeof parsed?.[k] === "string" && hex.test(parsed[k])
              ? parsed[k]
              : DEFAULT_TAG_COLORS[k];
          setTagColorsState({
            red: pick("red"),
            deepRed: pick("deepRed"),
            cream: pick("cream"),
            gold: pick("gold"),
          });
        } catch {
          // Non-fatal: keep defaults.
        }
      }

      // Custom tag-color presets. Validate each entry shape and drop
      // anything that doesn't have a non-empty name + 4 valid #RRGGBB
      // hex slots so a corrupt save can't crash the TagColours screen.
      if (customTagPresetsData) {
        try {
          const parsedList = JSON.parse(customTagPresetsData);
          const hex = /^#[0-9A-Fa-f]{6}$/;
          if (Array.isArray(parsedList)) {
            const cleaned: TagColorPreset[] = [];
            for (const p of parsedList) {
              const name = typeof p?.name === "string" ? p.name.trim() : "";
              const c = p?.colors;
              if (
                name &&
                c &&
                typeof c.red === "string" && hex.test(c.red) &&
                typeof c.deepRed === "string" && hex.test(c.deepRed) &&
                typeof c.cream === "string" && hex.test(c.cream) &&
                typeof c.gold === "string" && hex.test(c.gold)
              ) {
                cleaned.push({
                  name: name.slice(0, 60),
                  colors: {
                    red: c.red.toUpperCase(),
                    deepRed: c.deepRed.toUpperCase(),
                    cream: c.cream.toUpperCase(),
                    gold: c.gold.toUpperCase(),
                  },
                });
              }
            }
            setCustomTagPresetsState(cleaned);
          }
        } catch {
          // Non-fatal: keep empty list.
        }
      }

      // Last data-download timestamp. Stored as a stringified number;
      // anything non-numeric (corrupt / legacy) falls back to null so
      // the Dashboard simply hides the "Last Data Download" line until
      // the user records a fresh one.
      if (dataDownloadTimeData) {
        const n = Number(dataDownloadTimeData);
        if (Number.isFinite(n) && n > 0) setDataDownloadTime(n);
      }

      // Company details. Merge with defaults so any missing field
      // (e.g. from an older app version that didn't persist GST/FSSAI)
      // still gets a sane string instead of `undefined`. A corrupt
      // payload silently falls back to the full default object.
      if (companyDetailsData) {
        try {
          const parsed = JSON.parse(companyDetailsData);
          if (parsed && typeof parsed === "object") {
            const merged: CompanyDetails = { ...DEFAULT_COMPANY_DETAILS };
            for (const k of Object.keys(DEFAULT_COMPANY_DETAILS) as (keyof CompanyDetails)[]) {
              const v = (parsed as Record<string, unknown>)[k];
              if (typeof v === "string") merged[k] = v;
            }
            setCompanyDetailsState(merged);
          }
        } catch {
          // Non-fatal: keep defaults.
        }
      }

      // CompanyR — same merge-with-defaults strategy as the primary
      // companyDetails block above. Independent storage slot.
      if (companyDetailsRData) {
        try {
          const parsed = JSON.parse(companyDetailsRData);
          if (parsed && typeof parsed === "object") {
            const merged: CompanyDetails = { ...DEFAULT_COMPANY_DETAILS_R };
            for (const k of Object.keys(DEFAULT_COMPANY_DETAILS_R) as (keyof CompanyDetails)[]) {
              const v = (parsed as Record<string, unknown>)[k];
              if (typeof v === "string") merged[k] = v;
            }
            setCompanyDetailsRState(merged);
          }
        } catch {
          // Non-fatal: keep defaults.
        }
      }

      if (sessionData) {
        const savedUser = loadedUsers.find((u) => u.id === sessionData);
        if (savedUser) setCurrentUser(savedUser);
      }
    } catch (e) {
      setSuppliers([]);
      setOrders([]);
    } finally {
      // Mark hydration complete in both success and failure paths so screens
      // never get stuck in a "still loading" state if AsyncStorage throws.
      setHydrated(true);
    }
  }

  // All save* helpers persist to AsyncStorage FIRST and only update React
  // state if the write succeeds. If the disk is full (or AsyncStorage throws
  // for any other reason) the rejection bubbles up to the caller and the UI
  // never shows a change that wasn't actually saved — so the next app launch
  // is consistent with what the user just saw.
  async function saveMrpBatch(entries: MrpEntry[]) {
    await AsyncStorage.setItem(MRP_KEY, JSON.stringify(entries));
    setMrpEntries(entries);
  }

  async function clearMrpBatch() {
    await AsyncStorage.removeItem(MRP_KEY);
    setMrpEntries([]);
  }

  async function saveRasiItems(entries: RasiItem[]) {
    await AsyncStorage.setItem(RASI_ITEMS_KEY, JSON.stringify(entries));
    setRasiItems(entries);
  }

  async function clearRasiItems() {
    await AsyncStorage.removeItem(RASI_ITEMS_KEY);
    setRasiItems([]);
  }

  // Latest Purchases helpers mirror the MRP write-first pattern: persist to
  // AsyncStorage first so the on-screen state never shows a "save" that
  // wasn't actually written (matches the rest of the data layer).
  async function saveLatestPurchasesBatch(entries: LatestPurchaseEntry[]) {
    await AsyncStorage.setItem(LATEST_PURCHASES_KEY, JSON.stringify(entries));
    setLatestPurchases(entries);
  }

  async function clearLatestPurchases() {
    await AsyncStorage.removeItem(LATEST_PURCHASES_KEY);
    setLatestPurchases([]);
  }

  // Promo helpers mirror the MRP / Latest Purchases write-first pattern:
  // persist to AsyncStorage first so the on-screen state never shows a
  // "save" that wasn't actually written.
  //
  // Auto-snapshots whatever's currently in promoEntries into the prev
  // bucket BEFORE overwriting (skipped on the very first import — there
  // is nothing meaningful to capture). Snapshot + new entries are
  // written in lockstep so a failure on either rolls the UI back via
  // the throw bubbling to the caller.
  async function savePromoBatch(entries: PromoEntry[]) {
    const current = promoEntriesRef.current;
    if (current.length > 0) {
      const now = Date.now();
      await AsyncStorage.multiSet([
        [PROMO_PREV_KEY, JSON.stringify(current)],
        [PROMO_PREV_AT_KEY, String(now)],
        [PROMO_KEY, JSON.stringify(entries)],
      ]);
      setPromoPrevEntries(current);
      setPromoPrevSnapshotAt(now);
    } else {
      await AsyncStorage.setItem(PROMO_KEY, JSON.stringify(entries));
    }
    setPromoEntries(entries);
  }

  // Manual snapshot — copies the live promoEntries into the prev
  // bucket without touching the live data. No-op when nothing's loaded.
  async function snapshotPromoNow() {
    const current = promoEntriesRef.current;
    if (current.length === 0) return;
    const now = Date.now();
    await AsyncStorage.multiSet([
      [PROMO_PREV_KEY, JSON.stringify(current)],
      [PROMO_PREV_AT_KEY, String(now)],
    ]);
    setPromoPrevEntries(current);
    setPromoPrevSnapshotAt(now);
  }

  async function clearPromoBatch() {
    await AsyncStorage.multiRemove([PROMO_KEY, PROMO_NEW_QTY_KEY]);
    setPromoEntries([]);
    setPromoNewQty({});
  }

  // Wipes only the prev snapshot. Live promoEntries and the New Qty
  // overrides are untouched.
  async function clearPromoPrev() {
    await AsyncStorage.multiRemove([PROMO_PREV_KEY, PROMO_PREV_AT_KEY]);
    setPromoPrevEntries([]);
    setPromoPrevSnapshotAt(null);
  }

  async function saveLastSupplyDateBatch(entries: LastSupplyDateEntry[]) {
    await AsyncStorage.setItem(LAST_SUPPLY_DATE_KEY, JSON.stringify(entries));
    setLastSupplyDates(entries);
  }

  async function clearLastSupplyDates() {
    await AsyncStorage.removeItem(LAST_SUPPLY_DATE_KEY);
    setLastSupplyDates([]);
  }

  // Single-row write for the "New Qty" overrides map. Mirrors the
  // write-first pattern used elsewhere — persists the next snapshot to
  // AsyncStorage before updating React state so a failed save never
  // leaves the UI ahead of disk. Pass `undefined` to remove the entry.
  async function setPromoNewQtyValue(key: string, value: number | undefined) {
    const next = { ...promoNewQty };
    if (value === undefined || !Number.isFinite(value)) {
      delete next[key];
    } else {
      next[key] = value;
    }
    await AsyncStorage.setItem(PROMO_NEW_QTY_KEY, JSON.stringify(next));
    setPromoNewQty(next);
  }

  async function login(userId: string, password: string): Promise<{ success: boolean; error?: string }> {
    const user = appUsers.find(
      (u) => u.userId.toLowerCase() === userId.trim().toLowerCase() && u.password === password
    );
    if (!user) return { success: false, error: "Invalid User ID or Password." };
    try {
      await AsyncStorage.setItem(SESSION_KEY, user.id);
    } catch {
      return { success: false, error: STORAGE_ERROR_MESSAGE };
    }
    setCurrentUser(user);
    return { success: true };
  }

  async function logout(): Promise<void> {
    await AsyncStorage.removeItem(SESSION_KEY);
    setCurrentUser(null);
  }

  async function saveSuppliers(data: Supplier[]) {
    await AsyncStorage.setItem(SUPPLIERS_KEY, JSON.stringify(data));
    setSuppliers(data);
  }

  async function saveAppUsers(data: AppUser[]) {
    await AsyncStorage.setItem(USERS_KEY, JSON.stringify(data));
    setAppUsers(data);
  }

  async function addAppUser(user: Omit<AppUser, "id" | "createdAt">) {
    const newUser: AppUser = {
      ...user,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    await saveAppUsers([...appUsers, newUser]);
  }

  async function updateAppUser(id: string, data: Partial<AppUser>) {
    await saveAppUsers(appUsers.map((u) => (u.id === id ? { ...u, ...data } : u)));
  }

  async function deleteAppUser(id: string) {
    await saveAppUsers(appUsers.filter((u) => u.id !== id));
  }

  async function addSuppliersBatch(
    items: Omit<Supplier, "id" | "createdAt">[]
  ): Promise<{ added: number; skipped: string[]; addedSuppliers: Supplier[] }> {
    const skipped: string[] = [];
    const existingCodes = new Set(suppliers.map((s) => s.vendorCode.toUpperCase()));
    const newSuppliers: Supplier[] = [];
    const seenCodes = new Set<string>();
    for (const item of items) {
      const code = item.vendorCode.toUpperCase();
      if (existingCodes.has(code) || seenCodes.has(code)) {
        skipped.push(item.vendorCode);
        continue;
      }
      seenCodes.add(code);
      newSuppliers.push({ ...item, id: generateId(), createdAt: new Date().toISOString() });
    }
    if (newSuppliers.length > 0) await saveSuppliers([...suppliers, ...newSuppliers]);
    return { added: newSuppliers.length, skipped, addedSuppliers: newSuppliers };
  }

  async function addUsersBatch(
    items: Omit<AppUser, "id" | "createdAt">[]
  ): Promise<{ added: number; skipped: string[] }> {
    const skipped: string[] = [];
    const existingIds = new Set(appUsers.map((u) => u.userId.toLowerCase()));
    const newUsers: AppUser[] = [];
    const seenIds = new Set<string>();
    for (const item of items) {
      const uid = item.userId.toLowerCase();
      if (existingIds.has(uid) || seenIds.has(uid)) {
        skipped.push(item.userId);
        continue;
      }
      seenIds.add(uid);
      newUsers.push({ ...item, id: generateId(), createdAt: new Date().toISOString() });
    }
    if (newUsers.length > 0) await saveAppUsers([...appUsers, ...newUsers]);
    return { added: newUsers.length, skipped };
  }

  async function saveOrders(data: Order[]) {
    await AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(data));
    setOrders(data);
  }

  function calculateTotal(items: OrderItem[]): number {
    return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  }

  async function addSupplier(supplier: Omit<Supplier, "id" | "createdAt">) {
    const newSupplier: Supplier = {
      ...supplier,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    await saveSuppliers([...suppliers, newSupplier]);
  }

  async function updateSupplier(id: string, data: Partial<Supplier>) {
    await saveSuppliers(suppliers.map((s) => (s.id === id ? { ...s, ...data } : s)));
  }

  // Targeted setter for the supplier-level "general notes" string. Kept as a
  // dedicated entry point (instead of relying on updateSupplier from the
  // My Orders screen) so the order screen never needs the full Supplier
  // shape, and so any caller writing notes touches only this one field.
  async function setSupplierGeneralNotes(id: string, generalNotes: string) {
    await saveSuppliers(
      suppliersRef.current.map((s) => (s.id === id ? { ...s, generalNotes } : s))
    );
  }

  // Targeted setter for the supplier-level photos array. Same shape as
  // setSupplierGeneralNotes so callers don't need the full Supplier
  // object. Capped at 3 entries; extras are dropped silently. Reads from
  // suppliersRef so a concurrent notes save can't be clobbered by a stale
  // closure of `suppliers`.
  async function setSupplierPhotos(id: string, photos: string[]) {
    const capped = photos.slice(0, 3);
    await saveSuppliers(
      suppliersRef.current.map((s) => (s.id === id ? { ...s, photos: capped } : s))
    );
  }

  async function deleteSupplier(id: string) {
    await saveSuppliers(suppliers.filter((s) => s.id !== id));
  }

  // Batch delete used by the bulk-undo flow on the import screen so we can
  // remove every placeholder supplier created by a single bulk action in
  // one persisted write (one AsyncStorage round-trip + one re-render),
  // instead of N sequential deletes that would each rebuild the array.
  async function deleteSuppliersBatch(ids: string[]) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    await saveSuppliers(suppliers.filter((s) => !idSet.has(s.id)));
  }

  async function addOrder(order: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">) {
    const now = new Date().toISOString();
    const newOrder: Order = {
      ...order,
      id: generateId(),
      orderNumber: generateOrderNumber(),
      totalAmount: calculateTotal(order.items),
      createdAt: now,
      updatedAt: now,
    };
    await saveOrders([newOrder, ...orders]);
  }

  async function addOrdersBatch(orderInputs: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[]) {
    const now = new Date().toISOString();
    const newOrders: Order[] = orderInputs.map((order) => ({
      ...order,
      id: generateId(),
      orderNumber: generateOrderNumber(),
      totalAmount: calculateTotal(order.items),
      createdAt: now,
      updatedAt: now,
    }));
    await saveOrders([...newOrders, ...orders]);
  }

  // Async chunked variant for very large imports. Builds AND persists in
  // CHUNK-sized batches so we can (a) render progress between batches and
  // (b) honor a cancel signal between batches. Each chunk is its own
  // AsyncStorage write — that means a cancel mid-import leaves the chunks
  // already written intact, and the caller is told how many were saved.
  // Returns `{ saved, canceled }` so the caller can update the UI accordingly.
  // Storage errors still throw — the caller's catch will show a save-failed
  // alert; any chunks committed before the throw remain on disk (this is no
  // worse than the previous monolithic behavior, where a thrown setItem also
  // left state inconsistent for very large payloads).
  async function addOrdersBatchAsync(
    orderInputs: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[],
    onProgress?: (processed: number, total: number) => void | Promise<void>,
    shouldCancel?: () => boolean
  ): Promise<{ saved: number; canceled: boolean }> {
    const now = new Date().toISOString();
    const total = orderInputs.length;
    const CHUNK = 100;
    let saved = 0;
    // Snapshot the existing orders ONCE so we can preserve the original
    // import order across chunks. We accumulate freshly-built orders in
    // import order and prepend the full accumulated list each chunk —
    // otherwise prepending each chunk individually would put later chunks
    // ahead of earlier ones (reversed display order vs. the monolithic
    // version this replaces). Concurrent additions to `orders` during this
    // long-running async path won't be merged in — same trade-off as the
    // previous implementation, which also captured a single snapshot at
    // the end. It's acceptable because nothing else in the app can add
    // orders while the import screen is busy.
    const existingOrders: Order[] = ordersRef.current;
    const accumulatedNew: Order[] = [];
    for (let start = 0; start < total; start += CHUNK) {
      // Cancel checkpoint at the top of each chunk. Any orders already
      // persisted in earlier chunks remain saved — that's the partial-save
      // contract the caller uses to message the user.
      if (shouldCancel && shouldCancel()) {
        return { saved, canceled: true };
      }
      const end = Math.min(start + CHUNK, total);
      for (let i = start; i < end; i++) {
        const order = orderInputs[i];
        accumulatedNew.push({
          ...order,
          id: generateId(),
          orderNumber: generateOrderNumber(),
          totalAmount: calculateTotal(order.items),
          createdAt: now,
          updatedAt: now,
        });
      }
      // Persist to AsyncStorage FIRST, then update in-memory state. If
      // setItem throws, the previously-committed chunks remain on disk and
      // `saved` reflects what's safely persisted.
      const updated = [...accumulatedNew, ...existingOrders];
      await AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(updated));
      setOrders(updated);
      saved = end;
      if (onProgress) await onProgress(saved, total);
      // Yield so the UI can paint progress and process the cancel tap before
      // we burn into the next chunk's stringify.
      await new Promise((r) => setTimeout(r, 0));
    }
    return { saved, canceled: false };
  }

  async function updateOrder(id: string, data: Partial<Order>) {
    await saveOrders(
      orders.map((o) =>
        o.id === id
          ? {
              ...o,
              ...data,
              totalAmount: data.items ? calculateTotal(data.items) : o.totalAmount,
              updatedAt: new Date().toISOString(),
            }
          : o
      )
    );
  }

  // ----------------------------------------------------------------
  // PriceTag workflow helpers (PromoPrint + PriceTag Preview screens)
  //
  // Persistence is write-first (mirrors the rest of the data layer)
  // so a failed disk write never leaves the on-screen list out of
  // sync with what's actually saved.
  // ----------------------------------------------------------------
  async function savePriceTagItems(items: PriceTagItem[]) {
    await AsyncStorage.setItem(PRICE_TAG_KEY, JSON.stringify(items));
    setPriceTagItems(items);
  }

  async function removePriceTagItem(key: string) {
    const next = priceTagItemsRef.current.filter((i) => i.key !== key);
    await AsyncStorage.setItem(PRICE_TAG_KEY, JSON.stringify(next));
    setPriceTagItems(next);
  }

  async function setPriceTagImage(key: string, imageUri: string | null) {
    const next = priceTagItemsRef.current.map((i) =>
      i.key === key
        ? imageUri == null
          ? (() => { const { imageUri: _drop, ...rest } = i; return rest as PriceTagItem; })()
          : { ...i, imageUri }
        : i
    );
    await AsyncStorage.setItem(PRICE_TAG_KEY, JSON.stringify(next));
    setPriceTagItems(next);
  }

  async function clearPriceTagItems() {
    await AsyncStorage.removeItem(PRICE_TAG_KEY);
    setPriceTagItems([]);
  }

  async function setPriceTagStyle(style: PriceTagStyle) {
    await AsyncStorage.setItem(PRICE_TAG_STYLE_KEY, style);
    setPriceTagStyleState(style);
  }

  async function setPriceTagShowLogo(show: boolean) {
    await AsyncStorage.setItem(PRICE_TAG_SHOW_LOGO_KEY, show ? "1" : "0");
    setPriceTagShowLogoState(show);
  }

  async function setPriceTagTitle(title: string) {
    const clean = title.slice(0, 256);
    await AsyncStorage.setItem(PRICE_TAG_TITLE_KEY, clean);
    setPriceTagTitleState(clean);
  }

  // ----- PriceTag Review helpers (clone) -----
  async function savePriceTagReviewItems(items: PriceTagItem[]) {
    await AsyncStorage.setItem(PRICE_TAG_REVIEW_KEY, JSON.stringify(items));
    setPriceTagReviewItems(items);
  }

  async function removePriceTagReviewItem(key: string) {
    const next = priceTagReviewItemsRef.current.filter((i) => i.key !== key);
    await AsyncStorage.setItem(PRICE_TAG_REVIEW_KEY, JSON.stringify(next));
    setPriceTagReviewItems(next);
  }

  async function setPriceTagReviewImage(key: string, imageUri: string | null) {
    const next = priceTagReviewItemsRef.current.map((i) =>
      i.key === key
        ? imageUri == null
          ? (() => { const { imageUri: _drop, ...rest } = i; return rest as PriceTagItem; })()
          : { ...i, imageUri }
        : i
    );
    await AsyncStorage.setItem(PRICE_TAG_REVIEW_KEY, JSON.stringify(next));
    setPriceTagReviewItems(next);
  }

  async function clearPriceTagReviewItems() {
    await AsyncStorage.removeItem(PRICE_TAG_REVIEW_KEY);
    setPriceTagReviewItems([]);
  }

  async function setPriceTagReviewStyle(style: PriceTagStyle) {
    await AsyncStorage.setItem(PRICE_TAG_REVIEW_STYLE_KEY, style);
    setPriceTagReviewStyleState(style);
  }

  async function setPriceTagReviewShowLogo(show: boolean) {
    await AsyncStorage.setItem(PRICE_TAG_REVIEW_SHOW_LOGO_KEY, show ? "1" : "0");
    setPriceTagReviewShowLogoState(show);
  }

  async function setPriceTagSquareVariant(v: "detailed" | "minimal") {
    await AsyncStorage.setItem(PRICE_TAG_SQUARE_VARIANT_KEY, v);
    setPriceTagSquareVariantState(v);
  }

  async function setPriceTagReviewTitle(title: string) {
    const clean = title.slice(0, 256);
    await AsyncStorage.setItem(PRICE_TAG_REVIEW_TITLE_KEY, clean);
    setPriceTagReviewTitleState(clean);
  }

  async function setTagColors(colors: TagColors) {
    await AsyncStorage.setItem(TAG_COLORS_KEY, JSON.stringify(colors));
    setTagColorsState(colors);
  }

  async function resetTagColors() {
    await AsyncStorage.removeItem(TAG_COLORS_KEY);
    setTagColorsState(DEFAULT_TAG_COLORS);
  }

  async function persistCustomTagPresets(next: TagColorPreset[]) {
    await AsyncStorage.setItem(
      CUSTOM_TAG_PRESETS_KEY,
      JSON.stringify(next),
    );
    setCustomTagPresetsState(next);
  }

  async function saveCustomTagPreset(name: string, colors: TagColors) {
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    // Replace by name (case-insensitive) so re-saving with the same
    // name updates instead of duplicating.
    const lower = clean.toLowerCase();
    const next = customTagPresets.filter(
      (p) => p.name.toLowerCase() !== lower,
    );
    next.push({ name: clean, colors });
    await persistCustomTagPresets(next);
  }

  async function deleteCustomTagPreset(name: string) {
    const lower = name.trim().toLowerCase();
    const next = customTagPresets.filter(
      (p) => p.name.toLowerCase() !== lower,
    );
    await persistCustomTagPresets(next);
  }

  async function replaceCustomTagPresets(presets: TagColorPreset[]) {
    await persistCustomTagPresets(presets);
  }

  // ----- TitleList helpers -----
  async function saveTitleList(items: TitleListItem[]) {
    await AsyncStorage.setItem(TITLE_LIST_KEY, JSON.stringify(items));
    await AsyncStorage.setItem(TITLE_LIST_SEEDED_KEY, "1");
    setTitleListState(items);
  }

  async function addTitle(title: string, category: string = "Custom") {
    const clean = title.trim().slice(0, 120);
    if (!clean) return;
    const next: TitleListItem = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: clean,
      category: category.trim().slice(0, 60) || "Custom",
    };
    await saveTitleList([next, ...titleListRef.current]);
  }

  async function updateTitle(id: string, title: string, category?: string) {
    const clean = title.trim().slice(0, 120);
    if (!clean) return;
    const next = titleListRef.current.map((t) =>
      t.id === id
        ? {
            ...t,
            title: clean,
            ...(category !== undefined
              ? { category: category.trim().slice(0, 60) || "Custom" }
              : {}),
          }
        : t,
    );
    await saveTitleList(next);
  }

  async function deleteTitle(id: string) {
    await saveTitleList(titleListRef.current.filter((t) => t.id !== id));
  }

  // ----- Data Download Time helpers -----
  // Stamps "now" as the current snapshot time. Used by the Admin
  // "DownloadTime" button (manual refresh acknowledgement) and by
  // the Promo Excel importer once it finishes saving the new batch.
  async function setDataDownloadTimeNow() {
    const now = Date.now();
    await AsyncStorage.setItem(DATA_DOWNLOAD_TIME_KEY, String(now));
    setDataDownloadTime(now);
  }

  async function setDataDownloadTimeValue(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error("Invalid timestamp");
    }
    await AsyncStorage.setItem(DATA_DOWNLOAD_TIME_KEY, String(ms));
    setDataDownloadTime(ms);
  }

  async function clearDataDownloadTime() {
    await AsyncStorage.removeItem(DATA_DOWNLOAD_TIME_KEY);
    setDataDownloadTime(null);
  }

  // ----- Company details helpers -----
  async function setCompanyDetails(details: CompanyDetails) {
    // Normalise to strings; trim long inputs so an accidental paste
    // can't bloat AsyncStorage. 200 chars per field is plenty for
    // every real address line, GST or FSSAI number.
    const trim = (v: unknown): string =>
      typeof v === "string" ? v.slice(0, 200) : "";
    const next: CompanyDetails = {
      companyName: trim(details.companyName),
      address1: trim(details.address1),
      address2: trim(details.address2),
      city: trim(details.city),
      state: trim(details.state),
      country: trim(details.country),
      pincode: trim(details.pincode),
      mobile: trim(details.mobile),
      whatsapp: trim(details.whatsapp),
      gstNo: trim(details.gstNo),
      fssaiNo: trim(details.fssaiNo),
    };
    await AsyncStorage.setItem(COMPANY_DETAILS_KEY, JSON.stringify(next));
    setCompanyDetailsState(next);
  }

  async function resetCompanyDetails() {
    await AsyncStorage.removeItem(COMPANY_DETAILS_KEY);
    setCompanyDetailsState(DEFAULT_COMPANY_DETAILS);
  }

  // ----- CompanyR details helpers (mirror of the primary set) -----
  async function setCompanyDetailsR(details: CompanyDetails) {
    const trim = (v: unknown): string =>
      typeof v === "string" ? v.slice(0, 200) : "";
    const next: CompanyDetails = {
      companyName: trim(details.companyName),
      address1: trim(details.address1),
      address2: trim(details.address2),
      city: trim(details.city),
      state: trim(details.state),
      country: trim(details.country),
      pincode: trim(details.pincode),
      mobile: trim(details.mobile),
      whatsapp: trim(details.whatsapp),
      gstNo: trim(details.gstNo),
      fssaiNo: trim(details.fssaiNo),
    };
    await AsyncStorage.setItem(COMPANY_DETAILS_R_KEY, JSON.stringify(next));
    setCompanyDetailsRState(next);
  }

  async function resetCompanyDetailsR() {
    await AsyncStorage.removeItem(COMPANY_DETAILS_R_KEY);
    setCompanyDetailsRState(DEFAULT_COMPANY_DETAILS_R);
  }

  async function deleteOrder(id: string) {
    await saveOrders(orders.filter((o) => o.id !== id));
  }

  async function clearAllOrders() {
    await saveOrders([]);
  }

  async function clearAllSuppliers() {
    await saveSuppliers([]);
  }

  async function saveRodeoItemsBatch(entries: RodeoItem[]) {
    await AsyncStorage.setItem(RODEO_ITEMS_KEY, JSON.stringify(entries));
    setRodeoItems(entries);
  }

  async function clearRodeoItems() {
    await saveRodeoItemsBatch([]);
  }

  async function clearAllAppUsers() {
    await saveAppUsers([]);
  }

  async function updateOrderStatus(id: string, status: OrderStatus) {
    await saveOrders(
      orders.map((o) =>
        o.id === id ? { ...o, status, updatedAt: new Date().toISOString() } : o
      )
    );
  }

  return (
    <AppContext.Provider
      value={{
        suppliers,
        orders,
        appUsers,
        currentUser,
        login,
        logout,
        addSupplier,
        updateSupplier,
        setSupplierGeneralNotes,
        setSupplierPhotos,
        deleteSupplier,
        addOrder,
        addOrdersBatch,
        addOrdersBatchAsync,
        updateOrder,
        deleteOrder,
        clearAllOrders,
        updateOrderStatus,
        addAppUser,
        updateAppUser,
        deleteAppUser,
        addSuppliersBatch,
        deleteSuppliersBatch,
        addUsersBatch,
        clearAllSuppliers,
        clearAllAppUsers,
        mrpEntries,
        saveMrpBatch,
        clearMrpBatch,
        rasiItems,
        saveRasiItems,
        clearRasiItems,
        latestPurchases,
        saveLatestPurchasesBatch,
        clearLatestPurchases,
        promoEntries,
        promoPrevEntries,
        promoPrevSnapshotAt,
        savePromoBatch,
        snapshotPromoNow,
        clearPromoBatch,
        clearPromoPrev,
        lastSupplyDates,
        saveLastSupplyDateBatch,
        clearLastSupplyDates,
        rodeoItems,
        saveRodeoItemsBatch,
        clearRodeoItems,
        promoNewQty,
        setPromoNewQtyValue,
        priceTagItems,
        savePriceTagItems,
        removePriceTagItem,
        setPriceTagImage,
        clearPriceTagItems,
        priceTagStyle,
        setPriceTagStyle,
        priceTagShowLogo,
        setPriceTagShowLogo,
        priceTagTitle,
        setPriceTagTitle,
        priceTagReviewItems,
        savePriceTagReviewItems,
        removePriceTagReviewItem,
        setPriceTagReviewImage,
        clearPriceTagReviewItems,
        priceTagReviewStyle,
        setPriceTagReviewStyle,
        priceTagReviewShowLogo,
        setPriceTagReviewShowLogo,
        priceTagSquareVariant,
        setPriceTagSquareVariant,
        priceTagReviewTitle,
        setPriceTagReviewTitle,
        tagColors,
        setTagColors,
        resetTagColors,
        customTagPresets,
        saveCustomTagPreset,
        deleteCustomTagPreset,
        replaceCustomTagPresets,
        titleList,
        saveTitleList,
        addTitle,
        updateTitle,
        deleteTitle,
        dataDownloadTime,
        setDataDownloadTimeNow,
        setDataDownloadTimeValue,
        clearDataDownloadTime,
        companyDetails,
        setCompanyDetails,
        resetCompanyDetails,
        companyDetailsR,
        setCompanyDetailsR,
        resetCompanyDetailsR,
        hydrated,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
