import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  login: (userId: string, password: string) => { success: boolean; error?: string };
  logout: () => void;
  addSupplier: (supplier: Omit<Supplier, "id" | "createdAt">) => void;
  updateSupplier: (id: string, supplier: Partial<Supplier>) => void;
  deleteSupplier: (id: string) => void;
  addOrder: (order: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">) => void;
  addOrdersBatch: (orders: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[]) => void;
  addOrdersBatchAsync: (
    orders: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[],
    onProgress?: (processed: number, total: number) => void | Promise<void>
  ) => Promise<void>;
  updateOrder: (id: string, order: Partial<Order>) => void;
  deleteOrder: (id: string) => void;
  clearAllOrders: () => void;
  updateOrderStatus: (id: string, status: OrderStatus) => void;
  addAppUser: (user: Omit<AppUser, "id" | "createdAt">) => void;
  updateAppUser: (id: string, user: Partial<AppUser>) => void;
  deleteAppUser: (id: string) => void;
  addSuppliersBatch: (items: Omit<Supplier, "id" | "createdAt">[]) => { added: number; skipped: string[]; addedSuppliers: Supplier[] };
  addUsersBatch: (items: Omit<AppUser, "id" | "createdAt">[]) => { added: number; skipped: string[] };
  mrpEntries: MrpEntry[];
  saveMrpBatch: (entries: MrpEntry[]) => void;
  clearMrpBatch: () => void;
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

  async function saveMrpBatch(entries: MrpEntry[]) {
    setMrpEntries(entries);
    await AsyncStorage.setItem(MRP_KEY, JSON.stringify(entries));
  }

  async function clearMrpBatch() {
    setMrpEntries([]);
    await AsyncStorage.removeItem(MRP_KEY);
  }

  function login(userId: string, password: string): { success: boolean; error?: string } {
    const user = appUsers.find(
      (u) => u.userId.toLowerCase() === userId.trim().toLowerCase() && u.password === password
    );
    if (!user) return { success: false, error: "Invalid User ID or Password." };
    setCurrentUser(user);
    AsyncStorage.setItem(SESSION_KEY, user.id);
    return { success: true };
  }

  function logout() {
    setCurrentUser(null);
    AsyncStorage.removeItem(SESSION_KEY);
  }

  async function saveSuppliers(data: Supplier[]) {
    setSuppliers(data);
    await AsyncStorage.setItem(SUPPLIERS_KEY, JSON.stringify(data));
  }

  async function saveAppUsers(data: AppUser[]) {
    setAppUsers(data);
    await AsyncStorage.setItem(USERS_KEY, JSON.stringify(data));
  }

  function addAppUser(user: Omit<AppUser, "id" | "createdAt">) {
    const newUser: AppUser = {
      ...user,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    saveAppUsers([...appUsers, newUser]);
  }

  function updateAppUser(id: string, data: Partial<AppUser>) {
    saveAppUsers(appUsers.map((u) => (u.id === id ? { ...u, ...data } : u)));
  }

  function deleteAppUser(id: string) {
    saveAppUsers(appUsers.filter((u) => u.id !== id));
  }

  function addSuppliersBatch(items: Omit<Supplier, "id" | "createdAt">[]): { added: number; skipped: string[]; addedSuppliers: Supplier[] } {
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
    if (newSuppliers.length > 0) saveSuppliers([...suppliers, ...newSuppliers]);
    return { added: newSuppliers.length, skipped, addedSuppliers: newSuppliers };
  }

  function addUsersBatch(items: Omit<AppUser, "id" | "createdAt">[]): { added: number; skipped: string[] } {
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
    if (newUsers.length > 0) saveAppUsers([...appUsers, ...newUsers]);
    return { added: newUsers.length, skipped };
  }

  async function saveOrders(data: Order[]) {
    setOrders(data);
    await AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(data));
  }

  function calculateTotal(items: OrderItem[]): number {
    return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  }

  function addSupplier(supplier: Omit<Supplier, "id" | "createdAt">) {
    const newSupplier: Supplier = {
      ...supplier,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    saveSuppliers([...suppliers, newSupplier]);
  }

  function updateSupplier(id: string, data: Partial<Supplier>) {
    saveSuppliers(suppliers.map((s) => (s.id === id ? { ...s, ...data } : s)));
  }

  function deleteSupplier(id: string) {
    saveSuppliers(suppliers.filter((s) => s.id !== id));
  }

  function addOrder(order: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">) {
    const now = new Date().toISOString();
    const newOrder: Order = {
      ...order,
      id: generateId(),
      orderNumber: generateOrderNumber(),
      totalAmount: calculateTotal(order.items),
      createdAt: now,
      updatedAt: now,
    };
    saveOrders([newOrder, ...orders]);
  }

  function addOrdersBatch(orderInputs: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[]) {
    const now = new Date().toISOString();
    const newOrders: Order[] = orderInputs.map((order) => ({
      ...order,
      id: generateId(),
      orderNumber: generateOrderNumber(),
      totalAmount: calculateTotal(order.items),
      createdAt: now,
      updatedAt: now,
    }));
    saveOrders([...newOrders, ...orders]);
  }

  // Async chunked variant for very large imports. Builds the new Order objects
  // in CHUNK-sized batches with `await setTimeout(0)` between chunks so the JS
  // thread can render the spinner / progress text in the caller. Reports
  // progress after each chunk via the optional callback. The actual state
  // commit (saveOrders) happens once at the end — there's no good way to chunk
  // that without showing partial state — but the yield right before it lets the
  // UI commit the latest progress message before the heavy reconciliation.
  async function addOrdersBatchAsync(
    orderInputs: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">[],
    onProgress?: (processed: number, total: number) => void | Promise<void>
  ) {
    const now = new Date().toISOString();
    const total = orderInputs.length;
    const newOrders: Order[] = new Array(total);
    const CHUNK = 100;
    for (let i = 0; i < total; i++) {
      const order = orderInputs[i];
      newOrders[i] = {
        ...order,
        id: generateId(),
        orderNumber: generateOrderNumber(),
        totalAmount: calculateTotal(order.items),
        createdAt: now,
        updatedAt: now,
      };
      // Report at clean milestones: 100/N, 200/N, ...
      if ((i + 1) % CHUNK === 0 && i + 1 < total) {
        if (onProgress) await onProgress(i + 1, total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (onProgress) await onProgress(total, total);
    await new Promise((r) => setTimeout(r, 0));
    // Persist to AsyncStorage FIRST, then update in-memory state. If the
    // storage write throws, we don't want to leave orders in memory that
    // weren't actually saved — the caller would show a "failed" alert while
    // the data appears in the UI, and the next app launch would lose it.
    // Merge against the LATEST orders via ordersRef, not the closure-captured
    // `orders`, so concurrent additions during this long-running async path
    // aren't lost.
    const updated = [...newOrders, ...ordersRef.current];
    await AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(updated));
    setOrders(updated);
  }

  function updateOrder(id: string, data: Partial<Order>) {
    saveOrders(
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

  function deleteOrder(id: string) {
    saveOrders(orders.filter((o) => o.id !== id));
  }

  function clearAllOrders() {
    saveOrders([]);
  }

  function updateOrderStatus(id: string, status: OrderStatus) {
    saveOrders(
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
