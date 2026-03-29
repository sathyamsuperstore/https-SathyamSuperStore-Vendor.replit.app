import React from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { useApp, AppUser } from "@/context/AppContext";
import { EmptyState } from "@/components/EmptyState";

const USER_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  Admin:   { bg: "#FEE2E2", text: "#EF4444" },
  Vendor:  { bg: "#DBEAFE", text: "#3B82F6" },
  Manager: { bg: "#EDE9FE", text: "#8B5CF6" },
  Staff:   { bg: "#D1FAE5", text: "#10B981" },
};

function getInitials(name: string): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();
}

function UserCard({ user }: { user: AppUser }) {
  const router = useRouter();
  const typeColors = USER_TYPE_COLORS[user.userType] ?? { bg: Colors.surfaceSecondary, text: Colors.textSecondary };

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push({ pathname: "/user/[id]", params: { id: user.id } })}
      activeOpacity={0.7}
    >
      <View style={[styles.avatar, { backgroundColor: typeColors.bg }]}>
        <Text style={[styles.initials, { color: typeColors.text }]}>
          {getInitials(user.vendorName || user.userId)}
        </Text>
      </View>
      <View style={styles.info}>
        <View style={styles.topRow}>
          <Text style={styles.name}>{user.vendorName || user.userId}</Text>
          <View style={[styles.typeBadge, { backgroundColor: typeColors.bg }]}>
            <Text style={[styles.typeText, { color: typeColors.text }]}>{user.userType}</Text>
          </View>
        </View>
        <Text style={styles.userId}>@{user.userId}</Text>
        {user.vendorCode ? (
          <View style={styles.metaRow}>
            <Feather name="tag" size={11} color={Colors.textMuted} />
            <Text style={styles.metaText}>{user.vendorCode}</Text>
            {user.vendorMobileNo1 ? (
              <>
                <Feather name="phone" size={11} color={Colors.textMuted} />
                <Text style={styles.metaText}>{user.vendorMobileNo1}</Text>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
      <Feather name="chevron-right" size={18} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

export default function UsersScreen() {
  const { appUsers } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { paddingTop: topPt }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Users</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => router.push("/user/new")}
        >
          <Feather name="plus" size={20} color={Colors.textInverse} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={appUsers}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <UserCard user={item} />}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 100 },
          appUsers.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="users"
            title="No users yet"
            subtitle="Tap the + button to add your first user"
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
  },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { paddingHorizontal: 20 },
  listEmpty: { flex: 1 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
      android: { elevation: 2 },
    }),
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  initials: { fontSize: 16, fontWeight: "800" },
  info: { flex: 1, gap: 3 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  name: { fontSize: 15, fontWeight: "700", color: Colors.text, flex: 1 },
  typeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  typeText: { fontSize: 11, fontWeight: "700" },
  userId: { fontSize: 12, color: Colors.textMuted },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  metaText: { fontSize: 11, color: Colors.textMuted },
});
