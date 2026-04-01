import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { AppUser } from "@/context/AppContext";

interface Props {
  user: AppUser;
}

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
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

export function UserCard({ user }: Props) {
  const router = useRouter();
  const typeColors = TYPE_COLORS[user.userType] ?? { bg: Colors.surfaceSecondary, text: Colors.textSecondary };

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
        <Text style={styles.name}>{user.vendorName || user.userId}</Text>
        <Text style={styles.subText}>@{user.userId}</Text>
        <View style={styles.meta}>
          <View style={[styles.typeBadge, { backgroundColor: typeColors.bg }]}>
            <Text style={[styles.typeText, { color: typeColors.text }]}>{user.userType}</Text>
          </View>
          {user.vendorCode ? (
            <View style={styles.codeBadge}>
              <Feather name="tag" size={11} color={Colors.textMuted} />
              <Text style={styles.codeText}>{user.vendorCode}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <Feather name="chevron-right" size={18} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
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
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: "700", color: Colors.text, marginBottom: 2 },
  subText: { fontSize: 13, color: Colors.textSecondary, marginBottom: 6 },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  typeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  typeText: { fontSize: 11, fontWeight: "700" },
  codeBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  codeText: { fontSize: 11, color: Colors.textMuted },
});
