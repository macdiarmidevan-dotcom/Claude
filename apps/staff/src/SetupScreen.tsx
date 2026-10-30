import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { createClient, signIn, type Settings, type Station } from "./api";
import { colors } from "./theme";
import { DEMO, DEMO_PASSWORD } from "./demo";

/**
 * Signing in. Each employee and manager uses their own email and password, so the app knows who
 * checked a group in and only shows manager tools to managers. A shared device key is still
 * offered for a kiosk that nobody signs in to.
 */
export function SetupScreen({ initial, onSave }: { initial?: Settings; onSave: (s: Settings) => void }) {
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? "http://localhost:3000");
  const [courseSlug, setCourseSlug] = useState(initial?.courseSlug ?? "river-bend");
  const [mode, setMode] = useState<"account" | "key">("account");
  const [email, setEmail] = useState(DEMO ? "manager@riverbend.example" : "");
  const [password, setPassword] = useState(DEMO ? DEMO_PASSWORD : "");
  const [apiKey, setApiKey] = useState(initial?.apiKey?.startsWith("sk_") ? initial.apiKey : "");
  const [station, setStation] = useState<Station>(initial?.station ?? "starter");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // In the demo the server and course are pretend, so they stay out of the way.
  const [showServer, setShowServer] = useState(!DEMO);

  const ready = mode === "account" ? email.trim() !== "" && password !== "" : apiKey.trim() !== "";

  async function connect() {
    setBusy(true);
    setError(undefined);
    const where = { apiUrl: apiUrl.trim(), courseSlug: courseSlug.trim() };
    try {
      if (mode === "account") {
        const { token } = await signIn(where.apiUrl, where.courseSlug, email.trim(), password);
        onSave({ ...where, apiKey: token, station });
      } else {
        const settings = { ...where, apiKey: apiKey.trim(), station };
        // The tee sheet needs a secret key, so check that rather than just the course.
        await createClient(settings).teeSheet(new Date().toISOString().slice(0, 10));
        onSave(settings);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      <View style={styles.card}>
        <Text role="heading" style={styles.title}>Sign in</Text>
        <Text style={styles.subtitle}>
          {DEMO
            ? `This is a demo with a pretend River Bend tee sheet. Nothing you do is saved. You're signing in as the manager. To see what other staff see, use proshop@riverbend.example or starter@riverbend.example. Every demo password is "${DEMO_PASSWORD}".`
            : mode === "account"
              ? "Use the email and password your manager set up for you."
              : "A shared device key signs this device in without a person. Your manager has it."}
        </Text>
        {showServer ? (
          <>
            <Field label="Server" value={apiUrl} onChangeText={setApiUrl} />
            <Field label="Course" value={courseSlug} onChangeText={setCourseSlug} />
          </>
        ) : null}
        {mode === "account" ? (
          <>
            <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" textContentType="username" />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              onSubmitEditing={() => ready && !busy && connect()}
            />
          </>
        ) : (
          <Field label="Device key" value={apiKey} onChangeText={setApiKey} secureTextEntry placeholder="sk_…" />
        )}
        <Text style={styles.label}>This device is for</Text>
        <StationPicker value={station} onChange={setStation} />
        {error && <Text role="alert" style={styles.error}>{error}</Text>}
        <Pressable
          accessibilityRole="button"
          style={[styles.button, (busy || !ready) && { opacity: 0.5 }]}
          disabled={busy || !ready}
          onPress={connect}
        >
          <Text style={styles.buttonText}>{busy ? "Signing in…" : "Sign in"}</Text>
        </Pressable>
        <View style={styles.links}>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => { setMode(mode === "account" ? "key" : "account"); setError(undefined); }}>
            <Text style={styles.link}>{mode === "account" ? "Use a shared device key instead" : "Sign in with email instead"}</Text>
          </Pressable>
          {!showServer && (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setShowServer(true)}>
              <Text style={styles.link}>Server settings</Text>
            </Pressable>
          )}
        </View>
        {mode === "account" && !DEMO && <Text style={styles.hint}>Forgot your password? A manager can reset it under Staff accounts.</Text>}
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
    <View style={[styles.segment, dark && { borderColor: "#3a3d42" }]}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.id)}
            style={[styles.segmentItem, on && { backgroundColor: colors.primary }]}
          >
            <Text style={{ fontWeight: "600", color: on ? "#fff" : dark ? colors.railText : colors.text }}>{o.label}</Text>
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
      <TextInput accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} style={styles.input} {...input} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 16 },
  card: { backgroundColor: colors.card, borderRadius: 3, borderWidth: 1, borderColor: colors.border, padding: 24, width: "100%", maxWidth: 420 },
  title: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 },
  subtitle: { color: colors.muted, marginBottom: 20, fontSize: 14 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 12, fontSize: 14, color: colors.text },
  error: { color: colors.noShow, marginBottom: 12 },
  segment: { flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: 3, overflow: "hidden", marginBottom: 14 },
  segmentItem: { flex: 1, paddingVertical: 7, paddingHorizontal: 10, alignItems: "center" },
  button: { backgroundColor: colors.primary, borderRadius: 3, paddingVertical: 10, alignItems: "center", marginTop: 6 },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  links: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 12, marginTop: 16 },
  link: { color: colors.primary, fontWeight: "600", textDecorationLine: "underline", fontSize: 13 },
  hint: { color: colors.muted, fontSize: 12, marginTop: 12 },
});
