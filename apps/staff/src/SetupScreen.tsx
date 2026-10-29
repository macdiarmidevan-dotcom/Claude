import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { createClient, type Settings, type Station } from "./api";
import { colors } from "./theme";
import { DEMO } from "./demo";

export function SetupScreen({ initial, onSave }: { initial?: Settings; onSave: (s: Settings) => void }) {
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? "http://localhost:3000");
  const [courseSlug, setCourseSlug] = useState(initial?.courseSlug ?? "river-bend");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [station, setStation] = useState<Station>(initial?.station ?? "starter");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError(undefined);
    const settings = { apiUrl: apiUrl.trim(), courseSlug: courseSlug.trim(), apiKey: apiKey.trim(), station };
    try {
      // The tee sheet needs a secret key, so check that rather than just the course.
      await createClient(settings).teeSheet(new Date().toISOString().slice(0, 10));
      onSave(settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      <View style={styles.card}>
        <Text style={styles.title}>Tee Sheet</Text>
        <Text style={styles.subtitle}>
          {DEMO
            ? "This is a demo with a pretend River Bend tee sheet. Press Connect to look around. Nothing you do is saved. The key below signs you in as a manager; change it to demo-staff to see what other staff see."
            : "Connect this device to your course. Your manager has the staff key."}
        </Text>
        <Field label="Server" value={apiUrl} onChangeText={setApiUrl} />
        <Field label="Course" value={courseSlug} onChangeText={setCourseSlug} />
        <Field label="Staff key" value={apiKey} onChangeText={setApiKey} secureTextEntry placeholder="sk_…" />
        <Text style={styles.label}>This device is for</Text>
        <StationPicker value={station} onChange={setStation} />
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable
          accessibilityRole="button"
          style={[styles.button, (busy || !apiKey) && { opacity: 0.5 }]}
          disabled={busy || !apiKey}
          onPress={connect}
        >
          <Text style={styles.buttonText}>{busy ? "Connecting…" : "Connect"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function StationPicker({ value, onChange, dark }: { value: Station; onChange: (s: Station) => void; dark?: boolean }) {
  const options: { id: Station; label: string }[] = [
    { id: "proshop", label: "Pro shop" },
    { id: "starter", label: "Starter" },
  ];
  return (
    <View style={[styles.segment, dark && { borderColor: "#cfe3d5" }]}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.id)}
            style={[styles.segmentItem, on && (dark ? { backgroundColor: "#fff" } : { backgroundColor: colors.green })]}
          >
            <Text style={{ fontWeight: "600", color: on ? (dark ? colors.green : "#fff") : dark ? "#fff" : colors.text }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput autoCapitalize="none" autoCorrect={false} style={styles.input} {...input} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.green, alignItems: "center", justifyContent: "center", padding: 16 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 24, width: "100%", maxWidth: 420 },
  title: { fontSize: 26, fontWeight: "700", color: colors.green, marginBottom: 4 },
  subtitle: { color: colors.muted, marginBottom: 20, fontSize: 15 },
  label: { fontSize: 13, fontWeight: "600", color: colors.muted, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, fontSize: 16, color: colors.text },
  error: { color: colors.noShow, marginBottom: 12 },
  segment: { flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: "hidden", marginBottom: 14 },
  segmentItem: { flex: 1, paddingVertical: 10, paddingHorizontal: 14, alignItems: "center" },
  button: { backgroundColor: colors.green, borderRadius: 10, padding: 14, alignItems: "center", marginTop: 6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
