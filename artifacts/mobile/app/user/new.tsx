import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
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

  const bottomPad = insets.bottom + (Platform.OS === "android" ? 16 : 12);

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

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.sectionHeader}>Account</Text>

          <View style={styles.formField}>
            <Text style={styles.label}>UserID *</Text>
            <TextInput
              style={styles.input}
              value={userId}
              onChangeText={setUserId}
              placeholder="Enter unique user ID"
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
              keyboardShouldPersistTaps="handled"
            >
              {USER_TYPES.map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeBtn, userType === t && styles.typeBtnActive]}
                  onPress={() => setUserType(t)}
                >
                  <Text style={[styles.typeBtnText, userType === t && styles.typeBtnTextActive]}>
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
              value={vendorCode}
              onChangeText={setVendorCode}
              placeholder="e.g. VC001"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="characters"
            />
          </View>

          <View style={styles.formField}>
            <Text style={styles.label}>Vendor Name</Text>
            <TextInput
              style={styles.input}
              value={vendorName}
              onChangeText={setVendorName}
              placeholder="Full vendor / company name"
              placeholderTextColor={Colors.textMuted}
            />
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

          <View style={styles.formField}>
            <Text style={styles.label}>Vendor GST No</Text>
            <TextInput
              style={styles.input}
              value={vendorGstNo}
              onChangeText={setVendorGstNo}
              placeholder="e.g. 27AAPFU0939F1ZV"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
            />
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: bottomPad }]}>
          <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
            <Feather name="user-plus" size={18} color={Colors.textInverse} />
            <Text style={styles.submitBtnText}>Create User</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 16, paddingBottom: 20 },
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
  footer: {
    backgroundColor: Colors.background,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
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
