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
import { useApp } from "@/context/AppContext";

const CATEGORIES = ["Electronics", "Raw Materials", "Packaging", "Logistics", "Services", "Other"];

export default function NewSupplierScreen() {
  const { addSupplier } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState("");
  const [vendorCode, setVendorCode] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("Other");

  function handleSubmit() {
    if (!name.trim()) {
      Alert.alert("Missing Name", "Supplier name is required.");
      return;
    }
    addSupplier({ name, vendorCode: vendorCode.trim(), contactName, email, phone, address, category });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }

  return (
    <>
      <Stack.Screen options={{ title: "New Supplier", headerBackTitle: "Back" }} />
      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 40 }]}
        showsVerticalScrollIndicator={false}
        bottomOffset={20}
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
          <Text style={styles.label}>Vendor Code</Text>
          <TextInput
            style={styles.input}
            value={vendorCode}
            onChangeText={setVendorCode}
            placeholder="e.g. VC001"
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
      </KeyboardAwareScrollView>
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
