import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ActivityEntry, Client, Role, StaffUser } from "./api";
import { colors, type WebPress } from "./theme";

/**
 * Managers add employees, choose who is a manager, reset forgotten passwords and turn off
 * accounts for people who leave. Below that is who did what on the tee sheet.
 */
export function StaffScreen({ client, me }: { client: Client; me: StaffUser | null }) {
  const [people, setPeople] = useState<StaffUser[]>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    client.staff().then(setPeople).catch((e) => setError(e.message));
    client.activity().then(setActivity).catch(() => undefined);
  }, [client]);
  useEffect(load, [load]);

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <Text role="heading" style={styles.h2}>Accounts</Text>
        {!adding && (
          <Pressable accessibilityRole="button" onPress={() => setAdding(true)} style={styles.button}>
            <Text style={styles.buttonText}>Add a person</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.help}>Everyone signs in with their own email and password. Managers can also change the waiver, import the tee sheet and manage accounts.</Text>
      {adding && (
        <AddPerson
          client={client}
          onDone={(added) => {
            setAdding(false);
            if (added) load();
          }}
        />
      )}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!people ? (
        !error && <ActivityIndicator style={{ marginTop: 24 }} color={colors.green} />
      ) : (
        <View style={styles.list}>
          {people.map((p) => (
            <Person key={p.id} person={p} isMe={p.id === me?.id} client={client} onChanged={load} />
          ))}
        </View>
      )}

      <Text role="heading" style={[styles.h2, { marginTop: 32 }]}>Recent activity</Text>
      {activity.length === 0 ? (
        <Text style={styles.help}>Nothing yet. Check-ins, payments, carts and other changes show here with who made them.</Text>
      ) : (
        <View style={styles.list}>
          {activity.map((a, i) => (
            <View key={i} style={styles.activity}>
              <Text style={styles.activityTime}>{when(a.at)}</Text>
              <Text style={styles.activityText}>
                <Text style={{ fontWeight: "700" }}>{a.actor}</Text> · {a.action}
                {a.golfer ? ` for ${a.golfer}` : ""}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Person({ person, isMe, client, onChanged }: { person: StaffUser; isMe: boolean; client: Client; onChanged: () => void }) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function change(patch: { role?: Role; active?: boolean; password?: string }, done?: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await client.updateStaff(person.id, patch);
      setResetting(false);
      setPassword("");
      setNotice(done);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.person, !person.active && { opacity: 0.6 }]}>
      <View style={styles.personTop}>
        <View style={{ flex: 1, minWidth: 180 }}>
          <Text style={styles.name}>
            {person.name}
            {isMe ? " (you)" : ""}
          </Text>
          <Text style={styles.meta}>
            {person.email} · {person.role === "manager" ? "Manager" : "Staff"}
            {person.active ? "" : " · Turned off"}
          </Text>
          <Text style={styles.meta}>{person.lastLoginAt ? `Last signed in ${when(person.lastLoginAt)}` : "Hasn't signed in yet"}</Text>
        </View>
        <View style={styles.actions}>
          {person.active && (
            <Small
              label={person.role === "manager" ? "Make staff" : "Make manager"}
              disabled={busy}
              onPress={() => change({ role: person.role === "manager" ? "staff" : "manager" })}
            />
          )}
          {person.active && <Small label="Reset password" disabled={busy} onPress={() => setResetting(!resetting)} />}
          {!isMe && (
            <Small
              label={person.active ? "Turn off" : "Turn back on"}
              disabled={busy}
              onPress={() => change({ active: !person.active }, person.active ? "Signed out on every device. They can't sign in until turned back on." : undefined)}
            />
          )}
        </View>
      </View>
      {resetting && (
        <View style={styles.resetRow}>
          <TextInput
            accessibilityLabel={`New password for ${person.name}`}
            placeholder="New password, at least 8 characters"
            value={password}
            onChangeText={setPassword}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { flex: 1, minWidth: 200 }]}
          />
          <Small label="Save" primary disabled={busy || password.length < 8} onPress={() => change({ password }, "Password changed. Give it to them in person; they're signed out until they use it.")} />
        </View>
      )}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {notice && <Text style={styles.notice}>{notice}</Text>}
    </View>
  );
}

function AddPerson({ client, onDone }: { client: Client; onDone: (added: boolean) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = name.trim() !== "" && email.includes("@") && password.length >= 8;

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await client.addStaff({ name: name.trim(), email: email.trim(), role, password });
      onDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add them");
      setBusy(false);
    }
  }

  return (
    <View style={styles.person}>
      <Text style={styles.name}>Add a person</Text>
      <Labeled label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
      <Labeled label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      <Labeled label="First password" value={password} onChangeText={setPassword} autoCapitalize="none" placeholder="At least 8 characters. They can change it later." />
      <Text style={styles.fieldLabel}>Role</Text>
      <View style={[styles.actions, { marginBottom: 12 }]}>
        <Small label="Staff" primary={role === "staff"} onPress={() => setRole("staff")} />
        <Small label="Manager" primary={role === "manager"} onPress={() => setRole("manager")} />
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Small label={busy ? "Adding…" : "Add"} primary disabled={busy || !ready} onPress={save} />
        <Small label="Cancel" disabled={busy} onPress={() => onDone(false)} />
      </View>
    </View>
  );
}

/** Lets anyone signed in with their own account change their password. */
export function ChangePassword({ client }: { client: Client }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  async function save() {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await client.changePassword(current, next);
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ maxWidth: 360 }}>
      <Labeled label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" />
      <Labeled label="New password" value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" placeholder="At least 8 characters" />
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {done && <Text style={styles.notice}>Password changed. Other devices you were signed in on will ask you to sign in again.</Text>}
      <Small label={busy ? "Saving…" : "Change password"} primary disabled={busy || !current || next.length < 8} onPress={save} />
    </View>
  );
}

function Labeled(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput accessibilityLabel={label} autoCorrect={false} style={styles.input} {...input} />
    </View>
  );
}

function Small({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: primary }}
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.small, primary && styles.smallPrimary, disabled && { opacity: 0.5 }, focused && styles.focusRing]}
    >
      <Text style={[styles.smallText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const styles = StyleSheet.create({
  content: { padding: 24, maxWidth: 820 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 6 },
  h2: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 6 },
  help: { color: colors.muted, fontSize: 15, lineHeight: 22, marginBottom: 12 },
  error: { color: colors.noShow, marginVertical: 8 },
  notice: { color: colors.checkedIn, marginVertical: 8 },
  list: { gap: 10 },
  person: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 14, marginBottom: 10 },
  personTop: { flexDirection: "row", flexWrap: "wrap", gap: 12, alignItems: "center" },
  name: { fontSize: 16, fontWeight: "700", color: colors.text, marginBottom: 4 },
  meta: { color: colors.muted, fontSize: 14 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  resetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12, alignItems: "center" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, fontSize: 15, color: colors.text, backgroundColor: "#fff" },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.muted, marginBottom: 6 },
  small: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, minHeight: 40, justifyContent: "center", backgroundColor: "#fff" },
  smallPrimary: { backgroundColor: colors.green, borderColor: colors.green },
  smallText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  button: { backgroundColor: colors.green, borderRadius: 10, paddingHorizontal: 18, minHeight: 44, justifyContent: "center" },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  activity: { flexDirection: "row", gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border, flexWrap: "wrap" },
  activityTime: { color: colors.muted, fontSize: 14, width: 110 },
  activityText: { color: colors.text, fontSize: 14, flex: 1, minWidth: 200 },
  focusRing: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
