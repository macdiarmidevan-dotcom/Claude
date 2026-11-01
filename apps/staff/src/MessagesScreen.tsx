import { type ComponentRef, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { AudiencePreview, Campaign, CampaignDetail, Client, EventSummary, GolferAccount, MessageAudience, MessageChannel, MessageSettings } from "./api";
import { addDays, formatDate, todayIn } from "./dates";
import { useSearch } from "./Golfers";
import { colors, type WebPress } from "./theme";

// Messages to golfers by email and text: everyone booked on a day, a league, one golfer, or (for
// managers) every golfer or every house account holder. Until a provider is set up, messages go
// through the simulator: they're recorded exactly as they'd be sent, but nothing is delivered.

type Tab = "new" | "sent" | "settings";
type AudienceType = "date" | "event" | "golfer" | "golfers" | "house_accounts";

const PLACEHOLDERS = [
  ["{first_name}", "First name"],
  ["{tee_time}", "Tee time"],
  ["{date}", "Date"],
  ["{course}", "Course name"],
] as const;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function MessagesScreen({ client, isManager, timeZone }: { client: Client; isManager: boolean; timeZone: string }) {
  const [tab, setTab] = useState<Tab>("new");
  const [open, setOpen] = useState<string>();
  const tabs: [Tab, string][] = [
    ["new", "New message"],
    ["sent", "Sent"],
    ...(isManager ? ([["settings", "Settings"]] as [Tab, string][]) : []),
  ];
  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={styles.tabs}>
        {tabs.map(([id, label]) => (
          <Pressable
            key={id}
            role="tab"
            aria-selected={tab === id}
            onPress={() => (setTab(id), setOpen(undefined))}
            style={({ focused }: WebPress) => [styles.tab, tab === id && styles.tabOn, focused && styles.focus]}
          >
            <Text style={[styles.tabText, tab === id && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {open ? (
        <CampaignView client={client} id={open} onBack={() => setOpen(undefined)} />
      ) : tab === "new" ? (
        <Compose client={client} isManager={isManager} timeZone={timeZone} onSent={(c) => (setTab("sent"), setOpen(c.id))} />
      ) : tab === "sent" ? (
        <SentList client={client} onOpen={setOpen} />
      ) : (
        <Settings client={client} />
      )}
    </View>
  );
}

export function SimulatorNote({ provider }: { provider?: string }) {
  if (provider && provider !== "simulator") return null;
  return (
    <View style={styles.note}>
      <Text style={styles.noteText}>
        Practice mode: messages are recorded here exactly as golfers would get them, but nothing is delivered until an email and text provider is set up.
      </Text>
    </View>
  );
}

function Compose({ client, isManager, timeZone, onSent }: { client: Client; isManager: boolean; timeZone: string; onSent: (c: CampaignDetail) => void }) {
  const [type, setType] = useState<AudienceType>("date");
  const [date, setDate] = useState(todayIn(timeZone));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventId, setEventId] = useState<string>();
  const [q, setQ] = useState("");
  const [golfer, setGolfer] = useState<GolferAccount>();
  const { results } = useSearch(client, q);
  const [channels, setChannels] = useState<MessageChannel[]>(["email", "sms"]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<AudiencePreview>();
  const [settings, setSettings] = useState<MessageSettings>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const bodyRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [cursor, setCursor] = useState<number>();

  useEffect(() => {
    client
      .events()
      .then((list) => setEvents(list.filter((e) => e.active)))
      .catch(() => setEvents([]));
    client
      .messageSettings()
      .then(setSettings)
      .catch(() => undefined);
  }, [client]);

  const time = (s: string) => (/^\d{1,2}:\d{2}$/.test(s.trim()) ? s.trim().padStart(5, "0") : undefined);
  const audience: MessageAudience | undefined =
    type === "date"
      ? { type: "date", date, ...(time(from) ? { from: time(from) } : {}), ...(time(to) ? { to: time(to) } : {}) }
      : type === "event"
        ? eventId
          ? { type: "event", eventId }
          : undefined
        : type === "golfer"
          ? golfer
            ? { type: "golfer_list", golferIds: [golfer.id] }
            : undefined
          : { type };
  const key = JSON.stringify([audience, channels]);
  useEffect(() => {
    setPreview(undefined);
    if (!audience || !channels.length) return;
    const t = setTimeout(
      () =>
        client
          .previewMessage(audience, channels)
          .then(setPreview)
          .catch((e) => setError(e.message)),
      250,
    );
    return () => clearTimeout(t);
  }, [client, key]);

  const insert = (token: string) => {
    const at = cursor ?? body.length;
    setBody(body.slice(0, at) + token + body.slice(at));
    setCursor(at + token.length);
    bodyRef.current?.focus();
  };
  const toggle = (c: MessageChannel) => setChannels(channels.includes(c) ? channels.filter((x) => x !== c) : [...channels, c]);
  const email = channels.includes("email");
  const sms = channels.includes("sms");
  const ready = !!audience && channels.length > 0 && body.trim() && (!email || subject.trim()) && !!preview?.golfers;

  async function send() {
    if (!audience) return;
    setSending(true);
    setError(undefined);
    try {
      onSent(await client.sendMessage({ audience, channels, subject: email ? subject : null, body }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send");
    } finally {
      setSending(false);
    }
  }

  const types: [AudienceType, string][] = [
    ["date", "Booked on a day"],
    ["event", "League or outing"],
    ["golfer", "One golfer"],
    ...(isManager
      ? ([
          ["golfers", "All golfers"],
          ["house_accounts", "House accounts"],
        ] as [AudienceType, string][])
      : []),
  ];
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <SimulatorNote provider={settings?.provider} />
      <View style={styles.card}>
        <Text style={styles.title}>Who it goes to</Text>
        <View style={styles.row}>
          {types.map(([id, label]) => (
            <Chip key={id} label={label} on={type === id} onPress={() => setType(id)} />
          ))}
        </View>
        {type === "date" && (
          <>
            <View style={styles.row}>
              <SmallButton label="‹ Day before" onPress={() => setDate(addDays(date, -1))} />
              <Text style={[styles.strong, { minWidth: 150, textAlign: "center" }]}>{formatDate(date)}</Text>
              <SmallButton label="Day after ›" onPress={() => setDate(addDays(date, 1))} />
              {date !== todayIn(timeZone) && <SmallButton label="Today" onPress={() => setDate(todayIn(timeZone))} />}
            </View>
            <View style={[styles.row, { marginTop: 8 }]}>
              <Field label="From (optional)" value={from} onChange={setFrom} placeholder="e.g. 07:00" width={130} />
              <Field label="To (optional)" value={to} onChange={setTo} placeholder="e.g. 10:00" width={130} />
            </View>
            <Text style={styles.help}>Golfers booked on {formatDate(date)} who haven't teed off yet. Leave the times blank for the whole day.</Text>
          </>
        )}
        {type === "event" && (
          <View style={styles.row}>
            {events.length === 0 && <Text style={styles.help}>No leagues or outings yet.</Text>}
            {events.map((e) => (
              <Chip key={e.id} label={`${e.name} (${e.players})`} on={eventId === e.id} onPress={() => setEventId(e.id)} />
            ))}
          </View>
        )}
        {type === "golfer" &&
          (golfer ? (
            <View style={styles.row}>
              <Text style={styles.strong}>{golfer.name}</Text>
              <Text style={styles.help}>
                {golfer.phone} · {golfer.email}
              </Text>
              <SmallButton label="Change" onPress={() => (setGolfer(undefined), setQ(""))} />
            </View>
          ) : (
            <>
              <Field label="Find a golfer" value={q} onChange={setQ} placeholder="Name or phone" width={320} />
              {results?.slice(0, 6).map((g) => (
                <Pressable key={g.id} accessibilityRole="button" onPress={() => setGolfer(g)} style={({ focused }: WebPress) => [styles.result, focused && styles.focus]}>
                  <Text style={styles.strong}>{g.name}</Text>
                  <Text style={styles.help}>{g.phone}</Text>
                </Pressable>
              ))}
            </>
          ))}
        {(type === "golfers" || type === "house_accounts") && <Text style={styles.help}>A marketing message: golfers who opted out of email or texts are left off.</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Message</Text>
        <View style={styles.row}>
          <Toggle label="Email" on={email} onPress={() => toggle("email")} />
          <Toggle label="Text message" on={sms} onPress={() => toggle("sms")} />
        </View>
        {email && <Field label="Email subject" value={subject} onChange={setSubject} placeholder="e.g. Frost delay this morning" width={520} />}
        <Text style={styles.label}>Message</Text>
        <TextInput
          ref={bodyRef}
          accessibilityLabel="Message"
          value={body}
          onChangeText={setBody}
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.start)}
          multiline
          placeholder="Hi {first_name}, …"
          style={[styles.input, { minHeight: 120, maxWidth: 620, textAlignVertical: "top" }]}
        />
        <View style={[styles.row, { marginTop: 6 }]}>
          <Text style={styles.help}>Fill in for each golfer:</Text>
          {PLACEHOLDERS.map(([token, label]) => (
            <SmallButton key={token} label={label} onPress={() => insert(token)} />
          ))}
        </View>
        {sms && (
          <Text style={[styles.help, body.length > 160 && { color: colors.warn }]}>
            {body.length} characters{body.length > 160 ? `, sent as ${Math.ceil(body.length / 153)} texts` : ""}. Names and times change the length a little.
          </Text>
        )}
        {email && settings?.signature && <Text style={styles.help}>Emails end with the course signature.</Text>}
      </View>

      <View style={[styles.row, { marginTop: 12 }]}>
        <Button label={sending ? "Sending…" : preview ? `Send to ${preview.golfers} ${preview.golfers === 1 ? "golfer" : "golfers"}` : "Send"} primary disabled={!ready || sending} onPress={send} />
        {preview ? (
          <Text style={styles.help}>
            {preview.label}: {email ? `${preview.email} by email` : ""}
            {email && sms ? ", " : ""}
            {sms ? `${preview.sms} by text` : ""}
            {preview.unreachable ? `. ${preview.unreachable} can't be reached (no ${email && sms ? "email or mobile" : email ? "email" : "mobile number"}${preview.kind === "marketing" ? " or opted out" : ""})` : ""}.
          </Text>
        ) : audience && channels.length ? (
          <ActivityIndicator color={colors.primary} />
        ) : null}
      </View>
      {error && (
        <Text role="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </ScrollView>
  );
}

function SentList({ client, onOpen }: { client: Client; onOpen: (id: string) => void }) {
  const [list, setList] = useState<Campaign[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    client
      .campaigns()
      .then(setList)
      .catch((e) => setError(e.message));
  }, [client]);
  if (!list) return error ? <Text style={[styles.error, styles.page]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {list.length === 0 && <Text style={styles.help}>Nothing sent yet.</Text>}
      {list.map((c) => (
        <Pressable key={c.id} accessibilityRole="button" onPress={() => onOpen(c.id)} style={({ focused }: WebPress) => [styles.listRow, focused && styles.focus]}>
          <View style={{ flex: 1, minWidth: 220 }}>
            <Text style={styles.strong}>{c.subject ?? c.body.slice(0, 60)}</Text>
            <Text style={styles.help}>
              {c.audienceLabel} · {c.channels.map((x) => (x === "email" ? "Email" : "Text")).join(" and ")} · {when(c.sentAt)}
              {c.sentBy ? ` by ${c.sentBy}` : ""}
            </Text>
          </View>
          <Text style={styles.text}>
            {c.sent} sent{c.skipped ? `, ${c.skipped} not sent` : ""}
            {c.failed ? `, ${c.failed} failed` : ""}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function CampaignView({ client, id, onBack }: { client: Client; id: string; onBack: () => void }) {
  const [c, setC] = useState<CampaignDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    client
      .campaign(id)
      .then(setC)
      .catch((e) => setError(e.message));
  }, [client, id]);
  if (!c) return error ? <Text style={[styles.error, styles.page]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />;
  const example = c.messages.find((m) => m.status === "sent") ?? c.messages[0];
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="link" onPress={onBack}>
        <Text style={styles.link}>‹ Sent messages</Text>
      </Pressable>
      <Text role="heading" style={[styles.h1, { marginTop: 10 }]}>
        {c.subject ?? "Text message"}
      </Text>
      <Text style={styles.help}>
        {c.audienceLabel} · {when(c.sentAt)}
        {c.sentBy ? ` by ${c.sentBy}` : ""}
        {c.kind === "marketing" ? " · marketing, opted-out golfers left off" : ""}
      </Text>
      <View style={[styles.row, { marginTop: 10 }]}>
        <Stat label="Golfers" value={String(c.golfers)} />
        <Stat label="Sent" value={String(c.sent)} />
        <Stat label="Not sent" value={String(c.skipped)} tone={c.skipped ? colors.warn : undefined} />
        {c.failed > 0 && <Stat label="Failed" value={String(c.failed)} tone={colors.noShow} />}
      </View>
      {example && (
        <View style={styles.card}>
          <Text style={styles.label}>As {example.name} got it</Text>
          <Text style={[styles.text, { lineHeight: 21 }]}>{example.body}</Text>
        </View>
      )}
      <View style={styles.card}>
        <Text style={styles.title}>Each golfer</Text>
        {c.messages.map((m) => (
          <View key={m.id} style={styles.line}>
            <Text style={[styles.text, { width: 180 }]}>{m.name}</Text>
            <Text style={[styles.help, { width: 50 }]}>{m.channel === "email" ? "Email" : "Text"}</Text>
            <Text style={[styles.help, { flex: 1, minWidth: 160 }]}>{m.to ?? "—"}</Text>
            <Text style={[styles.text, { color: m.status === "sent" ? colors.checkedIn : m.status === "failed" ? colors.noShow : colors.warn }]}>
              {m.status === "sent" ? (m.provider === "simulator" ? "Recorded" : "Sent") : m.status === "failed" ? `Failed: ${m.reason}` : m.reason}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Settings({ client }: { client: Client }) {
  const [s, setS] = useState<MessageSettings>();
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [signature, setSignature] = useState("");
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    client
      .messageSettings()
      .then((x) => (setS(x), setFromName(x.fromName), setReplyTo(x.replyTo ?? ""), setSignature(x.signature ?? "")))
      .catch((e) => setError(e.message));
  }, [client]);
  if (!s) return error ? <Text style={[styles.error, styles.page]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <SimulatorNote provider={s.provider} />
      <View style={styles.card}>
        <Field label="From name" value={fromName} onChange={setFromName} width={360} />
        <Field label="Replies go to" value={replyTo} onChange={setReplyTo} placeholder="e.g. proshop@riverbendgolf.com" width={360} />
        <Field label="Email signature" value={signature} onChange={setSignature} width={480} multiline />
        {error && <Text style={styles.error}>{error}</Text>}
        {notice && <Text style={[styles.help, { color: colors.checkedIn }]}>{notice}</Text>}
        <View style={[styles.row, { marginTop: 8 }]}>
          <Button
            label="Save"
            primary
            onPress={() =>
              client
                .saveMessageSettings({ fromName, replyTo, signature })
                .then((x) => (setS(x), setNotice("Saved."), setError(undefined)))
                .catch((e) => setError(e.message))
            }
          />
        </View>
      </View>
    </ScrollView>
  );
}

function Field({ label, value, onChange, placeholder, width, multiline }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; width?: number; multiline?: boolean }) {
  return (
    <View style={{ marginBottom: 8, width: "100%", maxWidth: width }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} placeholder={placeholder} multiline={multiline} style={[styles.input, multiline && { minHeight: 64, textAlignVertical: "top" }]} />
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.statValue, tone && { color: tone }]}>{value}</Text>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={onPress} style={({ focused }: WebPress) => [styles.chip, on && styles.chipOn, focused && styles.focus]}>
      <Text style={[styles.chipText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={onPress} style={({ focused }: WebPress) => [styles.chip, on && styles.chipOn, focused && styles.focus]}>
      <Text style={[styles.chipText, on && { color: "#fff" }]}>
        {on ? "✓ " : ""}
        {label}
      </Text>
    </Pressable>
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

function SmallButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={({ focused }: WebPress) => [styles.small, focused && styles.focus]}>
      <Text style={styles.smallText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 16, backgroundColor: colors.card },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { color: colors.muted, fontWeight: "600", fontSize: 14 },
  tabTextOn: { color: colors.primary },
  page: { padding: 16, maxWidth: 1000 },
  h1: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 8 },
  text: { color: colors.text, fontSize: 14 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  link: { color: colors.primary, fontWeight: "600", textDecorationLine: "underline", fontSize: 14 },
  error: { color: colors.noShow, marginVertical: 6 },
  note: { borderWidth: 1, borderColor: "#e3c77a", backgroundColor: "#fdf6e3", borderRadius: 3, padding: 10 },
  noteText: { color: "#6b5310", fontSize: 13, lineHeight: 19 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, marginTop: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  listRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 3, backgroundColor: colors.card, marginBottom: 6 },
  result: { paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 3, marginBottom: 4, backgroundColor: "#fff", maxWidth: 320 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  stat: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingVertical: 8, paddingHorizontal: 12, minWidth: 120, backgroundColor: "#fff" },
  statValue: { fontSize: 18, fontWeight: "700", color: colors.text },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  small: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, minHeight: 30, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  smallText: { color: colors.text, fontWeight: "600", fontSize: 12 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
