import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  quantity: number;
  unit: string;
  unitPrice: number;
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
  createdAt: string;
  updatedAt: string;
}

interface AppContextType {
  suppliers: Supplier[];
  orders: Order[];
  appUsers: AppUser[];
  addSupplier: (supplier: Omit<Supplier, "id" | "createdAt">) => void;
  updateSupplier: (id: string, supplier: Partial<Supplier>) => void;
  deleteSupplier: (id: string) => void;
  addOrder: (order: Omit<Order, "id" | "orderNumber" | "createdAt" | "updatedAt" | "totalAmount">) => void;
  updateOrder: (id: string, order: Partial<Order>) => void;
  deleteOrder: (id: string) => void;
  updateOrderStatus: (id: string, status: OrderStatus) => void;
  addAppUser: (user: Omit<AppUser, "id" | "createdAt">) => void;
  updateAppUser: (id: string, user: Partial<AppUser>) => void;
  deleteAppUser: (id: string) => void;
}

const AppContext = createContext<AppContextType | null>(null);

const SUPPLIERS_KEY = "@suppliers";
const ORDERS_KEY = "@orders";
const USERS_KEY = "@appUsers";
const ORDERS_CLEARED_KEY = "@orders_cleared_v1";
const SUPPLIERS_CLEARED_KEY = "@suppliers_cleared_v1";

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function generateOrderNumber(): string {
  const prefix = "ORD";
  const num = Math.floor(Math.random() * 90000) + 10000;
  return `${prefix}-${num}`;
}

const SEED_SUPPLIERS: Supplier[] = [];

const SEED_ORDERS: Order[] = [];

export function AppProvider({ children }: { children: ReactNode }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [suppliersData, ordersData, usersData, ordersCleared, suppliersCleared] = await Promise.all([
        AsyncStorage.getItem(SUPPLIERS_KEY),
        AsyncStorage.getItem(ORDERS_KEY),
        AsyncStorage.getItem(USERS_KEY),
        AsyncStorage.getItem(ORDERS_CLEARED_KEY),
        AsyncStorage.getItem(SUPPLIERS_CLEARED_KEY),
      ]);

      if (!suppliersCleared) {
        setSuppliers([]);
        await Promise.all([
          AsyncStorage.setItem(SUPPLIERS_KEY, JSON.stringify([])),
          AsyncStorage.setItem(SUPPLIERS_CLEARED_KEY, "1"),
        ]);
      } else if (suppliersData) {
        setSuppliers(JSON.parse(suppliersData));
      }

      if (!ordersCleared) {
        setOrders([]);
        await Promise.all([
          AsyncStorage.setItem(ORDERS_KEY, JSON.stringify([])),
          AsyncStorage.setItem(ORDERS_CLEARED_KEY, "1"),
        ]);
      } else if (ordersData) {
        setOrders(JSON.parse(ordersData));
      }

      if (usersData) {
        setAppUsers(JSON.parse(usersData));
      }
    } catch (e) {
      setSuppliers(SEED_SUPPLIERS);
      setOrders([]);
    }
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
        addSupplier,
        updateSupplier,
        deleteSupplier,
        addOrder,
        updateOrder,
        deleteOrder,
        updateOrderStatus,
        addAppUser,
        updateAppUser,
        deleteAppUser,
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
