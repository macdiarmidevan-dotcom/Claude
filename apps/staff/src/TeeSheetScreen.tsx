import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import type { HostInstance } from "react-native";
import { findRate } from "@golf/core";
import { ApiError, type Client, type Course, type SheetBooking, type SheetTeeTime, type Station } from "./api";
import { addDays, dayParts, nowIn, todayIn, weekStart } from "./dates";
import { DelayBar } from "./DelayPanel";
import { CalendarPicker } from "./CalendarPicker";
import { TeeTimePanel } from "./TeeTimePanel";
import { Header } from "./Header";
import { Icon, type IconName } from "./Icon";
import { useAddOn } from "./AddOns";
import { colors, type WebPress, formatTime, money, slotColor, slotLabel, slotShort, type SlotState } from "./theme";

// Other devices' changes show up within this many seconds.
const REFRESH_MS = 5000;
const ROW_HEIGHT = 34;

/** 7:02 as "7:02 AM"; on phones just "7:02". */
function clock(localTime: string, compact = false) {
  const h = Number(localTime.slice(0, 2));
  const hm = `${((h + 11) % 12) + 1}:${localTime.slice(3, 5)}`;
  return compact ? hm : `${hm} ${h < 12 ? "AM" : "PM"}`;
}

/** Whole dollars without cents ("$41", "$3,840"); anything else with them. */
const dollars = (cents: number) => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : money(cents));

/** "Henderson" from "Mike Henderson": guests show as "Henderson guest". */
const lastName = (name: string) => name.trim().split(/\s+/).at(-1) ?? name;

type Line = { kind: "time"; key: string; teeTime: SheetTeeTime; index: number };

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
  isManager?: boolean;
}

export function TeeSheetScreen({ client, course, station, onSignOut, onOpenMenu, onOpenGolfer, jumpTo, isManager = false }: Props) {
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
  // Which player in that group was tapped: 0 is the golfer who booked, then their guests.
  const [focusPlayer, setFocusPlayer] = useState<number>();
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

  // One line per tee time, like a spreadsheet: each time carries its own AM or PM.
  const lines = useMemo(() => (sheet ?? []).map((t, index): Line => ({ kind: "time", key: t.id, teeTime: t, index })), [sheet]);
  const offsets = useMemo(() => {
    let y = 0;
    return lines.map((l) => {
      const at = y;
      y += ROW_HEIGHT;
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
    const checkedIn = live.filter((b) => b.status === "checked_in" || b.status === "teed_off").reduce((s, b) => s + b.players, 0);
    const collected = sheet?.flatMap((t) => t.bookings).filter((b) => b.status !== "cancelled").reduce((s, b) => s + b.payment.paidCents, 0) ?? 0;
    return { players, checkedIn, open: Math.max(0, capacity - players), collected };
  }, [sheet]);

  // Players booked on each day of the week shown, for the week bar. The day on screen comes from the live sheet.
  const monday = weekStart(date);
  const [weekCounts, setWeekCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    setWeekCounts({});
    Promise.all(
      Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((d) =>
        client
          .teeSheet(d)
          .then((r) => [d, playersOn(r.teeTimes)] as const)
          .catch(() => [d, undefined] as const),
      ),
    ).then((rows) => live && setWeekCounts(Object.fromEntries(rows.filter((r) => r[1] !== undefined))));
    return () => {
      live = false;
    };
  }, [client, monday]);
  const counts = sheet ? { ...weekCounts, [date]: totals.players } : weekCounts;

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 10_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The tee time under a name dragged dy pixels up or down from the row at lineIndex.
  const teeTimeAt = (lineIndex: number, dy: number) => {
    const y = (offsets[lineIndex] ?? 0) + ROW_HEIGHT / 2 + dy;
    let i = offsets.findIndex((at) => y >= at && y < at + ROW_HEIGHT);
    if (i === -1) i = y < 0 ? 0 : lines.length - 1;
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
      isManager={isManager}
      onOpenGolfer={onOpenGolfer}
      onChanged={load}
      onClose={() => setSelectedId(undefined)}
      focusBookingId={focusId}
      focusPlayer={focusPlayer}
      guestRequest={guestRequest && selected.bookings.some((b) => b.id === guestRequest.bookingId) ? guestRequest : undefined}
    />
  );

  // Add-ons the course can switch: prices beside each time, the color key, and weather delays.
  const showPrices = useAddOn("tee_sheet_prices");
  const showKey = useAddOn("color_key_open");
  const delaysOn = useAddOn("weather_delays");
  const [delayRequest, setDelayRequest] = useState(0);
  const [calendar, setCalendar] = useState(false);
  const canDelay = !!sheet?.length && date >= today;
  // The walk-in goes on the next tee time with room: from now on today, from the first time on other days.
  const nextOpen = sheet?.find((t, i) => t.status === "open" && t.bookedPlayers < t.maxPlayers && (!isToday || nextIndex === -1 || i >= nextIndex));
  const addWalkIn = () => {
    if (!nextOpen) return setNotice({ text: "No open tee times left on this day", key: Date.now() });
    setSelectedId(nextOpen.id);
    setFocusId(undefined);
    setFocusPlayer(undefined);
    const at = lines.findIndex((l) => l.kind === "time" && l.teeTime.id === nextOpen.id);
    if (at > 1) listRef.current?.scrollToIndex({ index: at - 2, animated: true });
  };
  const stationName = station === "proshop" ? "Pro shop" : "Starter";
  const longDate = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

  return (
    <View style={{ flex: 1 }}>
      <Header title="Tee sheet" note={compact ? undefined : longDate} subtitle={compact ? `${dayParts(date).long} · ${stationName}` : undefined} onOpenMenu={onOpenMenu}>
        {compact ? (
          <>
            <ToolButton icon="calendar" label="Calendar" onPress={() => setCalendar(true)} />
            {delaysOn && <ToolButton icon="cloud" label="Weather delay" disabled={!canDelay} onPress={() => setDelayRequest(Date.now())} />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a walk-in"
              onPress={addWalkIn}
              style={({ hovered, focused }: WebPress) => [styles.addButton, hovered && { backgroundColor: colors.primaryText }, focused && styles.focusRing]}
            >
              <Icon name="plus" size={16} color="#fff" strokeWidth={2.5} />
            </Pressable>
          </>
        ) : (
          <>
            <BarButton label="Calendar" onPress={() => setCalendar(true)} />
            {delaysOn && <BarButton label="Weather delay" disabled={!canDelay} onPress={() => setDelayRequest(Date.now())} />}
            <BarButton label="Add a walk-in" primary onPress={addWalkIn} />
          </>
        )}
      </Header>
      {calendar && <CalendarPicker date={date} today={today} onPick={setDate} onClose={() => setCalendar(false)} />}
      <View style={[styles.page, compact && { padding: 0, gap: 0 }]}>
      <WeekBar date={date} counts={counts} compact={compact} onPick={setDate} />
      <View style={[styles.card, compact && { borderWidth: 0 }]}>
      <StatsStrip error={error} loading={!sheet} totals={totals} compact={compact} showKey={showKey} />
      {delaysOn && <DelayBar client={client} date={date} today={today} nowLocal={nowIn(course.timeZone)} sheet={sheet} onChanged={load} openRequest={delayRequest} showButton={false} />}
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
                length: ROW_HEIGHT,
                offset: offsets[index] ?? 0,
                index,
              })}
              accessibilityLabel={`Tee times for ${dayParts(date).long}`}
              renderItem={({ item, index: lineIndex }) => (
                  <TeeTimeRow
                    teeTime={item.teeTime}
                    priceCents={compact || !showPrices ? undefined : priceAt(item.teeTime)}
                    compact={compact}
                    selected={item.teeTime.id === selectedId}
                    isNext={item.index === nextIndex}
                    past={isToday && nextIndex !== -1 && item.index < nextIndex}
                    onPress={(bookingId, player) => {
                      setSelectedId(item.teeTime.id);
                      setFocusId(bookingId);
                      setFocusPlayer(player);
                    }}
                    onAddGuests={(bookingId, count) => {
                      setSelectedId(item.teeTime.id);
                      setFocusId(bookingId);
                      setFocusPlayer(undefined);
                      setGuestRequest({ bookingId, count, key: Date.now() });
                    }}
                    movingId={moveDrag?.booking.id}
                    moveTarget={moveDrag?.targetId === item.teeTime.id ? (moveDrag.ok ? "ok" : "full") : undefined}
                    onMoveDrag={(b, dy, pageY) => onMoveDrag(b, lineIndex, dy, pageY)}
                    onMoveDrop={onMoveDrop}
                    onMoveCancel={stopMoving}
                  />
              )}
            />
          )}
        </View>
        {/* The tee sheet runs to the right edge until a tee time is chosen; then its details open beside it. */}
        {sideBySide && panel && <View style={styles.side}>{panel}</View>}
      </View>
      </View>
      </View>

      {!sideBySide && (
        <Modal visible={!!panel} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedId(undefined)}>
          {panel}
        </Modal>
      )}
    </View>
  );
}

/** The week as one segmented bar: each day with how many players are booked. The day on screen is filled in. */
function WeekBar({ date, counts, compact, onPick }: { date: string; counts: Record<string, number>; compact: boolean; onPick: (d: string) => void }) {
  const monday = weekStart(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return (
    <View style={styles.week}>
      <WeekArrow icon="chevronLeft" name="Previous week" onPress={() => onPick(addDays(date, -7))} />
      {days.map((d) => {
        const on = d === date;
        const { weekday, day, long } = dayParts(d);
        const n = counts[d];
        return (
          <Pressable
            key={d}
            accessibilityRole="button"
            accessibilityLabel={`${long}${n !== undefined ? `, ${n} booked` : ""}`}
            accessibilityState={{ selected: on }}
            onPress={() => onPick(d)}
            style={({ hovered, focused }: WebPress) => [styles.day, hovered && !on && { backgroundColor: colors.strip }, on && styles.dayOn, focused && styles.focusRing]}
          >
            <Text style={[styles.dayText, on && { color: "#fff" }]} numberOfLines={1}>
              <Text style={styles.dayWeekday}>{(compact ? weekday.slice(0, 2) : weekday).toUpperCase()} </Text>
              {day}
            </Text>
            {!compact && <Text style={[styles.dayCount, on && { color: "rgba(255,255,255,0.85)" }]}>{n === undefined ? " " : `${n} booked`}</Text>}
          </Pressable>
        );
      })}
      <WeekArrow icon="chevronRight" name="Next week" onPress={() => onPick(addDays(date, 7))} />
    </View>
  );
}

function WeekArrow({ icon, name, onPress }: { icon: IconName; name: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={({ hovered, focused }: WebPress) => [styles.arrow, hovered && { backgroundColor: colors.rowLine }, focused && styles.focusRing]}>
      <Icon name={icon} size={14} color={colors.text} />
    </Pressable>
  );
}

/** The strip at the top of the sheet: the day's numbers on the left and the color key on the right. */
function StatsStrip({ error, loading, totals, compact, showKey }: { error?: string; loading: boolean; totals: { players: number; checkedIn: number; open: number; collected: number }; compact: boolean; showKey: boolean }) {
  const stat = (value: string, label: string) => (
    <Text style={styles.statLabel} accessibilityLabel={`${value} ${label}`}>
      <Text style={styles.statValue}>{value}</Text> {label}
    </Text>
  );
  return (
    <View style={styles.heading}>
      {error ? (
        <Text style={styles.offline} numberOfLines={1}>{error}</Text>
      ) : loading ? (
        <Text style={styles.statLabel}>Loading…</Text>
      ) : (
        <View style={styles.stats}>
          {stat(String(totals.players), totals.players === 1 ? "player" : "players")}
          {stat(String(totals.checkedIn), "checked in")}
          {stat(String(totals.open), compact ? "open" : "open spots")}
          {stat(dollars(totals.collected), "collected")}
        </View>
      )}
      {!compact && showKey && <Legend />}
    </View>
  );
}

/** A text button on the dark toolbar. */
function BarButton({ label, primary, disabled, onPress }: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [
        styles.barButton,
        primary && styles.barButtonPrimary,
        hovered && !disabled && { backgroundColor: primary ? colors.primaryText : colors.railHover },
        disabled && { opacity: 0.45 },
        focused && styles.focusRing,
      ]}
    >
      <Text style={styles.barButtonText}>{label}</Text>
    </Pressable>
  );
}

function ToolButton({ icon, label, on, disabled, onPress }: { icon: IconName; label: string; on?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: on }}
      aria-pressed={on}
      disabled={disabled}
      onPress={onPress}
      {...({ title: label } as object)}
      style={({ hovered, focused }: WebPress) => [styles.tool, on && styles.toolOn, hovered && !disabled && !on && { backgroundColor: colors.railHover }, disabled && { opacity: 0.4 }, focused && styles.focusRing]}
    >
      <Icon name={icon} size={18} color={on ? "#fff" : colors.railText} />
    </Pressable>
  );
}

function Legend() {
  return (
    <View style={styles.legend} accessibilityLabel="Color key">
      {(Object.keys(slotColor) as SlotState[]).map((s) => (
        <View key={s} style={styles.legendItem} accessibilityLabel={slotLabel[s]}>
          <View style={[styles.legendSwatch, { backgroundColor: slotColor[s] }]} />
          <Text style={styles.legendText}>{slotShort[s]}</Text>
        </View>
      ))}
    </View>
  );
}

function playersOn(teeTimes: SheetTeeTime[]) {
  return teeTimes.flatMap((t) => t.bookings).filter((b) => b.status !== "cancelled" && b.status !== "no_show").reduce((s, b) => s + b.players, 0);
}

/** The row's status box: money owed first, then where the groups are in their round. */
function rowTag(groups: SheetBooking[], blocked: boolean, owed: number, compact: boolean): { text: string; color: string } | undefined {
  if (blocked) return { text: "Blocked", color: "#5b6574" };
  if (!groups.length) return undefined;
  if (owed > 0) return { text: compact ? dollars(owed) : `Owes ${dollars(owed)}`, color: colors.warn };
  if (groups.every((b) => b.status === "no_show")) return { text: "No-show", color: slotColor.no_show };
  if (groups.some((b) => b.status === "teed_off")) return { text: "On course", color: slotColor.teed_off };
  if (groups.some((b) => b.status === "checked_in")) return { text: "Checked in", color: slotColor.checked_in };
  return { text: "Paid", color: slotColor.prepaid };
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
  onPress: (bookingId?: string, player?: number) => void;
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
  // A tap on a name also reaches the row behind it; the row shouldn't then open the whole time instead.
  const nameTapped = useRef(0);
  const groups = teeTime.bookings.filter((b) => b.status !== "cancelled");
  const blocked = teeTime.status === "blocked";
  // No-shows aren't expected to pay, so they don't count toward what's owed.
  const owed = groups.filter((b) => b.status !== "no_show").reduce((s, b) => s + b.payment.balanceCents, 0);
  const carts = groups.flatMap((b) => b.cartNumbers);
  const tag = rowTag(groups, blocked, owed, compact);

  // One slot per player: each group fills as many slots as it has players, in booking order.
  const slots: { booking?: SheetBooking; first: boolean; player: number }[] = [];
  for (const b of groups) for (let i = 0; i < b.players && slots.length < teeTime.maxPlayers; i++) slots.push({ booking: b, first: i === 0, player: i });
  while (slots.length < teeTime.maxPlayers) slots.push({ first: false, player: 0 });
  const open = teeTime.maxPlayers - teeTime.bookedPlayers;
  const firstOpen = slots.findIndex((x) => !x.booking);
  const slotWidth = slotsWidth / teeTime.maxPlayers;
  // Only groups still playing can take guests, and only into open spots.
  const canGuest = (b: SheetBooking) => !blocked && open > 0 && slotWidth > 0 && b.status !== "no_show" && b.status !== "cancelled";
  // Groups that haven't teed off yet can be dragged up or down to another time.
  const canMove = (b: SheetBooking) => b.status === "confirmed" || b.status === "checked_in";
  const dragProps = (b: SheetBooking, player = 0) => ({
    canGuest: canGuest(b),
    canMove: canMove(b),
    maxGuests: open,
    slotWidth,
    onTap: () => {
      nameTapped.current = Date.now();
      onPress(b.id, player);
    },
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
      onPress={() => Date.now() - nameTapped.current > 400 && onPress()}
      style={({ hovered, focused }: WebPress) => [
        styles.row,
        hovered && { backgroundColor: "#f7f8fa" },
        selected && styles.rowSelected,
        moveTarget === "ok" && styles.rowDropOk,
        moveTarget === "full" && styles.rowDropFull,
        focused && styles.focusRing,
      ]}
    >
      <View style={[styles.timeCol, compact && { width: 48, paddingHorizontal: 6 }]}>
        {/* Earlier tee times today: the time goes grey, the players keep their full colors. */}
        <Text style={[styles.rowTime, past && { color: colors.muted }]} numberOfLines={1}>{clock(teeTime.localTime, compact)}</Text>
      </View>
      {priceCents !== undefined && (
        <View style={styles.price}>
          <Text style={styles.priceText}>{blocked ? "" : dollars(priceCents)}</Text>
        </View>
      )}
      <View style={styles.playerCol}>
      {blocked ? (
        <View style={styles.blockedBar}>
          <Text style={styles.blockedText} numberOfLines={1}>Blocked{teeTime.note ? `: ${teeTime.note}` : ""}</Text>
        </View>
      ) : (
        <View style={styles.slots} onLayout={(e) => setSlotsWidth(e.nativeEvent.layout.width)}>
          {compact
            ? // Phones: one bar per group across its players, so the whole name fits.
              [
                ...groups.map((b) => (
                  <DragName key={b.id} {...dragProps(b)} style={[styles.slot, { flex: b.players, backgroundColor: slotColor[stateOf(b)] }, lifted(b)]}>
                    <Text style={styles.slotText} numberOfLines={1}>
                      {b.customerName}
                      {b.players > 1 ? ` (${b.players})` : ""}
                    </Text>
                  </DragName>
                )),
                ...slots
                  .map((x, i) =>
                    x.booking ? null : (
                      <View key={`open${i}`} style={[styles.slot, styles.slotOpen, ghost(i) && styles.slotGhost]} />
                    ),
                  )
                  .filter(Boolean),
              ]
            : slots.map((s, i) =>
            s.booking ? (
              <DragName
                key={i}
                {...dragProps(s.booking, s.player)}
                // Only the group's name slides; the guest spots behind it just open the group.
                canGuest={s.first && canGuest(s.booking)}
                canMove={s.first && canMove(s.booking)}
                style={[styles.slot, { backgroundColor: slotColor[stateOf(s.booking)] }, lifted(s.booking)]}
              >
                <Text style={styles.slotText} numberOfLines={1}>
                  {s.first ? s.booking.customerName : `${lastName(s.booking.customerName)} guest`}
                </Text>
              </DragName>
            ) : ghost(i) ? (
              <View key={i} style={[styles.slot, styles.slotOpen, styles.slotGhost]}>
                <Text style={styles.ghostText}>+ Guest</Text>
              </View>
            ) : (
              <View key={i} style={[styles.slot, styles.slotOpen]} accessibilityLabel="Open">
                <Text style={styles.openText} numberOfLines={1}>{i === firstOpen && teeTime.note ? teeTime.note : "Open"}</Text>
              </View>
            ),
          )}
        </View>
      )}
      </View>
      {/* Carts and the status sit in their own columns so they stay visible when names are cut off. */}
      {!compact && (
        <View style={styles.cartCol} accessibilityLabel={carts.length ? `${carts.length === 1 ? "Cart" : "Carts"} ${carts.join(", ")}` : undefined}>
          {carts.length > 0 && (
            <>
              <Text style={styles.cart} numberOfLines={1}>{carts.length === 1 ? "Cart" : "Carts"} {carts.join(", ")}</Text>
            </>
          )}
        </View>
      )}
      <View style={[styles.endCol, compact && { width: 78, paddingHorizontal: 6, borderLeftWidth: 0 }]}>
        {moveTarget ? (
          <Text style={[styles.pay, { color: moveTarget === "ok" ? colors.primaryText : colors.noShow }]} numberOfLines={1}>
            {moveTarget === "ok" ? "Move here" : blocked ? "Blocked" : "No room"}
          </Text>
        ) : (
          tag && (
            <View style={[styles.tag, { backgroundColor: tag.color }, compact && { paddingHorizontal: 4 }]}>
              <Text style={[styles.tagText, compact && { fontSize: 10, letterSpacing: 0 }]} numberOfLines={1}>{tag.text}</Text>
            </View>
          )
        )}
        {compact && carts.length > 0 && (
          <View style={styles.cartRow} accessibilityLabel={`${carts.length === 1 ? "Cart" : "Carts"} ${carts.join(", ")}`}>
            <Icon name="cart" size={13} color={colors.muted} />
            <Text style={styles.cart} numberOfLines={1}>{carts.join(", ")}</Text>
          </View>
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
  noticeButton: { paddingHorizontal: 6, minHeight: 28, justifyContent: "center", borderRadius: 0 },
  noticeAction: { color: "#8fd3ad", fontWeight: "700", fontSize: 13 },
  noticeClose: { color: "#c9ccd1", fontSize: 13 },
  slotGhost: { borderColor: colors.primary, borderStyle: "solid", backgroundColor: colors.primaryLight },
  ghostText: { color: colors.primaryText, fontSize: 12, fontWeight: "700" },
  empty: { color: colors.muted, textAlign: "center", marginTop: 40, paddingHorizontal: 24, fontSize: 14, lineHeight: 22 },
  focusRing: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid", outlineOffset: -2 } as object,
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, paddingTop: 14, gap: 12 },
  card: { flex: 1, backgroundColor: colors.card, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, overflow: "hidden" },
  tool: { width: 34, height: 34, borderRadius: 0, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.toolbarLine, backgroundColor: "transparent" },
  toolOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  addButton: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 0, backgroundColor: colors.primary },
  barButton: { height: 32, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1, borderColor: colors.toolbarLine },
  barButtonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary, paddingHorizontal: 14 },
  barButtonText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  // The day's numbers and the color key, in one strip across the top of the sheet.
  heading: { minHeight: 36, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 18, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.strip, borderBottomWidth: 1, borderColor: colors.border },
  stats: { flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 18 },
  statValue: { fontSize: 14, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  statLabel: { fontSize: 12, color: "#3a4452" },
  offline: { fontSize: 13, color: colors.noShow, fontWeight: "600" },
  // The week: one bar of square segments with arrows at each end.
  week: { flexDirection: "row", alignItems: "stretch", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  arrow: { width: 34, alignItems: "center", justifyContent: "center", backgroundColor: colors.strip },
  day: { flex: 1, minWidth: 0, paddingVertical: 6, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderColor: colors.border },
  dayOn: { backgroundColor: colors.primary },
  dayWeekday: { fontSize: 11, fontWeight: "400", letterSpacing: 0.6 },
  dayText: { fontSize: 14, fontWeight: "700", color: colors.text, textAlign: "center" },
  dayCount: { fontSize: 11, color: "#5a6576", marginTop: 1 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 18 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendSwatch: { width: 11, height: 11 },
  legendText: { fontSize: 12, color: "#3a4452" },
  // A row is a line of cells, like a spreadsheet: time, price, the four players, carts and status.
  row: { height: ROW_HEIGHT, flexDirection: "row", alignItems: "stretch", backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.rowLine },
  rowSelected: { backgroundColor: colors.primaryLight },
  timeCol: { width: 78, justifyContent: "center", paddingHorizontal: 12, backgroundColor: colors.bg },
  rowTime: { fontSize: 13, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
  price: { width: 50, justifyContent: "center", paddingHorizontal: 8, borderLeftWidth: 1, borderColor: colors.rowLine },
  priceText: { fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] },
  playerCol: { flex: 1, minWidth: 0, justifyContent: "center", paddingHorizontal: 8, borderLeftWidth: 1, borderColor: colors.rowLine },
  slots: { flexDirection: "row", gap: 2, minWidth: 0 },
  slot: { flex: 1, height: 24, justifyContent: "center", paddingHorizontal: 8, minWidth: 0 },
  slotOpen: { borderWidth: 1, borderStyle: "dashed", borderColor: "#a3adba" },
  slotText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  openText: { color: "#5a6576", fontSize: 12 },
  blockedBar: { height: 24, backgroundColor: "#d5dae0", justifyContent: "center", paddingHorizontal: 10 },
  blockedText: { color: "#27303c", fontSize: 12, fontWeight: "600" },
  cartCol: { width: 100, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, borderLeftWidth: 1, borderColor: colors.rowLine },
  cart: { fontSize: 12, color: "#3a4452" },
  cartRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  endCol: { width: 118, alignItems: "flex-end", justifyContent: "center", paddingHorizontal: 12, borderLeftWidth: 1, borderColor: colors.rowLine },
  pay: { fontWeight: "700", fontSize: 12 },
  // Status as a small solid box, the same colors as the players' boxes.
  tag: { paddingHorizontal: 7, paddingVertical: 3 },
  tagText: { color: "#fff", fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  side: { width: 400, borderLeftWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
});
