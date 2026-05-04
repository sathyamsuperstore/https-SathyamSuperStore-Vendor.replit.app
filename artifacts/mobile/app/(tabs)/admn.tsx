import React, { useEffect } from "react";
import {
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/colors";
import { useApp } from "@/context/AppContext";

export default function AdmnHubScreen() {
  const { currentUser } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const isAllowed =
    !!currentUser &&
    (currentUser.userType === "Admin" ||
      currentUser.userType === "Manager" ||
      currentUser.userType === "Staff");

  useEffect(() => {
    if (!isAllowed) {
      router.replace("/(tabs)");
    }
  }, [isAllowed, router]);

  if (!isAllowed) return null;

  const topPt = Platform.OS === "web" ? insets.top + 67 : insets.top;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: topPt + 16, paddingBottom: insets.bottom + 100 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Image
            source={require("../../assets/images/logo.png")}
            style={styles.headerLogo}
            resizeMode="contain"
          />
          <View>
            <Text style={styles.greeting}>Admin only</Text>
            <Text style={styles.title}>Admn</Text>
          </View>
        </View>
      </View>

      <View style={styles.placeholderCard}>
        <Feather name="shield" size={28} color={Colors.primary} />
        <Text style={styles.placeholderTitle}>Admin tools coming soon</Text>
        <Text style={styles.placeholderBody}>
          This space is reserved for admin-only tools. New features for Admins,
          Managers, and Staff will appear here.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: 20 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerLogo: { width: 48, height: 48 },
  greeting: { fontSize: 13, color: Colors.textMuted, marginBottom: 2 },
  title: { fontSize: 28, fontWeight: "800", color: Colors.text },
  placeholderCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    alignItems: "center",
    gap: 10,
  },
  placeholderTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.text,
    marginTop: 4,
  },
  placeholderBody: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
});
