import type { Order, OrderItem } from "@/context/AppContext";

export type SortFieldKey =
  | "supplierName"
  | "status"
  | "orderNumber"
  | "beat"
  | "brand"
  | "category"
  | "name"
  | "unit"
  | "unitPrice"
  | "quantity"
  | "stock"
  | "min"
  | "sortNo";

export type SortFieldDef = {
  key: SortFieldKey;
  label: string;
  type: "string" | "number";
  scope: "order" | "item";
};

export const SORT_FIELDS: SortFieldDef[] = [
  { key: "supplierName", label: "Vendor", type: "string", scope: "order" },
  { key: "status", label: "Status", type: "string", scope: "order" },
  { key: "orderNumber", label: "Order #", type: "string", scope: "order" },
  { key: "beat", label: "Beat", type: "string", scope: "order" },
  { key: "brand", label: "Brand", type: "string", scope: "item" },
  { key: "category", label: "Category", type: "string", scope: "item" },
  { key: "name", label: "Item Desc.", type: "string", scope: "item" },
  { key: "unit", label: "UOM", type: "string", scope: "item" },
  { key: "unitPrice", label: "MRP", type: "number", scope: "item" },
  { key: "quantity", label: "Ord Qty", type: "number", scope: "item" },
  { key: "stock", label: "Stock", type: "number", scope: "item" },
  { key: "min", label: "Min", type: "number", scope: "item" },
  { key: "sortNo", label: "Sort No", type: "number", scope: "item" },
];

export const SORT_FIELD_BY_KEY: Record<SortFieldKey, SortFieldDef> = SORT_FIELDS.reduce(
  (acc, f) => {
    acc[f.key] = f;
    return acc;
  },
  {} as Record<SortFieldKey, SortFieldDef>,
);

export type SortLevel = { key: SortFieldKey; dir: "asc" | "desc" } | null;
export type SortLevelActive = { key: SortFieldKey; dir: "asc" | "desc" };
export const EMPTY_SORT_LEVELS: SortLevel[] = [null, null, null];

export function getOrderSortValue(o: Order, key: SortFieldKey): string | number | null {
  switch (key) {
    case "supplierName": return o.supplierName ?? "";
    case "status": return o.status ?? "";
    case "orderNumber": return o.orderNumber ?? "";
    case "beat": return (o.beat ?? "").trim();
    default: return null;
  }
}

export function getItemSortValue(it: OrderItem, key: SortFieldKey): string | number | null {
  switch (key) {
    case "brand": return it.brand ?? "";
    case "category": return it.category ?? "";
    case "name":
      return it.name.includes(" - ")
        ? it.name.split(" - ").slice(1).join(" - ")
        : it.name;
    case "unit": return it.unit ?? "";
    case "unitPrice": return it.unitPrice ?? null;
    case "quantity": return it.quantity ?? null;
    case "stock": return it.stock ?? null;
    case "min": return it.min ?? null;
    case "sortNo": return it.sortNo ?? null;
    default: return null;
  }
}

export function cmpSortVal(
  a: string | number | null,
  b: string | number | null,
  type: "string" | "number",
  dir: "asc" | "desc",
): number {
  const aBlank = a == null || (type === "string" && a === "");
  const bBlank = b == null || (type === "string" && b === "");
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  let r = 0;
  if (type === "string") {
    r = String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
  } else {
    const an = Number(a);
    const bn = Number(b);
    if (isNaN(an) && isNaN(bn)) r = 0;
    else if (isNaN(an)) r = 1;
    else if (isNaN(bn)) r = -1;
    else r = an - bn;
  }
  return dir === "desc" ? -r : r;
}

export function dirLabelFor(type: "string" | "number", dir: "asc" | "desc"): string {
  if (type === "string") return dir === "asc" ? "A→Z" : "Z→A";
  return dir === "asc" ? "Low→High" : "High→Low";
}

export function applyOrderSort(orders: Order[], levels: SortLevelActive[]): Order[] {
  if (levels.length === 0) return orders;
  return [...orders].sort((a, b) => {
    for (const c of levels) {
      const def = SORT_FIELD_BY_KEY[c.key];
      const r = cmpSortVal(getOrderSortValue(a, c.key), getOrderSortValue(b, c.key), def.type, c.dir);
      if (r !== 0) return r;
    }
    return 0;
  });
}

export function applyItemSort(items: OrderItem[], levels: SortLevelActive[]): OrderItem[] {
  if (levels.length === 0) return items;
  return [...items].sort((a, b) => {
    for (const c of levels) {
      const def = SORT_FIELD_BY_KEY[c.key];
      const r = cmpSortVal(getItemSortValue(a, c.key), getItemSortValue(b, c.key), def.type, c.dir);
      if (r !== 0) return r;
    }
    return 0;
  });
}
