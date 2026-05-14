import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import {
  NotoSansTamil_400Regular,
  NotoSansTamil_500Medium,
  NotoSansTamil_700Bold,
} from "@expo-google-fonts/noto-sans-tamil";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PinGate } from "@/components/PinGate";
import { AppProvider } from "@/context/AppContext";
import { AuthProvider } from "@/context/AuthContext";
import { Colors } from "@/constants/colors";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerStyle: { backgroundColor: Colors.surface },
        headerTintColor: Colors.primary,
        headerTitleStyle: { fontWeight: "700", color: Colors.text },
        contentStyle: { backgroundColor: Colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="order/[id]" options={{ presentation: "card" }} />
      <Stack.Screen name="order/new" options={{ presentation: "modal" }} />
      <Stack.Screen name="order/import" options={{ presentation: "modal" }} />
      <Stack.Screen name="supplier/[id]" options={{ presentation: "card" }} />
      <Stack.Screen name="supplier/new" options={{ presentation: "modal" }} />
      <Stack.Screen name="supplier/import" options={{ presentation: "modal" }} />
      <Stack.Screen name="user/[id]" options={{ presentation: "card" }} />
      <Stack.Screen name="user/new" options={{ presentation: "modal" }} />
      <Stack.Screen name="user/import" options={{ presentation: "modal" }} />
      <Stack.Screen name="drive-import" options={{ presentation: "modal" }} />
      <Stack.Screen name="promo-compare" options={{ presentation: "card", title: "Promo Changes" }} />
      <Stack.Screen name="pricetag-preview" options={{ presentation: "card", title: "PriceTag Preview" }} />
      <Stack.Screen name="pricetag-review" options={{ presentation: "card", title: "PriceTag Review" }} />
      <Stack.Screen name="pricetag-img" options={{ presentation: "card", title: "PriceTag IMG" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    NotoSansTamil_400Regular,
    NotoSansTamil_500Medium,
    NotoSansTamil_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <AuthProvider>
              <PinGate>
                <AppProvider>
                  <RootLayoutNav />
                </AppProvider>
              </PinGate>
            </AuthProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
