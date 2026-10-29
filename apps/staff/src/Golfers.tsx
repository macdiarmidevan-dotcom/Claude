import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, GolferAccount, GolferProfile, SheetBooking } from "./api";
import { colors, money, statusLabel, type WebPress } from "./theme";

// Golfer accounts. The first time someone is checked in, the pro shop creates their account with
// their phone and email. Every check-in after that is a name search and one tap, so all their
// rounds land on the same account.

/** Waits a moment after typing stops, so each keystroke isn't its own search. */
export function useSearch(client: Client, q: string) {
  const [results, setResults] = useState<GolferAccount[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(undefined);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      client
        .searchGolfers(q)
        .then((r) => live && (setResults(r), setError(undefined)))
        .catch((e) => live && setError(e.message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, q]);
  return { results, error };
}

/**
 * Shown at the pro shop when a booking isn't on a golfer account yet. Staff search by name and
 * link the right person, or create the account if this is the golfer's first visit.
 */
export function GolferPicker({ client, booking, onLinked, onCancel }: { client: Client; booking: SheetBooking; onLinked: () => void; onCancel: () => void }) {
  const placeholderName = /^(walk-?in|guest)$/i.test(booking.customerName.trim()) ? "" : booking.customerName;
  const [q, setQ] = useState(placeholderName);
  const { results, error: searchError } = useSearch(client, q);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function link(g: GolferAccount) {
    setBusy(true);
    setError(undefined);
    try {
      await client.linkGolfer(booking.id, g.id);
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link the account");
      setBusy(false);
    }
  }

  return (
    <View style={styles.box} accessibilityLiveRegion="polite">
      <Text style={styles.boxTitle}>Which golfer is this?</Text>
      {!creating ? (
        <>
          <Text style={styles.help}>Search by name, phone or email. If it's their first time here, create their account.</Text>
          <TextInput
            accessibilityLabel="Search golfer accounts"
            placeholder="Golfer's name"
            value={q}
            onChangeText={setQ}
            autoCorrect={false}
            autoFocus
            style={styles.input}
          />
          {(searchError || error) && <Text role="alert" style={styles.error}>{searchError ?? error}</Text>}
          {results && results.length === 0 && <Text style={styles.help}>No account matches "{q.trim()}".</Text>}
          {results?.map((g) => (
            <Pressable
              key={g.id}
              accessibilityRole="button"
              accessibilityLabel={`Link ${g.name}, ${g.phone}, ${g.roundsPlayed} rounds`}
              disabled={busy}
              onPress={() => link(g)}
              style={({ hovered, focused }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focusRing]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.resultName}>{g.name}</Text>
                <Text style={styles.meta}>
                  {g.phone} · {g.email}
                </Text>
              </View>
              <Text style={styles.meta}>{rounds(g.roundsPlayed)}</Text>
            </Pressable>
          ))}
          <View style={styles.actions}>
            <Button label="New golfer: create account" primary onPress={() => setCreating(true)} />
            <Button label="Back" onPress={onCancel} />
          </View>
        </>
      ) : (
        <GolferForm
          client={client}
          initialName={placeholderName || q}
          initialPhone={booking.customerPhone ?? ""}
          bookingId={booking.id}
          onSaved={onLinked}
          onCancel={() => setCreating(false)}
        />
      )}
    </View>
  );
}

/** Creates an account (linking the booking when given) or changes an existing one's details. */
function GolferForm(props: {
  client: Client;
  initialName?: string;
  initialPhone?: string;
  bookingId?: string;
  existing?: GolferProfile;
  onSaved: (g: GolferProfile) => void;
  onCancel: () => void;
}) {
  const { client, existing } = props;
  const [name, setName] = useState(existing?.name ?? props.initialName ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? props.initialPhone ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = name.trim() !== "" && phone.replace(/\D/g, "").length >= 10 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const input = { name: name.trim(), phone: phone.trim(), email: email.trim() };
      props.onSaved(existing ? await client.updateGolfer(existing.id, input) : await client.createGolfer({ ...input, bookingId: props.bookingId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the account");
      setBusy(false);
    }
  }

  return (
    <View>
      <Field label="Full name" value={name} onChangeText={setName} autoCapitalize="words" autoComplete="name" />
      <Field label="Mobile phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="(630) 555-0100" />
      <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
      <Text style={styles.help}>Each phone number and email can only belong to one golfer.</Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Button
          label={busy ? "Saving…" : existing ? "Save changes" : props.bookingId ? "Create account and link" : "Create account"}
          primary
          disabled={busy || !ready}
          onPress={save}
        />
        <Button label="Cancel" disabled={busy} onPress={props.onCancel} />
      </View>
    </View>
  );
}

/** The Customers section: find any golfer and see their rounds. */
export function GolfersScreen({ client, openId, onOpenBooking }: { client: Client; openId?: string; onOpenBooking?: OpenBooking }) {
  const [q, setQ] = useState("");
  const { results, error } = useSearch(client, q);
  const [open, setOpen] = useState<string | undefined>(openId);
  const [adding, setAdding] = useState(false);
  useEffect(() => setOpen(openId), [openId]);

  if (open) return <GolferDetail client={client} id={open} onBack={() => setOpen(undefined)} onOpenBooking={onOpenBooking} />;

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.help}>
        Golfer accounts are created at the pro shop the first time someone checks in. Search to see a golfer's rounds, no-shows and contact details.
      </Text>
      <TextInput
        accessibilityLabel="Search golfers"
        placeholder="Search by name, phone or email"
        value={q}
        onChangeText={setQ}
        autoCorrect={false}
        style={[styles.input, { maxWidth: 480 }]}
      />
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {results && results.length === 0 && <Text style={styles.help}>No golfer matches "{q.trim()}".</Text>}
      <View style={{ maxWidth: 720 }}>
        {results?.map((g) => (
          <Pressable
            key={g.id}
            accessibilityRole="link"
            onPress={() => setOpen(g.id)}
            style={({ hovered, focused }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focusRing]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.resultName}>{g.name}</Text>
              <Text style={styles.meta}>
                {g.phone} · {g.email}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.meta}>{rounds(g.roundsPlayed)}</Text>
              {g.lastPlayed && <Text style={styles.meta}>Last {day(g.lastPlayed)}</Text>}
            </View>
          </Pressable>
        ))}
      </View>
      <View style={[styles.box, { maxWidth: 480, marginTop: 20 }]}>
        {adding ? (
          <GolferForm client={client} onSaved={(g) => setOpen(g.id)} onCancel={() => setAdding(false)} />
        ) : (
          <>
            <Text style={styles.help}>Signing up a golfer before their first round, for a punch card or league?</Text>
            <Button label="Create a golfer account" onPress={() => setAdding(true)} />
          </>
        )}
      </View>
    </ScrollView>
  );
}

/** Opens the tee sheet at a booking. */
export type OpenBooking = (booking: { bookingId: string; startsAt: string }) => void;

/** One golfer's account: totals, contact details and every booking, newest first. */
export function GolferDetail({ client, id, onBack, onOpenBooking }: { client: Client; id: string; onBack?: () => void; onOpenBooking?: OpenBooking }) {
  const [g, setG] = useState<GolferProfile>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    client.golfer(id).then(setG).catch((e) => setError(e.message));
  }, [client, id]);

  if (!g) return error ? <Text role="alert" style={[styles.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {onBack && (
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8} style={{ marginBottom: 12 }}>
          <Text style={styles.link}>‹ All golfers</Text>
        </Pressable>
      )}
      <Text role="heading" style={styles.h1}>{g.name}</Text>
      {editing ? (
        <View style={[styles.box, { maxWidth: 480 }]}>
          <GolferForm
            client={client}
            existing={g}
            onSaved={(updated) => {
              setG(updated);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </View>
      ) : (
        <View style={styles.contact}>
          <Text style={styles.meta}>
            {g.phone} · {g.email}
          </Text>
          <Text style={styles.meta}>
            Account created {day(g.createdAt)}
            {g.createdBy ? ` by ${g.createdBy}` : ""}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setEditing(true)} hitSlop={8}>
            <Text style={styles.link}>Edit contact details</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.stats}>
        <Stat label="Rounds played" value={String(g.stats.roundsPlayed)} />
        <Stat label="Holes played" value={String(g.stats.holesPlayed)} />
        <Stat label="Upcoming" value={String(g.stats.upcoming)} />
        <Stat label="No-shows" value={String(g.stats.noShows)} warn={g.stats.noShows > 0} />
        <Stat label="Guests brought" value={String(g.stats.guestsBrought)} />
        <Stat label="Own spend" value={money(g.stats.paidCents)} />
      </View>

      <Text role="heading" style={styles.h2}>Rounds and bookings</Text>
      {g.history.length === 0 ? (
        <Text style={styles.help}>No bookings yet.</Text>
      ) : (
        <View style={{ maxWidth: 820 }}>
          {onOpenBooking && <Text style={styles.help}>Tap a round to see it on the tee sheet.</Text>}
          {g.history.map((h) => (
            <Pressable
              key={h.bookingId}
              accessibilityRole="link"
              accessibilityLabel={`${dateTime(h.startsAt)}, ${h.holes} holes. Open on the tee sheet`}
              disabled={!onOpenBooking || h.bookingId.startsWith("past-")}
              onPress={() => onOpenBooking?.(h)}
              style={({ hovered, focused }: WebPress) => [styles.historyRow, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focusRing]}
            >
              <Text style={[styles.historyCell, { width: 230 }]}>{dateTime(h.startsAt)}</Text>
              <Text style={[styles.historyCell, { flex: 1, minWidth: 140 }]}>
                {h.holes} holes · {h.guests ? `with ${h.guests} ${h.guests === 1 ? "guest" : "guests"}` : "alone"}
              </Text>
              <Text style={[styles.historyCell, { width: 130 }, h.status === "no_show" && { color: colors.noShow }]}>
                {h.status === "teed_off" || h.status === "checked_in" ? "Played" : statusLabel[h.status]}
              </Text>
              <Text style={[styles.historyCell, { width: 80, textAlign: "right" }]}>{money(h.paidCents)}</Text>
              {onOpenBooking && <Text style={[styles.historyCell, { color: colors.primary }]} aria-hidden>›</Text>}
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, warn && { color: colors.noShow }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} autoCorrect={false} style={styles.input} {...input} />
    </View>
  );
}

function Button({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, disabled && { opacity: 0.5 }, focused && styles.focusRing]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

export const rounds = (n: number) => `${n} ${n === 1 ? "round" : "rounds"}`;
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

const styles = StyleSheet.create({
  page: { padding: 16 },
  box: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, marginTop: 10, backgroundColor: colors.bg },
  boxTitle: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 6 },
  help: { color: colors.muted, fontSize: 13, lineHeight: 20, marginBottom: 10 },
  error: { color: colors.noShow, marginVertical: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 11, fontSize: 14, color: colors.text, backgroundColor: "#fff", marginBottom: 8 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  result: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, minHeight: 44, borderRadius: 3, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff", marginBottom: 6 },
  resultName: { fontSize: 14, fontWeight: "700", color: colors.text },
  meta: { color: colors.muted, fontSize: 13 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  link: { color: colors.primary, fontWeight: "600", textDecorationLine: "underline", fontSize: 14 },
  h1: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 6 },
  h2: { fontSize: 16, fontWeight: "700", color: colors.text, marginTop: 24, marginBottom: 8 },
  contact: { gap: 4 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 18 },
  stat: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingVertical: 8, paddingHorizontal: 12, minWidth: 120 },
  statValue: { fontSize: 20, fontWeight: "700", color: colors.text },
  statLabel: { color: colors.muted, fontSize: 12, marginTop: 2 },
  historyRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border },
  historyCell: { color: colors.text, fontSize: 13 },
  focusRing: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
