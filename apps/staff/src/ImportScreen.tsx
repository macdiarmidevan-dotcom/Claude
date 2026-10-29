import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, ImportResult, ImportRun, ImportSource } from "./api";
import { colors, formatTime, type WebPress } from "./theme";
import { dayParts } from "./dates";
import { SyncCard } from "./SyncCard";

const SOURCES: { id: ImportSource; label: string }[] = [
  { id: "teeitup", label: "TeeItUp" },
  { id: "golfnow", label: "GolfNow" },
  { id: "import", label: "Other / spreadsheet" },
];

const ACTION_LABEL: Record<ImportResult["changes"][number]["action"], string> = {
  create: "New",
  update: "Changed",
  no_show: "No-show",
  cancel: "Cancelled",
  unchanged: "Same",
  skip: "Skipped",
};

/** Opens the browser's file picker and reads the chosen file as text. */
function pickFile(): Promise<{ name: string; text: string } | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,text/csv";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text() } : undefined);
    };
    input.click();
  });
}

/**
 * A manager brings in the tee sheet from the course's booking provider. They choose an
 * export file, see what would change, then import it. Running it again only applies changes.
 */
export function ImportScreen({ client }: { client: Client }) {
  const [source, setSource] = useState<ImportSource>("teeitup");
  const [file, setFile] = useState<{ name?: string; text: string }>();
  const [preview, setPreview] = useState<ImportResult>();
  const [done, setDone] = useState<ImportResult>();
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadRuns = () => client.imports().then(setRuns).catch(() => undefined);
  useEffect(() => {
    loadRuns();
  }, [client]);

  async function check(text: string, name?: string) {
    setFile({ name, text });
    setDone(undefined);
    setError(undefined);
    setBusy(true);
    try {
      setPreview(await client.importTeeSheet({ source, csv: text, fileName: name, dryRun: true }));
    } catch (e) {
      setPreview(undefined);
      setError(e instanceof Error ? e.message : "Couldn't read that file");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setDone(await client.importTeeSheet({ source, csv: file.text, fileName: file.name }));
      setPreview(undefined);
      setFile(undefined);
      loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import didn't go through");
    } finally {
      setBusy(false);
    }
  }

  const result = done ?? preview;
  const changes = result?.changes.filter((c) => c.action !== "unchanged") ?? [];
  const pending = preview ? preview.counts.created + preview.counts.updated + preview.counts.cancelled : 0;

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.lead}>
        Golfers keep booking on your booking site. Their bookings come in here so staff can check groups in, either
        automatically or by uploading an export. Either way, only what changed is applied.
      </Text>

      <SyncCard client={client} onSynced={loadRuns} />

      <Text role="heading" aria-level={2} style={styles.sectionTitle}>Upload a file</Text>

      <Text style={styles.label}>Where the file comes from</Text>
      <View style={styles.choices}>
        {SOURCES.map((s) => (
          <Choice key={s.id} label={s.label} on={source === s.id} onPress={() => setSource(s.id)} />
        ))}
      </View>

      {Platform.OS === "web" ? (
        <Button
          label={busy ? "Reading…" : file ? "Choose a different file" : "Choose export file (.csv)"}
          primary={!file}
          disabled={busy}
          onPress={async () => {
            const picked = await pickFile();
            if (picked) check(picked.text, picked.name);
          }}
        />
      ) : (
        <PasteBox onCheck={(text) => check(text)} busy={busy} />
      )}
      <Text style={styles.help}>
        The file needs columns for the date, tee time and golfer name. Players, holes, price, amount paid, status and
        confirmation number are used when they're there.
      </Text>

      {error && (
        <Text style={styles.error} role="alert">
          {error}
        </Text>
      )}

      {result && (
        <View style={styles.result} accessibilityLiveRegion="polite">
          <Text style={styles.resultTitle} role="heading" aria-level={2}>
            {done ? "Imported" : `What this file would change${file?.name ? ` (${file.name})` : ""}`}
          </Text>
          <Text style={styles.help}>{result.dates.map((d) => dayParts(d).long).join(", ") || "No days found"}</Text>
          <View style={styles.counts}>
            <Count n={result.counts.created} label="new" />
            <Count n={result.counts.updated} label="changed" />
            <Count n={result.counts.cancelled} label="cancelled" />
            <Count n={result.counts.unchanged} label="the same" />
            {result.counts.problems > 0 && <Count n={result.counts.problems} label="couldn't be read" warn />}
          </View>

          {result.overbooked.map((o) => (
            <Text key={o.date + o.time} style={styles.warn}>
              {dayParts(o.date).long} at {formatTime(o.time)} has {o.players} players booked for {o.maxPlayers} spots.
            </Text>
          ))}

          {changes.length > 0 && (
            <View style={styles.table}>
              {changes.map((c) => (
                <View key={c.action + c.externalId} style={styles.change}>
                  <Text style={[styles.tag, c.action === "cancel" && { color: colors.noShow, borderColor: colors.noShow }]}>{ACTION_LABEL[c.action]}</Text>
                  <Text style={styles.changeText}>
                    {formatTime(c.time)} · {c.name} ({c.players}){c.detail ? ` · ${c.detail}` : ""}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {result.problems.length > 0 && (
            <View style={{ marginTop: 12 }}>
              <Text style={styles.label}>Rows we couldn't read</Text>
              {result.problems.map((p) => (
                <Text key={p.line} style={styles.problem}>
                  Line {p.line}: {p.message}
                </Text>
              ))}
            </View>
          )}

          {preview && (
            <Button
              label={busy ? "Importing…" : pending > 0 ? `Import ${pending} ${pending === 1 ? "change" : "changes"}` : "Nothing to import"}
              primary
              disabled={busy || pending === 0}
              onPress={apply}
            />
          )}
        </View>
      )}

      {runs.length > 0 && (
        <View style={{ marginTop: 28 }}>
          <Text style={styles.label}>Recent imports</Text>
          {runs.map((r) => (
            <Text key={r.id} style={styles.run}>
              {new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ·{" "}
              {SOURCES.find((s) => s.id === r.source)?.label} · {r.counts.created} new, {r.counts.updated} changed, {r.counts.cancelled} cancelled
              {r.via === "sync" ? " · automatic sync" : r.fileName ? ` · ${r.fileName}` : ""}
            </Text>
          ))}
        </View>
      )}

    </ScrollView>
  );
}

function PasteBox({ onCheck, busy }: { onCheck: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState("");
  return (
    <View>
      <TextInput
        style={styles.paste}
        value={text}
        onChangeText={setText}
        multiline
        placeholder="Paste the exported CSV here"
        accessibilityLabel="Exported tee sheet CSV"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button label={busy ? "Reading…" : "Check file"} primary disabled={busy || !text.trim()} onPress={() => onCheck(text)} />
    </View>
  );
}

function Count({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <View style={styles.count}>
      <Text style={[styles.countN, warn && { color: colors.noShow }]}>{n}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

function Choice({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.choice, on && styles.choiceOn, focused && styles.focus]}
    >
      <Text style={{ color: on ? "#fff" : colors.text, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function Button({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingBottom: 60, maxWidth: 760 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: "#1c1c1a", marginBottom: 12 },
  lead: { fontSize: 16, lineHeight: 24, color: colors.text, marginBottom: 20 },
  label: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
  help: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 8 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  choice: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 14, minHeight: 44, justifyContent: "center", backgroundColor: colors.card },
  choiceOn: { backgroundColor: colors.green, borderColor: colors.green },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 18, minHeight: 48, justifyContent: "center", alignSelf: "flex-start", backgroundColor: colors.card, marginTop: 4 },
  buttonPrimary: { backgroundColor: colors.green, borderColor: colors.green },
  buttonText: { fontSize: 16, fontWeight: "600", color: colors.text },
  paste: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, minHeight: 160, fontSize: 14, backgroundColor: colors.card, color: colors.text, marginBottom: 10, textAlignVertical: "top" },
  error: { color: colors.noShow, backgroundColor: "#fbebeb", padding: 12, borderRadius: 8, marginTop: 14 },
  result: { marginTop: 20, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 18 },
  resultTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  counts: { flexDirection: "row", flexWrap: "wrap", gap: 22, marginVertical: 14 },
  count: { alignItems: "flex-start" },
  countN: { fontSize: 26, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  countLabel: { fontSize: 13, color: colors.muted },
  warn: { color: colors.warn, fontSize: 14, marginBottom: 6 },
  table: { borderTopWidth: 1, borderColor: colors.border, marginTop: 4, marginBottom: 12 },
  change: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  tag: { fontSize: 12, fontWeight: "700", color: colors.greenText, borderWidth: 1, borderColor: colors.greenText, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, minWidth: 76, textAlign: "center" },
  changeText: { flex: 1, fontSize: 14, color: colors.text },
  problem: { fontSize: 14, color: colors.noShow, marginBottom: 4 },
  run: { fontSize: 14, color: colors.text, marginBottom: 6 },
});
