import React from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";

interface Props {
  label: string;
  value: string | number;
  icon: keyof typeof Feather.glyphMap;
  color: string;
  bg: string;
  subtitle?: string;
}

export function StatCard({ label, value, icon, color, bg, subtitle }: Props) {
  return (
    <View style={styles.card}>
      <View style={[styles.iconWrap, { backgroundColor: bg }]}>
        <Feather name={icon} size={20} color={color} />
      </View>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: Colors.border,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
      android: { elevation: 2 },
    }),
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  value: { fontSize: 24, fontWeight: "800", color: Colors.text, marginBottom: 2 },
  label: { fontSize: 12, color: Colors.textSecondary, fontWeight: "500" },
  subtitle: { fontSize: 11, color: Colors.textMuted, marginTop: 4 },
});
