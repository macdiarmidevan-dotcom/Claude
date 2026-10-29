import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, ImportSource, SyncConnection, SyncMethod } from "./api";
import { colors, type WebPress } from "./theme";

const SOURCES: { id: ImportSource; label: string }[] = [
  { id: "teeitup", label: "TeeItUp" },
  { id: "golfnow", label: "GolfNow" },
  { id: "import", label: "Other" },
];

const INTERVALS = [5, 10, 15, 30, 60];

/**
 * Keeps the tee sheet in step with the course's booking provider on its own. The manager sets it
 * up once; after that new, changed and cancelled online bookings come in every few minutes.
 */
export function SyncCard({ client, onSynced }: { client: Client; onSynced: () => void }) {
  const [conn, setConn] = useState<SyncConnection | null>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    client.sync().then(setConn).catch((e) => setError(e.message));
  }, [client]);

  async function syncNow() {
    setBusy(true);
    setError(undefined);
    try {
      setConn((await client.syncNow()).connection);
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(enabled: boolean) {
    if (!conn) return;
    setBusy(true);
    try {
      setConn(await client.saveSync({ source: conn.source, method: conn.method, reportUrl: conn.reportUrl, enabled, intervalMinutes: conn.intervalMinutes }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  if (conn === undefined) {
    return <View style={styles.card}>{error ? <Text role="alert" style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.primary} />}</View>;
  }

  if (!conn || editing) {
    return (
      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.title}>Automatic sync</Text>
        <SyncForm
          client={client}
          existing={conn}
          onSaved={(c) => {
            setConn(c);
            setEditing(false);
          }}
          onCancel={conn ? () => setEditing(false) : undefined}
        />
      </View>
    );
  }

  const provider = SOURCES.find((s) => s.id === conn.source)?.label ?? "Booking system";
  const statusColor = conn.lastStatus === "ok" ? colors.checkedIn : conn.lastStatus === "error" ? colors.noShow : colors.warn;

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text role="heading" aria-level={2} style={[styles.title, { flex: 1 }]}>Automatic sync</Text>
        <Text style={[styles.pill, conn.enabled ? styles.pillOn : null]}>{conn.enabled ? "On" : "Paused"}</Text>
      </View>
      <Text style={styles.text}>
        {conn.method === "report_url"
          ? `Pulls ${provider}'s tee sheet ${conn.enabled ? `every ${conn.intervalMinutes} minutes` : "only when you press Sync now"}.`
          : `Connects to the ${provider} API${conn.hasCredentials ? " with the saved sign-in details" : ""}.`}
      </Text>
      {conn.reportUrl && conn.method === "report_url" && (
        <Text style={styles.muted} numberOfLines={1}>
          {conn.reportUrl}
        </Text>
      )}
      <View style={[styles.status, { borderColor: statusColor }]} accessibilityLiveRegion="polite">
        {conn.lastRunAt ? (
          <>
            <Text style={[styles.statusTitle, { color: statusColor }]}>
              {conn.lastStatus === "ok" ? "✓ Synced" : conn.lastStatus === "waiting" ? "Waiting for provider access" : "✕ Last sync failed"} ·{" "}
              {new Date(conn.lastRunAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </Text>
            {conn.lastMessage && <Text style={styles.text}>{conn.lastMessage}</Text>}
          </>
        ) : (
          <Text style={styles.text}>Hasn't synced yet. Press Sync now to try it.</Text>
        )}
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Button label={busy ? "Syncing…" : "Sync now"} primary disabled={busy} onPress={syncNow} />
        {conn.method === "report_url" && <Button label={conn.enabled ? "Pause" : "Turn on"} disabled={busy} onPress={() => toggle(!conn.enabled)} />}
        <Button label="Change settings" disabled={busy} onPress={() => setEditing(true)} />
      </View>
    </View>
  );
}

function SyncForm({ client, existing, onSaved, onCancel }: { client: Client; existing: SyncConnection | null; onSaved: (c: SyncConnection | null) => void; onCancel?: () => void }) {
  const [source, setSource] = useState<ImportSource>(existing?.source ?? "teeitup");
  const [method, setMethod] = useState<SyncMethod>(existing?.method ?? "report_url");
  const [reportUrl, setReportUrl] = useState(existing?.reportUrl ?? "");
  const [interval, setIntervalMinutes] = useState(existing?.intervalMinutes ?? 10);
  const [facilityId, setFacilityId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const provider = SOURCES.find((s) => s.id === source)!.label;

  const ready = method === "report_url" ? reportUrl.trim().startsWith("https://") : existing?.hasCredentials || (facilityId.trim() !== "" && apiKey.trim() !== "");

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const credentials = method === "provider_api" && apiKey.trim() ? { facilityId: facilityId.trim(), apiKey: apiKey.trim() } : undefined;
      onSaved(
        await client.saveSync({
          source,
          method,
          reportUrl: method === "report_url" ? reportUrl.trim() : null,
          credentials,
          enabled: true,
          intervalMinutes: interval,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the sync settings");
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await client.removeSync();
      onSaved(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't turn sync off");
      setBusy(false);
    }
  }

  return (
    <View>
      <Text style={styles.text}>Bring online bookings in on their own, so the pro shop never has to upload a file.</Text>
      <Text style={styles.label}>Booking system</Text>
      <View style={styles.actions}>
        {SOURCES.map((s) => (
          <Button key={s.id} label={s.label} radio selected={source === s.id} onPress={() => setSource(s.id)} />
        ))}
      </View>
      <Text style={styles.label}>How to connect</Text>
      <View style={styles.actions}>
        <Button label="Report link" radio selected={method === "report_url"} onPress={() => setMethod("report_url")} />
        <Button label={`${provider} API`} radio selected={method === "provider_api"} onPress={() => setMethod("provider_api")} />
      </View>

      {method === "report_url" ? (
        <>
          <Text style={styles.text}>
            In {provider === "Other" ? "your booking system" : provider}, set up the tee sheet report to be published or scheduled as a CSV, and copy its link here. It must start with https://.
          </Text>
          <Field label="Report link" value={reportUrl} onChangeText={setReportUrl} placeholder="https://…" keyboardType="url" />
          <Text style={styles.label}>Check for changes every</Text>
          <View style={styles.actions}>
            {INTERVALS.map((m) => (
              <Button key={m} label={m < 60 ? `${m} min` : "1 hour"} radio selected={interval === m} onPress={() => setIntervalMinutes(m)} />
            ))}
          </View>
        </>
      ) : (
        <>
          <View style={styles.notice}>
            <Text style={styles.text}>
              {provider} only lets approved partners use its API, and the course has to ask for it. Ask your {provider} rep for API access for this course. Until it's
              granted, a report link or a file upload keeps the tee sheet up to date.
            </Text>
          </View>
          {existing?.hasCredentials && <Text style={styles.muted}>Sign-in details are saved. Enter new ones only to replace them.</Text>}
          <Field label={`${provider} course or facility ID`} value={facilityId} onChangeText={setFacilityId} />
          <Field label="API key from your rep" value={apiKey} onChangeText={setApiKey} secureTextEntry />
          <Text style={styles.muted}>These are stored encrypted on the server and never shown again.</Text>
        </>
      )}

      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.actions, { marginTop: 14 }]}>
        <Button label={busy ? "Saving…" : existing ? "Save" : "Turn on sync"} primary disabled={busy || !ready} onPress={save} />
        {onCancel && <Button label="Cancel" disabled={busy} onPress={onCancel} />}
        {existing && <Button label="Turn off and remove" danger disabled={busy} onPress={remove} />}
      </View>
    </View>
  );
}

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} style={styles.input} {...input} />
    </View>
  );
}

function Button(props: { label: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean; radio?: boolean; selected?: boolean }) {
  const { label, onPress, primary, danger, disabled, radio, selected } = props;
  const filled = primary || selected;
  return (
    <Pressable
      accessibilityRole={radio ? "radio" : "button"}
      accessibilityState={radio ? { checked: selected } : { disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.button, filled && styles.buttonOn, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, filled && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, marginBottom: 28 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 16, fontWeight: "700", color: colors.text, marginBottom: 6 },
  pill: { fontSize: 12, fontWeight: "700", color: colors.muted, borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 3 },
  pillOn: { color: "#fff", backgroundColor: colors.checkedIn, borderColor: colors.checkedIn },
  text: { color: colors.text, fontSize: 14, lineHeight: 22, marginTop: 4 },
  muted: { color: colors.muted, fontSize: 13, marginTop: 6 },
  label: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 6 },
  status: { borderLeftWidth: 4, paddingLeft: 12, paddingVertical: 4, marginTop: 14 },
  statusTitle: { fontWeight: "700", fontSize: 14 },
  notice: { backgroundColor: colors.primaryLight, borderRadius: 3, padding: 12, marginTop: 10 },
  error: { color: colors.noShow, marginTop: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: colors.card },
  buttonOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { fontSize: 14, fontWeight: "600", color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 11, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
