import React, { useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { Colors } from "@/constants/colors";
import { Supplier, showStorageErrorAlert } from "@/context/AppContext";

const MAX_PHOTOS = 10;

// Reusable supplier photos row. Renders up to 10 thumbnails with per-photo
// delete buttons and an "Add Photo" tile that lets the user pick from the
// library or take a new shot with the camera. Mirrors the visual language
// of the supplier-level notes box used on StockUpd / My Orders so the two
// fields read as a single attachment area for the supplier.
//
// Photos are persisted by the parent via `onChange`, which writes to
// AppContext (data-URI strings). The parent owns the saved value; this
// component is fully controlled.
export function SupplierPhotosBox({
  supplier,
  photos,
  onChange,
}: {
  supplier: Supplier;
  photos: string[];
  onChange: (photos: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const remainingSlots = Math.max(0, MAX_PHOTOS - photos.length);

  async function ensureLibraryPermission(): Promise<boolean> {
    const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (res.status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow photo library access to attach photos to this supplier."
      );
      return false;
    }
    return true;
  }

  async function ensureCameraPermission(): Promise<boolean> {
    const res = await ImagePicker.requestCameraPermissionsAsync();
    if (res.status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow camera access to take a photo for this supplier."
      );
      return false;
    }
    return true;
  }

  async function appendAsset(asset: ImagePicker.ImagePickerAsset) {
    // Resize down to a sane upper bound (~1280px on the longer edge) and
    // re-compress to JPEG before encoding to base64. AsyncStorage and the
    // PDF html embed both grow linearly with the encoded payload, so a
    // raw 12MP camera shot would otherwise bloat persistence and make the
    // export print slow.
    const longerEdge = Math.max(asset.width ?? 0, asset.height ?? 0);
    const ratio = longerEdge > 1280 ? 1280 / longerEdge : 1;
    const resizeActions = ratio < 1
      ? [{ resize: { width: Math.round((asset.width ?? 0) * ratio) } }]
      : [];
    const manipulated = await ImageManipulator.manipulateAsync(
      asset.uri,
      resizeActions,
      {
        compress: 0.6,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );
    const b64 = manipulated.base64 ?? asset.base64;
    if (!b64) return;
    const dataUri = `data:image/jpeg;base64,${b64}`;
    const next = [...photos, dataUri].slice(0, MAX_PHOTOS);
    try {
      await onChange(next);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      showStorageErrorAlert();
    }
  }

  async function pickFromLibrary() {
    if (busy || remainingSlots === 0) return;
    if (!(await ensureLibraryPermission())) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.5,
        base64: true,
      });
      if (!result.canceled && result.assets?.[0]) {
        await appendAsset(result.assets[0]);
      }
    } catch (e: any) {
      Alert.alert("Couldn't add photo", e?.message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function takePhoto() {
    if (busy || remainingSlots === 0) return;
    if (!(await ensureCameraPermission())) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 0.5,
        base64: true,
      });
      if (!result.canceled && result.assets?.[0]) {
        await appendAsset(result.assets[0]);
      }
    } catch (e: any) {
      Alert.alert("Couldn't add photo", e?.message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  function handleAddPress() {
    if (busy || remainingSlots === 0) return;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Take Photo", "Choose from Library"],
          cancelButtonIndex: 0,
        },
        (idx) => {
          if (idx === 1) takePhoto();
          else if (idx === 2) pickFromLibrary();
        }
      );
    } else {
      Alert.alert("Add Photo", undefined, [
        { text: "Take Photo", onPress: takePhoto },
        { text: "Choose from Library", onPress: pickFromLibrary },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }

  async function handleDelete(index: number) {
    if (busy) return;
    const next = photos.filter((_, i) => i !== index);
    try {
      await onChange(next);
      Haptics.selectionAsync();
    } catch {
      showStorageErrorAlert();
    }
  }

  return (
    <View style={styles.box}>
      <View style={styles.header}>
        <Feather name="image" size={13} color={Colors.textSecondary} />
        <Text style={styles.label} numberOfLines={1}>
          Photos for {supplier.name || supplier.vendorCode}
        </Text>
        <Text style={styles.count}>
          {photos.length}/{MAX_PHOTOS}
        </Text>
      </View>
      <View style={styles.row}>
        {photos.map((uri, i) => (
          <View key={`${i}-${uri.slice(-12)}`} style={styles.thumbWrap}>
            <Image source={{ uri }} style={styles.thumb} />
            <TouchableOpacity
              style={styles.deleteBtn}
              onPress={() => handleDelete(i)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              activeOpacity={0.7}
            >
              <Feather name="x" size={12} color="#fff" />
            </TouchableOpacity>
          </View>
        ))}
        {remainingSlots > 0 && (
          <TouchableOpacity
            style={[styles.addTile, busy && styles.addTileBusy]}
            onPress={handleAddPress}
            disabled={busy}
            activeOpacity={0.7}
          >
            {busy ? (
              <ActivityIndicator size="small" color={Colors.textMuted} />
            ) : (
              <>
                <Feather name="plus" size={20} color={Colors.textSecondary} />
                <Text style={styles.addText}>Add Photo</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const THUMB = 72;

const styles = StyleSheet.create({
  box: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  label: {
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  count: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  thumbWrap: {
    width: THUMB,
    height: THUMB,
    position: "relative",
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: "#eee",
  },
  deleteBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.danger,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: Colors.surface,
  },
  addTile: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.background,
  },
  addTileBusy: {
    opacity: 0.6,
  },
  addText: {
    fontSize: 10,
    color: Colors.textSecondary,
    marginTop: 2,
  },
});
