import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, DelayReason, MessageChannel, SheetTeeTime, TeeSheetDelay } from "./api";
import { colors, formatTime, type WebPress } from "./theme";

// Weather delays on the tee sheet. Frost or fog holds the first tee: push every tee time from a
// chosen one onward back by some minutes, groups and all, and text or email the golfers their
// new time. The latest delay on a day can be taken back.

const REASONS: { id: DelayReason; label: string }[] = [
  { id: "frost", label: "Frost" },
  { id: "fog", label: "Fog" },
  { id: "rain", label: "Rain" },
  { id: "lightning", label: "Lightning" },
  { id: "course", label: "Course conditions" },
  { id: "other", label: "Other" },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.id, r.label])) as Record<DelayReason, string>;
REASON_LABEL.heat = "Heat";
const MINUTES = [15, 30, 45, 60, 90, 120];
const DEFAULT_MESSAGE = "Hi {first_name}, {reason} delay at {course} today: tee times are running {minutes} minutes late. Your tee time is now {tee_time}. Questions? Call the pro shop.";

const plus = (hhmm: string, minutes: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h! * 60 + m! + minutes;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

export function DelayBar({ client, date, today, nowLocal, sheet, onChanged }: { client: Client; date: string; today: string; nowLocal: string; sheet?: SheetTeeTime[]; onChanged: () => void }) {
  const isToday = date === today;
  const [delays, setDelays] = useState<TeeSheetDelay[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    client
      .delays(date)
      .then(setDelays)
      .catch(() => setDelays([]));
  useEffect(() => {
    setOpen(false);
    load();
  }, [client, date]);
  const active = delays.filter((d) => !d.undoneAt);
  const latest = active.at(-1);
  // Only today and days ahead can be delayed.
  const canDelay = !!sheet?.length && date >= today;
  return (
    <View>
      {active.map((d) => (
        <View key={d.id} style={styles.banner} role="status">
          <Text style={styles.bannerText}>
            <Text style={{ fontWeight: "700" }}>{REASON_LABEL[d.reason]} delay:</Text> tee times from {formatTime(d.fromTime)} pushed back {d.minutes} minutes
            {d.note ? ` (${d.note})` : ""}. {d.groups} {d.groups === 1 ? "group" : "groups"} moved
            {d.campaignId ? " and told" : ""}
            {d.staff ? ` · ${d.staff}` : ""} at {new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </Text>
          {d === latest && (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                client
                  .undoDelay(d.id)
                  .then((x) => (setDelays(x), onChanged()))
                  .catch((e) => setError(e.message))
              }
              style={({ focused }: WebPress) => [styles.smallButton, focused && styles.focus]}
            >
              <Text style={styles.smallButtonText}>Take back</Text>
            </Pressable>
          )}
        </View>
      ))}
      {error && <Text style={[styles.error, { paddingHorizontal: 16 }]}>{error}</Text>}
      {open && sheet ? (
        <DelayForm
          client={client}
          date={date}
          sheet={sheet}
          firstTime={(isToday ? sheet.find((t) => t.localTime >= nowLocal) : sheet[0])?.localTime ?? sheet[0]!.localTime}
          onCancel={() => setOpen(false)}
          onDone={() => (setOpen(false), load(), onChanged())}
        />
      ) : (
        canDelay && (
          <View style={styles.barRow}>
            <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={({ focused }: WebPress) => [styles.smallButton, focused && styles.focus]}>
              <Text style={styles.smallButtonText}>Weather delay…</Text>
            </Pressable>
          </View>
        )
      )}
    </View>
  );
}

function DelayForm({ client, date, sheet, firstTime, onCancel, onDone }: { client: Client; date: string; sheet: SheetTeeTime[]; firstTime: string; onCancel: () => void; onDone: () => void }) {
  const [from, setFrom] = useState(firstTime);
  const [minutes, setMinutes] = useState(30);
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState<DelayReason>("frost");
  const [note, setNote] = useState("");
  const [channels, setChannels] = useState<MessageChannel[]>(["sms", "email"]);
  const [body, setBody] = useState(DEFAULT_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mins = custom.trim() ? Number(custom) : minutes;
  const valid = Number.isInteger(mins) && mins >= 5 && mins <= 300;
  const moved = sheet.filter((t) => t.localTime >= from);
  const groups = moved.reduce((n, t) => n + t.bookings.filter((b) => b.status === "confirmed" || b.status === "checked_in").length, 0);
  const last = sheet.at(-1)!.localTime;
  const startTimes = sheet.filter((t) => t.localTime >= firstTime).slice(0, 6);
  const toggle = (c: MessageChannel) => setChannels(channels.includes(c) ? channels.filter((x) => x !== c) : [...channels, c]);

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await client.delayTeeSheet({ date, from, minutes: mins, reason, note: note.trim() || null, notify: channels.length ? { channels, body } : null });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't push the tee sheet back");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Weather delay</Text>
      <Text style={styles.label}>Why</Text>
      <View style={styles.row}>
        {REASONS.map((r) => (
          <Chip key={r.id} label={r.label} on={reason === r.id} onPress={() => setReason(r.id)} />
        ))}
      </View>
      <Text style={styles.label}>Push back from</Text>
      <View style={styles.row}>
        {startTimes.map((t) => (
          <Chip key={t.id} label={formatTime(t.localTime)} on={from === t.localTime} onPress={() => setFrom(t.localTime)} />
        ))}
      </View>
      <Text style={styles.label}>By how long</Text>
      <View style={styles.row}>
        {MINUTES.map((m) => (
          <Chip key={m} label={m < 60 ? `${m} min` : m === 60 ? "1 hour" : `${m / 60} hours`} on={!custom && minutes === m} onPress={() => (setMinutes(m), setCustom(""))} />
        ))}
        <TextInput accessibilityLabel="Other number of minutes" value={custom} onChangeText={setCustom} placeholder="Minutes" keyboardType="number-pad" style={[styles.input, { width: 90 }]} />
      </View>
      <TextInput accessibilityLabel="Note (optional)" value={note} onChangeText={setNote} placeholder="Note (optional), e.g. greens still white" style={[styles.input, { maxWidth: 420, marginBottom: 8 }]} />
      {valid && (
        <Text style={styles.help}>
          Moves {moved.length} tee times and {groups} {groups === 1 ? "group" : "groups"}: {formatTime(from)} becomes {formatTime(plus(from, mins))}, and the last tee time becomes{" "}
          {formatTime(plus(last, mins))}.
        </Text>
      )}
      <Text style={[styles.label, { marginTop: 10 }]}>Tell the golfers whose times move</Text>
      <View style={styles.row}>
        <Chip label={`${channels.includes("sms") ? "✓ " : ""}Text message`} on={channels.includes("sms")} onPress={() => toggle("sms")} check />
        <Chip label={`${channels.includes("email") ? "✓ " : ""}Email`} on={channels.includes("email")} onPress={() => toggle("email")} check />
      </View>
      {channels.length > 0 && (
        <TextInput accessibilityLabel="Message to golfers" value={body} onChangeText={setBody} multiline style={[styles.input, { minHeight: 72, maxWidth: 620, textAlignVertical: "top" }]} />
      )}
      {channels.length > 0 && <Text style={styles.help}>Each golfer gets their own new tee time. Golfers with no mobile number or email are listed under Messages › Sent.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={[styles.row, { marginTop: 8 }]}>
        <Pressable
          accessibilityRole="button"
          disabled={!valid || busy}
          onPress={save}
          style={({ focused }: WebPress) => [styles.button, styles.buttonPrimary, (!valid || busy) && { opacity: 0.5 }, focused && styles.focus]}
        >
          <Text style={[styles.buttonText, { color: "#fff" }]}>{busy ? "Pushing back…" : `Push back ${valid ? mins : "?"} minutes`}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onCancel} style={({ focused }: WebPress) => [styles.button, focused && styles.focus]}>
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Chip({ label, on, onPress, check }: { label: string; on: boolean; onPress: () => void; check?: boolean }) {
  return (
    <Pressable
      accessibilityRole={check ? "checkbox" : "radio"}
      accessibilityState={check ? { checked: on } : { selected: on }}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.chip, on && styles.chipOn, focused && styles.focus]}
    >
      <Text style={[styles.chipText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: "#fdf6e3", borderBottomWidth: 1, borderColor: "#e3c77a" },
  bannerText: { flex: 1, minWidth: 220, color: "#6b5310", fontSize: 13, lineHeight: 19 },
  barRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 6 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, margin: 12 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 8 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.noShow, marginVertical: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 8, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  smallButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, minHeight: 30, justifyContent: "center", backgroundColor: "#fff" },
  smallButtonText: { color: colors.text, fontWeight: "600", fontSize: 12 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
