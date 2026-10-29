import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import type { HostInstance } from "react-native";
import { findRate } from "@golf/core";
import { ApiError, type Client, type Course, type SheetBooking, type SheetTeeTime, type Station } from "./api";
import { addDays, dayParts, nowIn, todayIn, weekStart } from "./dates";
import { CalendarPicker } from "./CalendarPicker";
import { TeeTimePanel } from "./TeeTimePanel";
import { Header } from "./Header";
import { colors, type WebPress, formatTime, money, slotColor, slotLabel, slotMark, type SlotState } from "./theme";

// Other devices' changes show up within this many seconds.
const REFRESH_MS = 5000;
const ROW_HEIGHT = 32;
const HOUR_HEIGHT = 24;

type Line = { kind: "hour"; key: string; label: string } | { kind: "time"; key: string; teeTime: SheetTeeTime; index: number };

interface Props {
  client: Client;
  course: Course;
  station: Station;
  onSignOut: () => void;
  /** Present on narrow screens, where the menu is folded away. */
  onOpenMenu?: () => void;
  /** Opens a golfer's account from a name on the tee sheet. */
  onOpenGolfer?: (golferId: string) => void;
  /** Shows this booking's day and opens its tee time, e.g. from a golfer's account. */
  jumpTo?: { date: string; bookingId: string };
}

export function TeeSheetScreen({ client, course, station, onSignOut, onOpenMenu, onOpenGolfer, jumpTo }: Props) {
  const { width } = useWindowDimensions();
  const sideBySide = width >= 1100; // laptops and desktops: grid and details side by side
  const compact = width < 600; // phones

  const [date, setDate] = useState(() => jumpTo?.date ?? todayIn(course.timeZone));
  const [sheet, setSheet] = useState<SheetTeeTime[]>();
  const [selectedId, setSelectedId] = useState<string>();
  // Guests dragged onto a group, for the panel to confirm.
  const [guestRequest, setGuestRequest] = useState<{ bookingId: string; count: number; key: number }>();
  // The group whose name was tapped, so the panel can bring it to the top of the eye line.
  const [focusId, setFocusId] = useState<string>();
  // A group being dragged up or down to another tee time, and the time it's over right now.
  const [moveDrag, setMoveDrag] = useState<{ booking: SheetBooking; targetId?: string; ok: boolean }>();
  const [notice, setNotice] = useState<{ text: string; undo?: () => void; key: number }>();
  const [error, setError] = useState<string>();
  const listRef = useRef<FlatList<Line>>(null);
  const scrolledFor = useRef<string | undefined>(undefined);
  // The booking to open once its day has loaded.
  const pending = useRef(jumpTo?.bookingId);

  useEffect(() => {
    if (!jumpTo) return;
    pending.current = jumpTo.bookingId;
    setDate(jumpTo.date);
  }, [jumpTo]);

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
    if (!sheet) return;
    const wanted = pending.current ? sheet.findIndex((t) => t.bookings.some((b) => b.id === pending.current)) : -1;
    if (wanted !== -1) {
      pending.current = undefined;
      setSelectedId(sheet[wanted]!.id);
    } else if (scrolledFor.current === date) return;
    scrolledFor.current = date;
    const target = lines.findIndex((l) => l.kind === "time" && l.index === (wanted !== -1 ? wanted : nextIndex));
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

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 10_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The tee time under a name dragged dy pixels up or down from the row at lineIndex.
  const teeTimeAt = (lineIndex: number, dy: number) => {
    const y = (offsets[lineIndex] ?? 0) + ROW_HEIGHT / 2 + dy;
    let i = offsets.findIndex((at, k) => y >= at && y < at + (lines[k]!.kind === "hour" ? HOUR_HEIGHT : ROW_HEIGHT));
    if (i === -1) i = y < 0 ? 0 : lines.length - 1;
    if (lines[i]?.kind === "hour") i++;
    const line = lines[i];
    return line?.kind === "time" ? line.teeTime : undefined;
  };
  const hasRoom = (t: SheetTeeTime, b: SheetBooking) => t.status === "open" && t.maxPlayers - t.bookedPlayers >= b.players;

  async function moveGroup(b: SheetBooking, to: SheetTeeTime) {
    const from = sheet?.find((t) => t.id === b.teeTimeId);
    try {
      await client.move(b.id, to.id);
      setNotice({
        text: `Moved ${b.customerName} to ${formatTime(to.localTime)}`,
        undo: from
          ? async () => {
              setNotice(undefined);
              try {
                await client.move(b.id, from.id);
              } catch (e) {
                setNotice({ text: e instanceof Error ? e.message : "Couldn't move them back", key: Date.now() });
              }
              load();
            }
          : undefined,
        key: Date.now(),
      });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Couldn't move the group", key: Date.now() });
    }
    load();
  }

  // Dragging a group near the top or bottom edge of the list scrolls it, so any time of day can
  // be reached. dy is measured from where the drag started, so scrolling is added back in.
  const scrollY = useRef(0);
  const listWrap = useRef<HostInstance>(null);
  const listBox = useRef({ top: 0, height: 0 });
  const moving = useRef<{ booking: SheetBooking; lineIndex: number; dy: number; pageY: number; scroll0: number; timer?: ReturnType<typeof setInterval> }>(undefined);
  const contentHeight = (offsets.at(-1) ?? 0) + ROW_HEIGHT;
  const targetOf = (m: NonNullable<typeof moving.current>) => {
    const t = teeTimeAt(m.lineIndex, m.dy + scrollY.current - m.scroll0);
    return t && t.id !== m.booking.teeTimeId ? t : undefined;
  };
  const latest = useRef({ targetOf, hasRoom, contentHeight });
  latest.current = { targetOf, hasRoom, contentHeight };
  const showTarget = () => {
    const m = moving.current;
    if (!m) return;
    const t = latest.current.targetOf(m);
    setMoveDrag({ booking: m.booking, targetId: t?.id, ok: !!t && latest.current.hasRoom(t, m.booking) });
  };
  const edge = (pageY: number) => {
    const { top, height } = listBox.current;
    if (!height) return 0;
    if (pageY < top + 48) return -1;
    if (pageY > top + height - 48) return 1;
    return 0;
  };
  const stopMoving = () => {
    if (moving.current?.timer) clearInterval(moving.current.timer);
    moving.current = undefined;
    setMoveDrag(undefined);
  };
  useEffect(() => stopMoving, []);

  function onMoveDrag(b: SheetBooking, lineIndex: number, dy: number, pageY: number) {
    if (!moving.current) {
      moving.current = { booking: b, lineIndex, dy, pageY, scroll0: scrollY.current };
      listWrap.current?.measureInWindow((_x, top, _w, height) => (listBox.current = { top, height }));
    }
    const m = moving.current;
    m.dy = dy;
    m.pageY = pageY;
    if (edge(pageY) && !m.timer) {
      m.timer = setInterval(() => {
        const cur = moving.current;
        const dir = cur ? edge(cur.pageY) : 0;
        if (!cur || !dir) {
          if (cur?.timer) clearInterval(cur.timer);
          if (cur) cur.timer = undefined;
          return;
        }
        const max = Math.max(0, latest.current.contentHeight - listBox.current.height);
        const next = Math.max(0, Math.min(max, scrollY.current + dir * 10));
        if (next === scrollY.current) return;
        scrollY.current = next;
        listRef.current?.scrollToOffset({ offset: next, animated: false });
        showTarget();
      }, 16);
    }
    showTarget();
  }

  function onMoveDrop(b: SheetBooking, dy: number) {
    const m = moving.current;
    if (m) m.dy = dy;
    const t = m && targetOf(m);
    stopMoving();
    if (!t) return;
    if (!hasRoom(t, b)) {
      setNotice({
        text:
          t.status === "blocked"
            ? `${formatTime(t.localTime)} is blocked`
            : `${formatTime(t.localTime)} doesn't have room for ${b.players} ${b.players === 1 ? "player" : "players"}`,
        key: Date.now(),
      });
      return;
    }
    moveGroup(b, t);
  }

  const selected = sheet?.find((t) => t.id === selectedId);
  const panel = selected && sheet && (
    <TeeTimePanel
      key={selected.id}
      client={client}
      teeTime={selected}
      sheet={sheet}
      courseHoles={course.holes}
      course={course}
      station={station}
      onOpenGolfer={onOpenGolfer}
      onChanged={load}
      onClose={() => setSelectedId(undefined)}
      focusBookingId={focusId}
      guestRequest={guestRequest && selected.bookings.some((b) => b.id === guestRequest.bookingId) ? guestRequest : undefined}
    />
  );

  const summary = error ?? (sheet ? `${totals.players} golfers · ${totals.open} spots open${totals.owed ? ` · ${money(totals.owed)} owed` : ""}` : "Loading…");

  return (
    <View style={{ flex: 1 }}>
      <Header title="Tee sheet" subtitle={`${station === "proshop" ? "Pro shop" : "Starter"} · ${summary}`} onOpenMenu={onOpenMenu} />
      <WeekStrip date={date} today={today} compact={compact} onPick={setDate} />
      {!compact && <Legend />}
      {notice && (
        <View key={notice.key} style={styles.notice} accessibilityLiveRegion="polite" role="status">
          <Text style={styles.noticeText}>{notice.text}</Text>
          {notice.undo && (
            <Pressable accessibilityRole="button" onPress={notice.undo} hitSlop={8} style={({ focused }: WebPress) => [styles.noticeButton, focused && styles.focusRing]}>
              <Text style={styles.noticeAction}>Undo</Text>
            </Pressable>
          )}
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={() => setNotice(undefined)} hitSlop={8} style={styles.noticeButton}>
            <Text style={styles.noticeClose}>✕</Text>
          </Pressable>
        </View>
      )}

      <View style={{ flex: 1, flexDirection: "row" }}>
        <View ref={listWrap} style={{ flex: 1, minWidth: 0 }}>
          {!sheet ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : sheet.length === 0 ? (
            <Text style={styles.empty}>No tee times on this day.</Text>
          ) : (
            <FlatList
              ref={listRef}
              onScroll={(e) => (scrollY.current = e.nativeEvent.contentOffset.y)}
              scrollEventThrottle={16}
              data={lines}
              extraData={[selectedId, moveDrag]}
              keyExtractor={(l) => l.key}
              getItemLayout={(_, index) => ({
                length: lines[index]?.kind === "hour" ? HOUR_HEIGHT : ROW_HEIGHT,
                offset: offsets[index] ?? 0,
                index,
              })}
              accessibilityLabel={`Tee times for ${dayParts(date).long}`}
              renderItem={({ item, index: lineIndex }) =>
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
                    onPress={(bookingId) => {
                      setSelectedId(item.teeTime.id);
                      setFocusId(bookingId);
                    }}
                    onAddGuests={(bookingId, count) => {
                      setSelectedId(item.teeTime.id);
                      setGuestRequest({ bookingId, count, key: Date.now() });
                    }}
                    movingId={moveDrag?.booking.id}
                    moveTarget={moveDrag?.targetId === item.teeTime.id ? (moveDrag.ok ? "ok" : "full") : undefined}
                    onMoveDrag={(b, dy, pageY) => onMoveDrag(b, lineIndex, dy, pageY)}
                    onMoveDrop={onMoveDrop}
                    onMoveCancel={stopMoving}
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
  const [calendar, setCalendar] = useState(false);
  return (
    <View style={styles.week}>
      {calendar && <CalendarPicker date={date} today={today} onPick={onPick} onClose={() => setCalendar(false)} />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go to today"
        disabled={date === today}
        onPress={() => onPick(today)}
        style={({ focused }: WebPress) => [styles.todayButton, date === today && { opacity: 0.5 }, focused && styles.focusRing]}
      >
        <Text style={styles.todayText}>Today</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Pick a date from the calendar. Showing ${dayParts(date).long}`}
        onPress={() => setCalendar(true)}
        style={({ focused }: WebPress) => [styles.todayButton, { marginLeft: 6 }, focused && styles.focusRing]}
      >
        <Text style={styles.todayText}>{compact ? "Cal" : `Calendar · ${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`}</Text>
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
              <Text style={[styles.dayText, on && { color: "#fff" }, d === today && !on && { color: colors.primary }]}>
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
  /** With the booking whose name was tapped, if it was a name rather than the row. */
  onPress: (bookingId?: string) => void;
  /** The group being dragged to another time, if it's from this row. */
  movingId?: string;
  /** This row is under a group being dragged: "ok" if it has room for them. */
  moveTarget?: "ok" | "full";
  /** A golfer's name is being dragged dy pixels up or down, to move their group. */
  onMoveDrag: (booking: SheetBooking, dy: number, pageY: number) => void;
  onMoveDrop: (booking: SheetBooking, dy: number) => void;
  onMoveCancel: () => void;
  /** A golfer's name was dragged right across open spots: add that many guests to their group. */
  onAddGuests: (bookingId: string, count: number) => void;
}

function TeeTimeRow({ teeTime, priceCents, compact, selected, isNext, past, onPress, onAddGuests, movingId, moveTarget, onMoveDrag, onMoveDrop, onMoveCancel }: RowProps) {
  const [slotsWidth, setSlotsWidth] = useState(0);
  // While a name is being dragged: whose group, and how many open spots it covers so far.
  const [drag, setDrag] = useState<{ bookingId: string; count: number }>();
  const groups = teeTime.bookings.filter((b) => b.status !== "cancelled");
  const blocked = teeTime.status === "blocked";
  // No-shows aren't expected to pay, so they don't count toward what's owed.
  const owed = groups.filter((b) => b.status !== "no_show").reduce((s, b) => s + b.payment.balanceCents, 0);
  const carts = groups.flatMap((b) => b.cartNumbers);

  // One slot per player: each group fills as many slots as it has players, in booking order.
  const slots: { booking?: SheetBooking; first: boolean }[] = [];
  for (const b of groups) for (let i = 0; i < b.players && slots.length < teeTime.maxPlayers; i++) slots.push({ booking: b, first: i === 0 });
  while (slots.length < teeTime.maxPlayers) slots.push({ first: false });
  const open = teeTime.maxPlayers - teeTime.bookedPlayers;
  const firstOpen = slots.findIndex((x) => !x.booking);
  const slotWidth = slotsWidth / teeTime.maxPlayers;
  // Only groups still playing can take guests, and only into open spots.
  const canGuest = (b: SheetBooking) => !blocked && open > 0 && slotWidth > 0 && b.status !== "no_show" && b.status !== "cancelled";
  // Groups that haven't teed off yet can be dragged up or down to another time.
  const canMove = (b: SheetBooking) => b.status === "confirmed" || b.status === "checked_in";
  const dragProps = (b: SheetBooking) => ({
    canGuest: canGuest(b),
    canMove: canMove(b),
    maxGuests: open,
    slotWidth,
    onTap: () => onPress(b.id),
    onGuestDrag: (count: number) => setDrag(count ? { bookingId: b.id, count } : undefined),
    onGuestDrop: (count: number) => {
      setDrag(undefined);
      if (count > 0) onAddGuests(b.id, count);
    },
    onMoveDrag: (dy: number, pageY: number) => onMoveDrag(b, dy, pageY),
    onMoveDrop: (dy: number) => onMoveDrop(b, dy),
    onCancel: () => {
      setDrag(undefined);
      onMoveCancel();
    },
  });
  const lifted = (b: SheetBooking) => b.id === movingId && { opacity: 0.45 };
  const ghost = (i: number) => drag !== undefined && firstOpen !== -1 && i >= firstOpen && i < firstOpen + drag.count;

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
      onPress={() => onPress()}
      style={({ hovered, focused }: WebPress) => [
        styles.row,
        hovered && { backgroundColor: "#f7f8f4" },
        selected && styles.rowSelected,
        past && { opacity: 0.6 },
        moveTarget === "ok" && styles.rowDropOk,
        moveTarget === "full" && styles.rowDropFull,
        focused && styles.focusRing,
      ]}
    >
      <View style={[styles.timeCol, compact && { width: 58 }]}>
        <Text style={[styles.rowTime, compact && { fontSize: 13 }]}>{formatTime(teeTime.localTime)}</Text>
        {isNext && <Text style={styles.next}>NEXT</Text>}
      </View>
      {priceCents !== undefined && <Text style={styles.price}>{money(priceCents)}</Text>}
      {blocked ? (
        <View style={styles.blockedBar}>
          <Text style={styles.blockedText} numberOfLines={1}>Blocked{teeTime.note ? ` · ${teeTime.note}` : ""}</Text>
        </View>
      ) : (
        <View style={styles.slots} onLayout={(e) => setSlotsWidth(e.nativeEvent.layout.width)}>
          {compact
            ? // Phones: one bar per group across its players, so the whole name fits.
              [
                ...groups.map((b) => (
                  <DragName key={b.id} {...dragProps(b)} style={[styles.slot, { flex: b.players, backgroundColor: slotColor[stateOf(b)] }, lifted(b)]}>
                    <Text style={styles.slotText} numberOfLines={1}>
                      {slotMark[stateOf(b)]}
                      {b.customerName}
                      {b.players > 1 ? ` (${b.players})` : ""}
                    </Text>
                  </DragName>
                )),
                ...slots
                  .map((x, i) => (x.booking ? null : <View key={`open${i}`} style={[styles.slot, styles.slotOpen, ghost(i) && styles.slotGhost]} />))
                  .filter(Boolean),
              ]
            : slots.map((s, i) =>
            s.booking ? (
              <DragName
                key={i}
                {...dragProps(s.booking)}
                // Only the group's name slides; the guest spots behind it just open the group.
                canGuest={s.first && canGuest(s.booking)}
                canMove={s.first && canMove(s.booking)}
                style={[styles.slot, { backgroundColor: slotColor[stateOf(s.booking)] }, lifted(s.booking)]}
              >
                <Text style={styles.slotText} numberOfLines={1}>
                  {slotMark[stateOf(s.booking)]}
                  {s.first ? s.booking.customerName : "Guest"}
                </Text>
              </DragName>
            ) : ghost(i) ? (
              <View key={i} style={[styles.slot, styles.slotOpen, styles.slotGhost]}>
                <Text style={styles.ghostText}>+ Guest</Text>
              </View>
            ) : (
              <View key={i} style={[styles.slot, styles.slotOpen]}>
                <Text style={styles.openText}>{i === firstOpen && teeTime.note ? teeTime.note : "Open"}</Text>
              </View>
            ),
          )}
        </View>
      )}
      {/* Money and carts sit in their own column so they stay visible when names are cut off. */}
      <View style={[styles.endCol, compact && { width: 64 }]}>
        {moveTarget ? (
          <Text style={[styles.pay, { color: moveTarget === "ok" ? colors.primaryText : colors.noShow }]} numberOfLines={1}>
            {moveTarget === "ok" ? "Move here" : blocked ? "Blocked" : "No room"}
          </Text>
        ) : (
          <>
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
          </>
        )}
      </View>
    </Pressable>
  );
}

/**
 * A golfer's name on the tee sheet. Sliding it to the right across open spots adds that many
 * guests to their group (the panel then asks walking or riding before charging anything).
 * Dragging it up or down moves the group to another tee time. A plain tap opens the group.
 */
function DragName(props: {
  canGuest: boolean;
  canMove: boolean;
  maxGuests: number;
  slotWidth: number;
  onTap: () => void;
  onGuestDrag: (count: number) => void;
  onGuestDrop: (count: number) => void;
  onMoveDrag: (dy: number, pageY: number) => void;
  onMoveDrop: (dy: number) => void;
  onCancel: () => void;
  style: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const latest = useRef(props);
  latest.current = props;
  // Which way the name is going, once it has moved far enough to tell.
  const mode = useRef<"none" | "guest" | "move">("none");
  const guests = (dx: number) => Math.max(0, Math.min(latest.current.maxGuests, Math.round(dx / latest.current.slotWidth)));
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        mode.current = "none";
      },
      onPanResponderMove: (_, g) => {
        const { canGuest, canMove, onGuestDrag, onMoveDrag } = latest.current;
        if (mode.current === "none") {
          if (canGuest && g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5) mode.current = "guest";
          else if (canMove && Math.abs(g.dy) > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5) mode.current = "move";
        }
        if (mode.current === "guest") onGuestDrag(guests(g.dx));
        if (mode.current === "move") onMoveDrag(g.dy, g.moveY);
      },
      // Let the list scroll unless the name is already being dragged.
      onPanResponderTerminationRequest: () => mode.current === "none",
      onPanResponderRelease: (_, g) => {
        const { onGuestDrop, onMoveDrop, onTap } = latest.current;
        if (mode.current === "guest") onGuestDrop(guests(g.dx));
        else if (mode.current === "move") onMoveDrop(g.dy);
        else if (Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) onTap();
        mode.current = "none";
      },
      onPanResponderTerminate: () => {
        mode.current = "none";
        latest.current.onCancel();
      },
    }),
  ).current;
  const draggable = props.canGuest || props.canMove;
  return (
    <View {...pan.panHandlers} style={[props.style, draggable ? styles.draggable : styles.tappable]}>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  // touchAction: on iPads and phones a finger on a name drags it rather than scrolling the page.
  draggable: { cursor: "grab", userSelect: "none", touchAction: "none" } as object,
  tappable: { cursor: "pointer", userSelect: "none" } as object,
  rowDropOk: { backgroundColor: colors.primaryLight, outlineColor: colors.primary, outlineWidth: 2, outlineStyle: "dashed", outlineOffset: -2 } as object,
  rowDropFull: { backgroundColor: "#fbeceb", outlineColor: colors.noShow, outlineWidth: 2, outlineStyle: "dashed", outlineOffset: -2 } as object,
  notice: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.text },
  noticeText: { flex: 1, color: "#fff", fontSize: 13 },
  noticeButton: { paddingHorizontal: 6, minHeight: 28, justifyContent: "center", borderRadius: 3 },
  noticeAction: { color: "#9cc3f5", fontWeight: "700", fontSize: 13 },
  noticeClose: { color: "#c9ccd1", fontSize: 13 },
  slotGhost: { borderColor: colors.primary, borderStyle: "solid", backgroundColor: colors.primaryLight },
  ghostText: { color: colors.primaryText, fontSize: 12, fontWeight: "700" },
  empty: { color: colors.muted, textAlign: "center", marginTop: 40, paddingHorizontal: 24, fontSize: 14, lineHeight: 22 },
  focusRing: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid", outlineOffset: -2 } as object,
  week: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  todayButton: { borderWidth: 1, borderColor: colors.primary, borderRadius: 3, paddingHorizontal: 12, minHeight: 34, justifyContent: "center" },
  todayText: { color: colors.primary, fontWeight: "700", fontSize: 13 },
  arrow: { width: 32, minHeight: 34, alignItems: "center", justifyContent: "center", borderRadius: 3 },
  arrowText: { fontSize: 20, color: colors.primary, lineHeight: 26 },
  days: { flex: 1, flexDirection: "row", gap: 4 },
  day: { flex: 1, minHeight: 34, borderRadius: 3, alignItems: "center", justifyContent: "center", paddingHorizontal: 2 },
  dayOn: { backgroundColor: colors.text },
  dayText: { fontSize: 12, fontWeight: "600", color: colors.text, textAlign: "center" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 14, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch: { width: 16, height: 14, borderRadius: 2, alignItems: "center", justifyContent: "center" },
  legendMark: { color: "#fff", fontSize: 10, fontWeight: "700" },
  legendText: { fontSize: 12, color: colors.text },
  hour: { height: HOUR_HEIGHT, justifyContent: "center", paddingHorizontal: 12, backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border },
  hourText: { fontSize: 12, fontWeight: "700", color: colors.muted, letterSpacing: 0.5 },
  row: { height: ROW_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  rowSelected: { backgroundColor: colors.primaryLight },
  timeCol: { width: 70 },
  rowTime: { fontSize: 13, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
  next: { fontSize: 9, fontWeight: "800", color: colors.primary, letterSpacing: 1 },
  price: { width: 60, fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] },
  slots: { flex: 1, flexDirection: "row", gap: 3, minWidth: 0 },
  slot: { flex: 1, height: 22, borderRadius: 2, justifyContent: "center", paddingHorizontal: 6, minWidth: 0 },
  slotOpen: { borderWidth: 1, borderColor: colors.border, borderStyle: "dashed", alignItems: "center" },
  slotText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  openText: { color: colors.muted, fontSize: 12 },
  blockedBar: { flex: 1, height: 22, borderRadius: 2, backgroundColor: colors.blocked, justifyContent: "center", paddingHorizontal: 10 },
  blockedText: { color: colors.muted, fontStyle: "italic", fontSize: 12 },
  endCol: { width: 104, alignItems: "flex-end" },
  pay: { fontWeight: "700", fontSize: 12 },
  cart: { fontSize: 12, color: colors.primaryText, fontWeight: "600" },
  side: { width: 400, borderLeftWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
});
