import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  TextInput,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, AppUser, UserType, showStorageErrorAlert } from "@/context/AppContext";

const USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

export default function UserDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { appUsers, suppliers, updateAppUser, deleteAppUser } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const user = useMemo(() => appUsers.find((u) => u.id === id), [appUsers, id]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<AppUser>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!user) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>User not found</Text>
      </View>
    );
  }

  const currentUser = user;

  function startEdit() {
    setForm({ ...user });
    setEditing(true);
  }

  const userIdDuplicate =
    (form.userId?.trim().length ?? 0) > 0 &&
    appUsers.some(
      (u) => u.id !== id && u.userId.toLowerCase() === form.userId!.trim().toLowerCase()
    );

  async function handleSave() {
    if (saving) return;
    if (!form.userId?.trim()) {
      Alert.alert("Missing Field", "UserID is required.");
      return;
    }
    if (!form.password?.trim()) {
      Alert.alert("Missing Field", "Password is required.");
      return;
    }
    const duplicate = appUsers.find(
      (u) => u.id !== id && u.userId.toLowerCase() === form.userId!.trim().toLowerCase()
    );
    if (duplicate) {
      Alert.alert("Duplicate UserID", "A user with this UserID already exists.");
      return;
    }
    setSaving(true);
    try {
      await updateAppUser(currentUser.id, {
        ...form,
        userId: form.userId!.trim(),
        vendorCode: form.vendorCode?.trim() ?? "",
        vendorName: form.vendorName?.trim() ?? "",
        vendorMobileNo1: form.vendorMobileNo1?.trim() ?? "",
        vendorMobileNo2: form.vendorMobileNo2?.trim() ?? "",
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditing(false);
    } catch {
      showStorageErrorAlert();
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    if (deleting) return;
    Alert.alert("Delete User", "This action cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setDeleting(true);
          try {
            await deleteAppUser(currentUser.id);
            router.back();
          } catch {
            showStorageErrorAlert();
            setDeleting(false);
          }
        },
      },
    ]);
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: editing ? "Edit User" : user.userId,
          headerRight: () =>
            editing ? (
              <TouchableOpacity
                onPress={handleSave}
                disabled={saving}
                style={{ padding: 8, opacity: saving ? 0.6 : 1 }}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={Colors.primaryLight} />
                ) : (
                  <Text style={{ color: Colors.primaryLight, fontWeight: "700", fontSize: 16 }}>Save</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={startEdit} style={{ padding: 8 }}>
                <Feather name="edit-2" size={18} color={Colors.primary} />
              </TouchableOpacity>
            ),
        }}
      />

      <ScrollView
        style={styles.container}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 80 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {editing ? (
          <View style={styles.form}>
            <View style={styles.formField}>
              <View style={styles.labelRow}>
                <Text style={styles.fieldLabel}>UserID *</Text>
                <View style={styles.pkBadge}>
                  <Feather name="key" size={10} color={Colors.primary} />
                  <Text style={styles.pkBadgeText}>Primary Key</Text>
                </View>
              </View>
              <TextInput
                style={[styles.input, userIdDuplicate && styles.inputError]}
                value={form.userId}
                onChangeText={(v) => setForm((p) => ({ ...p, userId: v }))}
                placeholder="User ID"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {userIdDuplicate ? (
                <View style={styles.errorRow}>
                  <Feather name="alert-circle" size={13} color={Colors.danger} />
                  <Text style={styles.errorText}>This UserID is already taken</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Password *</Text>
              <View style={styles.passwordWrap}>
                <TextInput
                  style={[styles.input, styles.passwordInput]}
                  value={form.password}
                  onChangeText={(v) => setForm((p) => ({ ...p, password: v }))}
                  placeholder="Password"
                  placeholderTextColor={Colors.textMuted}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword((v) => !v)}
                >
                  <Feather name={showPassword ? "eye-off" : "eye"} size={20} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>User Type</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.typeOptions}>
                {USER_TYPES.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.typeBtn, form.userType === t && styles.typeBtnActive]}
                    onPress={() => setForm((p) => ({ ...p, userType: t }))}
                  >
                    <Text style={[styles.typeBtnText, form.userType === t && styles.typeBtnTextActive]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Linked Supplier</Text>
              {suppliers.length === 0 ? (
                <View style={styles.noSuppliers}>
                  <Feather name="info" size={14} color={Colors.textMuted} />
                  <Text style={styles.noSuppliersText}>No suppliers added yet</Text>
                </View>
              ) : (
                <View style={styles.supplierList}>
                  {suppliers.map((s) => {
                    const selected = form.vendorCode === s.vendorCode;
                    return (
                      <TouchableOpacity
                        key={s.id}
                        style={[styles.supplierRow, selected && styles.supplierRowActive]}
                        onPress={() => setForm((p) => ({
                          ...p,
                          vendorCode: selected ? "" : s.vendorCode,
                          vendorName: selected ? "" : s.name,
                        }))}
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
              {form.vendorCode ? (
                <View style={styles.selectedInfo}>
                  <Feather name="link" size={13} color={Colors.primary} />
                  <Text style={styles.selectedInfoText}>
                    Linked to <Text style={{ fontWeight: "700" }}>{form.vendorCode}</Text> — {form.vendorName}
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Mobile No 1</Text>
              <TextInput style={styles.input} value={form.vendorMobileNo1} onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo1: v }))} placeholder="+91 00000 00000" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Mobile No 2</Text>
              <TextInput style={styles.input} value={form.vendorMobileNo2} onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo2: v }))} placeholder="Optional" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />
            </View>
            <TouchableOpacity
              style={[styles.deleteBtn, deleting && styles.btnDisabled]}
              onPress={handleDelete}
              disabled={deleting}
              activeOpacity={0.8}
            >
              {deleting ? (
                <>
                  <ActivityIndicator size="small" color={Colors.danger} />
                  <Text style={styles.deleteBtnText}>Deleting…</Text>
                </>
              ) : (
                <>
                  <Feather name="trash-2" size={16} color={Colors.danger} />
                  <Text style={styles.deleteBtnText}>Delete User</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.infoCard}>
              <InfoRow icon="user" label="UserID" value={user.userId} />
              <InfoRow icon="lock" label="Password" value="••••••••" />
              <InfoRow icon="shield" label="User Type" value={user.userType} />
              <InfoRow icon="tag" label="Vendor Code" value={user.vendorCode} />
              <InfoRow icon="briefcase" label="Vendor Name" value={user.vendorName} />
              <InfoRow icon="phone" label="Mobile No 1" value={user.vendorMobileNo1} />
              <InfoRow icon="phone" label="Mobile No 2" value={user.vendorMobileNo2} last />
            </View>

            <TouchableOpacity
              style={[styles.deleteBtn, deleting && styles.btnDisabled]}
              onPress={handleDelete}
              disabled={deleting}
              activeOpacity={0.8}
            >
              {deleting ? (
                <>
                  <ActivityIndicator size="small" color={Colors.danger} />
                  <Text style={styles.deleteBtnText}>Deleting…</Text>
                </>
              ) : (
                <>
                  <Feather name="trash-2" size={16} color={Colors.danger} />
                  <Text style={styles.deleteBtnText}>Delete User</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </>
  );
}

function InfoRow({
  icon,
  label,
  value,
  last,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <View style={[infoStyles.row, !last && infoStyles.rowBorder]}>
      <Feather name={icon} size={16} color={Colors.textMuted} style={infoStyles.icon} />
      <View style={infoStyles.content}>
        <Text style={infoStyles.label}>{label}</Text>
        <Text style={infoStyles.value}>{value || "—"}</Text>
      </View>
    </View>
  );
}

const infoStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 14 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  icon: { marginTop: 2, marginRight: 12 },
  content: { flex: 1 },
  label: { fontSize: 12, color: Colors.textMuted, marginBottom: 3, fontWeight: "500" },
  value: { fontSize: 15, color: Colors.text, fontWeight: "500" },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 20 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16, color: Colors.textSecondary },
  infoCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  form: { gap: 16 },
  formField: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "700", color: Colors.text },
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
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
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
  typeOptions: { gap: 8, paddingVertical: 4 },
  typeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  typeBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeBtnText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  typeBtnTextActive: { color: Colors.textInverse },
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
  selectedInfo: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
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
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  btnDisabled: { opacity: 0.6 },
  deleteBtnText: { color: Colors.danger, fontSize: 15, fontWeight: "600" },
});
