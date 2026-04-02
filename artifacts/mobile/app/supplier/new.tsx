import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp } from "@/context/AppContext";

const CATEGORIES = ["Electronics", "Raw Materials", "Packaging", "Logistics", "Services", "Other"];

export default function NewSupplierScreen() {
  const { suppliers, addSupplier } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState("");
  const [vendorCode, setVendorCode] = useState("");
  const [vendorGstNo, setVendorGstNo] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("Other");

  const vendorCodeDuplicate = vendorCode.trim().length > 0 &&
    suppliers.some((s) => s.vendorCode.toUpperCase() === vendorCode.trim().toUpperCase());

  function handleSubmit() {
    if (!name.trim()) {
      Alert.alert("Missing Field", "Company name is required.");
      return;
    }
    if (!vendorCode.trim()) {
      Alert.alert("Missing Field", "Vendor code is required.");
      return;
    }
    if (vendorCodeDuplicate) {
      Alert.alert("Duplicate Vendor Code", `"${vendorCode.trim().toUpperCase()}" is already assigned to another supplier. Vendor Code must be unique.`);
      return;
    }
    addSupplier({ name, vendorCode: vendorCode.trim().toUpperCase(), vendorGstNo: vendorGstNo.trim(), contactName, email, phone, address, category });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }

  return (
    <>
      <Stack.Screen options={{ title: "New Supplier", headerBackTitle: "Back" }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 80 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.formField}>
          <Text style={styles.label}>Company Name *</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. TechParts Global"
            placeholderTextColor={Colors.textMuted}
          />
        </View>

        <View style={styles.formField}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Vendor Code *</Text>
            <View style={styles.pkBadge}>
              <Feather name="key" size={10} color={Colors.primary} />
              <Text style={styles.pkBadgeText}>Primary Key</Text>
            </View>
          </View>
          <TextInput
            style={[styles.input, vendorCodeDuplicate && styles.inputError]}
            value={vendorCode}
            onChangeText={(v) => setVendorCode(v.toUpperCase())}
            placeholder="e.g. VC001"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {vendorCodeDuplicate ? (
            <View style={styles.errorRow}>
              <Feather name="alert-circle" size={13} color={Colors.danger} />
              <Text style={styles.errorText}>This vendor code is already taken</Text>
            </View>
          ) : vendorCode.trim().length > 0 ? (
            <View style={styles.successRow}>
              <Feather name="check-circle" size={13} color={Colors.success} />
              <Text style={styles.successText}>Vendor code is available</Text>
            </View>
          ) : null}
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

        <View style={styles.formField}>
          <Text style={styles.label}>Contact Person</Text>
          <TextInput
            style={styles.input}
            value={contactName}
            onChangeText={setContactName}
            placeholder="Full name"
            placeholderTextColor={Colors.textMuted}
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="contact@supplier.com"
            placeholderTextColor={Colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Phone</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="+1 (555) 000-0000"
            placeholderTextColor={Colors.textMuted}
            keyboardType="phone-pad"
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Address</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={setAddress}
            placeholder="Full business address"
            placeholderTextColor={Colors.textMuted}
          />
        </View>

        <View style={styles.formField}>
          <Text style={styles.label}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>
            {CATEGORIES.map((cat) => (
              <TouchableOpacity
                key={cat}
                style={[styles.catBtn, category === cat && styles.catBtnActive]}
                onPress={() => setCategory(cat)}
              >
                <Text style={[styles.catBtnText, category === cat && styles.catBtnTextActive]}>{cat}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
          <Feather name="user-plus" size={18} color={Colors.textInverse} />
          <Text style={styles.submitBtnText}>Add Supplier</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 20 },
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
  categories: { gap: 8, paddingVertical: 4 },
  catBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  catBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  catBtnText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  catBtnTextActive: { color: Colors.textInverse },
  submitBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 8,
  },
  submitBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
});
