import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { addDays, weekStart } from "./dates";
import { colors, type WebPress } from "./theme";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const monthName = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/** A month calendar for jumping the tee sheet to any date, far ahead or back. */
export function CalendarPicker({ date, today, onPick, onClose }: { date: string; today: string; onPick: (d: string) => void; onClose: () => void }) {
  const [month, setMonth] = useState(date.slice(0, 7));
  const first = weekStart(`${month}-01`);
  // Six rows always fit any month, and keep the calendar the same height as you page through.
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close calendar" style={styles.backdrop} onPress={onClose}>
        <Pressable role="dialog" aria-label="Choose a date" style={styles.card} onPress={() => undefined}>
          <View style={styles.head}>
            <Arrow label="‹" name="Previous month" onPress={() => setMonth(shiftMonth(month, -1))} />
            <Text role="heading" style={styles.month} accessibilityLiveRegion="polite">{monthName(month)}</Text>
            <Arrow label="›" name="Next month" onPress={() => setMonth(shiftMonth(month, 1))} />
          </View>
          <View style={styles.row}>
            {WEEKDAYS.map((w) => (
              <Text key={w} style={styles.weekday} aria-hidden>{w}</Text>
            ))}
          </View>
          {[0, 1, 2, 3, 4, 5].map((r) => (
            <View key={r} style={styles.row}>
              {cells.slice(r * 7, r * 7 + 7).map((d) => {
                const inMonth = d.startsWith(month);
                const on = d === date;
                const isToday = d === today;
                return (
                  <Pressable
                    key={d}
                    accessibilityRole="button"
                    accessibilityLabel={new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) + (isToday ? ", today" : "")}
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      onPick(d);
                      onClose();
                    }}
                    style={({ hovered, focused }: WebPress) => [
                      styles.cell,
                      hovered && !on && { backgroundColor: colors.primaryLight },
                      isToday && !on && styles.today,
                      on && styles.on,
                      focused && styles.focusRing,
                    ]}
                  >
                    <Text style={[styles.cellText, !inMonth && { color: "#a9a8a0" }, on && { color: "#fff", fontWeight: "700" }]}>
                      {Number(d.slice(8))}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          <View style={styles.foot}>
            <Pressable accessibilityRole="button" onPress={() => { onPick(today); onClose(); }} hitSlop={8}>
              <Text style={styles.link}>Today</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
              <Text style={styles.link}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Arrow({ label, name, onPress }: { label: string; name: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={({ focused }: WebPress) => [styles.arrow, focused && styles.focusRing]}>
      <Text style={styles.arrowText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 16 },
  card: { backgroundColor: colors.card, borderRadius: 3, padding: 16, width: "100%", maxWidth: 380 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  month: { fontSize: 16, fontWeight: "700", color: colors.text },
  row: { flexDirection: "row" },
  weekday: { flex: 1, textAlign: "center", color: colors.muted, fontSize: 12, fontWeight: "600", paddingVertical: 6 },
  cell: { flex: 1, aspectRatio: 1, minHeight: 34, alignItems: "center", justifyContent: "center", borderRadius: 3, margin: 1 },
  cellText: { fontSize: 14, color: colors.text },
  today: { borderWidth: 2, borderColor: colors.primary },
  on: { backgroundColor: colors.primary },
  foot: { flexDirection: "row", justifyContent: "space-between", marginTop: 12, paddingHorizontal: 4 },
  link: { color: colors.primary, fontWeight: "600", fontSize: 14, textDecorationLine: "underline" },
  arrow: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 3 },
  arrowText: { fontSize: 20, color: colors.text },
  focusRing: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
