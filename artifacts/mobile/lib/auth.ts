import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const TOKEN_KEY = "vendor_portal_session_token";

// SecureStore is unavailable on web; fall back to localStorage. Web
// is only used for development previews so this is acceptable.
const webStore = {
  async getItemAsync(key: string): Promise<string | null> {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key);
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  },
  async deleteItemAsync(key: string): Promise<void> {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

const store = Platform.OS === "web" ? webStore : SecureStore;

export async function loadStoredToken(): Promise<string | null> {
  try {
    return await store.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function storeToken(token: string): Promise<void> {
  await store.setItemAsync(TOKEN_KEY, token);
}

export async function clearStoredToken(): Promise<void> {
  await store.deleteItemAsync(TOKEN_KEY);
}

// Build a URL pointing at our api-server. Mirrors the helper in
// pricetag-preview.tsx so the auth flow uses the same convention.
export function apiUrl(path: string): string {
  const dom = process.env.EXPO_PUBLIC_DOMAIN;
  if (dom) return `https://${dom}${path}`;
  return path;
}

export async function loginWithPin(pin: string): Promise<string> {
  const resp = await fetch(apiUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  const text = await resp.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!resp.ok) {
    const msg =
      (body && typeof body.error === "string" && body.error) ||
      `Sign-in failed (${resp.status}).`;
    throw new Error(msg);
  }
  const token: string | undefined = body?.token;
  if (!token) throw new Error("Server returned no token.");
  await storeToken(token);
  return token;
}
