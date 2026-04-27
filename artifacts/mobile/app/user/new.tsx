import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  Platform,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, UserType, showStorageErrorAlert } from "@/context/AppContext";

const USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

export default function NewUserScreen() {
  const { appUsers, suppliers, addAppUser } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [userType, setUserType] = useState<UserType>("Vendor");
  const [vendorCode, setVendorCode] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorMobileNo1, setVendorMobileNo1] = useState("");
  const [vendorMobileNo2, setVendorMobileNo2] = useState("");

  const userIdDuplicate =
    userId.trim().length > 0 &&
    appUsers.some((u) => u.userId.toLowerCase() === userId.trim().toLowerCase());

  function selectSupplier(code: string, name: string) {
    if (vendorCode === code) {
      setVendorCode("");
      setVendorName("");
    } else {
      setVendorCode(code);
      setVendorName(name);
    }
  }

  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (saving) return;
    if (!userId.trim()) {
      Alert.alert("Missing Field", "UserID is required.");
      return;
    }
    if (!password.trim()) {
      Alert.alert("Missing Field", "Password is required.");
      return;
    }
    const duplicate = appUsers.find(
      (u) => u.userId.toLowerCase() === userId.trim().toLowerCase()
    );
    if (duplicate) {
      Alert.alert("Duplicate UserID", "A user with this UserID already exists.");
      return;
    }
    setSaving(true);
    try {
      await addAppUser({
        userId: userId.trim(),
        password,
        userType,
        vendorCode: vendorCode.trim(),
        vendorName: vendorName.trim(),
        vendorMobileNo1: vendorMobileNo1.trim(),
        vendorMobileNo2: vendorMobileNo2.trim(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      showStorageErrorAlert();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "New User",
          headerBackTitle: "Back",
          headerRight: () => (
            <TouchableOpacity onPress={handleSubmit} style={{ padding: 8 }}>
              <Text style={{ color: Colors.primary, fontWeight: "700", fontSize: 16 }}>
                Save
              </Text>
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 80 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.sectionHeader}>Account</Text>

        <View style={styles.formField}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>UserID *</Text>
            <View style={styles.pkBadge}>
              <Feather name="key" size={10} color={Colors.primary} />
              <Text style={styles.pkBadgeText}>Primary Key</Text>
            </View>
          </View>
          <TextInput
            style={[styles.input, userIdDuplicate && styles.inputError]}
            value={userId}
            onChangeText={setUserId}
            placeholder="Enter unique user ID"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {userIdDuplicate ? (
            <View style={styles.errorRow}>
              <Feather name="alert-circle" size={13} color={Colors.danger} />
              <Text style={styles.errorText}>This UserID is already taken</Text>
            </View>
          ) : userId.trim().length > 0 ? (
            <View style={styles.successRow}>
              <Feather name="check-circle" size={13} color={Colors.success} />
              <Text style={styles.successText}>UserID is available</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Password *</Text>
          <View style={styles.passwordWrap}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              value={password}
              onChangeText={setPassword}
              placeholder="Enter password"
              placeholderTextColor={Colors.textMuted}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowPassword((v) => !v)}>
              <Feather name={showPassword ? "eye-off" : "eye"} size={20} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>User Type</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.typeOptions}
            keyboardShouldPersistTaps="handled"
          >
            {USER_TYPES.map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.typeBtn, userType === t && styles.typeBtnActive]}
                onPress={() => setUserType(t)}
              >
                <Text style={[styles.typeBtnText, userType === t && styles.typeBtnTextActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        <Text style={[styles.sectionHeader, { marginTop: 8 }]}>Vendor Details</Text>

        <View style={styles.formField}>
          <Text style={styles.label}>Linked Supplier</Text>
          {suppliers.length === 0 ? (
            <View style={styles.noSuppliers}>
              <Feather name="info" size={14} color={Colors.textMuted} />
              <Text style={styles.noSuppliersText}>No suppliers added yet</Text>
            </View>
          ) : (
            <View style={styles.supplierList}>
              {suppliers.map((s) => {
                const selected = vendorCode === s.vendorCode;
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.supplierRow, selected && styles.supplierRowActive]}
                    onPress={() => selectSupplier(s.vendorCode, s.name)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.supplierCodeBadge, selected && styles.supplierCodeBadgeActive]}>
                      <Text style={[styles.supplierCodeText, selected && styles.supplierCodeTextActive]}>
                        {s.vendorCode || "—"}
                      </Text>
                    </View>
                    <Text style={[styles.supplierName, selected && styles.supplierNameActive]} numberOfLines={1}>
                      {s.name}
                    </Text>
                    {selected && <Feather name="check-circle" size={18} color={Colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {vendorCode ? (
            <View style={styles.selectedInfo}>
              <Feather name="link" size={13} color={Colors.primary} />
              <Text style={styles.selectedInfoText}>
                Linked to <Text style={{ fontWeight: "700" }}>{vendorCode}</Text> — {vendorName}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Vendor Mobile No 1</Text>
          <TextInput
            style={styles.input}
            value={vendorMobileNo1}
            onChangeText={setVendorMobileNo1}
            placeholder="+91 00000 00000"
            placeholderTextColor={Colors.textMuted}
            keyboardType="phone-pad"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Vendor Mobile No 2</Text>
          <TextInput
            style={styles.input}
            value={vendorMobileNo2}
            onChangeText={setVendorMobileNo2}
            placeholder="+91 00000 00000 (optional)"
            placeholderTextColor={Colors.textMuted}
            keyboardType="phone-pad"
          />
        </View>

        <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit} activeOpacity={0.8}>
          <Feather name="user-plus" size={18} color="#fff" />
          <Text style={styles.submitBtnText}>Create User</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 16 },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  formField: { gap: 8 },
  label: { fontSize: 14, fontWeight: "700", color: Colors.text },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "android" ? 10 : 12,
    fontSize: 15,
    color: Colors.text,
  },
  passwordWrap: { position: "relative" },
  passwordInput: { paddingRight: 48 },
  eyeBtn: {
    position: "absolute",
    right: 12,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    padding: 4,
  },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pkBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  pkBadgeText: { fontSize: 10, fontWeight: "700", color: Colors.primary },
  inputError: { borderColor: Colors.danger, borderWidth: 1.5 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  errorText: { fontSize: 12, color: Colors.danger, fontWeight: "500" },
  successRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  successText: { fontSize: 12, color: Colors.success, fontWeight: "500" },
  typeOptions: { gap: 8, paddingVertical: 4 },
  typeBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  typeBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeBtnText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  typeBtnTextActive: { color: "#fff" },
  supplierList: { borderRadius: 12, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  supplierRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 10,
  },
  supplierRowActive: { backgroundColor: Colors.primaryMuted },
  supplierCodeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: Colors.border,
    minWidth: 52,
    alignItems: "center",
  },
  supplierCodeBadgeActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  supplierCodeText: { fontSize: 11, fontWeight: "700", color: Colors.textSecondary },
  supplierCodeTextActive: { color: Colors.textInverse },
  supplierName: { flex: 1, fontSize: 14, fontWeight: "500", color: Colors.text },
  supplierNameActive: { color: Colors.primary, fontWeight: "700" },
  selectedInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
  },
  selectedInfoText: { fontSize: 13, color: Colors.primary },
  noSuppliers: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noSuppliersText: { fontSize: 14, color: Colors.textMuted },
  submitBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 8,
    elevation: 3,
  },
  submitBtnText: { fontSize: 16, fontWeight: "700", color: "#fff" },
});
