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
  const url = apiUrl("/api/auth/login");
  const dom = process.env.EXPO_PUBLIC_DOMAIN;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  } catch {
    // Network-level failure — DNS, no internet, or the baked-in API
    // host is unreachable from this device.
    throw new Error(
      `Cannot reach the server${dom ? ` (${dom})` : ""}. Check your internet, or rebuild the APK with EXPO_PUBLIC_DOMAIN set to your published .replit.app domain.`,
    );
  }

  const text = await resp.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  // 403 from a .replit.dev (workspace) URL means the APK was built
  // pointing at the dev server, which blocks outside requests.
  if (resp.status === 403) {
    const looksLikeDevUrl = !!dom && /\.replit\.dev$|\.picard\.replit\.dev$/i.test(dom);
    throw new Error(
      looksLikeDevUrl
        ? `This APK was built pointing at a development URL (${dom}), which blocks outside requests. Set EXPO_PUBLIC_DOMAIN to your published .replit.app domain and rebuild the APK.`
        : `Server refused the request (403)${dom ? ` from ${dom}` : ""}. The APK may be pointing at the wrong API URL — set EXPO_PUBLIC_DOMAIN to your published .replit.app domain and rebuild.`,
    );
  }

  // 5xx with no body usually means ADMIN_PIN/SESSION_SECRET aren't
  // configured on the deployed server.
  if (resp.status >= 500) {
    const msg =
      (body && typeof body.error === "string" && body.error) ||
      `Server error (${resp.status}). The deployed API may be missing ADMIN_PIN or SESSION_SECRET.`;
    throw new Error(msg);
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
