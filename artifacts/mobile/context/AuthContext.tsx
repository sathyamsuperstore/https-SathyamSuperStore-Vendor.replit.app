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
  isFirstRunSeen,
  loadStoredToken,
  loginWithPin as loginWithPinHttp,
  markFirstRunSeen,
  storeToken,
} from "@/lib/auth";

type AuthContextValue = {
  token: string | null;
  ready: boolean;
  // True on the very first launch after install — PinGate uses this
  // to bypass the Admin PIN prompt so the user can explore the app
  // without knowing the PIN. Cleared as soon as PinGate acknowledges
  // it (via `acknowledgeFirstRun`) so subsequent launches without a
  // stored token fall back to the normal lock.
  firstRunBypass: boolean;
  acknowledgeFirstRun: () => Promise<void>;
  loginWithPin: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [firstRunBypass, setFirstRunBypass] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [stored, seen] = await Promise.all([
        loadStoredToken(),
        isFirstRunSeen(),
      ]);
      if (cancelled) return;
      setToken(stored);
      // Only bypass the PIN gate when this is genuinely the first
      // launch (no flag set) AND the user hasn't already established
      // a session. Once they sign in or explicitly acknowledge the
      // bypass, the flag is set and won't trigger again.
      setFirstRunBypass(!seen && !stored);
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
      firstRunBypass,
      async acknowledgeFirstRun() {
        await markFirstRunSeen();
        setFirstRunBypass(false);
      },
      async loginWithPin(pin: string) {
        const t = await loginWithPinHttp(pin);
        await storeToken(t);
        await markFirstRunSeen();
        setFirstRunBypass(false);
        setToken(t);
      },
      async logout() {
        await clearStoredToken();
        setToken(null);
      },
    }),
    [token, ready, firstRunBypass],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
