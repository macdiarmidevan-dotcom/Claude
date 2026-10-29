import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Waiver, WaiverSignature } from "./api";
import { SignaturePad } from "./SignaturePad";
import { colors } from "./theme";

interface Props {
  waiver: Waiver;
  /** Carts whose drivers still need to sign, in order. */
  carts: string[];
  onDone: (signatures: WaiverSignature[]) => void;
  onCancel: () => void;
}

/**
 * Hands the iPad to each cart's driver in turn to read and sign the waiver.
 * The cart is only assigned once every driver has signed.
 */
export function WaiverModal({ waiver, carts, onDone, onCancel }: Props) {
  const [index, setIndex] = useState(0);
  const [signatures, setSignatures] = useState<WaiverSignature[]>([]);
  const [driverName, setDriverName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [path, setPath] = useState("");
  const [padKey, setPadKey] = useState(0);
  const onSign = useCallback((p: string) => setPath(p), []);

  const cart = carts[index]!;
  const ready = agreed && driverName.trim().length > 0 && path.length > 0;
  const last = index === carts.length - 1;

  function sign() {
    const next = [...signatures, { cartNumber: cart, driverName: driverName.trim(), signature: path }];
    if (last) return onDone(next);
    setSignatures(next);
    setIndex(index + 1);
    setDriverName("");
    setAgreed(false);
    setPath("");
    setPadKey((k) => k + 1); // fresh, empty pad for the next driver
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onCancel}>
      <View style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.step}>
            Cart {cart}
            {carts.length > 1 ? `  ·  driver ${index + 1} of ${carts.length}` : ""}
          </Text>
          <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{waiver.title}</Text>
          <Text style={styles.prompt}>Please hand the iPad to the driver of cart {cart}.</Text>
          <View style={styles.terms}>
            <ScrollView nestedScrollEnabled>
              <Text style={styles.termsText}>{waiver.body}</Text>
            </ScrollView>
          </View>

          <Text style={styles.label}>Driver's full name</Text>
          <TextInput style={styles.input} value={driverName} onChangeText={setDriverName} placeholder="Name" autoCapitalize="words" />

          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: agreed }}
            onPress={() => setAgreed(!agreed)}
            style={styles.agreeRow}
          >
            <View style={[styles.box, agreed && styles.boxOn]}>{agreed && <Text style={styles.tick}>✓</Text>}</View>
            <Text style={styles.agreeText}>I have read and agree to the terms above, and I will be driving cart {cart}.</Text>
          </Pressable>

          <Text style={styles.label}>Signature</Text>
          <SignaturePad key={padKey} onChange={onSign} />

          <Pressable
            accessibilityRole="button"
            disabled={!ready}
            onPress={sign}
            style={[styles.signButton, !ready && { opacity: 0.4 }]}
          >
            <Text style={styles.signText}>{last ? "Sign and assign carts" : "Sign and pass to next driver"}</Text>
          </Pressable>
          <Text style={styles.version}>Waiver version {waiver.version}. Signed on this device with the date and time.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.primary, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  step: { color: "#fff", fontSize: 16, fontWeight: "700" },
  cancel: { color: "#cfe3d5", fontSize: 14 },
  body: { padding: 16, paddingBottom: 60, width: "100%", maxWidth: 720, alignSelf: "center" },
  title: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 },
  prompt: { color: colors.muted, fontSize: 14, marginBottom: 14 },
  terms: { maxHeight: 260, borderWidth: 1, borderColor: colors.border, borderRadius: 3, backgroundColor: colors.card, padding: 14, marginBottom: 18 },
  termsText: { fontSize: 14, lineHeight: 22, color: colors.text },
  label: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 12, fontSize: 15, backgroundColor: colors.card, marginBottom: 16, color: colors.text },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 18 },
  box: { width: 28, height: 28, borderRadius: 3, borderWidth: 2, borderColor: colors.primary, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  boxOn: { backgroundColor: colors.primary },
  tick: { color: "#fff", fontWeight: "800", fontSize: 14 },
  agreeText: { flex: 1, fontSize: 14, color: colors.text, lineHeight: 22 },
  signButton: { backgroundColor: colors.primary, borderRadius: 3, padding: 16, alignItems: "center", marginTop: 10 },
  signText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  version: { color: colors.muted, fontSize: 12, marginTop: 12, textAlign: "center" },
});
