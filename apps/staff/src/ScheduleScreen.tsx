import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { Client, Coworker, EmployeeType, Me, Punch, Shift, Swap, SwapAction, Timesheet } from "./api";
import { addDays, dayParts, todayIn, weekStart } from "./dates";
import { colors, formatTime, radius, type WebPress } from "./theme";

type Tab = "week" | "swaps" | "timesheets";

const SWAP_STATUS: Record<Swap["status"], string> = {
  awaiting_coworker: "Waiting for coworker",
  awaiting_manager: "Waiting for manager",
  approved: "Approved",
  declined: "Declined",
  rejected: "Turned down by manager",
  cancelled: "Cancelled",
};

const clock = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
const shortDate = (date: string) => {
  const d = dayParts(date);
  return `${d.weekday} ${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
};
const shiftLabel = (s: Shift) => `${shortDate(s.date)}, ${formatTime(s.start)}–${formatTime(s.end)}`;

/**
 * The staff schedule: the week's shifts, the time clock, shift swaps and, for managers,
 * timesheets. Everyone sees the whole schedule; only managers change it.
 */
export function ScheduleScreen({ client, me, timeZone }: { client: Client; me: Me | undefined; timeZone: string }) {
  const isManager = me?.role === "manager";
  const [tab, setTab] = useState<Tab>("week");
  const [swapCount, setSwapCount] = useState(0);

  const tabs: { id: Tab; label: string }[] = [
    { id: "week", label: "Schedule" },
    { id: "swaps", label: swapCount ? `Shift swaps (${swapCount})` : "Shift swaps" },
    ...(isManager ? [{ id: "timesheets" as const, label: "Timesheets" }] : []),
  ];

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {me?.user && <ClockCard client={client} timeZone={timeZone} />}
      <View role="tablist" style={styles.tabs}>
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onPress={() => setTab(t.id)}
            style={({ focused }: WebPress) => [styles.tab, tab === t.id && styles.tabOn, focused && styles.focus]}
          >
            <Text style={[styles.tabText, tab === t.id && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "week" ? (
        <WeekView client={client} me={me} timeZone={timeZone} onSwapAsked={() => setTab("swaps")} />
      ) : tab === "swaps" ? (
        <SwapsView client={client} me={me} onCount={setSwapCount} />
      ) : (
        <TimesheetsView client={client} timeZone={timeZone} />
      )}
    </ScrollView>
  );
}

function ClockCard({ client, timeZone }: { client: Client; timeZone: string }) {
  const [state, setState] = useState<{ open: Punch | null; nextShift: Shift | null }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    client.clock().then(setState).catch((e) => setError(e.message));
  }, [client]);

  async function punch() {
    setBusy(true);
    setError(undefined);
    try {
      setState(await (state?.open ? client.clockOut() : client.clockIn()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.card, styles.row]} accessibilityLiveRegion="polite">
      <View style={{ flex: 1, minWidth: 200 }}>
        <Text style={styles.label}>Time clock</Text>
        {!state ? (
          <Text style={styles.text}>{error ?? "Loading…"}</Text>
        ) : state.open ? (
          <Text style={styles.strong}>Clocked in since {clock(state.open.clockIn, timeZone)}</Text>
        ) : (
          <Text style={styles.strong}>Not clocked in</Text>
        )}
        {state?.nextShift && !state.open && <Text style={styles.muted}>Next shift: {shiftLabel(state.nextShift)}</Text>}
        {state && error && <Text role="alert" style={styles.error}>{error}</Text>}
      </View>
      {state && <Button label={busy ? "…" : state.open ? "Clock out" : "Clock in"} primary disabled={busy} onPress={punch} />}
    </View>
  );
}

function WeekView({ client, me, timeZone, onSwapAsked }: { client: Client; me: Me | undefined; timeZone: string; onSwapAsked: () => void }) {
  const isManager = me?.role === "manager";
  const today = todayIn(timeZone);
  const [monday, setMonday] = useState(weekStart(today));
  const [shifts, setShifts] = useState<Shift[]>();
  const [people, setPeople] = useState<Coworker[]>([]);
  const [types, setTypes] = useState<EmployeeType[]>([]);
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<Partial<Shift> & { date: string }>();
  const [swapping, setSwapping] = useState<Shift>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));

  const load = useCallback(() => {
    setError(undefined);
    client.shifts(monday, addDays(monday, 6)).then(setShifts).catch((e) => setError(e.message));
  }, [client, monday]);

  useEffect(load, [load]);
  useEffect(() => {
    client.coworkers().then(setPeople).catch(() => undefined);
    if (isManager) client.employeeTypes().then((t) => setTypes(t.filter((x) => x.active))).catch(() => undefined);
  }, [client, isManager]);

  async function copyLastWeek() {
    setNotice(undefined);
    try {
      const r = await client.copyWeek(addDays(monday, -7), monday);
      setNotice(`Copied ${r.copied} shift${r.copied === 1 ? "" : "s"} from last week${r.skipped ? `. ${r.skipped} skipped because they'd clash with shifts already here` : ""}.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't copy last week");
    }
  }

  const myId = me?.user?.id;
  const visible = (shifts ?? []).filter((s) => !mine || s.staff?.id === myId);
  // One row per person who works this week, then open shifts nobody has yet.
  const rows: { id: string | null; name: string; detail?: string }[] = [];
  for (const s of visible) {
    const id = s.staff?.id ?? null;
    if (!rows.some((r) => r.id === id)) rows.push({ id, name: s.staff?.name ?? "Open shifts", detail: people.find((p) => p.id === id)?.employeeType ?? undefined });
  }
  rows.sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.id === myId ? -1 : b.id === myId ? 1 : a.name.localeCompare(b.name)));
  const hours = (id: string | null) => visible.filter((s) => (s.staff?.id ?? null) === id).reduce((t, s) => t + s.hours, 0);

  return (
    <View>
      <View style={[styles.row, { marginBottom: 12 }]}>
        <Button label="‹" label2="Previous week" onPress={() => setMonday(addDays(monday, -7))} />
        <Text role="heading" aria-level={2} style={styles.weekTitle}>
          Week of {shortDate(monday)}
        </Text>
        <Button label="›" label2="Next week" onPress={() => setMonday(addDays(monday, 7))} />
        {monday !== weekStart(today) && <Button label="This week" onPress={() => setMonday(weekStart(today))} />}
        <View style={{ flex: 1 }} />
        {myId && <Button label="My shifts" radio selected={mine} onPress={() => setMine(!mine)} />}
        {isManager && <Button label="Copy last week" onPress={copyLastWeek} />}
        {isManager && <Button label="Add shift" primary onPress={() => setEditing({ date: days.includes(today) ? today : monday, start: "07:00", end: "15:00" })} />}
      </View>
      {notice && <Text style={[styles.notice, styles.text]}>{notice}</Text>}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!shifts ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <ScrollView horizontal contentContainerStyle={{ minWidth: "100%" }}>
          <View role="table" aria-label="Shifts this week" style={styles.grid}>
            <View role="row" style={[styles.gridRow, styles.gridHead]}>
              <Text role="columnheader" style={[styles.nameCell, styles.headText]}>Employee</Text>
              {days.map((d) => {
                const p = dayParts(d);
                return (
                  <Text key={d} role="columnheader" style={[styles.dayCell, styles.headText, d === today && { color: colors.primaryText }]}>
                    {p.weekday} {p.day}
                  </Text>
                );
              })}
            </View>
            {rows.length === 0 && (
              <View style={styles.gridRow}>
                <Text style={[styles.text, { padding: 12 }]}>{mine ? "You have no shifts this week." : isManager ? "No shifts this week yet. Add one, or copy last week." : "No shifts this week yet."}</Text>
              </View>
            )}
            {rows.map((r) => (
              <View key={r.id ?? "open"} role="row" style={[styles.gridRow, r.id === myId && { backgroundColor: colors.primaryLight }]}>
                <View role="rowheader" style={styles.nameCell}>
                  <Text style={styles.strong} numberOfLines={1}>
                    {r.name}
                    {r.id === myId ? " (you)" : ""}
                  </Text>
                  <Text style={styles.small}>
                    {r.detail ? `${r.detail} · ` : ""}
                    {Math.round(hours(r.id) * 10) / 10} h
                  </Text>
                </View>
                {days.map((d) => (
                  <View key={d} role="cell" style={styles.dayCell}>
                    {visible
                      .filter((s) => (s.staff?.id ?? null) === r.id && s.date === d)
                      .map((s) => {
                        const canSwap = s.staff?.id === myId && s.startsAt > new Date().toISOString();
                        const open = isManager ? () => setEditing(s) : canSwap ? () => setSwapping(s) : undefined;
                        return (
                          <Pressable
                            key={s.id}
                            disabled={!open}
                            onPress={open}
                            accessibilityRole={open ? "button" : undefined}
                            accessibilityLabel={`${s.staff?.name ?? "Open shift"}, ${shiftLabel(s)}${s.employeeType ? `, ${s.employeeType.name}` : ""}${isManager ? ". Edit" : canSwap ? ". Ask to swap" : ""}`}
                            style={({ hovered, focused }: WebPress) => [styles.shift, !s.staff && styles.shiftOpen, hovered && open && { borderColor: colors.primary }, focused && styles.focus]}
                          >
                            <Text style={styles.shiftTime}>
                              {formatTime(s.start)}–{formatTime(s.end)}
                            </Text>
                            {(s.employeeType || s.note) && (
                              <Text style={styles.small} numberOfLines={1}>
                                {s.note ?? s.employeeType?.name}
                              </Text>
                            )}
                          </Pressable>
                        );
                      })}
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      {!isManager && myId && <Text style={styles.muted}>Tap one of your upcoming shifts to ask a coworker to take it or trade.</Text>}

      {editing && (
        <ShiftEditor
          client={client}
          shift={editing}
          days={days}
          people={people}
          types={types}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
      {swapping && (
        <SwapAsk
          client={client}
          shift={swapping}
          people={people.filter((p) => p.id !== myId)}
          theirShifts={(shifts ?? []).filter((s) => s.staff && s.staff.id !== myId && s.startsAt > new Date().toISOString())}
          onClose={() => setSwapping(undefined)}
          onSent={() => {
            setSwapping(undefined);
            onSwapAsked();
          }}
        />
      )}
    </View>
  );
}

function ShiftEditor(props: {
  client: Client;
  shift: Partial<Shift> & { date: string };
  days: string[];
  people: Coworker[];
  types: EmployeeType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { client, shift, days, people, types, onClose, onSaved } = props;
  const [staffId, setStaffId] = useState<string | null>(shift.staff?.id ?? null);
  const [typeId, setTypeId] = useState<string | null>(shift.employeeType?.id ?? null);
  const [date, setDate] = useState(shift.date);
  const [start, setStart] = useState(shift.start ?? "07:00");
  const [end, setEnd] = useState(shift.end ?? "15:00");
  const [note, setNote] = useState(shift.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const valid = /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && start !== end;
  const dayChoices = days.includes(date) ? days : [date, ...days];

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the shift");
      setBusy(false);
    }
  }

  const input = { staffUserId: staffId, employeeTypeId: typeId, date, start, end, note: note.trim() || null };
  return (
    <Sheet title={shift.id ? "Edit shift" : "Add shift"} onClose={onClose}>
      <Text style={styles.label}>Who</Text>
      <View style={styles.choices}>
        <Button label="Open shift" radio selected={staffId === null} onPress={() => setStaffId(null)} />
        {people.map((p) => (
          <Button
            key={p.id}
            label={p.name}
            radio
            selected={staffId === p.id}
            onPress={() => {
              setStaffId(p.id);
              const t = types.find((x) => x.name === p.employeeType);
              if (t && !typeId) setTypeId(t.id);
            }}
          />
        ))}
      </View>
      {types.length > 0 && (
        <>
          <Text style={styles.label}>Job</Text>
          <View style={styles.choices}>
            <Button label="Any" radio selected={typeId === null} onPress={() => setTypeId(null)} />
            {types.map((t) => (
              <Button key={t.id} label={t.name} radio selected={typeId === t.id} onPress={() => setTypeId(t.id)} />
            ))}
          </View>
        </>
      )}
      <Text style={styles.label}>Day</Text>
      <View style={styles.choices}>
        {dayChoices.map((d) => (
          <Button key={d} label={shortDate(d)} radio selected={date === d} onPress={() => setDate(d)} />
        ))}
      </View>
      <View style={[styles.row, { marginTop: 4 }]}>
        <Field label="Starts (24-hour, e.g. 06:30)" value={start} onChangeText={setStart} />
        <Field label="Ends" value={end} onChangeText={setEnd} />
      </View>
      {valid && end < start && <Text style={styles.muted}>Ends the next morning.</Text>}
      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. Open the range" />
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.choices, { marginTop: 16 }]}>
        <Button
          label={busy ? "Saving…" : "Save shift"}
          primary
          disabled={busy || !valid}
          onPress={() => run(() => (shift.id ? client.updateShift(shift.id, input) : client.addShift(input)))}
        />
        <Button label="Cancel" disabled={busy} onPress={onClose} />
        {shift.id && <Button label="Delete shift" danger disabled={busy} onPress={() => run(() => client.deleteShift(shift.id!))} />}
      </View>
    </Sheet>
  );
}

function SwapAsk(props: { client: Client; shift: Shift; people: Coworker[]; theirShifts: Shift[]; onClose: () => void; onSent: () => void }) {
  const { client, shift, people, theirShifts, onClose, onSent } = props;
  const [to, setTo] = useState<string>();
  const [trade, setTrade] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const options = theirShifts.filter((s) => s.staff?.id === to);

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      await client.askSwap({ offeredShiftId: shift.id, toUserId: to!, requestedShiftId: trade, message: message.trim() || null });
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the request");
      setBusy(false);
    }
  }

  return (
    <Sheet title="Ask to swap a shift" onClose={onClose}>
      <Text style={styles.text}>Your shift: {shiftLabel(shift)}</Text>
      <Text style={styles.label}>Ask</Text>
      <View style={styles.choices}>
        {people.map((p) => (
          <Button
            key={p.id}
            label={p.employeeType ? `${p.name} · ${p.employeeType}` : p.name}
            radio
            selected={to === p.id}
            onPress={() => {
              setTo(p.id);
              setTrade(null);
            }}
          />
        ))}
      </View>
      {to && (
        <>
          <Text style={styles.label}>In return</Text>
          <View style={styles.choices}>
            <Button label="Nothing, they just take it" radio selected={trade === null} onPress={() => setTrade(null)} />
            {options.map((s) => (
              <Button key={s.id} label={`Their ${shiftLabel(s)}`} radio selected={trade === s.id} onPress={() => setTrade(s.id)} />
            ))}
          </View>
        </>
      )}
      <Field label="Message (optional)" value={message} onChangeText={setMessage} placeholder="e.g. Family thing that morning" />
      <Text style={styles.muted}>They'll get the request to accept. A manager may need to approve it too.</Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.choices, { marginTop: 16 }]}>
        <Button label={busy ? "Sending…" : "Send request"} primary disabled={busy || !to} onPress={send} />
        <Button label="Cancel" disabled={busy} onPress={onClose} />
      </View>
    </Sheet>
  );
}

function SwapsView({ client, me, onCount }: { client: Client; me: Me | undefined; onCount: (n: number) => void }) {
  const isManager = me?.role === "manager";
  const myId = me?.user?.id;
  const [swaps, setSwaps] = useState<Swap[]>();
  const [approval, setApproval] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    client
      .swaps()
      .then((list) => {
        setSwaps(list);
        onCount(list.filter((w) => (w.status === "awaiting_coworker" && w.to.id === myId) || (w.status === "awaiting_manager" && isManager)).length);
      })
      .catch((e) => setError(e.message));
  }, [client, myId, isManager]);

  useEffect(load, [load]);
  useEffect(() => {
    client.schedulingSettings().then((s) => setApproval(s.swapsNeedApproval)).catch(() => undefined);
  }, [client]);

  async function act(w: Swap, action: SwapAction) {
    setBusy(w.id);
    setError(undefined);
    try {
      await client.answerSwap(w.id, action);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(undefined);
    }
  }

  async function toggleApproval(on: boolean) {
    setApproval(on);
    try {
      setApproval((await client.saveSchedulingSettings({ swapsNeedApproval: on })).swapsNeedApproval);
    } catch (e) {
      setApproval(!on);
      setError(e instanceof Error ? e.message : "Couldn't save that");
    }
  }

  const needsMe = (w: Swap) => (w.status === "awaiting_coworker" && w.to.id === myId) || (w.status === "awaiting_manager" && isManager);
  const groups = [
    { title: "Needs your answer", list: (swaps ?? []).filter(needsMe) },
    { title: "Waiting", list: (swaps ?? []).filter((w) => w.status.startsWith("awaiting") && !needsMe(w)) },
    { title: "Finished", list: (swaps ?? []).filter((w) => !w.status.startsWith("awaiting")) },
  ];

  return (
    <View>
      {isManager && approval !== undefined && (
        <View style={[styles.card, styles.row]}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <Text style={styles.strong}>Manager must approve swaps</Text>
            <Text style={styles.muted}>
              {approval ? "After the coworker accepts, a manager approves before the schedule changes." : "The schedule changes as soon as the coworker accepts."}
            </Text>
          </View>
          <Switch accessibilityLabel="Manager must approve swaps" value={approval} onValueChange={toggleApproval} trackColor={{ true: colors.primary, false: colors.border }} />
        </View>
      )}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!swaps ? (
        <ActivityIndicator color={colors.primary} />
      ) : swaps.length === 0 ? (
        <Text style={styles.text}>No shift swaps yet. To ask for one, open the Schedule and tap one of your upcoming shifts.</Text>
      ) : (
        groups
          .filter((g) => g.list.length)
          .map((g) => (
            <View key={g.title} style={{ marginBottom: 16 }}>
              <Text style={styles.label}>{g.title}</Text>
              <View style={styles.table}>
                {g.list.map((w) => (
                  <View key={w.id} style={[styles.tableRow, styles.row]}>
                    <View style={{ flex: 1, minWidth: 220 }}>
                      <Text style={styles.strong}>
                        {w.from.id === myId ? "You" : w.from.name} → {w.to.id === myId ? "you" : w.to.name}
                      </Text>
                      <Text style={styles.text}>
                        {w.requested ? `Trade ${shiftLabel(w.offered)} for ${shiftLabel(w.requested)}` : `Take ${shiftLabel(w.offered)}`}
                      </Text>
                      {w.message && <Text style={styles.muted}>“{w.message}”</Text>}
                    </View>
                    <Text style={[styles.status, w.status === "approved" && { color: colors.checkedIn }, ["declined", "rejected"].includes(w.status) && { color: colors.noShow }]}>
                      {SWAP_STATUS[w.status]}
                    </Text>
                    {w.status === "awaiting_coworker" && w.to.id === myId && (
                      <>
                        <Button label="Accept" primary disabled={!!busy} onPress={() => act(w, "accept")} />
                        <Button label="Decline" disabled={!!busy} onPress={() => act(w, "decline")} />
                      </>
                    )}
                    {w.status === "awaiting_manager" && isManager && (
                      <>
                        <Button label="Approve" primary disabled={!!busy} onPress={() => act(w, "approve")} />
                        <Button label="Turn down" disabled={!!busy} onPress={() => act(w, "reject")} />
                      </>
                    )}
                    {w.status.startsWith("awaiting") && w.from.id === myId && <Button label="Cancel request" disabled={!!busy} onPress={() => act(w, "cancel")} />}
                  </View>
                ))}
              </View>
            </View>
          ))
      )}
    </View>
  );
}

function TimesheetsView({ client, timeZone }: { client: Client; timeZone: string }) {
  const today = todayIn(timeZone);
  const [monday, setMonday] = useState(weekStart(today));
  const [sheets, setSheets] = useState<Timesheet[]>();
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSheets(undefined);
    client.timesheets(monday, addDays(monday, 6)).then(setSheets).catch((e) => setError(e.message));
  }, [client, monday]);

  const total = (k: "scheduledHours" | "workedHours") => Math.round((sheets ?? []).reduce((t, s) => t + s[k], 0) * 10) / 10;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });

  return (
    <View>
      <View style={[styles.row, { marginBottom: 12 }]}>
        <Button label="‹" label2="Previous week" onPress={() => setMonday(addDays(monday, -7))} />
        <Text role="heading" aria-level={2} style={styles.weekTitle}>
          Week of {shortDate(monday)}
        </Text>
        <Button label="›" label2="Next week" onPress={() => setMonday(addDays(monday, 7))} />
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!sheets ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <View role="table" aria-label="Hours this week" style={styles.table}>
          <View role="row" style={[styles.tableRow, styles.gridHead, styles.row]}>
            <Text role="columnheader" style={[styles.headText, { flex: 1 }]}>Employee</Text>
            <Text role="columnheader" style={[styles.headText, styles.num]}>Scheduled</Text>
            <Text role="columnheader" style={[styles.headText, styles.num]}>Worked</Text>
            <Text role="columnheader" style={[styles.headText, styles.num]}>Difference</Text>
          </View>
          {sheets.length === 0 && <Text style={[styles.text, { padding: 12 }]}>No hours this week.</Text>}
          {sheets.map((s) => {
            const diff = Math.round((s.workedHours - s.scheduledHours) * 10) / 10;
            return (
              <View key={s.staff.id}>
                <Pressable
                  role="row"
                  aria-expanded={open === s.staff.id}
                  onPress={() => setOpen(open === s.staff.id ? undefined : s.staff.id)}
                  style={({ hovered, focused }: WebPress) => [styles.tableRow, styles.row, hovered && { backgroundColor: colors.bg }, focused && styles.focus]}
                >
                  <Text style={[styles.strong, { flex: 1 }]}>
                    {open === s.staff.id ? "▾ " : "▸ "}
                    {s.staff.name}
                    {s.open ? <Text style={{ color: colors.checkedIn }}> · on the clock</Text> : null}
                  </Text>
                  <Text style={[styles.text, styles.num]}>{s.scheduledHours} h</Text>
                  <Text style={[styles.text, styles.num]}>{s.workedHours} h</Text>
                  <Text style={[styles.text, styles.num, diff > 0 && { color: colors.warn }]}>{diff > 0 ? `+${diff}` : diff} h</Text>
                </Pressable>
                {open === s.staff.id &&
                  s.punches.map((p) => (
                    <View key={p.id} style={[styles.tableRow, styles.row, { paddingLeft: 32, backgroundColor: colors.bg }]}>
                      <Text style={[styles.text, { flex: 1 }]}>
                        {day(p.clockIn)}: {clock(p.clockIn, timeZone)} – {p.clockOut ? clock(p.clockOut, timeZone) : "still clocked in"}
                        {p.edited ? " (edited)" : ""}
                      </Text>
                      <Text style={[styles.text, styles.num]}>{p.hours ?? "–"} h</Text>
                    </View>
                  ))}
              </View>
            );
          })}
          {sheets.length > 0 && (
            <View style={[styles.tableRow, styles.row, styles.gridHead]}>
              <Text style={[styles.strong, { flex: 1 }]}>Total</Text>
              <Text style={[styles.strong, styles.num]}>{total("scheduledHours")} h</Text>
              <Text style={[styles.strong, styles.num]}>{total("workedHours")} h</Text>
              <Text style={styles.num} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View role="dialog" aria-label={title} style={styles.sheet}>
          <ScrollView>
            <Text role="heading" aria-level={2} style={styles.sheetTitle}>
              {title}
            </Text>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ marginTop: 10, flex: 1, minWidth: 140 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} autoCorrect={false} style={styles.input} {...input} />
    </View>
  );
}

function Button(props: { label: string; label2?: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean; radio?: boolean; selected?: boolean }) {
  const { label, label2, onPress, primary, danger, disabled, radio, selected } = props;
  const filled = primary || selected;
  return (
    <Pressable
      accessibilityRole={radio ? "radio" : "button"}
      accessibilityLabel={label2 ?? label}
      accessibilityState={radio ? { checked: selected } : { disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, filled && styles.buttonOn, hovered && !filled && { backgroundColor: colors.bg }, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, filled && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 12, marginBottom: 14 },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, marginBottom: 14 },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: "600", color: colors.muted },
  tabTextOn: { color: colors.text },
  weekTitle: { fontSize: 15, fontWeight: "700", color: colors.text, marginHorizontal: 4 },
  grid: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card },
  gridRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border },
  gridHead: { backgroundColor: colors.bg },
  headText: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, paddingVertical: 7 },
  nameCell: { width: 170, paddingHorizontal: 10, paddingVertical: 6, borderRightWidth: 1, borderColor: colors.border, justifyContent: "center" },
  dayCell: { flex: 1, minWidth: 108, padding: 4, gap: 4, borderRightWidth: 1, borderColor: colors.border, textAlign: "center" },
  shift: { borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, borderLeftColor: colors.primary, borderRadius: radius, backgroundColor: colors.card, paddingHorizontal: 6, paddingVertical: 4 },
  shiftOpen: { borderLeftColor: colors.warn, borderStyle: "dashed" },
  shiftTime: { fontSize: 12, fontWeight: "700", color: colors.text },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card },
  tableRow: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  num: { width: 90, textAlign: "right" },
  status: { fontSize: 12, fontWeight: "700", color: colors.muted, minWidth: 140 },
  label: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 12, marginBottom: 6 },
  text: { color: colors.text, fontSize: 13, lineHeight: 19 },
  strong: { color: colors.text, fontSize: 13, fontWeight: "700" },
  small: { color: colors.muted, fontSize: 11 },
  muted: { color: colors.muted, fontSize: 12, marginTop: 8 },
  notice: { backgroundColor: colors.primaryLight, borderRadius: radius, padding: 10, marginBottom: 10 },
  error: { color: colors.noShow, marginVertical: 8 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, minHeight: 32, justifyContent: "center", backgroundColor: colors.card },
  buttonOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { fontSize: 13, fontWeight: "600", color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: colors.text, backgroundColor: "#fff" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", alignItems: "center", padding: 16 },
  sheet: { backgroundColor: colors.card, borderRadius: radius, padding: 18, width: "100%", maxWidth: 560, maxHeight: "90%" },
  sheetTitle: { fontSize: 16, fontWeight: "700", color: colors.text, marginBottom: 4 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
