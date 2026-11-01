import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, Course, Me, StaffFeedback, Station } from "./api";
import { ChangePassword } from "./StaffScreen";
import { colors, type WebPress } from "./theme";

// The account menu: tapping your name at the foot of the sidebar opens settings, your schedule,
// your account, feedback, the help center, and log out.

export type AccountAction = "settings" | "help" | "schedule";

export function AccountMenu({
  client,
  course,
  me,
  isManager,
  station,
  page,
  onGo,
  onSignOut,
}: {
  client: Client;
  course?: Course;
  me?: Me;
  isManager: boolean;
  station: Station;
  /** Where they are in the app, sent along with feedback. */
  page: string;
  onGo: (to: AccountAction) => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"feedback" | "account">();
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const items: { label: string; onPress: () => void }[] = [
    { label: "Settings", onPress: pick(() => onGo("settings")) },
    { label: "My schedule", onPress: pick(() => onGo("schedule")) },
    { label: "My account", onPress: pick(() => setDialog("account")) },
    { label: "Send feedback", onPress: pick(() => setDialog("feedback")) },
    { label: "Help center", onPress: pick(() => onGo("help")) },
    { label: "Log out", onPress: pick(onSignOut) },
  ];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Account menu for ${me?.user?.name ?? "this device"}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ hovered, focused }: WebPress) => [styles.foot, (hovered || open) && { backgroundColor: "#26292d" }, focused && styles.focus]}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(me?.user?.name)}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name} numberOfLines={1}>{me?.user?.name ?? "Shared device"}</Text>
          <Text style={styles.muted}>{isManager ? "Manager" : "Staff"}</Text>
        </View>
        <Text style={styles.caret}>{open ? "▾" : "▴"}</Text>
      </Pressable>

      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close account menu" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        <View role="menu" style={styles.popup}>
          <View style={styles.popupHead}>
            <Text style={styles.popupName} numberOfLines={1}>{me?.user?.name ?? "Shared device"}</Text>
            {me?.user?.email ? <Text style={styles.popupSub} numberOfLines={1}>{me.user.email}</Text> : null}
          </View>
          {items.map((item, i) => (
            <Pressable
              key={item.label}
              role="menuitem"
              onPress={item.onPress}
              style={({ hovered, focused }: WebPress) => [
                styles.item,
                i === items.length - 1 && styles.itemLast,
                (hovered || focused) && { backgroundColor: colors.primaryLight },
              ]}
            >
              <Text style={[styles.itemText, i === items.length - 1 && { color: colors.noShow }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>

      <Modal transparent visible={!!dialog} animationType="fade" onRequestClose={() => setDialog(undefined)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} role="dialog">
            {dialog === "feedback" ? (
              <FeedbackForm client={client} page={page} onClose={() => setDialog(undefined)} />
            ) : (
              <MyAccount client={client} me={me} isManager={isManager} course={course} station={station} onClose={() => setDialog(undefined)} />
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const initials = (name?: string) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function FeedbackForm({ client, page, onClose }: { client: Client; page: string; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      await client.sendFeedback({ body: body.trim(), page });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send it");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <>
        <Text style={styles.title}>Thanks</Text>
        <Text style={styles.help}>Your feedback is in. Managers see it under Settings.</Text>
        <View style={styles.actions}>
          <Button label="Done" primary onPress={onClose} />
        </View>
      </>
    );
  }
  return (
    <>
      <Text style={styles.title}>Send feedback</Text>
      <Text style={styles.help}>What's confusing, broken or missing? Your manager reads these.</Text>
      <TextInput
        accessibilityLabel="Your feedback"
        value={body}
        onChangeText={setBody}
        multiline
        autoFocus
        placeholder="e.g. The waiver screen is hard to read in the sun"
        style={[styles.input, { minHeight: 110, textAlignVertical: "top" }]}
      />
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Button label={busy ? "Sending…" : "Send"} primary disabled={busy || !body.trim()} onPress={send} />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </>
  );
}

// "Central Daylight Time" rather than "America/Chicago".
const zoneName = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? timeZone;

/** Who you're signed in as, where, and a place to change your password. */
function MyAccount({
  client,
  me,
  isManager,
  course,
  station,
  onClose,
}: {
  client: Client;
  me?: Me;
  isManager: boolean;
  course?: Course;
  station: Station;
  onClose: () => void;
}) {
  const user = me?.user;
  const rows: [string, string][] = [
    ["Name", user?.name ?? "Shared device"],
    ...(user ? ([["Email", user.email]] as [string, string][]) : []),
    ["Role", (isManager ? "Manager" : "Staff") + (user?.employeeType ? ` · ${user.employeeType.name}` : "")],
    ["Course", course ? `${course.name} · ${zoneName(course.timeZone)}` : "Loading…"],
    ["This device", station === "proshop" ? "Pro shop" : "Starter"],
  ];
  return (
    <ScrollView style={{ maxHeight: 560 }}>
      <Text style={styles.title}>My account</Text>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.row}>
          <Text style={styles.rowLabel}>{k}</Text>
          <Text style={styles.rowValue} numberOfLines={2}>{v}</Text>
        </View>
      ))}
      {user ? (
        <>
          <Text style={[styles.locationName, { marginTop: 16, marginBottom: 8 }]}>Change password</Text>
          <ChangePassword client={client} />
        </>
      ) : (
        <Text style={[styles.help, { marginTop: 10 }]}>This device signs in with a shared key. Sign in with your own email to change a password.</Text>
      )}
      <View style={styles.actions}>
        <Button label="Done" primary onPress={onClose} />
      </View>
    </ScrollView>
  );
}

/** Managers read what staff sent from the account menu, newest first. */
export function FeedbackList({ client }: { client: Client }) {
  const [items, setItems] = useState<StaffFeedback[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    client.feedback().then(setItems).catch((e) => setError(e.message));
  }, [client]);
  if (error) return <Text role="alert" style={styles.error}>{error}</Text>;
  if (!items) return <ActivityIndicator color={colors.primary} style={{ alignSelf: "flex-start" }} />;
  if (!items.length) return <Text style={styles.help}>Nothing yet. Staff send feedback from the menu under their name.</Text>;
  return (
    <View>
      {items.map((f) => (
        <View key={f.id} style={styles.feedback}>
          <Text style={styles.feedbackBody}>{f.body}</Text>
          <Text style={styles.meta}>
            {f.staff ?? "Shared device"}
            {f.page ? ` · from ${f.page}` : ""} · {new Date(f.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Button({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  foot: { flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: 1, borderColor: "#2e3236", paddingHorizontal: 14, paddingVertical: 12 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  name: { color: colors.railText, fontSize: 13, fontWeight: "700" },
  muted: { color: colors.railMuted, fontSize: 12 },
  caret: { color: colors.railMuted, fontSize: 12 },
  popup: {
    position: "absolute",
    left: 8,
    bottom: 64,
    width: 224,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    paddingVertical: 4,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  popupHead: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border, marginBottom: 4 },
  popupName: { fontSize: 14, fontWeight: "700", color: colors.text },
  popupSub: { fontSize: 12, color: colors.muted, marginTop: 1 },
  item: { paddingHorizontal: 14, minHeight: 36, justifyContent: "center" },
  itemLast: { borderTopWidth: 1, borderColor: colors.border, marginTop: 4 },
  itemText: { fontSize: 14, color: colors.text },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", padding: 16 },
  dialog: { width: "100%", maxWidth: 440, backgroundColor: colors.card, borderRadius: 3, padding: 18 },
  title: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 6 },
  row: { flexDirection: "row", gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabel: { width: 96, color: colors.muted, fontSize: 14 },
  rowValue: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" },
  locationName: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 2 },
  help: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 10, fontSize: 14, color: colors.text, backgroundColor: "#fff", marginTop: 10 },
  error: { color: colors.noShow, marginTop: 8 },
  actions: { flexDirection: "row", gap: 8, marginTop: 14 },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
  feedback: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 10, backgroundColor: colors.card, marginBottom: 8 },
  meta: { color: colors.muted, fontSize: 12 },
  feedbackBody: { color: colors.text, fontSize: 14, lineHeight: 20, marginBottom: 4 },
});
