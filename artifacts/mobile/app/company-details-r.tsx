import React, { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import {
  useApp,
  DEFAULT_COMPANY_DETAILS_R,
  STORAGE_ERROR_TITLE,
  STORAGE_ERROR_MESSAGE,
  type CompanyDetails,
} from "@/context/AppContext";

// CompanyR — sister screen of CompanyDetails. Same shape, same UX,
// independent storage slot. See company-details.tsx for the original
// pattern; this file is a structural clone with the R variant of
// state + defaults wired in.
type FieldDef = {
  key: keyof CompanyDetails;
  label: string;
  keyboardType?: "default" | "phone-pad" | "numeric";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  placeholder?: string;
};

const FIELDS: FieldDef[] = [
  { key: "companyName", label: "Company Name", autoCapitalize: "words" },
  { key: "address1", label: "Address 1", autoCapitalize: "words" },
  { key: "address2", label: "Address 2", autoCapitalize: "words" },
  { key: "city", label: "City", autoCapitalize: "words" },
  { key: "state", label: "State", autoCapitalize: "characters" },
  { key: "country", label: "Country", autoCapitalize: "words" },
  { key: "pincode", label: "Pincode", keyboardType: "numeric" },
  { key: "mobile", label: "Mobile", keyboardType: "phone-pad", placeholder: "+91…" },
  { key: "whatsapp", label: "Whatsapp No", keyboardType: "phone-pad", placeholder: "+91…" },
  { key: "gstNo", label: "GST No", autoCapitalize: "characters" },
  { key: "fssaiNo", label: "Fssai No", keyboardType: "numeric" },
];

export default function CompanyDetailsRScreen() {
  const { companyDetailsR, setCompanyDetailsR, resetCompanyDetailsR } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [draft, setDraft] = useState<CompanyDetails>(companyDetailsR);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setDraft(companyDetailsR);
  }, [companyDetailsR]);

  const dirty = (Object.keys(DEFAULT_COMPANY_DETAILS_R) as (keyof CompanyDetails)[])
    .some((k) => draft[k] !== companyDetailsR[k]);

  function update(key: keyof CompanyDetails, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function onSave() {
    if (saving) return;
    setSaving(true);
    try {
      await setCompanyDetailsR(draft);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch {
      Alert.alert(STORAGE_ERROR_TITLE, STORAGE_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  function onResetDefaults() {
    const run = async () => {
      try {
        await resetCompanyDetailsR();
        setDraft(DEFAULT_COMPANY_DETAILS_R);
        Haptics.selectionAsync();
      } catch {
        Alert.alert(STORAGE_ERROR_TITLE, STORAGE_ERROR_MESSAGE);
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm("Reset all CompanyR details to the original defaults?")) {
        run();
      }
    } else {
      Alert.alert(
        "Reset CompanyR Details?",
        "This restores the original CompanyR values for every field.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Reset", style: "destructive", onPress: run },
        ],
      );
    }
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "CompanyR Details",
          headerBackTitle: "Back",
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 120 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.intro}>
            Second store-identity profile (CompanyR). Same fields as
            Company Details but stored separately. Tap Save to persist
            your changes.
          </Text>

          <View style={styles.tableCard}>
            <View style={styles.headerRow}>
              <Text style={[styles.headerCell, styles.cellFields]}>Field</Text>
              <Text style={[styles.headerCell, styles.cellValue]}>Value</Text>
            </View>
            {FIELDS.map((f, idx) => (
              <View
                key={f.key}
                style={[
                  styles.row,
                  idx === FIELDS.length - 1 && styles.rowLast,
                ]}
              >
                <Text style={[styles.fieldLabel, styles.cellFields]}>
                  {f.label}
                </Text>
                <View style={styles.cellValue}>
                  <TextInput
                    style={styles.input}
                    value={draft[f.key]}
                    onChangeText={(v) => update(f.key, v)}
                    placeholder={
                      f.placeholder ?? DEFAULT_COMPANY_DETAILS_R[f.key] ?? ""
                    }
                    placeholderTextColor={Colors.textMuted}
                    keyboardType={f.keyboardType ?? "default"}
                    autoCapitalize={f.autoCapitalize ?? "sentences"}
                    autoCorrect={false}
                    returnKeyType="done"
                  />
                </View>
              </View>
            ))}
          </View>

          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.secondaryBtn]}
              onPress={onResetDefaults}
              activeOpacity={0.85}
            >
              <Feather name="rotate-ccw" size={14} color={Colors.text} />
              <Text style={styles.secondaryBtnText}>Reset Defaults</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (!dirty || saving) && styles.primaryBtnDisabled,
              ]}
              onPress={onSave}
              disabled={!dirty || saving}
              activeOpacity={0.85}
            >
              <Feather name="save" size={14} color={Colors.textInverse} />
              <Text style={styles.primaryBtnText}>
                {saving ? "Saving…" : savedFlash ? "Saved" : "Save"}
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <Text style={styles.cancelBtnText}>Close</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  intro: {
    fontSize: 13,
    color: Colors.textMuted,
    lineHeight: 18,
    marginBottom: 12,
  },
  tableCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    overflow: "hidden",
  },
  headerRow: {
    flexDirection: "row",
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  headerCell: {
    fontSize: 12,
    fontWeight: "800",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 8,
  },
  rowLast: { borderBottomWidth: 0 },
  cellFields: { width: 130 },
  cellValue: { flex: 1 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: Colors.text },
  input: {
    fontSize: 14,
    color: Colors.text,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
  },
  actionsRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: Colors.textInverse, fontWeight: "800", fontSize: 14 },
  secondaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  secondaryBtnText: { color: Colors.text, fontWeight: "700", fontSize: 14 },
  cancelBtn: { marginTop: 14, paddingVertical: 12, alignItems: "center" },
  cancelBtnText: { color: Colors.textMuted, fontSize: 13, fontWeight: "600" },
});
