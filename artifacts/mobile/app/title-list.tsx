import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as XLSX from "xlsx-js-style";
import { Colors } from "@/constants/colors";
import {
  useApp,
  showStorageErrorAlert,
  type TitleListItem,
} from "@/context/AppContext";

// TitleList tab — user-managed catalogue of punchy banner titles. Lives
// in AsyncStorage via AppContext; seeded with ~400 defaults on first
// launch. Surface here lets the user search, add, edit, delete, and
// round-trip through Excel so they can curate the list outside the app
// when convenient.
export default function TitleListScreen() {
  const { titleList, addTitle, updateTitle, deleteTitle, saveTitleList } =
      useApp();
  const insets = useSafeAreaInsets();

  const [search, setSearch] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return titleList;
    return titleList.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q),
    );
  }, [titleList, search]);

  function notify(title: string, message?: string) {
    if (Platform.OS === "web") {
      window.alert(message ? `${title}\n\n${message}` : title);
    } else {
      Alert.alert(title, message);
    }
  }

  async function onAdd() {
    const t = newTitle.trim();
    if (!t) {
      notify("Title required", "Please type a title before adding.");
      return;
    }
    try {
      await addTitle(t, newCategory.trim() || "Custom");
      setNewTitle("");
      setNewCategory("");
    } catch {
      showStorageErrorAlert();
    }
  }

  function startEdit(item: TitleListItem) {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditCategory(item.category);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitle("");
    setEditCategory("");
  }

  async function commitEdit() {
    if (!editingId) return;
    const t = editTitle.trim();
    if (!t) {
      notify("Title required", "Please type a title before saving.");
      return;
    }
    try {
      await updateTitle(editingId, t, editCategory);
      cancelEdit();
    } catch {
      showStorageErrorAlert();
    }
  }

  function confirmDelete(item: TitleListItem) {
    const doDelete = async () => {
      try {
        await deleteTitle(item.id);
      } catch {
        showStorageErrorAlert();
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete "${item.title}"?`)) void doDelete();
    } else {
      Alert.alert("Delete title?", item.title, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void doDelete() },
      ]);
    }
  }

  async function onExport() {
    if (titleList.length === 0) {
      notify("Nothing to export", "Your title list is empty.");
      return;
    }
    try {
      setBusy(true);
      const rows = titleList.map((t) => ({
        Title: t.title,
        Category: t.category,
      }));
      const ws = XLSX.utils.json_to_sheet(rows, {
        header: ["Title", "Category"],
      });
      ws["!cols"] = [{ wch: 36 }, { wch: 18 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "TitleList");

      const stamp = new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[-:T]/g, "");
      const filename = `TitleList_${stamp}.xlsx`;

      if (Platform.OS === "web") {
        // On web we can let the browser hand the user a download.
        const wbout = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        const blob = new Blob([wbout], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
        const path = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(path, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, {
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: "Export TitleList",
            UTI: "org.openxmlformats.spreadsheetml.sheet",
          });
        } else {
          notify("Saved", `Exported to ${path}`);
        }
      }
    } catch (e) {
      notify("Export failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel",
          "*/*",
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      setBusy(true);
      const asset = result.assets[0];
      let workbook: XLSX.WorkBook;
      if (Platform.OS === "web") {
        const resp = await fetch(asset.uri);
        const arrayBuffer = await resp.arrayBuffer();
        workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        workbook = XLSX.read(base64, { type: "base64" });
      }
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      const parsed: TitleListItem[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const titleRaw = (r["Title"] ?? r["title"] ?? r["TITLE"] ?? "")
          .toString()
          .trim()
          .slice(0, 120);
        const catRaw = (r["Category"] ?? r["category"] ?? "")
          .toString()
          .trim()
          .slice(0, 60);
        if (!titleRaw) continue;
        const dupKey = titleRaw.toLowerCase();
        if (seen.has(dupKey)) continue;
        seen.add(dupKey);
        parsed.push({
          id: `imp-${Date.now()}-${parsed.length}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,
          title: titleRaw,
          category: catRaw || "Imported",
        });
      }

      if (parsed.length === 0) {
        notify(
          "Nothing to import",
          "We couldn't find any rows with a 'Title' column.",
        );
        return;
      }

      const proceed = async (replace: boolean) => {
        try {
          if (replace) {
            await saveTitleList(parsed);
          } else {
            const existing = new Set(
              titleList.map((t) => t.title.toLowerCase()),
            );
            const additions = parsed.filter(
              (p) => !existing.has(p.title.toLowerCase()),
            );
            await saveTitleList([...additions, ...titleList]);
          }
          notify(
            "Import complete",
            `${parsed.length} title${parsed.length === 1 ? "" : "s"} processed.`,
          );
        } catch {
          showStorageErrorAlert();
        }
      };

      const msg = `Found ${parsed.length} title${parsed.length === 1 ? "" : "s"}. Replace your current list, or merge them in?`;
      if (Platform.OS === "web") {
        const useReplace = window.confirm(`${msg}\n\nOK = Replace, Cancel = Merge`);
        await proceed(useReplace);
      } else {
        Alert.alert("Import TitleList", msg, [
          { text: "Cancel", style: "cancel" },
          { text: "Merge", onPress: () => void proceed(false) },
          {
            text: "Replace",
            style: "destructive",
            onPress: () => void proceed(true),
          },
        ]);
      }
    } catch (e) {
      notify("Import failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderItem({ item }: { item: TitleListItem }) {
    const isEditing = editingId === item.id;
    if (isEditing) {
      return (
        <View style={[styles.row, styles.rowEditing]}>
          <View style={{ flex: 1 }}>
            <TextInput
              value={editTitle}
              onChangeText={setEditTitle}
              style={styles.editInput}
              placeholder="Title"
              placeholderTextColor={Colors.textMuted}
              maxLength={120}
              autoFocus
            />
            <TextInput
              value={editCategory}
              onChangeText={setEditCategory}
              style={[styles.editInput, styles.editInputSmall]}
              placeholder="Category"
              placeholderTextColor={Colors.textMuted}
              maxLength={60}
            />
          </View>
          <TouchableOpacity
            style={[styles.iconBtn, styles.saveBtn]}
            onPress={commitEdit}
            accessibilityLabel="Save title"
          >
            <Feather name="check" size={16} color={Colors.textInverse} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, styles.cancelBtn]}
            onPress={cancelEdit}
            accessibilityLabel="Cancel edit"
          >
            <Feather name="x" size={16} color={Colors.textInverse} />
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.titleText} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.catText} numberOfLines={1}>
            {item.category}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.iconBtn, styles.editBtn]}
          onPress={() => startEdit(item)}
          accessibilityLabel="Edit title"
        >
          <Feather name="edit-2" size={14} color={Colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.iconBtn, styles.deleteBtn]}
          onPress={() => confirmDelete(item)}
          accessibilityLabel="Delete title"
        >
          <Feather name="trash-2" size={14} color="#B91C1C" />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={[styles.toolBtn, busy && styles.toolBtnBusy]}
          onPress={onImport}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <Feather name="upload" size={14} color={Colors.primary} />
          )}
          <Text style={styles.toolBtnText}>Import Excel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolBtn, busy && styles.toolBtnBusy]}
          onPress={onExport}
          disabled={busy}
          activeOpacity={0.85}
        >
          <Feather name="download" size={14} color={Colors.primary} />
          <Text style={styles.toolBtnText}>Export Excel</Text>
        </TouchableOpacity>
        <View style={styles.countPill}>
          <Text style={styles.countPillText}>
            {filtered.length}/{titleList.length}
          </Text>
        </View>
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

      <View style={styles.addRow}>
        <TextInput
          value={newTitle}
          onChangeText={setNewTitle}
          style={[styles.addInput, { flex: 2 }]}
          placeholder="New title"
          placeholderTextColor={Colors.textMuted}
          maxLength={120}
        />
        <TextInput
          value={newCategory}
          onChangeText={setNewCategory}
          style={[styles.addInput, { flex: 1 }]}
          placeholder="Category"
          placeholderTextColor={Colors.textMuted}
          maxLength={60}
        />
        <TouchableOpacity
          style={styles.addBtn}
          onPress={onAdd}
          activeOpacity={0.85}
          accessibilityLabel="Add title"
        >
          <Feather name="plus" size={16} color={Colors.textInverse} />
          <Text style={styles.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(it) => it.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 24 }}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {titleList.length === 0
                ? "No titles yet. Add one above or import from Excel."
                : "No titles match your search."}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
  },
  toolBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  toolBtnBusy: { opacity: 0.6 },
  toolBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "600" },
  countPill: {
    marginLeft: "auto",
    backgroundColor: Colors.surface,
    borderColor: Colors.border,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  countPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 10,
    height: 38,
    borderRadius: 8,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
    paddingVertical: 0,
  },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    marginBottom: 8,
    gap: 6,
  },
  addInput: {
    height: 38,
    paddingHorizontal: 10,
    fontSize: 13,
    color: Colors.text,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 8,
    backgroundColor: Colors.primary,
  },
  addBtnText: { color: Colors.textInverse, fontWeight: "700", fontSize: 13 },
  sep: { height: 1, backgroundColor: Colors.border, marginHorizontal: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  rowEditing: { backgroundColor: Colors.surface },
  titleText: { fontSize: 14, fontWeight: "600", color: Colors.text },
  catText: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  editInput: {
    height: 36,
    paddingHorizontal: 8,
    fontSize: 13,
    color: Colors.text,
    backgroundColor: Colors.background,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  editInputSmall: { marginTop: 6, height: 32 },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  editBtn: { borderColor: Colors.border, backgroundColor: Colors.surface },
  deleteBtn: { borderColor: "#FECACA", backgroundColor: "#FEF2F2" },
  saveBtn: { borderColor: Colors.primary, backgroundColor: Colors.primary },
  cancelBtn: { borderColor: Colors.border, backgroundColor: Colors.surface },
  empty: { paddingVertical: 32, alignItems: "center" },
  emptyText: { color: Colors.textMuted, fontSize: 13 },
});
