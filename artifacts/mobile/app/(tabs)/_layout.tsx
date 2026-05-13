import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";
import { Colors } from "@/constants/colors";
import { useApp, type UserType } from "@/context/AppContext";

// The "Admn" hub is only available to non-Vendor users. We compute
// visibility from the logged-in user's role and use it to (a) skip the
// NativeTabs trigger entirely, and (b) hide the classic Tabs.Screen
// from the bar via `href: null`. The route still exists so the
// in-screen redirect guard in admn.tsx can fire if a Vendor reaches it
// directly via deep link.
function isAdminRole(userType: UserType | undefined): boolean {
  return (
    userType === "Admin" || userType === "Manager" || userType === "Staff"
  );
}

/**
 * Tab bar shows 5 hubs:
 *
 *   Dashboard | Orders (Place + My Orders) | Stock (Update + Latest
 *   Purchases) | Catalog (MRP + Promo + Brand Review) | Directory
 *   (Suppliers + Users)
 *
 * The original 9 sub-screen routes (orders, myorders, stockupd,
 * latest-purchases, mrp, promo, brand-review, suppliers, users) still
 * exist as files so they can be embedded inside the hub wrappers, but
 * they are hidden from the tab bar (`href: null`) so the user only
 * sees the 5 consolidated tabs. Deep links inside the app are routed
 * through the hubs with a `?view=` query param.
 */

function NativeTabLayout({ adminVisible }: { adminVisible: boolean }) {
  // Native tabs (iOS Liquid Glass) only render the triggers we list
  // here, so the original sub-screen routes are automatically
  // excluded from the bar.
  //
  // No internal navigation in the app targets the legacy routes
  // (`/promo`, `/orders`, `/stockupd`, etc.) directly anymore — every
  // redirect and link points to a hub URL with `?view=`. The legacy
  // route files only exist so their default-exported screen
  // components can be imported into the hub wrappers; users never
  // reach them by tapping anything.
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "chart.bar", selected: "chart.bar.fill" }} />
        <Label>Dashboard</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="orders-hub">
        <Icon sf={{ default: "doc.text", selected: "doc.text.fill" }} />
        <Label>Orders</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="stock">
        <Icon
          sf={{
            default: "square.and.arrow.up",
            selected: "square.and.arrow.up.fill",
          }}
        />
        <Label>Stock</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="catalog">
        <Icon
          sf={{
            default: "indianrupeesign.circle",
            selected: "indianrupeesign.circle.fill",
          }}
        />
        <Label>Catalog</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="directory">
        <Icon sf={{ default: "person.2", selected: "person.2.fill" }} />
        <Label>Directory</Label>
      </NativeTabs.Trigger>
      {adminVisible && (
        <NativeTabs.Trigger name="admn">
          <Icon
            sf={{ default: "lock.shield", selected: "lock.shield.fill" }}
          />
          <Label>Admn</Label>
        </NativeTabs.Trigger>
      )}
    </NativeTabs>
  );
}

function ClassicTabLayout({ adminVisible }: { adminVisible: boolean }) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.tabBarActive,
        tabBarInactiveTintColor: Colors.tabBarInactive,
        tabBarStyle: {
          ...(isIOS || isWeb ? { position: "absolute" } : {}),
          backgroundColor: isIOS ? "transparent" : isDark ? "#000" : "#fff",
          borderTopWidth: isWeb || !isIOS ? 1 : 0,
          borderTopColor: isDark ? "#333" : Colors.border,
          elevation: isIOS ? 0 : 8,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? "#000" : "#fff" }]} />
          ) : null,
      }}
    >
      {/* === 5 visible hubs === */}
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="chart.bar" tintColor={color} size={24} />
            ) : (
              <Feather name="bar-chart-2" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="orders-hub"
        options={{
          title: "Orders",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="doc.text" tintColor={color} size={24} />
            ) : (
              <Feather name="file-text" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          title: "Stock",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="square.and.arrow.up" tintColor={color} size={24} />
            ) : (
              <Feather name="upload-cloud" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="catalog"
        options={{
          title: "Catalog",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="indianrupeesign.circle" tintColor={color} size={24} />
            ) : (
              <Feather name="dollar-sign" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="directory"
        options={{
          title: "Directory",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.2" tintColor={color} size={24} />
            ) : (
              <Feather name="users" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="admn"
        options={
          adminVisible
            ? {
                title: "Admn",
                tabBarIcon: ({ color }) =>
                  isIOS ? (
                    <SymbolView
                      name="lock.shield"
                      tintColor={color}
                      size={24}
                    />
                  ) : (
                    <Feather name="shield" size={22} color={color} />
                  ),
              }
            : { href: null }
        }
      />

      {/* === Hidden sub-screen routes (still navigable via `router.push`,
          but excluded from the bottom bar). They are embedded inside
          the hubs above. === */}
      <Tabs.Screen name="orders" options={{ href: null }} />
      <Tabs.Screen name="myorders" options={{ href: null }} />
      <Tabs.Screen name="stockupd" options={{ href: null }} />
      <Tabs.Screen name="latest-purchases" options={{ href: null }} />
      <Tabs.Screen name="mrp" options={{ href: null }} />
      <Tabs.Screen name="promo" options={{ href: null }} />
      <Tabs.Screen name="brand-review" options={{ href: null }} />
      <Tabs.Screen name="suppliers" options={{ href: null }} />
      <Tabs.Screen name="users" options={{ href: null }} />
      <Tabs.Screen name="last-supply-date" options={{ href: null }} />
      <Tabs.Screen name="data-download-time" options={{ href: null }} />
      <Tabs.Screen name="rodeo-items" options={{ href: null }} />
    </Tabs>
  );
}

export default function TabLayout() {
  const { currentUser } = useApp();
  const adminVisible = isAdminRole(currentUser?.userType);
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout adminVisible={adminVisible} />;
  }
  return <ClassicTabLayout adminVisible={adminVisible} />;
}

const styles = StyleSheet.create({});
