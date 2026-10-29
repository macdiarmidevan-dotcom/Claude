import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { CardPayment, CardTerminal, Client, PaymentSettings, ProcessorId } from "./api";
import { colors, money, type WebPress } from "./theme";

// Card readers. On a standalone terminal (where every course starts) staff run the card on the
// course's own machine and the app only records it. Once a manager connects a processor and adds
// readers, each device picks the reader next to it, and taking a card payment sends the amount
// to that reader and waits for the golfer to tap, dip or swipe.

interface ReaderState {
  settings?: PaymentSettings;
  /** This device's reader, when cards go through a connected processor. */
  terminal?: CardTerminal;
  /** Connected, but this device hasn't picked a reader yet. */
  needsReader: boolean;
  reload: () => void;
}

const ReaderContext = createContext<ReaderState>({ needsReader: false, reload: () => undefined });
export const useCardReader = () => useContext(ReaderContext);

export function CardReaderProvider({ client, terminalId, children }: { client: Client; terminalId?: string; children: React.ReactNode }) {
  const [settings, setSettings] = useState<PaymentSettings>();
  const [terminals, setTerminals] = useState<CardTerminal[]>([]);
  const load = useCallback(() => {
    client.paymentSettings().then(setSettings).catch(() => undefined);
    client.terminals().then(setTerminals).catch(() => undefined);
  }, [client]);
  useEffect(load, [load]);
  const active = terminals.filter((t) => t.active);
  // With only one reader there's nothing to choose.
  const terminal = settings?.connected ? (active.find((t) => t.id === terminalId) ?? (active.length === 1 ? active[0] : undefined)) : undefined;
  return (
    <ReaderContext.Provider value={{ settings, terminal, needsReader: !!settings?.connected && !terminal, reload: load }}>{children}</ReaderContext.Provider>
  );
}

const POLL_MS = 1500;

/**
 * "Waiting for card": sends the amount to the reader and checks until the card goes through,
 * is declined, or staff cancel. onPaid gets the card payment to finish the check-in or sale with.
 */
export function CardChargeModal({
  client,
  terminal,
  amountCents,
  description,
  onPaid,
  onClose,
}: {
  client: Client;
  terminal: CardTerminal;
  amountCents: number;
  description: string;
  onPaid: (payment: CardPayment) => void;
  onClose: () => void;
}) {
  const [payment, setPayment] = useState<CardPayment>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const done = useRef(false);
  const latest = useRef({ onPaid });
  latest.current = { onPaid };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPayment(undefined);
    setError(undefined);
    const poll = async (id: string) => {
      if (stopped) return;
      try {
        const p = await client.cardPayment(id);
        if (stopped) return;
        setPayment(p);
        if (p.status === "succeeded" && !done.current) {
          done.current = true;
          latest.current.onPaid(p);
          return;
        }
        if (p.status === "processing") timer = setTimeout(() => poll(id), POLL_MS);
      } catch (e) {
        // A dropped connection shouldn't lose a card that went through: keep checking.
        timer = setTimeout(() => poll(id), POLL_MS * 2);
      }
    };
    client
      .startCardPayment({ terminalId: terminal.id, amountCents, description })
      .then((p) => {
        if (stopped) return;
        setPayment(p);
        timer = setTimeout(() => poll(p.id), POLL_MS);
      })
      .catch((e) => !stopped && setError(e instanceof Error ? e.message : "The reader didn't respond"));
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, terminal.id, amountCents, description, attempt]);

  async function cancel() {
    if (payment?.status === "processing") {
      const after = await client.cancelCardPayment(payment.id).catch(() => undefined);
      // The card can go through just as staff press cancel; then it's paid, not cancelled.
      if (after?.status === "succeeded" && !done.current) {
        done.current = true;
        return onPaid(after);
      }
    }
    onClose();
  }

  const failed = error ?? (payment?.status === "failed" ? (payment.failureMessage ?? "The card was declined") : payment?.status === "cancelled" ? "Cancelled on the reader" : undefined);
  return (
    <Modal transparent animationType="fade" visible onRequestClose={cancel}>
      <View style={styles.backdrop}>
        <View style={styles.card} role="dialog" aria-label="Card payment" accessibilityLiveRegion="polite">
          <Text style={styles.amount}>{money(amountCents)}</Text>
          {failed ? (
            <>
              <Text style={styles.failed} role="alert">
                {failed}
              </Text>
              <View style={styles.row}>
                <Button
                  label="Try again"
                  primary
                  onPress={() => {
                    done.current = false;
                    setAttempt((n) => n + 1);
                  }}
                />
                <Button label="Back" onPress={onClose} />
              </View>
            </>
          ) : payment?.status === "succeeded" ? (
            <Text style={styles.ok}>
              ✓ Approved{payment.cardBrand ? ` · ${payment.cardBrand.replace(/_/g, " ")}` : ""}
              {payment.cardLast4 ? ` ····${payment.cardLast4}` : ""}
              {payment.tipCents ? ` · tip ${money(payment.tipCents)}` : ""}
            </Text>
          ) : (
            <>
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
              <Text style={styles.waiting}>{payment ? `Waiting for the card on ${terminal.name}…` : `Sending to ${terminal.name}…`}</Text>
              <Text style={styles.help}>The golfer taps, inserts or swipes on the reader.</Text>
              <View style={styles.row}>
                <Button label="Cancel" onPress={cancel} />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** Settings: how this course takes cards, its readers, and which reader this device uses. */
export function CardPaymentSettings({
  client,
  isManager,
  terminalId,
  onPickTerminal,
}: {
  client: Client;
  isManager: boolean;
  terminalId?: string;
  onPickTerminal: (id: string | undefined) => void;
}) {
  const { reload: reloadReader } = useCardReader();
  const [settings, setSettings] = useState<PaymentSettings>();
  const [terminals, setTerminals] = useState<CardTerminal[]>([]);
  const [provider, setProvider] = useState<ProcessorId>("standalone");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [tipping, setTipping] = useState(false);
  const [found, setFound] = useState<{ readerId: string; label: string; online: boolean | null }[]>();
  const [adding, setAdding] = useState<{ readerId: string; name: string; location: string }>();
  const [message, setMessage] = useState<{ text: string; bad?: boolean }>();

  const load = useCallback(async () => {
    const s = await client.paymentSettings();
    setSettings(s);
    setProvider(s.provider);
    setFields({ ...s.account });
    setTipping(s.tipping);
    setTerminals(await client.terminals());
  }, [client]);
  useEffect(() => {
    load().catch((e) => setMessage({ text: e instanceof Error ? e.message : "Couldn't load card settings", bad: true }));
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMessage(undefined);
    try {
      await fn();
      if (ok) setMessage({ text: ok });
      await load();
      reloadReader();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "That didn't work", bad: true });
    }
  };

  if (!settings) return <ActivityIndicator color={colors.primary} style={{ alignSelf: "flex-start" }} />;
  const current = settings.providers.find((p) => p.id === settings.provider)!;
  const chosen = settings.providers.find((p) => p.id === provider)!;
  const active = terminals.filter((t) => t.active);

  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.help}>
        {current.connected
          ? `Cards go through ${current.name}. Taking a card payment sends the amount to a reader.`
          : "Cards are run on the course's own terminal, and the register records them."}
      </Text>

      {current.connected && (
        <>
          <Text style={styles.sub}>This device's card reader</Text>
          {active.length === 0 ? (
            <Text style={styles.help}>{isManager ? "Add the course's readers below." : "A manager needs to add the course's card readers."}</Text>
          ) : (
            <View style={styles.chips}>
              {active.map((t) => (
                <Chip key={t.id} label={`${t.name}${t.location ? ` · ${t.location}` : ""}`} on={t.id === terminalId || (active.length === 1 && !terminalId)} onPress={() => onPickTerminal(t.id)} />
              ))}
            </View>
          )}
        </>
      )}

      {isManager && (
        <>
          <Text style={styles.sub}>Card processor</Text>
          <View style={styles.chips}>
            {settings.providers.map((p) => (
              <Chip
                key={p.id}
                label={p.name}
                on={provider === p.id}
                onPress={() => {
                  setProvider(p.id);
                  setFields(p.id === settings.provider ? { ...settings.account } : {});
                }}
              />
            ))}
          </View>
          {chosen.fields.map((f) => (
            <View key={f.key}>
              <Text style={styles.fieldLabel}>
                {f.label}
                {f.required ? "" : " (optional)"}
              </Text>
              <TextInput
                accessibilityLabel={f.label}
                style={styles.input}
                secureTextEntry={f.secret}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={f.secret && settings.hasCredentials && provider === settings.provider ? "Saved. Type to replace it" : ""}
                value={fields[f.key] ?? ""}
                onChangeText={(v) => setFields((x) => ({ ...x, [f.key]: v }))}
              />
              {f.help && <Text style={styles.small}>{f.help}</Text>}
            </View>
          ))}
          {chosen.connected && (
            <View style={[styles.row, { alignItems: "center" }]}>
              <Switch value={tipping} onValueChange={setTipping} accessibilityLabel="Ask for a tip on the reader" />
              <Text style={styles.text}>Ask for a tip on the reader</Text>
            </View>
          )}
          <View style={styles.row}>
            <Button
              label="Save"
              primary
              onPress={() => {
                const account: Record<string, string> = {};
                const credentials: Record<string, string> = {};
                for (const f of chosen.fields) if (fields[f.key]?.trim()) (f.secret ? credentials : account)[f.key] = fields[f.key]!.trim();
                run(() => client.savePaymentSettings({ provider, account, credentials, tipping }), "Saved");
              }}
            />
            {current.connected && provider === settings.provider && (
              <Button
                label="Find readers"
                onPress={() =>
                  run(async () => {
                    setFound(await client.discoverReaders());
                  })
                }
              />
            )}
          </View>

          {found && provider === settings.provider && (
            <View style={styles.box}>
              {found.length === 0 && <Text style={styles.help}>{current.name} didn't list any readers. Pair one with your processor first, or type its id below.</Text>}
              {found.map((r) => {
                const added = terminals.some((t) => t.readerId === r.readerId);
                return (
                  <View key={r.readerId} style={styles.rowBetween}>
                    <Text style={styles.text}>
                      {r.label} · {r.readerId}
                      {r.online === false ? " · offline" : ""}
                    </Text>
                    {added ? (
                      <Text style={styles.small}>Added</Text>
                    ) : (
                      <Button label="Add" onPress={() => setAdding({ readerId: r.readerId, name: r.label, location: "" })} />
                    )}
                  </View>
                );
              })}
              <Pressable accessibilityRole="button" onPress={() => setAdding({ readerId: "", name: "", location: "" })}>
                <Text style={styles.link}>+ Add a reader by its id</Text>
              </Pressable>
            </View>
          )}

          {adding && (
            <View style={styles.box}>
              <Text style={styles.fieldLabel}>Reader id</Text>
              <TextInput accessibilityLabel="Reader id" style={styles.input} autoCapitalize="none" value={adding.readerId} onChangeText={(v) => setAdding({ ...adding, readerId: v })} />
              <Text style={styles.fieldLabel}>Name staff will see</Text>
              <TextInput accessibilityLabel="Reader name" style={styles.input} placeholder="e.g. Pro shop counter" value={adding.name} onChangeText={(v) => setAdding({ ...adding, name: v })} />
              <Text style={styles.fieldLabel}>Where it is (optional)</Text>
              <TextInput accessibilityLabel="Reader location" style={styles.input} placeholder="Pro shop, Bar, Halfway house" value={adding.location} onChangeText={(v) => setAdding({ ...adding, location: v })} />
              <View style={styles.row}>
                <Button
                  label="Add reader"
                  primary
                  onPress={() =>
                    run(async () => {
                      await client.addTerminal({ readerId: adding.readerId, name: adding.name, location: adding.location || null });
                      setAdding(undefined);
                    }, "Reader added")
                  }
                />
                <Button label="Cancel" onPress={() => setAdding(undefined)} />
              </View>
            </View>
          )}

          {terminals.length > 0 && (
            <>
              <Text style={styles.sub}>Readers</Text>
              {terminals.map((t) => (
                <View key={t.id} style={styles.rowBetween}>
                  <Text style={[styles.text, !t.active && { color: colors.muted }]}>
                    {t.name}
                    {t.location ? ` · ${t.location}` : ""} · {t.readerId}
                    {t.active ? "" : " · turned off"}
                  </Text>
                  <Button label={t.active ? "Turn off" : "Turn on"} onPress={() => run(() => client.updateTerminal(t.id, { active: !t.active }))} />
                </View>
              ))}
            </>
          )}
        </>
      )}
      {message && (
        <Text role={message.bad ? "alert" : "status"} style={[styles.small, { color: message.bad ? colors.noShow : colors.checkedIn }]}>
          {message.text}
        </Text>
      )}
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      role="radio"
      aria-checked={on}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.chip, on && styles.chipOn, focused && styles.focus]}
    >
      <Text style={[styles.chipText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function Button({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, focused && styles.focus]}>
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 16 },
  card: { backgroundColor: colors.card, borderRadius: 3, padding: 24, width: "100%", maxWidth: 380, alignItems: "center" },
  amount: { fontSize: 32, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  waiting: { fontSize: 15, fontWeight: "600", color: colors.text, textAlign: "center" },
  ok: { fontSize: 16, fontWeight: "700", color: colors.checkedIn, marginTop: 12, textAlign: "center" },
  failed: { fontSize: 15, fontWeight: "600", color: colors.noShow, marginTop: 12, textAlign: "center" },
  help: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 12, marginTop: 2 },
  text: { color: colors.text, fontSize: 14, flexShrink: 1 },
  sub: { fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 8 },
  fieldLabel: { fontSize: 13, color: colors.text, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, minHeight: 36, fontSize: 14, backgroundColor: colors.card, color: colors.text },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 12, minHeight: 34, justifyContent: "center", backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text, fontWeight: "600" },
  box: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 12, gap: 8, backgroundColor: colors.card },
  link: { color: colors.primaryText, fontSize: 14, fontWeight: "600" },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: colors.card },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { fontSize: 14, fontWeight: "600", color: colors.text },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
