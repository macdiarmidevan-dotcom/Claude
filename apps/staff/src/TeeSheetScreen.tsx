import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { ApiError, createClient, type Course, type Settings, type SheetTeeTime } from "./api";
import { addDays, formatDate, nowIn, todayIn } from "./dates";
import { TeeTimePanel } from "./TeeTimePanel";
import { colors, formatTime, statusColor } from "./theme";

// Other devices' changes show up within this many seconds.
const REFRESH_MS = 5000;

export function TeeSheetScreen({ settings, onSignOut }: { settings: Settings; onSignOut: () => void }) {
  const client = useMemo(() => createClient(settings), [settings]);
  const { width } = useWindowDimensions();
  const wide = width >= 900; // iPad landscape and desktop: list and details side by side

  const [course, setCourse] = useState<Course>();
  const [date, setDate] = useState<string>();
  const [sheet, setSheet] = useState<SheetTeeTime[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();
  const [lastSync, setLastSync] = useState<Date>();
  const listRef = useRef<FlatList<SheetTeeTime>>(null);
  const scrolledFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    client
      .course()
      .then((c) => {
        setCourse(c);
        setDate(todayIn(c.timeZone));
      })
      .catch((e) => setError(e.message));
  }, [client]);

  const load = useCallback(async () => {
    if (!date) return;
    try {
      const res = await client.teeSheet(date);
      setSheet(res.teeTimes);
      setError(undefined);
      setLastSync(new Date());
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

  const isToday = course && date === todayIn(course.timeZone);
  const nextIndex = useMemo(() => {
    if (!sheet || !course || !isToday) return -1;
    const now = nowIn(course.timeZone);
    return sheet.findIndex((t) => t.localTime >= now);
  }, [sheet, course, isToday]);

  // Jump to the next tee time once per day viewed, so starters land where the action is.
  useEffect(() => {
    if (sheet && date && scrolledFor.current !== date && nextIndex > 0) {
      scrolledFor.current = date;
      setTimeout(() => listRef.current?.scrollToIndex({ index: Math.max(0, nextIndex - 1), animated: false }), 50);
    }
  }, [sheet, date, nextIndex]);

  const selected = sheet?.find((t) => t.id === selectedId);
  const totals = useMemo(() => {
    const players = sheet?.reduce((s, t) => s + t.bookedPlayers, 0) ?? 0;
    const capacity = sheet?.filter((t) => t.status === "open").reduce((s, t) => s + t.maxPlayers, 0) ?? 0;
    return { players, capacity };
  }, [sheet]);

  const panel = selected && course && sheet && (
    <TeeTimePanel
      key={selected.id}
      client={client}
      teeTime={selected}
      sheet={sheet}
      courseHoles={course.holes}
      onChanged={load}
      onClose={() => setSelectedId(undefined)}
    />
  );

  return (
    <View style={styles.page}>
      <View style={styles.topBar}>
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.courseName} numberOfLines={1}>{course?.name ?? "Loading…"}</Text>
          <Text style={styles.sync}>
            {error ?? (lastSync ? `${totals.players} golfers booked · ${Math.max(0, totals.capacity - totals.players)} spots open` : " ")}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onSignOut} hitSlop={8}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

      {date && (
        <View style={styles.dateBar}>
          <NavButton label="‹" onPress={() => setDate(addDays(date, -1))} />
          <View style={{ alignItems: "center", flex: 1 }}>
            <Text style={styles.date}>{formatDate(date)}</Text>
            {!isToday && course && (
              <Pressable onPress={() => setDate(todayIn(course.timeZone))}>
                <Text style={styles.today}>Back to today</Text>
              </Pressable>
            )}
          </View>
          <NavButton label="›" onPress={() => setDate(addDays(date, 1))} />
        </View>
      )}

      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ flex: 1 }}>
          {!sheet ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.green} />
          ) : sheet.length === 0 ? (
            <Text style={styles.empty}>No tee times on this day.</Text>
          ) : (
            <FlatList
              ref={listRef}
              data={sheet}
              keyExtractor={(t) => t.id}
              getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
              renderItem={({ item, index }) => (
                <TeeTimeRow
                  teeTime={item}
                  selected={item.id === selectedId}
                  isNext={index === nextIndex}
                  past={isToday === true && nextIndex !== -1 && index < nextIndex}
                  onPress={() => setSelectedId(item.id)}
                />
              )}
            />
          )}
        </View>
        {wide && <View style={styles.side}>{panel ?? <Text style={styles.empty}>Tap a tee time to check groups in, add walk-ins or block it.</Text>}</View>}
      </View>

      {!wide && (
        <Modal visible={!!panel} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectedId(undefined)}>
          {panel}
        </Modal>
      )}
    </View>
  );
}

const ROW_HEIGHT = 64;

function TeeTimeRow({ teeTime, selected, isNext, past, onPress }: { teeTime: SheetTeeTime; selected: boolean; isNext: boolean; past: boolean; onPress: () => void }) {
  const active = teeTime.bookings.filter((b) => b.status !== "cancelled");
  const blocked = teeTime.status === "blocked";
  const slots = Array.from({ length: teeTime.maxPlayers }, (_, i) => i < teeTime.bookedPlayers);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, blocked && styles.rowBlocked, selected && styles.rowSelected, past && { opacity: 0.55 }]}
    >
      <View style={styles.timeCol}>
        <Text style={styles.rowTime}>{formatTime(teeTime.localTime)}</Text>
        {isNext && <Text style={styles.next}>NEXT</Text>}
      </View>
      <View style={styles.slots}>
        {slots.map((filled, i) => (
          <View key={i} style={[styles.slot, filled && styles.slotFilled, blocked && styles.slotBlocked]} />
        ))}
      </View>
      <View style={{ flex: 1 }}>
        {blocked ? (
          <Text style={styles.blockedText} numberOfLines={1}>Blocked{teeTime.note ? ` · ${teeTime.note}` : ""}</Text>
        ) : active.length === 0 ? (
          <Text style={styles.openText} numberOfLines={1}>{teeTime.note ?? "Open"}</Text>
        ) : (
          active.map((b) => (
            <Text key={b.id} numberOfLines={1} style={styles.groupText}>
              <Text style={{ color: statusColor[b.status], fontWeight: "700" }}>{b.status === "checked_in" ? "✓ " : b.status === "no_show" ? "✕ " : ""}</Text>
              {b.customerName} ({b.players}){b.holes > 9 ? ` · ${b.holes}` : ""}
              {b.cartNumbers.length > 0 && <Text style={styles.cartTag}>{` · Cart ${b.cartNumbers.join(", ")}`}</Text>}
            </Text>
          ))
        )}
      </View>
    </Pressable>
  );
}

function NavButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.navButton}>
      <Text style={{ fontSize: 28, color: colors.green, lineHeight: 30 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  topBar: { backgroundColor: colors.green, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  courseName: { color: "#fff", fontSize: 20, fontWeight: "700" },
  sync: { color: "#cfe3d5", fontSize: 13, marginTop: 2 },
  signOut: { color: "#cfe3d5", fontSize: 14 },
  dateBar: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border, paddingVertical: 6, paddingHorizontal: 8 },
  date: { fontSize: 17, fontWeight: "600", color: colors.text },
  today: { color: colors.green, fontSize: 13, marginTop: 2, fontWeight: "600" },
  navButton: { width: 48, height: 44, alignItems: "center", justifyContent: "center" },
  empty: { color: colors.muted, textAlign: "center", marginTop: 40, paddingHorizontal: 24, fontSize: 15 },
  row: { height: ROW_HEIGHT, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  rowBlocked: { backgroundColor: colors.blocked },
  rowSelected: { backgroundColor: colors.greenLight },
  timeCol: { width: 78 },
  rowTime: { fontSize: 17, fontWeight: "700", color: colors.text },
  next: { fontSize: 10, fontWeight: "800", color: colors.green, letterSpacing: 1 },
  slots: { flexDirection: "row", gap: 4, width: 76 },
  slot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: colors.green },
  slotFilled: { backgroundColor: colors.green },
  slotBlocked: { borderColor: colors.muted, backgroundColor: colors.muted },
  blockedText: { color: colors.muted, fontStyle: "italic" },
  openText: { color: colors.muted },
  groupText: { color: colors.text, fontSize: 15 },
  cartTag: { color: colors.greenText, fontWeight: "700" },
  side: { width: 400, borderLeftWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
});
