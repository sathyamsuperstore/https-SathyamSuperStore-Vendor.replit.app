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
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Colors } from "@/constants/colors";
import { useApp, UserType } from "@/context/AppContext";

const USER_TYPES: UserType[] = ["Admin", "Vendor", "Manager", "Staff"];

export default function NewUserScreen() {
  const { appUsers, addAppUser } = useApp();
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
  const [vendorGstNo, setVendorGstNo] = useState("");

  function handleSubmit() {
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
    addAppUser({
      userId: userId.trim(),
      password,
      userType,
      vendorCode: vendorCode.trim(),
      vendorName: vendorName.trim(),
      vendorMobileNo1: vendorMobileNo1.trim(),
      vendorMobileNo2: vendorMobileNo2.trim(),
      vendorGstNo: vendorGstNo.trim(),
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }

  return (
    <>
      <Stack.Screen options={{ title: "New User", headerBackTitle: "Back" }} />
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
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <View style={styles.card}>
            <Field label="UserID *">
              <TextInput
                style={styles.input}
                value={userId}
                onChangeText={setUserId}
                placeholder="Enter unique user ID"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Divider />
            <Field label="Password *">
              <View style={styles.passwordRow}>
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
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword((v) => !v)}
                >
                  <Feather
                    name={showPassword ? "eye-off" : "eye"}
                    size={18}
                    color={Colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
            </Field>
            <Divider />
            <Field label="User Type">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.typeOptions}
              >
                {USER_TYPES.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.typeBtn, userType === t && styles.typeBtnActive]}
                    onPress={() => setUserType(t)}
                  >
                    <Text
                      style={[styles.typeBtnText, userType === t && styles.typeBtnTextActive]}
                    >
                      {t}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </Field>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Vendor Details</Text>
          <View style={styles.card}>
            <Field label="Vendor Code">
              <TextInput
                style={styles.input}
                value={vendorCode}
                onChangeText={setVendorCode}
                placeholder="e.g. VC001"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="characters"
              />
            </Field>
            <Divider />
            <Field label="Vendor Name">
              <TextInput
                style={styles.input}
                value={vendorName}
                onChangeText={setVendorName}
                placeholder="Full vendor/company name"
                placeholderTextColor={Colors.textMuted}
              />
            </Field>
            <Divider />
            <Field label="Mobile No 1">
              <TextInput
                style={styles.input}
                value={vendorMobileNo1}
                onChangeText={setVendorMobileNo1}
                placeholder="+91 00000 00000"
                placeholderTextColor={Colors.textMuted}
                keyboardType="phone-pad"
              />
            </Field>
            <Divider />
            <Field label="Mobile No 2">
              <TextInput
                style={styles.input}
                value={vendorMobileNo2}
                onChangeText={setVendorMobileNo2}
                placeholder="+91 00000 00000 (optional)"
                placeholderTextColor={Colors.textMuted}
                keyboardType="phone-pad"
              />
            </Field>
            <Divider />
            <Field label="GST No">
              <TextInput
                style={styles.input}
                value={vendorGstNo}
                onChangeText={setVendorGstNo}
                placeholder="e.g. 27AAPFU0939F1ZV"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            </Field>
          </View>
        </View>

        <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
          <Feather name="user-plus" size={18} color={Colors.textInverse} />
          <Text style={styles.submitBtnText}>Create User</Text>
        </TouchableOpacity>
      </KeyboardAwareScrollView>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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

const fieldStyles = StyleSheet.create({
  wrap: { paddingVertical: 12, paddingHorizontal: 16, gap: 6 },
  label: { fontSize: 12, fontWeight: "600", color: Colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 20 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: Colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.5, paddingLeft: 4 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  input: {
    fontSize: 15,
    color: Colors.text,
    paddingVertical: 4,
  },
  passwordRow: { flexDirection: "row", alignItems: "center" },
  passwordInput: { flex: 1 },
  eyeBtn: { padding: 4 },
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
  submitBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  submitBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
});
