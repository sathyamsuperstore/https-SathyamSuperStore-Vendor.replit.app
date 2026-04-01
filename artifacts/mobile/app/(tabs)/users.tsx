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
import { useApp } from "@/context/AppContext";
import { UserCard } from "@/components/UserCard";
import { EmptyState } from "@/components/EmptyState";

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
            icon="shield"
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
});
