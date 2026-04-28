import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Colors } from "@/constants/colors";
import { useApp, OrderItem, showStorageErrorAlert } from "@/context/AppContext";

function generateItemId(): string {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

const MAX_SUGGESTIONS = 8;

export default function NewOrderScreen() {
  const { suppliers, orders, addOrder } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [supplierId, setSupplierId] = useState<string>("");
  const [expectedDelivery, setExpectedDelivery] = useState(addDays(7));
  const [beat, setBeat] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<OrderItem[]>([
    { id: generateItemId(), name: "", quantity: 1, unit: "pcs", unitPrice: 0 },
  ]);
  // Tracks which item's brand/category suggestion list is open. Only one open
  // at a time so the screen does not become a wall of chips.
  const [openSuggest, setOpenSuggest] = useState<{
    itemId: string;
    field: "brand" | "category";
  } | null>(null);

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    orders.forEach((o) =>
      o.items.forEach((it) => {
        const b = (it.brand ?? "").trim();
        if (b) set.add(b);
      })
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [orders]);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    orders.forEach((o) =>
      o.items.forEach((it) => {
        const c = (it.category ?? "").trim();
        if (c) set.add(c);
      })
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [orders]);

  const selectedSupplier = suppliers.find((s) => s.id === supplierId);

  function updateItem(id: string, field: keyof OrderItem, value: string | number) {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, [field]: value } : item
      )
    );
  }

  function addItem() {
    setItems((prev) => [
      ...prev,
      { id: generateItemId(), name: "", quantity: 1, unit: "pcs", unitPrice: 0 },
    ]);
  }

  function removeItem(id: string) {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function getTotalAmount(): number {
    return items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  }

  function formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  }

  function getSuggestions(pool: string[], typed: string): string[] {
    const q = typed.trim().toLowerCase();
    if (!q) return pool.slice(0, MAX_SUGGESTIONS);
    const matches = pool.filter((v) => v.toLowerCase().includes(q));
    // If the typed text exactly matches an existing value, no need to suggest it.
    return matches.filter((v) => v.toLowerCase() !== q).slice(0, MAX_SUGGESTIONS);
  }

  function validate(): boolean {
    if (!supplierId) {
      Alert.alert("Missing Supplier", "Please select a supplier.");
      return false;
    }
    for (const item of items) {
      if (!item.name.trim()) {
        Alert.alert("Missing Item Name", "Please fill in all item names.");
        return false;
      }
      if (item.quantity <= 0 || item.unitPrice < 0) {
        Alert.alert("Invalid Item", "Quantity must be > 0 and price must be >= 0.");
        return false;
      }
    }
    return true;
  }

  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (saving) return;
    if (!validate()) return;
    const supplier = suppliers.find((s) => s.id === supplierId)!;
    setSaving(true);
    try {
      // Normalise brand/category: trim whitespace and drop empty strings so the
      // Orders tab filters (which gate on truthy values) treat manual entries
      // the same way as imported ones.
      const cleanedItems: OrderItem[] = items.map((it) => {
        const brand = (it.brand ?? "").trim();
        const category = (it.category ?? "").trim();
        return {
          ...it,
          brand: brand ? brand : undefined,
          category: category ? category : undefined,
        };
      });
      await addOrder({
        supplierId,
        supplierName: supplier.name,
        status: "pending",
        items: cleanedItems,
        notes,
        expectedDelivery: new Date(expectedDelivery).toISOString(),
        beat: beat.trim() || undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      showStorageErrorAlert();
    } finally {
      setSaving(false);
    }
  }

  function renderSuggestRow(
    itemId: string,
    field: "brand" | "category",
    typed: string,
  ) {
    const isOpen =
      openSuggest?.itemId === itemId && openSuggest?.field === field;
    if (!isOpen) return null;
    const pool = field === "brand" ? allBrands : allCategories;
    if (pool.length === 0) {
      return (
        <Text style={styles.suggestEmpty}>
          {field === "brand"
            ? "No brands yet — your typed value will be saved."
            : "No categories yet — your typed value will be saved."}
        </Text>
      );
    }
    const suggestions = getSuggestions(pool, typed);
    if (suggestions.length === 0) {
      return (
        <Text style={styles.suggestEmpty}>
          No matches — your typed value will be saved as a new {field}.
        </Text>
      );
    }
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.suggestRow}
        keyboardShouldPersistTaps="handled"
      >
        {suggestions.map((s) => (
          <TouchableOpacity
            key={s}
            style={styles.suggestChip}
            onPress={() => {
              updateItem(itemId, field, s);
              setOpenSuggest(null);
            }}
          >
            <Text style={styles.suggestChipText} numberOfLines={1}>
              {s}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "New Order", headerBackTitle: "Back" }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 40 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.label}>Supplier *</Text>
          {suppliers.length === 0 ? (
            <View style={styles.noSuppliers}>
              <Text style={styles.noSuppliersText}>No suppliers yet. Add one first.</Text>
              <TouchableOpacity onPress={() => router.push("/supplier/new")}>
                <Text style={styles.noSuppliersLink}>Add Supplier →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.supplierList}>
              {suppliers.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.supplierOption, supplierId === s.id && styles.supplierOptionActive]}
                  onPress={() => setSupplierId(s.id)}
                >
                  <Text style={[styles.supplierOptionText, supplierId === s.id && styles.supplierOptionTextActive]}>
                    {s.name}
                  </Text>
                  {supplierId === s.id && (
                    <Feather name="check" size={16} color={Colors.textInverse} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Expected Delivery (YYYY-MM-DD) *</Text>
          <TextInput
            style={styles.input}
            value={expectedDelivery}
            onChangeText={setExpectedDelivery}
            placeholder="2024-12-31"
            placeholderTextColor={Colors.textMuted}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Beat (optional)</Text>
          <TextInput
            style={styles.input}
            value={beat}
            onChangeText={setBeat}
            placeholder="e.g. Beat 1, North Zone..."
            placeholderTextColor={Colors.textMuted}
          />
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.label}>Items *</Text>
            <TouchableOpacity style={styles.addItemBtn} onPress={addItem}>
              <Feather name="plus" size={14} color={Colors.primary} />
              <Text style={styles.addItemBtnText}>Add Item</Text>
            </TouchableOpacity>
          </View>
          {items.map((item, idx) => (
            <View key={item.id} style={styles.itemCard}>
              <View style={styles.itemCardHeader}>
                <Text style={styles.itemIndex}>Item {idx + 1}</Text>
                {items.length > 1 && (
                  <TouchableOpacity onPress={() => removeItem(item.id)}>
                    <Feather name="x" size={16} color={Colors.danger} />
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.input}
                placeholder="Item name"
                placeholderTextColor={Colors.textMuted}
                value={item.name}
                onChangeText={(v) => updateItem(item.id, "name", v)}
              />

              <View style={styles.itemRow}>
                <View style={styles.itemFieldHalf}>
                  <Text style={styles.fieldLabel}>Brand (optional)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. Acme"
                    placeholderTextColor={Colors.textMuted}
                    value={item.brand ?? ""}
                    onChangeText={(v) => updateItem(item.id, "brand", v)}
                    onFocus={() =>
                      setOpenSuggest({ itemId: item.id, field: "brand" })
                    }
                  />
                </View>
                <View style={styles.itemFieldHalf}>
                  <Text style={styles.fieldLabel}>Category (optional)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. Snacks"
                    placeholderTextColor={Colors.textMuted}
                    value={item.category ?? ""}
                    onChangeText={(v) => updateItem(item.id, "category", v)}
                    onFocus={() =>
                      setOpenSuggest({ itemId: item.id, field: "category" })
                    }
                  />
                </View>
              </View>
              {renderSuggestRow(item.id, "brand", item.brand ?? "")}
              {renderSuggestRow(item.id, "category", item.category ?? "")}

              <View style={styles.itemRow}>
                <View style={styles.itemFieldSmall}>
                  <Text style={styles.fieldLabel}>Qty</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="1"
                    placeholderTextColor={Colors.textMuted}
                    value={String(item.quantity)}
                    onChangeText={(v) => updateItem(item.id, "quantity", parseFloat(v) || 0)}
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.itemFieldSmall}>
                  <Text style={styles.fieldLabel}>Unit</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="pcs"
                    placeholderTextColor={Colors.textMuted}
                    value={item.unit}
                    onChangeText={(v) => updateItem(item.id, "unit", v)}
                  />
                </View>
                <View style={styles.itemFieldLarge}>
                  <Text style={styles.fieldLabel}>Unit Price ($)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="0.00"
                    placeholderTextColor={Colors.textMuted}
                    value={String(item.unitPrice)}
                    onChangeText={(v) => updateItem(item.id, "unitPrice", parseFloat(v) || 0)}
                    keyboardType="numeric"
                  />
                </View>
              </View>
              <Text style={styles.itemSubtotal}>
                Subtotal: {formatCurrency(item.quantity * item.unitPrice)}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatCurrency(getTotalAmount())}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Notes (optional)</Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            placeholder="Add any notes about this order..."
            placeholderTextColor={Colors.textMuted}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        <TouchableOpacity
          style={[styles.submitBtn, saving && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <>
              <ActivityIndicator size="small" color={Colors.textInverse} />
              <Text style={styles.submitBtnText}>Saving…</Text>
            </>
          ) : (
            <>
              <Feather name="check" size={18} color={Colors.textInverse} />
              <Text style={styles.submitBtnText}>Create Order</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 20, gap: 20 },
  section: { gap: 8 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontSize: 14, fontWeight: "700", color: Colors.text },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: Colors.textSecondary, marginBottom: 4 },
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
  textarea: { minHeight: 90, paddingTop: 12 },
  noSuppliers: { backgroundColor: Colors.surfaceSecondary, borderRadius: 12, padding: 16, alignItems: "center", gap: 8 },
  noSuppliersText: { color: Colors.textSecondary, fontSize: 14 },
  noSuppliersLink: { color: Colors.primaryLight, fontWeight: "700", fontSize: 14 },
  supplierList: { gap: 8 },
  supplierOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  supplierOptionActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  supplierOptionText: { fontSize: 15, color: Colors.text, fontWeight: "500" },
  supplierOptionTextActive: { color: Colors.textInverse, fontWeight: "600" },
  addItemBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addItemBtnText: { fontSize: 13, color: Colors.primary, fontWeight: "700" },
  itemCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  itemCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemIndex: { fontSize: 12, fontWeight: "700", color: Colors.textSecondary, textTransform: "uppercase" },
  itemRow: { flexDirection: "row", gap: 8 },
  itemFieldSmall: { flex: 1 },
  itemFieldLarge: { flex: 2 },
  itemFieldHalf: { flex: 1 },
  itemSubtotal: { fontSize: 12, color: Colors.textMuted, textAlign: "right" },
  suggestRow: { gap: 6, paddingVertical: 4 },
  suggestChip: {
    backgroundColor: Colors.primaryMuted,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 200,
  },
  suggestChipText: { fontSize: 12, fontWeight: "600", color: Colors.primary },
  suggestEmpty: { fontSize: 11, color: Colors.textMuted, fontStyle: "italic", paddingVertical: 4 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: Colors.primaryMuted,
    borderRadius: 12,
    padding: 16,
    marginTop: -8,
  },
  totalLabel: { fontSize: 15, fontWeight: "700", color: Colors.primary },
  totalValue: { fontSize: 20, fontWeight: "800", color: Colors.primary },
  submitBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { fontSize: 16, fontWeight: "700", color: Colors.textInverse },
});
