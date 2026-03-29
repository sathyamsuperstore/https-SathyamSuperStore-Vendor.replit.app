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
  vendorGstNo: string;
  createdAt: string;
}

export interface Supplier {
  id: string;
  name: string;
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

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function generateOrderNumber(): string {
  const prefix = "ORD";
  const num = Math.floor(Math.random() * 90000) + 10000;
  return `${prefix}-${num}`;
}

const SEED_SUPPLIERS: Supplier[] = [
  {
    id: "s1",
    name: "TechParts Global",
    contactName: "Sarah Johnson",
    email: "sarah@techparts.com",
    phone: "+1 (555) 234-5678",
    address: "123 Industrial Blvd, Chicago, IL 60601",
    category: "Electronics",
    createdAt: new Date(Date.now() - 86400000 * 30).toISOString(),
  },
  {
    id: "s2",
    name: "RawMat Industries",
    contactName: "Michael Chen",
    email: "m.chen@rawmat.com",
    phone: "+1 (555) 987-6543",
    address: "456 Materials Ave, Houston, TX 77001",
    category: "Raw Materials",
    createdAt: new Date(Date.now() - 86400000 * 20).toISOString(),
  },
  {
    id: "s3",
    name: "PackRight Solutions",
    contactName: "Emma Davis",
    email: "emma@packright.com",
    phone: "+1 (555) 345-6789",
    address: "789 Packaging St, Atlanta, GA 30301",
    category: "Packaging",
    createdAt: new Date(Date.now() - 86400000 * 15).toISOString(),
  },
];

const SEED_ORDERS: Order[] = [
  {
    id: "o1",
    orderNumber: "ORD-10234",
    supplierId: "s1",
    supplierName: "TechParts Global",
    status: "delivered",
    items: [
      { id: "i1", name: "Circuit Board A", quantity: 100, unit: "pcs", unitPrice: 12.5 },
      { id: "i2", name: "Connector Set B", quantity: 50, unit: "sets", unitPrice: 8.0 },
    ],
    totalAmount: 1650,
    notes: "Urgent order for Q1 production",
    expectedDelivery: new Date(Date.now() - 86400000 * 2).toISOString(),
    createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: "o2",
    orderNumber: "ORD-10235",
    supplierId: "s2",
    supplierName: "RawMat Industries",
    status: "shipped",
    items: [
      { id: "i3", name: "Aluminum Sheet 2mm", quantity: 200, unit: "kg", unitPrice: 3.75 },
    ],
    totalAmount: 750,
    notes: "",
    expectedDelivery: new Date(Date.now() + 86400000 * 2).toISOString(),
    createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
  {
    id: "o3",
    orderNumber: "ORD-10236",
    supplierId: "s3",
    supplierName: "PackRight Solutions",
    status: "confirmed",
    items: [
      { id: "i4", name: "Cardboard Box M", quantity: 500, unit: "pcs", unitPrice: 0.85 },
      { id: "i5", name: "Bubble Wrap Roll", quantity: 10, unit: "rolls", unitPrice: 15.0 },
    ],
    totalAmount: 575,
    notes: "Standard packaging for March batch",
    expectedDelivery: new Date(Date.now() + 86400000 * 5).toISOString(),
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
  {
    id: "o4",
    orderNumber: "ORD-10237",
    supplierId: "s1",
    supplierName: "TechParts Global",
    status: "pending",
    items: [
      { id: "i6", name: "Microcontroller X7", quantity: 200, unit: "pcs", unitPrice: 22.0 },
    ],
    totalAmount: 4400,
    notes: "New product launch component",
    expectedDelivery: new Date(Date.now() + 86400000 * 10).toISOString(),
    createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
];

export function AppProvider({ children }: { children: ReactNode }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [suppliersData, ordersData, usersData] = await Promise.all([
        AsyncStorage.getItem(SUPPLIERS_KEY),
        AsyncStorage.getItem(ORDERS_KEY),
        AsyncStorage.getItem(USERS_KEY),
      ]);

      if (suppliersData) {
        setSuppliers(JSON.parse(suppliersData));
      } else {
        setSuppliers(SEED_SUPPLIERS);
        await AsyncStorage.setItem(SUPPLIERS_KEY, JSON.stringify(SEED_SUPPLIERS));
      }

      if (ordersData) {
        setOrders(JSON.parse(ordersData));
      } else {
        setOrders(SEED_ORDERS);
        await AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(SEED_ORDERS));
      }

      if (usersData) {
        setAppUsers(JSON.parse(usersData));
      }
    } catch (e) {
      setSuppliers(SEED_SUPPLIERS);
      setOrders(SEED_ORDERS);
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
