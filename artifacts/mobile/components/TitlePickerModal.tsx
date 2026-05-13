import React, { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import type { TitleListItem } from "@/context/AppContext";

// Modal that lets the user pick a banner title from the user-managed
// TitleList catalogue. Used by both PriceTag Preview and PriceTag
// Review when Style E ("Customize Me") is selected and the user taps
// the green edit button on top of the tag's banner.
//
// Picking a title invokes `onPick(title)` and closes the modal; the
// host screen is responsible for writing the chosen title onto the
// working item. A "Clear" action resets the per-item override back
// to the Style E default ("Edit Title").
export function TitlePickerModal({
  visible,
  titles,
  currentTitle,
  onPick,
  onClear,
  onClose,
}: {
  visible: boolean;
  titles: TitleListItem[];
  currentTitle?: string;
  onPick: (title: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return titles;
    return titles.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q),
    );
  }, [titles, search]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        activeOpacity={1}
        style={styles.scrim}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Pick a title</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Feather name="x" size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.searchRow}>
            <Feather
              name="search"
              size={14}
              color={Colors.textMuted}
              style={{ marginRight: 6 }}
            />
            <TextInput
              value={search}
              onChangeText={setSearch}
              style={styles.searchInput}
              placeholder="Search titles or categories…"
              placeholderTextColor={Colors.textMuted}
              autoCorrect={false}
              autoCapitalize="none"
              autoFocus={Platform.OS !== "ios"}
            />
            {search.length > 0 && (
              <TouchableOpacity
                onPress={() => setSearch("")}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="x-circle" size={16} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(t) => t.id}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            renderItem={({ item }) => {
              const active =
                !!currentTitle &&
                currentTitle.trim().toLowerCase() ===
                  item.title.trim().toLowerCase();
              return (
                <TouchableOpacity
                  style={[styles.row, active && styles.rowActive]}
                  onPress={() => onPick(item.title)}
                  activeOpacity={0.85}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text style={styles.rowCat} numberOfLines={1}>
                      {item.category}
                    </Text>
                  </View>
                  {active && (
                    <Feather name="check" size={16} color={Colors.primary} />
                  )}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  {titles.length === 0
                    ? "Your TitleList is empty. Add titles in the TitleList tab first."
                    : "No titles match your search."}
                </Text>
              </View>
            }
          />

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.footerBtn, styles.footerBtnSecondary]}
              onPress={onClear}
              activeOpacity={0.85}
            >
              <Feather name="rotate-ccw" size={14} color={Colors.danger} />
              <Text style={styles.footerBtnSecondaryText}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.footerBtn, styles.footerBtnPrimary]}
              onPress={onClose}
              activeOpacity={0.85}
            >
              <Text style={styles.footerBtnPrimaryText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "85%",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  headerTitle: { fontSize: 15, fontWeight: "700", color: Colors.text },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    height: 38,
    borderRadius: 8,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
    paddingVertical: 0,
  },
  list: { flexGrow: 0, maxHeight: 420 },
  sep: { height: 1, backgroundColor: Colors.border },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 6,
    gap: 10,
  },
  rowActive: { backgroundColor: Colors.primaryMuted },
  rowTitle: { fontSize: 14, fontWeight: "600", color: Colors.text },
  rowCat: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  empty: { paddingVertical: 24, alignItems: "center" },
  emptyText: {
    color: Colors.textMuted,
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: 20,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    gap: 8,
  },
  footerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    minWidth: 96,
  },
  footerBtnSecondary: {
    backgroundColor: Colors.dangerLight,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  footerBtnSecondaryText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.danger,
  },
  footerBtnPrimary: {
    backgroundColor: Colors.primary,
  },
  footerBtnPrimaryText: {
    color: Colors.textInverse,
    fontSize: 13,
    fontWeight: "700",
  },
});
