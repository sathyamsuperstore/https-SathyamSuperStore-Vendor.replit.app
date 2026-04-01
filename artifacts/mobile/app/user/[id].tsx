import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, AppUser, UserType } from "@/context/AppContext";

const USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
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

  const typeColors = TYPE_COLORS[user.userType] ?? { bg: Colors.surfaceSecondary, text: Colors.textSecondary };

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

  if (editing) {
    return (
      <>
        <Stack.Screen
          options={{
            title: "Edit User",
            headerRight: () => (
              <TouchableOpacity onPress={handleSave} style={{ padding: 8 }}>
                <Text style={{ color: Colors.primary, fontWeight: "700", fontSize: 16 }}>
                  Save
                </Text>
              </TouchableOpacity>
            ),
          }}
        />
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        >
        <ScrollView
          style={styles.container}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.sectionHeader}>Account</Text>

          <View style={styles.formField}>
            <Text style={styles.label}>UserID *</Text>
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
            <Text style={styles.label}>Password *</Text>
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
                <Feather
                  name={showPassword ? "eye-off" : "eye"}
                  size={20}
                  color={Colors.textMuted}
                />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.formField}>
            <Text style={styles.label}>User Type</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.typeOptions}
            >
              {USER_TYPES.map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeBtn, form.userType === t && styles.typeBtnActive]}
                  onPress={() => setForm((p) => ({ ...p, userType: t }))}
                >
                  <Text
                    style={[
                      styles.typeBtnText,
                      form.userType === t && styles.typeBtnTextActive,
                    ]}
                  >
                    {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <Text style={[styles.sectionHeader, { marginTop: 8 }]}>Vendor Details</Text>

          <View style={styles.formField}>
            <Text style={styles.label}>Vendor Code</Text>
            <TextInput
              style={styles.input}
              value={form.vendorCode}
              onChangeText={(v) => setForm((p) => ({ ...p, vendorCode: v }))}
              placeholder="e.g. VC001"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="characters"
            />
          </View>

          <View style={styles.formField}>
            <Text style={styles.label}>Vendor Name</Text>
            <TextInput
              style={styles.input}
              value={form.vendorName}
              onChangeText={(v) => setForm((p) => ({ ...p, vendorName: v }))}
              placeholder="Full vendor name"
              placeholderTextColor={Colors.textMuted}
            />
          </View>

          <View style={styles.formField}>
            <Text style={styles.label}>Vendor Mobile No 1</Text>
            <TextInput
              style={styles.input}
              value={form.vendorMobileNo1}
              onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo1: v }))}
              placeholder="+91 00000 00000"
              placeholderTextColor={Colors.textMuted}
              keyboardType="phone-pad"
            />
          </View>

          <View style={styles.formField}>
            <Text style={styles.label}>Vendor Mobile No 2</Text>
            <TextInput
              style={styles.input}
              value={form.vendorMobileNo2}
              onChangeText={(v) => setForm((p) => ({ ...p, vendorMobileNo2: v }))}
              placeholder="Optional"
              placeholderTextColor={Colors.textMuted}
              keyboardType="phone-pad"
            />
          </View>

          <View style={styles.formField}>
            <Text style={styles.label}>Vendor GST No</Text>
            <TextInput
              style={styles.input}
              value={form.vendorGstNo}
              onChangeText={(v) => setForm((p) => ({ ...p, vendorGstNo: v }))}
              placeholder="e.g. 27AAPFU0939F1ZV"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </View>

          <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
            <Feather name="trash-2" size={16} color={Colors.danger} />
            <Text style={styles.deleteBtnText}>Delete User</Text>
          </TouchableOpacity>
        </ScrollView>
        </KeyboardAvoidingView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: user.userId,
          headerRight: () => (
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
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 40 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.profileCard, { backgroundColor: Colors.primary }]}>
          <View style={[styles.avatar, { backgroundColor: typeColors.bg }]}>
            <Text style={[styles.avatarText, { color: typeColors.text }]}>
              {(user.vendorName || user.userId).substring(0, 2).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.profileName}>{user.vendorName || user.userId}</Text>
          <View style={[styles.typePill, { backgroundColor: typeColors.bg }]}>
            <Text style={[styles.typePillText, { color: typeColors.text }]}>
              {user.userType}
            </Text>
          </View>
        </View>

        <Text style={styles.sectionHeader}>Account</Text>

        <View style={styles.detailCard}>
          <DetailRow icon="user" label="UserID" value={user.userId} />
          <View style={styles.rowDivider} />
          <DetailRow icon="lock" label="Password" value="••••••••" />
          <View style={styles.rowDivider} />
          <DetailRow icon="shield" label="User Type" value={user.userType} />
        </View>

        <Text style={[styles.sectionHeader, { marginTop: 8 }]}>Vendor Details</Text>

        <View style={styles.detailCard}>
          <DetailRow icon="tag" label="Vendor Code" value={user.vendorCode} />
          <View style={styles.rowDivider} />
          <DetailRow icon="briefcase" label="Vendor Name" value={user.vendorName} />
          <View style={styles.rowDivider} />
          <DetailRow icon="phone" label="Mobile No 1" value={user.vendorMobileNo1} />
          <View style={styles.rowDivider} />
          <DetailRow icon="phone" label="Mobile No 2" value={user.vendorMobileNo2} />
          <View style={styles.rowDivider} />
          <DetailRow icon="file-text" label="GST No" value={user.vendorGstNo} />
        </View>

        <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
          <Feather name="trash-2" size={16} color={Colors.danger} />
          <Text style={styles.deleteBtnText}>Delete User</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={detailStyles.row}>
      <View style={detailStyles.labelRow}>
        <Feather name={icon} size={13} color={Colors.textMuted} />
        <Text style={detailStyles.label}>{label}</Text>
      </View>
      <Text style={detailStyles.value}>{value || "—"}</Text>
    </View>
  );
}

const detailStyles = StyleSheet.create({
  row: { paddingVertical: 12, paddingHorizontal: 16 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 3 },
  label: {
    fontSize: 11,
    color: Colors.textMuted,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  value: { fontSize: 15, color: Colors.text, fontWeight: "500" },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 16 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16, color: Colors.textSecondary },
  profileCard: {
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
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  detailCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  rowDivider: { height: 1, backgroundColor: Colors.border, marginHorizontal: 16 },
  formField: { gap: 8 },
  label: { fontSize: 14, fontWeight: "700", color: Colors.text },
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
    paddingHorizontal: 18,
    paddingVertical: 9,
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
    borderWidth: 1.5,
    borderColor: Colors.danger,
    marginTop: 8,
  },
  deleteBtnText: { color: Colors.danger, fontSize: 15, fontWeight: "600" },
});
