import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
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

const USER_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  Admin:   { bg: "#FEE2E2", text: "#EF4444" },
  Vendor:  { bg: "#DBEAFE", text: "#3B82F6" },
  Manager: { bg: "#EDE9FE", text: "#8B5CF6" },
  Staff:   { bg: "#D1FAE5", text: "#10B981" },
};

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

  const typeColors = USER_TYPE_COLORS[user.userType] ?? { bg: Colors.surfaceSecondary, text: Colors.textSecondary };

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
      vendorGstNo: form.vendorGstNo?.trim() ?? "",
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
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 40 },
        ]}
        showsVerticalScrollIndicator={false}
        bottomOffset={20}
        keyboardShouldPersistTaps="handled"
      >
        {editing ? (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Account</Text>
              <View style={styles.card}>
                <FieldRow label="UserID *">
                  <TextInput
                    style={styles.input}
                    value={form.userId}
                    onChangeText={(v) => setForm((p) => ({ ...p, userId: v }))}
                    placeholder="User ID"
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </FieldRow>
                <Divider />
                <FieldRow label="Password *">
                  <View style={styles.passwordRow}>
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      value={form.password}
                      onChangeText={(v) => setForm((p) => ({ ...p, password: v }))}
                      placeholder="Password"
                      placeholderTextColor={Colors.textMuted}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                    />
                    <TouchableOpacity onPress={() => setShowPassword((v) => !v)} style={{ padding: 4 }}>
                      <Feather name={showPassword ? "eye-off" : "eye"} size={18} color={Colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                </FieldRow>
                <Divider />
                <FieldRow label="User Type">
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
                </FieldRow>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Vendor Details</Text>
              <View style={styles.card}>
                <FieldRow label="Vendor Code">
                  <TextInput style={styles.input} value={form.vendorCode} onChangeText={(v) => setForm((p) => ({ ...p, vendorCode: v }))} placeholder="e.g. VC001" placeholderTextColor={Colors.textMuted} autoCapitalize="characters" />
                </FieldRow>
                <Divider />
                <FieldRow label="Vendor Name">
                  <TextInput style={styles.input} value={form.vendorName} onChangeText={(v) => setForm((p) => ({ ...p, vendorName: v }))} placeholder="Full vendor name" placeholderTextColor={Colors.textMuted} />
                </FieldRow>
                <Divider />
                <FieldRow label="Mobile No 1">
                  <TextInput style={styles.input} value={form.vendorMobileNo1} onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo1: v }))} placeholder="+91 00000 00000" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />
                </FieldRow>
                <Divider />
                <FieldRow label="Mobile No 2">
                  <TextInput style={styles.input} value={form.vendorMobileNo2} onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo2: v }))} placeholder="Optional" placeholderTextColor={Colors.textMuted} keyboardType="phone-pad" />
                </FieldRow>
                <Divider />
                <FieldRow label="GST No">
                  <TextInput style={styles.input} value={form.vendorGstNo} onChangeText={(v) => setForm((p) => ({ ...p, vendorGstNo: v }))} placeholder="e.g. 27AAPFU0939F1ZV" placeholderTextColor={Colors.textMuted} autoCapitalize="characters" autoCorrect={false} />
                </FieldRow>
              </View>
            </View>

            <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
              <Text style={styles.deleteBtnText}>Delete User</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.profileCard}>
              <View style={[styles.avatar, { backgroundColor: typeColors.bg }]}>
                <Text style={[styles.avatarText, { color: typeColors.text }]}>
                  {(user.vendorName || user.userId).substring(0, 2).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.profileName}>{user.vendorName || user.userId}</Text>
              <View style={[styles.typePill, { backgroundColor: typeColors.bg }]}>
                <Text style={[styles.typePillText, { color: typeColors.text }]}>{user.userType}</Text>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Account</Text>
              <View style={styles.card}>
                <InfoRow icon="user" label="UserID" value={user.userId} />
                <Divider />
                <InfoRow icon="lock" label="Password" value="••••••••" />
                <Divider />
                <InfoRow icon="shield" label="User Type" value={user.userType} />
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Vendor Details</Text>
              <View style={styles.card}>
                <InfoRow icon="tag" label="Vendor Code" value={user.vendorCode} />
                <Divider />
                <InfoRow icon="briefcase" label="Vendor Name" value={user.vendorName} />
                <Divider />
                <InfoRow icon="phone" label="Mobile No 1" value={user.vendorMobileNo1} />
                <Divider />
                <InfoRow icon="phone" label="Mobile No 2" value={user.vendorMobileNo2} />
                <Divider />
                <InfoRow icon="file-text" label="GST No" value={user.vendorGstNo} last />
              </View>
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

function InfoRow({ icon, label, value, last }: { icon: keyof typeof Feather.glyphMap; label: string; value: string; last?: boolean }) {
  return (
    <View style={[infoStyles.row, !last && infoStyles.rowBorder]}>
      <View style={infoStyles.labelRow}>
        <Feather name={icon} size={14} color={Colors.textMuted} />
        <Text style={infoStyles.label}>{label}</Text>
      </View>
      <Text style={infoStyles.value}>{value || "—"}</Text>
    </View>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={fieldStyles.wrap}>
      <Text style={fieldStyles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Divider() {
  return <View style={{ height: 1, backgroundColor: Colors.border }} />;
}

const infoStyles = StyleSheet.create({
  row: { paddingVertical: 13, paddingHorizontal: 16 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  label: { fontSize: 11, color: Colors.textMuted, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
  value: { fontSize: 15, color: Colors.text, fontWeight: "500" },
});

const fieldStyles = StyleSheet.create({
  wrap: { paddingVertical: 12, paddingHorizontal: 16, gap: 6 },
  label: { fontSize: 11, fontWeight: "600", color: Colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 20 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16, color: Colors.textSecondary },
  profileCard: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 10,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  avatarText: { fontSize: 24, fontWeight: "800" },
  profileName: { fontSize: 20, fontWeight: "800", color: Colors.textInverse },
  typePill: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20 },
  typePillText: { fontSize: 13, fontWeight: "700" },
  section: { gap: 10 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: Colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.5, paddingLeft: 4 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  input: { fontSize: 15, color: Colors.text, paddingVertical: 4 },
  passwordRow: { flexDirection: "row", alignItems: "center" },
  typeOptions: { gap: 8, paddingVertical: 4 },
  typeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.surfaceSecondary,
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
