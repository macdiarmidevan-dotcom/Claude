import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, Waiver } from "./api";
import { colors } from "./theme";

/**
 * Lets a manager change the cart waiver wording. Saving creates a new version, which
 * drivers sign from then on. Waivers already signed stay tied to the version they read.
 */
export function WaiverEditor({ client, onClose }: { client: Client; onClose: () => void }) {
  const [current, setCurrent] = useState<Waiver>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    client
      .waiver()
      .then((w) => {
        setCurrent(w);
        setTitle(w.title);
        setBody(w.body);
      })
      .catch((e) => setError(e.message));
  }, [client]);

  const changed = current !== undefined && (title.trim() !== current.title || body.trim() !== current.body);
  const valid = title.trim().length > 0 && body.trim().length >= 20;

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const w = await client.saveWaiver({ title: title.trim(), body: body.trim() });
      setCurrent(w);
      setTitle(w.title);
      setBody(w.body);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the waiver");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.headerText}>Cart waiver</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>
        {!current && !error ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.green} />
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {current && (
              <Text style={styles.note}>
                Drivers currently sign version {current.version}. Saving makes a new version for everyone signing from
                now on. Drivers who already signed keep the version they agreed to.
              </Text>
            )}
            <Text style={styles.label}>Title</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={(t) => {
                setTitle(t);
                setSaved(false);
              }}
            />
            <Text style={styles.label}>Wording</Text>
            <TextInput
              style={[styles.input, styles.bodyInput]}
              value={body}
              onChangeText={(t) => {
                setBody(t);
                setSaved(false);
              }}
              multiline
              textAlignVertical="top"
            />
            {!valid && <Text style={styles.error}>The waiver needs a title and at least a sentence of wording.</Text>}
            {error && <Text style={styles.error}>{error}</Text>}
            {saved && !changed && <Text style={styles.saved}>Saved as version {current?.version}.</Text>}
            <Pressable
              accessibilityRole="button"
              disabled={!changed || !valid || saving}
              onPress={save}
              style={[styles.save, (!changed || !valid || saving) && { opacity: 0.4 }]}
            >
              <Text style={styles.saveText}>{saving ? "Saving…" : "Save new version"}</Text>
            </Pressable>
            <Text style={styles.note}>Have the course's own lawyer or insurer review this wording before using it.</Text>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.green, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  close: { color: "#cfe3d5", fontSize: 16 },
  body: { padding: 20, paddingBottom: 60, width: "100%", maxWidth: 720, alignSelf: "center" },
  note: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  label: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, fontSize: 16, backgroundColor: colors.card, marginBottom: 16, color: colors.text },
  bodyInput: { minHeight: 320, lineHeight: 22 },
  error: { color: colors.noShow, marginBottom: 12 },
  saved: { color: colors.checkedIn, fontWeight: "600", marginBottom: 12 },
  save: { backgroundColor: colors.green, borderRadius: 10, padding: 16, alignItems: "center", marginBottom: 16 },
  saveText: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
