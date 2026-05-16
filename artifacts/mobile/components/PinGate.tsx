import React, { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/AuthContext";
import { Colors } from "@/constants/colors";

export function PinGate({ children }: { children: ReactNode }) {
  const { token, ready, loginWithPin, firstRunBypass, acknowledgeFirstRun } =
    useAuth();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First-time install: silently mark the bypass as acknowledged so
  // the next launch behaves normally, and let the user straight into
  // the app without being prompted for the Admin PIN.
  useEffect(() => {
    if (ready && !token && firstRunBypass) {
      void acknowledgeFirstRun();
    }
  }, [ready, token, firstRunBypass, acknowledgeFirstRun]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (token || firstRunBypass) return <>{children}</>;

  async function submit() {
    if (busy) return;
    if (pin.length === 0) {
      setError("Please enter the Admin PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await loginWithPin(pin);
      setPin("");
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <View style={styles.iconWrap}>
          <Feather name="lock" size={28} color={Colors.primary} />
        </View>
        <Text style={styles.title}>Vendor Portal</Text>
        <Text style={styles.subtitle}>Enter the Admin PIN to unlock.</Text>

        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={(v) => {
            setPin(v);
            if (error) setError(null);
          }}
          placeholder="Admin PIN"
          placeholderTextColor={Colors.textMuted}
          secureTextEntry
          keyboardType="number-pad"
          autoFocus
          onSubmitEditing={submit}
          returnKeyType="go"
          editable={!busy}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, busy && styles.buttonBusy]}
          onPress={submit}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator size="small" color={Colors.textInverse} />
          ) : (
            <Text style={styles.buttonText}>Unlock</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.footnote}>
          Ask your store admin if you don&apos;t know the PIN.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: "stretch",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  iconWrap: {
    alignSelf: "center",
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary + "18",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 18,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    color: Colors.text,
    backgroundColor: Colors.background,
    letterSpacing: 4,
    textAlign: "center",
  },
  error: {
    color: Colors.danger,
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
  button: {
    marginTop: 16,
    backgroundColor: Colors.primary,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: {
    color: Colors.textInverse,
    fontSize: 15,
    fontWeight: "700",
  },
  footnote: {
    color: Colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    marginTop: 12,
  },
});
