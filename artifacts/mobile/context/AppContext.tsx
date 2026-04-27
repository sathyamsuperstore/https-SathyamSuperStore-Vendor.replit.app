import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  quantity: number;
  unit: string;
  unitPrice: number;
  stock?: number;
  min?: number;
  sortNo?: number;
  newStockQty?: number;
  notes?: string;
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
  mrpEntries: MrpEntry[];
  saveMrpBatch: (entries: MrpEntry[]) => Promise<void>;
  clearMrpBatch: () => Promise<void>;
}

export interface MrpEntry {
  itemNo: string;
  mrp: number;
}

const AppContext = createContext<AppContextType | null>(null);

const SUPPLIERS_KEY = "@suppliers";
const ORDERS_KEY = "@orders";
const USERS_KEY = "@appUsers";
const MRP_KEY = "@mrpBatch";

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
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [mrpEntries, setMrpEntries] = useState<MrpEntry[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [suppliersData, ordersData, usersData, sessionData, mrpData] = await Promise.all([
        AsyncStorage.getItem(SUPPLIERS_KEY),
        AsyncStorage.getItem(ORDERS_KEY),
        AsyncStorage.getItem(USERS_KEY),
        AsyncStorage.getItem(SESSION_KEY),
        AsyncStorage.getItem(MRP_KEY),
      ]);

      const loadedSuppliers = suppliersData ? JSON.parse(suppliersData) : [];
      const loadedOrders = ordersData ? JSON.parse(ordersData) : [];
      const loadedUsers: AppUser[] = usersData ? JSON.parse(usersData) : [];
      const loadedMrp: MrpEntry[] = mrpData ? JSON.parse(mrpData) : [];

      setSuppliers(loadedSuppliers);
      setOrders(loadedOrders);
      setAppUsers(loadedUsers);
      setMrpEntries(loadedMrp);

      if (sessionData) {
        const savedUser = loadedUsers.find((u) => u.id === sessionData);
        if (savedUser) setCurrentUser(savedUser);
      }
    } catch (e) {
      setSuppliers([]);
      setOrders([]);
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

  async function deleteOrder(id: string) {
    await saveOrders(orders.filter((o) => o.id !== id));
  }

  async function clearAllOrders() {
    await saveOrders([]);
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
        mrpEntries,
        saveMrpBatch,
        clearMrpBatch,
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
