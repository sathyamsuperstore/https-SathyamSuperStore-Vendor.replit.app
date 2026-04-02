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
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Colors } from "@/constants/colors";
import { useApp, AppUser, UserType } from "@/context/AppContext";

const USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

export default function UserDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { appUsers, updateAppUser, deleteAppUser } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const user = useMemo(() => appUsers.find((u) => u.id === id), [appUsers, id]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<AppUser>>({});
  const [showPassword, setShowPassword] = useState(false);

  if (!user) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>User not found</Text>
      </View>
    );
  }

  function startEdit() {
    setForm({ ...user });
    setEditing(true);
  }

  function handleSave() {
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
    updateAppUser(user.id, {
      ...form,
      userId: form.userId!.trim(),
      vendorCode: form.vendorCode?.trim() ?? "",
      vendorName: form.vendorName?.trim() ?? "",
      vendorMobileNo1: form.vendorMobileNo1?.trim() ?? "",
      vendorMobileNo2: form.vendorMobileNo2?.trim() ?? "",
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setEditing(false);
  }

  function handleDelete() {
    Alert.alert("Delete User", "This action cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteAppUser(user.id);
          router.back();
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
              <TouchableOpacity onPress={handleSave} style={{ padding: 8 }}>
                <Text style={{ color: Colors.primaryLight, fontWeight: "700", fontSize: 16 }}>Save</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={startEdit} style={{ padding: 8 }}>
                <Feather name="edit-2" size={18} color={Colors.primary} />
              </TouchableOpacity>
            ),
        }}
      />

      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 80 },
        ]}
        showsVerticalScrollIndicator={false}
        bottomOffset={20}
        keyboardShouldPersistTaps="handled"
      >
        {editing ? (
          <View style={styles.form}>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>UserID *</Text>
              <TextInput
                style={styles.input}
                value={form.userId}
                onChangeText={(v) => setForm((p) => ({ ...p, userId: v }))}
                placeholder="User ID"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
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
              <Text style={styles.fieldLabel}>Vendor Code</Text>
              <TextInput style={styles.input} value={form.vendorCode} onChangeText={(v) => setForm((p) => ({ ...p, vendorCode: v }))} placeholder="e.g. VC001" placeholderTextColor={Colors.textMuted} autoCapitalize="characters" />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Vendor Name</Text>
              <TextInput style={styles.input} value={form.vendorName} onChangeText={(v) => setForm((p) => ({ ...p, vendorName: v }))} placeholder="Full vendor name" placeholderTextColor={Colors.textMuted} />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Mobile No 1</Text>
              <TextInput style={styles.input} value={form.vendorMobileNo1} onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo1: v }))} placeholder="+91 00000 00000" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Mobile No 2</Text>
              <TextInput style={styles.input} value={form.vendorMobileNo2} onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo2: v }))} placeholder="Optional" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />
            </View>
            <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
              <Text style={styles.deleteBtnText}>Delete User</Text>
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

            <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
              <Text style={styles.deleteBtnText}>Delete User</Text>
            </TouchableOpacity>
          </>
        )}
      </KeyboardAwareScrollView>
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
  deleteBtnText: { color: Colors.danger, fontSize: 15, fontWeight: "600" },
});
