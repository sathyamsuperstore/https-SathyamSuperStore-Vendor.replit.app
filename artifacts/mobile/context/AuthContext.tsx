import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  clearStoredToken,
  loadStoredToken,
  loginWithPin as loginWithPinHttp,
  storeToken,
} from "@/lib/auth";

type AuthContextValue = {
  token: string | null;
  ready: boolean;
  loginWithPin: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadStoredToken();
      if (cancelled) return;
      setToken(stored);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      ready,
      async loginWithPin(pin: string) {
        const t = await loginWithPinHttp(pin);
        await storeToken(t);
        setToken(t);
      },
      async logout() {
        await clearStoredToken();
        setToken(null);
      },
    }),
    [token, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
