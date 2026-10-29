import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { findRate } from "@golf/core";
import { ApiError, type Client, type Course, type SheetBooking, type SheetTeeTime, type Station } from "./api";
import { addDays, dayParts, nowIn, todayIn, weekStart } from "./dates";
import { TeeTimePanel } from "./TeeTimePanel";
import { Header } from "./Header";
import { colors, type WebPress, formatTime, money, slotColor, slotLabel, slotMark, type SlotState } from "./theme";

// Other devices' changes show up within this many seconds.
const REFRESH_MS = 5000;
const ROW_HEIGHT = 44;
const HOUR_HEIGHT = 30;

type Line = { kind: "hour"; key: string; label: string } | { kind: "time"; key: string; teeTime: SheetTeeTime; index: number };

interface Props {
  client: Client;
  course: Course;
  station: Station;
  onSignOut: () => void;
  /** Present on narrow screens, where the menu is folded away. */
  onOpenMenu?: () => void;
}

export function TeeSheetScreen({ client, course, station, onSignOut, onOpenMenu }: Props) {
  const { width } = useWindowDimensions();
  const sideBySide = width >= 1100; // laptops and desktops: grid and details side by side
  const compact = width < 600; // phones

  const [date, setDate] = useState(() => todayIn(course.timeZone));
  const [sheet, setSheet] = useState<SheetTeeTime[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();
  const listRef = useRef<FlatList<Line>>(null);
  const scrolledFor = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const res = await client.teeSheet(date);
      setSheet(res.teeTimes);
      setError(undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignOut();
      setError(e instanceof Error ? `Offline: ${e.message}` : "Offline");
    }
  }, [client, date, onSignOut]);

  useEffect(() => {
    setSheet(undefined);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const today = todayIn(course.timeZone);
  const isToday = date === today;
  const nextIndex = useMemo(() => {
    if (!sheet || !isToday) return -1;
    const now = nowIn(course.timeZone);
    return sheet.findIndex((t) => t.localTime >= now);
  }, [sheet, course, isToday]);

  // Tee times with a divider at the top of each hour, as on a paper tee sheet.
  const lines = useMemo(() => {
    const out: Line[] = [];
    let hour = "";
    sheet?.forEach((t, index) => {
      const h = t.localTime.slice(0, 2);
      if (h !== hour) {
        hour = h;
        out.push({ kind: "hour", key: `h${h}`, label: formatTime(`${h}:00`).replace(":00", ":00 ").toUpperCase() });
      }
      out.push({ kind: "time", key: t.id, teeTime: t, index });
    });
    return out;
  }, [sheet]);
  const offsets = useMemo(() => {
    let y = 0;
    return lines.map((l) => {
      const at = y;
      y += l.kind === "hour" ? HOUR_HEIGHT : ROW_HEIGHT;
      return at;
    });
  }, [lines]);

  // Jump to the next tee time once per day viewed, so starters land where the action is.
  useEffect(() => {
    if (!sheet || scrolledFor.current === date) return;
    scrolledFor.current = date;
    const target = lines.findIndex((l) => l.kind === "time" && l.index === nextIndex);
    if (target > 1) setTimeout(() => listRef.current?.scrollToIndex({ index: target - 2, animated: false }), 50);
  }, [sheet, date, lines, nextIndex]);

  // The standard price for each time: one nonresident adult, one loop of the course.
  const priceAt = useCallback(
    (t: SheetTeeTime) =>
      findRate(course.rates ?? [], { residency: "nonresident", ageGroup: "adult" }, { startsAt: t.startsAt, timeZone: course.timeZone })?.priceCents,
    [course],
  );

  const totals = useMemo(() => {
    const live = sheet?.flatMap((t) => t.bookings).filter((b) => b.status !== "cancelled" && b.status !== "no_show") ?? [];
    const players = live.reduce((s, b) => s + b.players, 0);
    const capacity = sheet?.filter((t) => t.status === "open").reduce((s, t) => s + t.maxPlayers, 0) ?? 0;
    const owed = live.reduce((s, b) => s + b.payment.balanceCents, 0);
    return { players, open: Math.max(0, capacity - players), owed };
  }, [sheet]);

  const selected = sheet?.find((t) => t.id === selectedId);
  const panel = selected && sheet && (
    <TeeTimePanel
      key={selected.id}
      client={client}
      teeTime={selected}
      sheet={sheet}
      courseHoles={course.holes}
      station={station}
      onChanged={load}
      onClose={() => setSelectedId(undefined)}
    />
  );

  const summary = error ?? (sheet ? `${totals.players} golfers · ${totals.open} spots open${totals.owed ? ` · ${money(totals.owed)} owed` : ""}` : "Loading…");

  return (
    <View style={{ flex: 1 }}>
      <Header title="Tee sheet" subtitle={`${station === "proshop" ? "Pro shop" : "Starter"} · ${summary}`} onOpenMenu={onOpenMenu} />
      <WeekStrip date={date} today={today} compact={compact} onPick={setDate} />
      {!compact && <Legend />}

      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {!sheet ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.green} />
          ) : sheet.length === 0 ? (
            <Text style={styles.empty}>No tee times on this day.</Text>
          ) : (
            <FlatList
              ref={listRef}
              data={lines}
              keyExtractor={(l) => l.key}
              getItemLayout={(_, index) => ({
                length: lines[index]?.kind === "hour" ? HOUR_HEIGHT : ROW_HEIGHT,
                offset: offsets[index] ?? 0,
                index,
              })}
              accessibilityLabel={`Tee times for ${dayParts(date).long}`}
              renderItem={({ item }) =>
                item.kind === "hour" ? (
                  <View style={styles.hour} role="heading" aria-level={2}>
                    <Text style={styles.hourText}>{item.label}</Text>
                  </View>
                ) : (
                  <TeeTimeRow
                    teeTime={item.teeTime}
                    priceCents={compact ? undefined : priceAt(item.teeTime)}
                    compact={compact}
                    selected={item.teeTime.id === selectedId}
                    isNext={item.index === nextIndex}
                    past={isToday && nextIndex !== -1 && item.index < nextIndex}
                    onPress={() => setSelectedId(item.teeTime.id)}
                  />
                )
              }
            />
          )}
        </View>
        {sideBySide && (
          <View style={styles.side}>
            {panel ?? <Text style={styles.empty}>Choose a tee time to check groups in, take payment, add walk-ins or block it.</Text>}
          </View>
        )}
      </View>

      {!sideBySide && (
        <Modal visible={!!panel} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedId(undefined)}>
          {panel}
        </Modal>
      )}
    </View>
  );
}

function WeekStrip({ date, today, compact, onPick }: { date: string; today: string; compact: boolean; onPick: (d: string) => void }) {
  const monday = weekStart(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return (
    <View style={styles.week}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go to today"
        disabled={date === today}
        onPress={() => onPick(today)}
        style={({ focused }: WebPress) => [styles.todayButton, date === today && { opacity: 0.5 }, focused && styles.focusRing]}
      >
        <Text style={styles.todayText}>Today</Text>
      </Pressable>
      <WeekArrow label="‹" name="Previous week" onPress={() => onPick(addDays(date, -7))} />
      <View style={styles.days}>
        {days.map((d) => {
          const on = d === date;
          const { weekday, day, long } = dayParts(d);
          return (
            <Pressable
              key={d}
              accessibilityRole="button"
              accessibilityLabel={`${long}${d === today ? ", today" : ""}`}
              accessibilityState={{ selected: on }}
              onPress={() => onPick(d)}
              style={({ focused }: WebPress) => [styles.day, on && styles.dayOn, focused && styles.focusRing]}
            >
              <Text style={[styles.dayText, on && { color: "#fff" }, d === today && !on && { color: colors.green }]}>
                {compact ? `${weekday.slice(0, 2)}\n${day}` : `${weekday} ${day}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <WeekArrow label="›" name="Next week" onPress={() => onPick(addDays(date, 7))} />
    </View>
  );
}

function WeekArrow({ label, name, onPress }: { label: string; name: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={({ focused }: WebPress) => [styles.arrow, focused && styles.focusRing]}>
      <Text style={styles.arrowText}>{label}</Text>
    </Pressable>
  );
}

function Legend() {
  return (
    <View style={styles.legend} accessibilityLabel="Color key">
      {(Object.keys(slotColor) as SlotState[]).map((s) => (
        <View key={s} style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: slotColor[s] }]}>
            <Text style={styles.legendMark}>{slotMark[s].trim()}</Text>
          </View>
          <Text style={styles.legendText}>{slotLabel[s]}</Text>
        </View>
      ))}
    </View>
  );
}

function stateOf(b: SheetBooking): SlotState {
  if (b.status === "confirmed") return b.payment.balanceCents === 0 ? "prepaid" : "booked";
  return b.status as SlotState;
}

interface RowProps {
  teeTime: SheetTeeTime;
  priceCents?: number;
  compact: boolean;
  selected: boolean;
  isNext: boolean;
  past: boolean;
  onPress: () => void;
}

function TeeTimeRow({ teeTime, priceCents, compact, selected, isNext, past, onPress }: RowProps) {
  const groups = teeTime.bookings.filter((b) => b.status !== "cancelled");
  const blocked = teeTime.status === "blocked";
  // No-shows aren't expected to pay, so they don't count toward what's owed.
  const owed = groups.filter((b) => b.status !== "no_show").reduce((s, b) => s + b.payment.balanceCents, 0);
  const carts = groups.flatMap((b) => b.cartNumbers);

  // One slot per player: each group fills as many slots as it has players, in booking order.
  const slots: { booking?: SheetBooking; first: boolean }[] = [];
  for (const b of groups) for (let i = 0; i < b.players && slots.length < teeTime.maxPlayers; i++) slots.push({ booking: b, first: i === 0 });
  while (slots.length < teeTime.maxPlayers) slots.push({ first: false });

  const spoken = blocked
    ? `blocked${teeTime.note ? `, ${teeTime.note}` : ""}`
    : groups.length === 0
      ? `open, ${teeTime.maxPlayers} spots${teeTime.note ? `, ${teeTime.note}` : ""}`
      : groups
          .map((b) => `${b.customerName}, ${b.players} ${b.players === 1 ? "player" : "players"}, ${slotLabel[stateOf(b)].toLowerCase()}${b.payment.balanceCents > 0 && b.status !== "no_show" ? `, owes ${money(b.payment.balanceCents)}` : ""}`)
          .join("; ") + (teeTime.maxPlayers > teeTime.bookedPlayers ? `; ${teeTime.maxPlayers - teeTime.bookedPlayers} open` : "");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${formatTime(teeTime.localTime)}${isNext ? ", next tee time" : ""}: ${spoken}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [
        styles.row,
        hovered && { backgroundColor: "#f7f8f4" },
        selected && styles.rowSelected,
        past && { opacity: 0.6 },
        focused && styles.focusRing,
      ]}
    >
      <View style={[styles.timeCol, compact && { width: 58 }]}>
        <Text style={[styles.rowTime, compact && { fontSize: 14 }]}>{formatTime(teeTime.localTime)}</Text>
        {isNext && <Text style={styles.next}>NEXT</Text>}
      </View>
      {priceCents !== undefined && <Text style={styles.price}>{money(priceCents)}</Text>}
      {blocked ? (
        <View style={styles.blockedBar}>
          <Text style={styles.blockedText} numberOfLines={1}>Blocked{teeTime.note ? ` · ${teeTime.note}` : ""}</Text>
        </View>
      ) : (
        <View style={styles.slots}>
          {compact
            ? // Phones: one bar per group across its players, so the whole name fits.
              [
                ...groups.map((b) => (
                  <View key={b.id} style={[styles.slot, { flex: b.players, backgroundColor: slotColor[stateOf(b)] }]}>
                    <Text style={styles.slotText} numberOfLines={1}>
                      {slotMark[stateOf(b)]}
                      {b.customerName}
                      {b.players > 1 ? ` (${b.players})` : ""}
                    </Text>
                  </View>
                )),
                ...slots.filter((x) => !x.booking).map((_, i) => <View key={`open${i}`} style={[styles.slot, styles.slotOpen]} />),
              ]
            : slots.map((s, i) =>
            s.booking ? (
              <View key={i} style={[styles.slot, { backgroundColor: slotColor[stateOf(s.booking)] }]}>
                <Text style={styles.slotText} numberOfLines={1}>
                  {slotMark[stateOf(s.booking)]}
                  {s.first ? s.booking.customerName : "Guest"}
                </Text>
              </View>
            ) : (
              <View key={i} style={[styles.slot, styles.slotOpen]}>
                <Text style={styles.openText}>{i === slots.findIndex((x) => !x.booking) && teeTime.note ? teeTime.note : "Open"}</Text>
              </View>
            ),
          )}
        </View>
      )}
      {/* Money and carts sit in their own column so they stay visible when names are cut off. */}
      <View style={[styles.endCol, compact && { width: 64 }]}>
        {groups.some((b) => b.status !== "no_show") && (
          <Text style={[styles.pay, { color: owed > 0 ? colors.noShow : colors.checkedIn }]} numberOfLines={1}>
            {owed > 0 ? (compact ? money(owed) : `Owes ${money(owed)}`) : "Paid"}
          </Text>
        )}
        {carts.length > 0 && (
          <Text style={styles.cart} numberOfLines={1}>
            {compact ? "" : carts.length === 1 ? "Cart " : "Carts "}
            {carts.join(", ")}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.muted, textAlign: "center", marginTop: 40, paddingHorizontal: 24, fontSize: 15, lineHeight: 22 },
  focusRing: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid", outlineOffset: -2 } as object,
  week: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  todayButton: { borderWidth: 1, borderColor: colors.green, borderRadius: 8, paddingHorizontal: 12, minHeight: 40, justifyContent: "center" },
  todayText: { color: colors.green, fontWeight: "700", fontSize: 14 },
  arrow: { width: 32, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  arrowText: { fontSize: 24, color: colors.green, lineHeight: 26 },
  days: { flex: 1, flexDirection: "row", gap: 4 },
  day: { flex: 1, minHeight: 40, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 2 },
  dayOn: { backgroundColor: colors.text },
  dayText: { fontSize: 13, fontWeight: "600", color: colors.text, textAlign: "center" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 14, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch: { width: 20, height: 16, borderRadius: 3, alignItems: "center", justifyContent: "center" },
  legendMark: { color: "#fff", fontSize: 10, fontWeight: "700" },
  legendText: { fontSize: 13, color: colors.text },
  hour: { height: HOUR_HEIGHT, justifyContent: "center", paddingHorizontal: 12, backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border },
  hourText: { fontSize: 12, fontWeight: "700", color: colors.muted, letterSpacing: 0.5 },
  row: { height: ROW_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  rowSelected: { backgroundColor: colors.greenLight },
  timeCol: { width: 70 },
  rowTime: { fontSize: 15, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  next: { fontSize: 9, fontWeight: "800", color: colors.green, letterSpacing: 1 },
  price: { width: 60, fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] },
  slots: { flex: 1, flexDirection: "row", gap: 3, minWidth: 0 },
  slot: { flex: 1, height: 28, borderRadius: 4, justifyContent: "center", paddingHorizontal: 6, minWidth: 0 },
  slotOpen: { borderWidth: 1, borderColor: colors.border, borderStyle: "dashed", alignItems: "center" },
  slotText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  openText: { color: colors.muted, fontSize: 12 },
  blockedBar: { flex: 1, height: 28, borderRadius: 4, backgroundColor: colors.blocked, justifyContent: "center", paddingHorizontal: 10 },
  blockedText: { color: colors.muted, fontStyle: "italic", fontSize: 13 },
  endCol: { width: 104, alignItems: "flex-end" },
  pay: { fontWeight: "700", fontSize: 13 },
  cart: { fontSize: 12, color: colors.greenText, fontWeight: "600" },
  side: { width: 400, borderLeftWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
});
