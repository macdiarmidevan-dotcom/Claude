import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, EventDay, EventDetail, EventFormat, EventKind, EventPaymentMethod, EventSummary, GolferAccount, HoldConflict, StandingTime } from "./api";
import { CardChargeModal, useCardReader } from "./CardReader";
import { addDays, todayIn } from "./dates";
import { useSearch } from "./Golfers";
import { colors, formatTime, money, type WebPress } from "./theme";

// Leagues, outings and standing tee times. Managers set them up; the pro shop runs the day: who's
// playing with whom, check-in, and taking the group's payment.

type Tab = "events" | "standing";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PAY_METHODS: { method: EventPaymentMethod; label: string }[] = [
  { method: "card", label: "Card" },
  { method: "cash", label: "Cash" },
  { method: "check", label: "Check" },
  { method: "gift_card", label: "Gift card" },
  { method: "comp", label: "Comp" },
];

const parseCents = (text: string) => {
  const clean = text.replace(/[$,\s]/g, "");
  return /^-?\d+(\.\d{0,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
};
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const weekdayOf = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

export function EventsScreen({ client, isManager, timeZone, courseHoles }: { client: Client; isManager: boolean; timeZone: string; courseHoles: number }) {
  const [tab, setTab] = useState<Tab>("events");
  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={styles.tabs}>
        {(
          [
            ["events", "Leagues & outings"],
            ["standing", "Standing tee times"],
          ] as const
        ).map(([id, label]) => (
          <Pressable key={id} role="tab" aria-selected={tab === id} onPress={() => setTab(id)} style={({ focused }: WebPress) => [styles.tab, tab === id && styles.tabOn, focused && styles.focus]}>
            <Text style={[styles.tabText, tab === id && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "events" ? (
        <Events client={client} isManager={isManager} timeZone={timeZone} courseHoles={courseHoles} />
      ) : (
        <StandingTimes client={client} isManager={isManager} timeZone={timeZone} courseHoles={courseHoles} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Leagues and outings

function Events({ client, isManager, timeZone, courseHoles }: { client: Client; isManager: boolean; timeZone: string; courseHoles: number }) {
  const [list, setList] = useState<EventSummary[]>();
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [conflicts, setConflicts] = useState<HoldConflict[]>([]);
  const [error, setError] = useState<string>();
  const load = () => client.events().then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [client]);

  if (open) return <EventView client={client} id={open} isManager={isManager} conflicts={conflicts} onBack={() => (setOpen(undefined), setConflicts([]), load())} />;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {isManager &&
        (adding ? (
          <NewEventForm
            client={client}
            timeZone={timeZone}
            courseHoles={courseHoles}
            onClose={() => setAdding(false)}
            onCreated={(id, c) => {
              setAdding(false);
              setConflicts(c);
              setOpen(id);
            }}
          />
        ) : (
          <Button label="New league or outing" primary onPress={() => setAdding(true)} />
        ))}
      {!list ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : list.length === 0 ? (
        <Text style={[styles.help, { marginTop: 12 }]}>No leagues or outings yet.</Text>
      ) : (
        <View style={{ marginTop: 12 }}>
          {list.map((e) => (
            <Pressable
              key={e.id}
              accessibilityRole="button"
              onPress={() => setOpen(e.id)}
              style={({ hovered, focused }: WebPress) => [styles.listRow, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
            >
              <View style={{ flex: 1, minWidth: 200 }}>
                <Text style={[styles.strong, !e.active && { color: colors.muted }]}>{e.name}</Text>
                <Text style={styles.help}>
                  {e.kind === "league" ? "League" : "Outing"} · {e.format === "shotgun" ? "Shotgun" : "Tee times"} · {e.players} {e.players === 1 ? "player" : "players"} · {money(e.pricePerPlayerCents)} a player
                </Text>
              </View>
              <Text style={styles.help}>{e.nextDate ? `Next: ${shortDate(e.nextDate)}` : "No dates left"}</Text>
              <Text style={{ color: colors.primary }} aria-hidden>
                ›
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function NewEventForm({
  client,
  timeZone,
  courseHoles,
  onClose,
  onCreated,
}: {
  client: Client;
  timeZone: string;
  courseHoles: number;
  onClose: () => void;
  onCreated: (id: string, conflicts: HoldConflict[]) => void;
}) {
  const today = todayIn(timeZone);
  const [kind, setKind] = useState<EventKind>("league");
  const [format, setFormat] = useState<EventFormat>("tee_times");
  const [name, setName] = useState("");
  const [holes, setHoles] = useState(courseHoles);
  const [price, setPrice] = useState("");
  const [cart, setCart] = useState(false);
  const [startsOn, setStartsOn] = useState(addDays(today, 7));
  const [endsOn, setEndsOn] = useState(addDays(today, 7 + 7 * 11));
  const [startTime, setStartTime] = useState("16:30");
  const [slots, setSlots] = useState("6");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const priceCents = parseCents(price);
  const n = /^\d+$/.test(slots) ? Number(slots) : 0;
  const valid = name.trim() && priceCents !== undefined && priceCents >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(startsOn) && /^\d{2}:\d{2}$/.test(startTime) && n > 0;

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await client.addEvent({
        name: name.trim(),
        kind,
        format,
        holes,
        pricePerPlayerCents: priceCents!,
        includesCart: cart,
        contactName: contact.trim() || null,
        contactPhone: phone.trim() || null,
        schedule: { startsOn, endsOn: kind === "league" ? endsOn : null, startTime, slots: n },
      });
      onCreated(r.event.id, r.conflicts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text role="heading" aria-level={2} style={styles.title}>
        New league or outing
      </Text>
      <View style={styles.row}>
        <Chip label="Weekly league" on={kind === "league"} onPress={() => setKind("league")} />
        <Chip label="One-day outing" on={kind === "outing"} onPress={() => setKind("outing")} />
      </View>
      <View style={styles.row}>
        <Chip label="One group per tee time" on={format === "tee_times"} onPress={() => setFormat("tee_times")} />
        <Chip label="Shotgun start" on={format === "shotgun"} onPress={() => setFormat("shotgun")} />
      </View>
      <View style={styles.row}>
        <Field label="Name" value={name} onChangeText={setName} placeholder={kind === "league" ? "Tuesday Men's League" : "Chamber of Commerce Outing"} />
        <Field label="Price per player, $" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="25.00" />
      </View>
      <View style={styles.row}>
        {[courseHoles, courseHoles * 2].map((h) => (
          <Chip key={h} label={`${h} holes`} on={holes === h} onPress={() => setHoles(h)} />
        ))}
        <Chip label="Cart included" on={cart} onPress={() => setCart(!cart)} />
      </View>
      <View style={styles.row}>
        <Field label={kind === "league" ? "First night (YYYY-MM-DD)" : "Date (YYYY-MM-DD)"} value={startsOn} onChangeText={setStartsOn} />
        {kind === "league" && <Field label="Last night" value={endsOn} onChangeText={setEndsOn} />}
        <Field label="First tee time (HH:MM)" value={startTime} onChangeText={setStartTime} />
        <Field label={format === "shotgun" ? "Tee times to hold (the shotgun window)" : "Tee times to hold"} value={slots} onChangeText={setSlots} keyboardType="number-pad" />
      </View>
      {kind === "league" && /^\d{4}-\d{2}-\d{2}$/.test(startsOn) && <Text style={styles.help}>Every {WEEKDAYS[weekdayOf(startsOn) - 1]} from the first night to the last.</Text>}
      <View style={styles.row}>
        <Field label="Contact name" value={contact} onChangeText={setContact} placeholder="Who the bill goes to" />
        <Field label="Contact phone" value={phone} onChangeText={setPhone} />
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <Button label={busy ? "Saving…" : "Create and hold tee times"} primary disabled={!valid || busy} onPress={save} />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

function EventView({ client, id, isManager, conflicts, onBack }: { client: Client; id: string; isManager: boolean; conflicts: HoldConflict[]; onBack: () => void }) {
  const [ev, setEv] = useState<EventDetail>();
  const [day, setDay] = useState<string>();
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState(conflicts);
  const load = () => client.event(id).then(setEv).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [client, id]);
  async function run(fn: () => Promise<EventDetail | void>) {
    setError(undefined);
    try {
      const r = await fn();
      if (r) setEv(r);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    }
  }

  if (!ev) return error ? <Text role="alert" style={[styles.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />;
  if (day) return <DayView client={client} dateId={day} isManager={isManager} onBack={() => (setDay(undefined), load())} onCancelled={(e) => (setEv(e), setDay(undefined))} />;
  const upcoming = ev.dates.filter((d) => d.status === "scheduled");
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8} style={{ marginBottom: 10 }}>
        <Text style={styles.link}>‹ Leagues & outings</Text>
      </Pressable>
      <Text role="heading" style={styles.h1}>
        {ev.name}
      </Text>
      <Text style={styles.help}>
        {ev.kind === "league" ? "League" : "Outing"} · {ev.format === "shotgun" ? "Shotgun start" : "One group per tee time"} · {ev.holes} holes · {money(ev.pricePerPlayerCents)} a player
        {ev.includesCart ? ", cart included" : ""}
        {ev.contactName ? ` · Bill to ${ev.contactName}${ev.contactPhone ? `, ${ev.contactPhone}` : ""}` : ""}
      </Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {shown.length > 0 && (
        <View style={[styles.card, { borderColor: colors.warn }]}>
          <Text style={styles.strong}>Some tee times couldn't be held because golfers are already booked:</Text>
          {shown.map((c, i) => (
            <Text key={i} style={styles.help}>
              {shortDate(c.date)} {formatTime(c.localTime)}: {c.detail}
            </Text>
          ))}
          <Text style={styles.help}>Move those golfers on the tee sheet, or play the event around them.</Text>
          <Button label="OK" onPress={() => setShown([])} />
        </View>
      )}

      <View style={styles.cols}>
        <View style={[styles.card, styles.col]}>
          <Text style={styles.title}>Dates</Text>
          {ev.dates.map((d) => (
            <Pressable
              key={d.id}
              accessibilityRole="button"
              disabled={d.status === "cancelled"}
              onPress={() => setDay(d.id)}
              style={({ hovered, focused }: WebPress) => [styles.line, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.strong, d.status === "cancelled" && { color: colors.muted, textDecorationLine: "line-through" }]}>
                  {shortDate(d.date)} · {formatTime(d.startTime)}
                </Text>
                <Text style={styles.help}>
                  {d.status === "cancelled"
                    ? "Cancelled"
                    : `${d.held} of ${d.slots} tee times held · ${d.paired ? `${d.paired} in groups` : "not paired yet"}${d.chargeCents ? ` · ${money(d.chargeCents)}` : ""}`}
                </Text>
              </View>
              {d.status === "scheduled" && <Text style={{ color: colors.primary }}>›</Text>}
            </Pressable>
          ))}
          {isManager && upcoming.length > 0 && <AddDate client={client} ev={ev} onAdded={(e, c) => (setEv(e), setShown(c))} />}
        </View>

        <View style={[styles.card, styles.col]}>
          <Text style={styles.title}>Players ({ev.players.length})</Text>
          {ev.players.map((p) => (
            <View key={p.id} style={styles.line}>
              <Text style={[styles.text, { flex: 1 }]}>
                {p.name}
                {p.handicap !== null ? <Text style={styles.help}> · {p.handicap} hcp</Text> : null}
                {p.golferId ? <Text style={styles.help}> · on account</Text> : null}
              </Text>
              <SmallButton label="Remove" onPress={() => run(() => client.removeEventPlayer(ev.id, p.id))} />
            </View>
          ))}
          <AddPlayer client={client} onAdd={(p) => run(() => client.addEventPlayer(ev.id, p))} />
        </View>
      </View>

      <Billing client={client} ev={ev} isManager={isManager} onChanged={setEv} />
    </ScrollView>
  );
}

function AddDate({ client, ev, onAdded }: { client: Client; ev: EventDetail; onAdded: (e: EventDetail, c: HoldConflict[]) => void }) {
  const last = ev.dates[ev.dates.length - 1];
  const [date, setDate] = useState(last ? addDays(last.date, 7) : "");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  if (!open) return <SmallButton label="Add a date" onPress={() => setOpen(true)} />;
  return (
    <View style={[styles.row, { marginTop: 8, alignItems: "flex-end" }]}>
      <Field label="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} />
      <Button
        label="Add"
        primary
        onPress={() =>
          client
            .addEventDate(ev.id, { date, startTime: last?.startTime ?? "08:00", slots: last?.slots ?? 4 })
            .then((r) => (onAdded(r.event, r.conflicts), setOpen(false)))
            .catch((e) => setError(e.message))
        }
      />
      <Button label="Cancel" onPress={() => setOpen(false)} />
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
    </View>
  );
}

function AddPlayer({ client, onAdd }: { client: Client; onAdd: (p: { name?: string; golferId?: string; handicap?: number | null }) => Promise<boolean> }) {
  const [q, setQ] = useState("");
  const [hcp, setHcp] = useState("");
  const { results } = useSearch(client, q);
  const handicap = /^-?\d+(\.\d)?$/.test(hcp.trim()) ? Number(hcp.trim()) : null;
  const add = (p: { name?: string; golferId?: string }) => onAdd({ ...p, handicap }).then((ok) => ok && (setQ(""), setHcp("")));
  return (
    <View style={{ marginTop: 10 }}>
      <View style={styles.row}>
        <TextInput accessibilityLabel="Player's name" placeholder="Add a player: name, or search golfer accounts" value={q} onChangeText={setQ} style={[styles.input, { flex: 1, minWidth: 200 }]} />
        <TextInput accessibilityLabel="Handicap" placeholder="Hcp" value={hcp} onChangeText={setHcp} keyboardType="decimal-pad" style={[styles.input, { width: 70 }]} />
      </View>
      {results?.slice(0, 4).map((g: GolferAccount) => (
        <Pressable key={g.id} accessibilityRole="button" onPress={() => add({ golferId: g.id })} style={({ hovered }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }]}>
          <Text style={styles.text}>
            {g.name} <Text style={styles.help}>· {g.phone}</Text>
          </Text>
        </Pressable>
      ))}
      {q.trim().length > 1 && <SmallButton label={`Add "${q.trim()}" without an account`} onPress={() => add({ name: q.trim() })} />}
    </View>
  );
}

function Billing({ client, ev, isManager, onChanged }: { client: Client; ev: EventDetail; isManager: boolean; onChanged: (e: EventDetail) => void }) {
  const b = ev.billing;
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<EventPaymentMethod>("check");
  const [note, setNote] = useState("");
  const [dateId, setDateId] = useState<string | null>(null);
  const [charging, setCharging] = useState(false);
  const [error, setError] = useState<string>();
  const reader = useCardReader();
  const cents = parseCents(amount) ?? (amount.trim() ? undefined : b.balanceCents > 0 ? b.balanceCents : undefined);

  async function pay(cardPaymentId?: string) {
    setError(undefined);
    try {
      onChanged(await client.addEventPayment(ev.id, { amountCents: cents!, method, eventDateId: dateId, note: note.trim() || null, ...(cardPaymentId ? { cardPaymentId } : {}) }));
      setAmount("");
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't take the payment");
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Billing</Text>
      <Text style={styles.help}>The group pays as one account: players who checked in (or are in a group, before check-in starts) times {money(ev.pricePerPlayerCents)}.</Text>
      <View style={[styles.row, { marginTop: 8 }]}>
        <Stat label="Charged so far" value={money(b.chargedCents)} />
        <Stat label="Paid" value={money(b.paidCents)} />
        <Stat label={b.balanceCents < 0 ? "Paid ahead" : "Balance"} value={money(Math.abs(b.balanceCents))} warn={b.balanceCents > 0} />
      </View>
      <View style={[styles.row, { marginTop: 10 }]}>
        {PAY_METHODS.map((m) => (
          <Chip key={m.method} label={m.label} on={method === m.method} onPress={() => setMethod(m.method)} />
        ))}
      </View>
      <View style={styles.row}>
        <Chip label="Whole season / account" on={dateId === null} onPress={() => setDateId(null)} />
        {ev.dates
          .filter((d) => d.status === "scheduled" && d.chargeCents > 0)
          .map((d) => (
            <Chip key={d.id} label={`${shortDate(d.date)} · ${money(d.chargeCents)}`} on={dateId === d.id} onPress={() => (setDateId(d.id), setAmount((d.chargeCents / 100).toFixed(2)))} />
          ))}
      </View>
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Amount"
          placeholder={b.balanceCents > 0 ? `Amount (balance ${money(b.balanceCents)})` : "Amount"}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          style={[styles.input, { width: 200 }]}
        />
        <TextInput accessibilityLabel="Note" placeholder={method === "check" ? "Check number" : "Note"} value={note} onChangeText={setNote} style={[styles.input, { flex: 1, minWidth: 160 }]} />
        <Button
          label={cents ? (cents < 0 ? `Refund ${money(-cents)}` : `Take ${money(cents)}`) : "Take payment"}
          primary
          disabled={!cents || (cents < 0 && !isManager)}
          onPress={() => (method === "card" && cents! > 0 && reader.terminal ? setCharging(true) : pay())}
        />
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {b.payments.map((p) => (
        <View key={p.id} style={styles.line}>
          <Text style={[styles.help, { flex: 1 }]}>
            {new Date(p.at).toLocaleDateString([], { month: "short", day: "numeric" })} · {PAY_METHODS.find((m) => m.method === p.method)?.label}
            {p.date ? ` · for ${shortDate(p.date)}` : ""}
            {p.note ? ` · ${p.note}` : ""}
            {p.staff ? ` · ${p.staff}` : ""}
          </Text>
          <Text style={styles.strong}>{money(p.amountCents)}</Text>
        </View>
      ))}
      {charging && reader.terminal && cents && (
        <CardChargeModal
          client={client}
          terminal={reader.terminal}
          amountCents={cents}
          description={ev.name}
          onPaid={(p) => {
            setCharging(false);
            pay(p.id);
          }}
          onClose={() => setCharging(false)}
        />
      )}
    </View>
  );
}

/** One date of an event: pair players into groups, see where each group starts, and check them in. */
function DayView({ client, dateId, isManager, onBack, onCancelled }: { client: Client; dateId: string; isManager: boolean; onBack: () => void; onCancelled: (e: EventDetail) => void }) {
  const [day, setDay] = useState<EventDay>();
  const [size, setSize] = useState(4);
  const [order, setOrder] = useState<"name" | "random" | "handicap">("handicap");
  const [moving, setMoving] = useState<string>();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    client.eventDay(dateId).then(setDay).catch((e) => setError(e.message));
  }, [client, dateId]);
  async function run(fn: () => Promise<EventDay>) {
    setError(undefined);
    try {
      setDay(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }
  if (!day) return error ? <Text role="alert" style={[styles.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />;
  const groupNos = day.groups.map((g) => g.groupNo);
  const nextGroup = (groupNos.length ? Math.max(...groupNos) : 0) + 1;
  const total = day.groups.reduce((s, g) => s + g.players.length, 0);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8} style={{ marginBottom: 10 }}>
        <Text style={styles.link}>‹ {day.eventName}</Text>
      </Pressable>
      <Text role="heading" style={styles.h1}>
        {shortDate(day.date)} · {day.format === "shotgun" ? `Shotgun at ${formatTime(day.startTime)}` : `From ${formatTime(day.startTime)}`}
      </Text>
      <Text style={styles.help}>
        {day.heldTimes.length} tee times held · {total} in groups · {day.checkedIn} checked in
      </Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}

      <View style={styles.card}>
        <Text style={styles.title}>Pair players</Text>
        <View style={styles.row}>
          <Text style={[styles.help, { width: 80 }]}>Group size</Text>
          {[2, 3, 4, 5].map((n) => (
            <Chip key={n} label={String(n)} on={size === n} onPress={() => setSize(n)} />
          ))}
        </View>
        <View style={styles.row}>
          <Text style={[styles.help, { width: 80 }]}>Mix by</Text>
          <Chip label="Handicap (even groups)" on={order === "handicap"} onPress={() => setOrder("handicap")} />
          <Chip label="Random draw" on={order === "random"} onPress={() => setOrder("random")} />
          <Chip label="Name" on={order === "name"} onPress={() => setOrder("name")} />
        </View>
        <Button label={day.groups.length ? "Pair again" : "Pair everyone"} primary onPress={() => run(() => client.autoPair(dateId, { groupSize: size, order }))} />
        {day.groups.length > 0 && <Text style={styles.help}>Pairing again keeps anyone already checked in as checked in. Tap a player to move them.</Text>}
      </View>

      <View style={styles.cols}>
        {day.groups.map((g) => {
          const allIn = g.players.every((p) => p.checkedIn);
          return (
            <View key={g.groupNo} style={[styles.card, styles.group]}>
              <View style={[styles.row, { justifyContent: "space-between", marginBottom: 4 }]}>
                <Text style={styles.strong}>
                  Group {g.groupNo} · {/^\d{2}:\d{2}$/.test(g.start) ? formatTime(g.start) : g.start}
                </Text>
                <SmallButton
                  label={allIn ? "Undo check-in" : "Check in group"}
                  primary={!allIn}
                  onPress={() => run(() => client.eventCheckIn(dateId, g.players.map((p) => p.id), !allIn))}
                />
              </View>
              {g.players.map((p) => (
                <View key={p.id}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${p.name}${p.checkedIn ? ", checked in" : ""}. Move to another group`}
                    onPress={() => setMoving(moving === p.id ? undefined : p.id)}
                    style={({ hovered, focused }: WebPress) => [styles.player, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
                  >
                    <Text style={[styles.text, { flex: 1 }]}>
                      {p.checkedIn ? "✓ " : ""}
                      {p.name}
                      {p.handicap !== null ? <Text style={styles.help}> · {p.handicap}</Text> : null}
                    </Text>
                  </Pressable>
                  {moving === p.id && (
                    <View style={[styles.row, { marginVertical: 4 }]}>
                      {groupNos
                        .filter((n) => n !== g.groupNo)
                        .map((n) => (
                          <SmallButton key={n} label={`To group ${n}`} onPress={() => (setMoving(undefined), run(() => client.setPairing(dateId, p.id, n)))} />
                        ))}
                      <SmallButton label="New group" onPress={() => (setMoving(undefined), run(() => client.setPairing(dateId, p.id, nextGroup)))} />
                      <SmallButton label="Not playing" onPress={() => (setMoving(undefined), run(() => client.setPairing(dateId, p.id, null)))} />
                    </View>
                  )}
                </View>
              ))}
            </View>
          );
        })}
      </View>
      {day.unpaired.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.title}>Not in a group</Text>
          {day.unpaired.map((p) => (
            <View key={p.id} style={styles.line}>
              <Text style={[styles.text, { flex: 1 }]}>{p.name}</Text>
              {groupNos.slice(0, 6).map((n) => (
                <SmallButton key={n} label={`Group ${n}`} onPress={() => run(() => client.setPairing(dateId, p.id, n))} />
              ))}
              <SmallButton label="New group" onPress={() => run(() => client.setPairing(dateId, p.id, nextGroup))} />
            </View>
          ))}
        </View>
      )}
      {isManager &&
        (confirmCancel ? (
          <View style={styles.card}>
            <Text style={styles.text}>Cancel this date? Its tee times open up again and it isn't billed.</Text>
            <View style={styles.row}>
              <Button label="Cancel this date" danger onPress={() => client.cancelEventDate(dateId).then(onCancelled).catch((e) => setError(e.message))} />
              <Button label="Keep it" onPress={() => setConfirmCancel(false)} />
            </View>
          </View>
        ) : (
          <Button label="Cancel this date (rained out)" onPress={() => setConfirmCancel(true)} />
        ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------
// Standing tee times

function StandingTimes({ client, isManager, timeZone, courseHoles }: { client: Client; isManager: boolean; timeZone: string; courseHoles: number }) {
  const [list, setList] = useState<StandingTime[]>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    client.standingTimes().then(setList).catch((e) => setError(e.message));
  }, [client]);
  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      setList(await client.standingTimes());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    }
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.help}>A golfer's permanent weekly time. It's booked for them 8 weeks ahead, and further out as days are opened on the tee sheet.</Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {isManager &&
        (adding ? (
          <NewStanding client={client} timeZone={timeZone} courseHoles={courseHoles} onClose={() => setAdding(false)} onSave={(s) => run(() => client.addStandingTime(s)).then((ok) => ok && setAdding(false))} />
        ) : (
          <Button label="Add a standing tee time" primary onPress={() => setAdding(true)} />
        ))}
      {!list ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : list.length === 0 ? (
        <Text style={[styles.help, { marginTop: 12 }]}>No standing tee times yet.</Text>
      ) : (
        <View style={{ marginTop: 12 }}>
          {list.map((s) => {
            const problems = s.upcoming.filter((u) => u.problem);
            return (
              <View key={s.id} style={styles.listRow}>
                <View style={{ flex: 1, minWidth: 220 }}>
                  <Text style={[styles.strong, !s.active && { color: colors.muted }]}>
                    {WEEKDAYS[s.weekday - 1]}s {formatTime(s.localTime)} · {s.golferName}
                    {s.active ? "" : " (stopped)"}
                  </Text>
                  <Text style={styles.help}>
                    {s.players} {s.players === 1 ? "player" : "players"} · {s.holes} holes · {s.riding ? "riding" : "walking"} · {s.residency} · from {shortDate(s.startsOn)}
                    {s.endsOn ? ` to ${shortDate(s.endsOn)}` : ""}
                  </Text>
                  {s.active && <Text style={styles.help}>Booked: {s.upcoming.filter((u) => u.bookingId).length} weeks ahead</Text>}
                  {problems.map((u) => (
                    <Text key={u.date} style={[styles.help, { color: colors.noShow }]}>
                      {shortDate(u.date)}: couldn't book ({u.problem})
                    </Text>
                  ))}
                </View>
                {isManager && <SmallButton label={s.active ? "Stop" : "Start again"} onPress={() => run(() => client.setStandingTimeActive(s.id, !s.active))} />}
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

function NewStanding({
  client,
  timeZone,
  courseHoles,
  onSave,
  onClose,
}: {
  client: Client;
  timeZone: string;
  courseHoles: number;
  onSave: (s: Omit<StandingTime, "id" | "golferName" | "active" | "upcoming">) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [golfer, setGolfer] = useState<GolferAccount>();
  const { results } = useSearch(client, golfer ? "" : q);
  const [weekday, setWeekday] = useState(6);
  const [time, setTime] = useState("07:02");
  const [players, setPlayers] = useState(4);
  const [holes, setHoles] = useState(courseHoles * 2);
  const [riding, setRiding] = useState(true);
  const [resident, setResident] = useState(false);
  const [startsOn, setStartsOn] = useState(todayIn(timeZone));
  const [endsOn, setEndsOn] = useState("");
  const valid = golfer && /^\d{2}:\d{2}$/.test(time) && /^\d{4}-\d{2}-\d{2}$/.test(startsOn) && (!endsOn || /^\d{4}-\d{2}-\d{2}$/.test(endsOn));
  return (
    <View style={styles.card}>
      <Text role="heading" aria-level={2} style={styles.title}>
        New standing tee time
      </Text>
      {golfer ? (
        <View style={styles.row}>
          <Text style={styles.strong}>{golfer.name}</Text>
          <SmallButton label="Change" onPress={() => setGolfer(undefined)} />
        </View>
      ) : (
        <>
          <TextInput accessibilityLabel="Golfer" placeholder="Search golfer accounts" value={q} onChangeText={setQ} style={styles.input} />
          {results?.slice(0, 5).map((g) => (
            <Pressable key={g.id} accessibilityRole="button" onPress={() => setGolfer(g)} style={({ hovered }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }]}>
              <Text style={styles.text}>
                {g.name} <Text style={styles.help}>· {g.phone}</Text>
              </Text>
            </Pressable>
          ))}
        </>
      )}
      <View style={[styles.row, { marginTop: 8 }]}>
        {WEEKDAYS.map((d, i) => (
          <Chip key={d} label={d} on={weekday === i + 1} onPress={() => setWeekday(i + 1)} />
        ))}
      </View>
      <View style={styles.row}>
        <Field label="Time (HH:MM)" value={time} onChangeText={setTime} />
        <Field label="From (YYYY-MM-DD)" value={startsOn} onChangeText={setStartsOn} />
        <Field label="Until (blank for no end)" value={endsOn} onChangeText={setEndsOn} />
      </View>
      <View style={styles.row}>
        {[1, 2, 3, 4].map((n) => (
          <Chip key={n} label={`${n} ${n === 1 ? "player" : "players"}`} on={players === n} onPress={() => setPlayers(n)} />
        ))}
      </View>
      <View style={styles.row}>
        {[courseHoles, courseHoles * 2].map((h) => (
          <Chip key={h} label={`${h} holes`} on={holes === h} onPress={() => setHoles(h)} />
        ))}
        <Chip label="Riding" on={riding} onPress={() => setRiding(true)} />
        <Chip label="Walking" on={!riding} onPress={() => setRiding(false)} />
        <Chip label="Resident" on={resident} onPress={() => setResident(true)} />
        <Chip label="Nonresident" on={!resident} onPress={() => setResident(false)} />
      </View>
      <View style={styles.row}>
        <Button
          label="Add and book ahead"
          primary
          disabled={!valid}
          onPress={() => onSave({ golferId: golfer!.id, weekday, localTime: time, players, holes, riding, residency: resident ? "resident" : "nonresident", startsOn, endsOn: endsOn || null })}
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ minWidth: 160, flex: 1 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} style={styles.input} {...input} />
    </View>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, warn && { color: colors.noShow }]}>{value}</Text>
      <Text style={styles.help}>{label}</Text>
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

function Button({ label, onPress, primary, danger, disabled }: { label: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, danger && styles.buttonDanger, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton(props: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ focused }: WebPress) => [styles.small, props.primary && styles.buttonPrimary, focused && styles.focus]}
    >
      <Text style={[styles.smallText, props.primary && { color: "#fff" }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 16, backgroundColor: colors.card },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { color: colors.muted, fontWeight: "600", fontSize: 14 },
  tabTextOn: { color: colors.primary },
  page: { padding: 16, maxWidth: 1100 },
  h1: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 8 },
  text: { color: colors.text, fontSize: 14 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  link: { color: colors.primary, fontWeight: "600", textDecorationLine: "underline", fontSize: 14 },
  error: { color: colors.noShow, marginVertical: 6 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, marginTop: 12 },
  cols: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  col: { flex: 1, minWidth: 300 },
  group: { minWidth: 240, flexBasis: 240, flexGrow: 1 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  line: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  listRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 3, backgroundColor: colors.card, marginBottom: 6 },
  player: { paddingVertical: 7, paddingHorizontal: 6, borderRadius: 3 },
  result: { paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 3, marginBottom: 4, backgroundColor: "#fff" },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  stat: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingVertical: 8, paddingHorizontal: 12, minWidth: 130, backgroundColor: "#fff" },
  statValue: { fontSize: 18, fontWeight: "700", color: colors.text },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start", marginTop: 4 },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonDanger: { borderColor: colors.noShow },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  small: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, minHeight: 30, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  smallText: { color: colors.text, fontWeight: "600", fontSize: 12 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
