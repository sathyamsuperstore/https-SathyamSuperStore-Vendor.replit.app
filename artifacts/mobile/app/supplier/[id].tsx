import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, Supplier } from "@/context/AppContext";
import { OrderCard } from "@/components/OrderCard";

const CATEGORIES = ["Electronics", "Raw Materials", "Packaging", "Logistics", "Services", "Other"];

export default function SupplierDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { suppliers, orders, updateSupplier, deleteSupplier } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const supplier = useMemo(() => suppliers.find((s) => s.id === id), [suppliers, id]);
  const supplierOrders = useMemo(() => orders.filter((o) => o.supplierId === id), [orders, id]);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Supplier>>({});

  if (!supplier) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Supplier not found</Text>
      </View>
    );
  }

  function startEdit() {
    setForm({
      name: supplier!.name,
      vendorCode: supplier!.vendorCode,
      vendorGstNo: supplier!.vendorGstNo,
      contactName: supplier!.contactName,
      email: supplier!.email,
      phone: supplier!.phone,
      address: supplier!.address,
      category: supplier!.category,
    });
    setEditing(true);
  }

  const vendorCodeDuplicate =
    (form.vendorCode?.trim().length ?? 0) > 0 &&
    suppliers.some(
      (s) =>
        s.id !== supplier!.id &&
        s.vendorCode.toUpperCase() === form.vendorCode!.trim().toUpperCase()
    );

  function handleSave() {
    if (!form.name?.trim()) {
      Alert.alert("Missing Field", "Company name is required.");
      return;
    }
    if (!form.vendorCode?.trim()) {
      Alert.alert("Missing Field", "Vendor code is required.");
      return;
    }
    if (vendorCodeDuplicate) {
      Alert.alert("Duplicate Vendor Code", `"${form.vendorCode!.trim().toUpperCase()}" is already assigned to another supplier. Vendor Code must be unique.`);
      return;
    }
    updateSupplier(supplier!.id, { ...form, vendorCode: form.vendorCode!.trim().toUpperCase() });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setEditing(false);
  }

  function handleDelete() {
    Alert.alert("Delete Supplier", "This will also keep existing orders. Continue?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteSupplier(supplier!.id);
          router.back();
        },
      },
    ]);
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: editing ? "Edit Supplier" : supplier.name,
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
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 80 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {editing ? (
          <View style={styles.form}>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Vendor Name *</Text>
              <TextInput
                style={styles.input}
                value={form.name}
                onChangeText={(v) => setForm((p) => ({ ...p, name: v }))}
                placeholder="Company name"
                placeholderTextColor={Colors.textMuted}
              />
            </View>
            <View style={styles.formField}>
              <View style={styles.labelRow}>
                <Text style={styles.fieldLabel}>Vendor Code *</Text>
                <View style={styles.pkBadge}>
                  <Feather name="key" size={10} color={Colors.primary} />
                  <Text style={styles.pkBadgeText}>Primary Key</Text>
                </View>
              </View>
              <TextInput
                style={[styles.input, vendorCodeDuplicate && styles.inputError]}
                value={form.vendorCode}
                onChangeText={(v) => setForm((p) => ({ ...p, vendorCode: v.toUpperCase() }))}
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
              ) : null}
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Vendor GST No</Text>
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
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Contact Name</Text>
              <TextInput
                style={styles.input}
                value={form.contactName}
                onChangeText={(v) => setForm((p) => ({ ...p, contactName: v }))}
                placeholder="Contact person"
                placeholderTextColor={Colors.textMuted}
              />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Email</Text>
              <TextInput
                style={styles.input}
                value={form.email}
                onChangeText={(v) => setForm((p) => ({ ...p, email: v }))}
                placeholder="email@example.com"
                placeholderTextColor={Colors.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Phone</Text>
              <TextInput
                style={styles.input}
                value={form.phone}
                onChangeText={(v) => setForm((p) => ({ ...p, phone: v }))}
                placeholder="+1 (555) 000-0000"
                placeholderTextColor={Colors.textMuted}
                keyboardType="phone-pad"
              />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Address</Text>
              <TextInput
                style={styles.input}
                value={form.address}
                onChangeText={(v) => setForm((p) => ({ ...p, address: v }))}
                placeholder="Full address"
                placeholderTextColor={Colors.textMuted}
              />
            </View>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>
                {CATEGORIES.map((cat) => (
                  <TouchableOpacity
                    key={cat}
                    style={[styles.catBtn, form.category === cat && styles.catBtnActive]}
                    onPress={() => setForm((p) => ({ ...p, category: cat }))}
                  >
                    <Text style={[styles.catBtnText, form.category === cat && styles.catBtnTextActive]}>{cat}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>
        ) : (
          <>
            <View style={styles.infoCard}>
              <InfoRow icon="tag" label="Vendor Code" value={supplier.vendorCode} />
              <InfoRow icon="file-text" label="Vendor GST No" value={supplier.vendorGstNo} />
              <InfoRow icon="user" label="Contact" value={supplier.contactName} />
              <InfoRow icon="mail" label="Email" value={supplier.email} />
              <InfoRow icon="phone" label="Phone" value={supplier.phone} />
              <InfoRow icon="map-pin" label="Address" value={supplier.address} />
              <InfoRow icon="layers" label="Category" value={supplier.category} last />
            </View>

            <View style={styles.ordersSection}>
              <Text style={styles.sectionTitle}>
                Orders ({supplierOrders.length})
              </Text>
              {supplierOrders.length === 0 ? (
                <View style={styles.noOrders}>
                  <Text style={styles.noOrdersText}>No orders from this supplier yet</Text>
                </View>
              ) : (
                supplierOrders.map((order) => <OrderCard key={order.id} order={order} />)
              )}
            </View>

            <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
              <Feather name="trash-2" size={16} color={Colors.danger} />
              <Text style={styles.deleteBtnText}>Delete Supplier</Text>
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
  sectionTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginBottom: 12 },
  ordersSection: {},
  noOrders: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noOrdersText: { color: Colors.textMuted, fontSize: 14 },
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
});
