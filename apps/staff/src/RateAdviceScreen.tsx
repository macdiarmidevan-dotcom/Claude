import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { TIME_BANDS, type AdviceCell } from "@golf/core";
import type { AdviceBasis, Client, RateAdvice } from "./api";
import { colors, money, type WebPress } from "./theme";

// Recommended rates: a suggested green fee for each day and time of day, from how full the tee
// sheet was. Managers only. It never changes a price; the manager decides, and changes the rate
// here and in the booking provider if they agree.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PERIODS: { label: string; weeks: number; basis: AdviceBasis }[] = [
  { label: "Last 4 weeks", weeks: 4, basis: "recent" },
  { label: "Last 8 weeks", weeks: 8, basis: "recent" },
  { label: "Last 12 weeks", weeks: 12, basis: "recent" },
  { label: "Next 8 weeks, last year", weeks: 8, basis: "last_year" },
];
const TONE = {
  raise: { bg: "#e3f0e8", fg: colors.checkedIn },
  lower: { bg: "#fbefe3", fg: colors.warn },
  hold: { bg: "#ffffff", fg: colors.muted },
  no_data: { bg: colors.strip, fg: colors.muted },
  no_rate: { bg: colors.strip, fg: colors.muted },
};

const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const change = (c: AdviceCell) => {
  if (c.status === "no_data") return "Too little data";
  if (c.status === "no_rate") return "No rate";
  const diff = c.recommendedCents! - c.currentCents!;
  return diff === 0 ? "Keep" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}`;
};

export function RateAdviceScreen({ client }: { client: Client }) {
  const [period, setPeriod] = useState(1);
  const [advice, setAdvice] = useState<RateAdvice>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    const p = PERIODS[period]!;
    setError(undefined);
    client.rateAdvice(p.weeks, p.basis).then(setAdvice).catch((e) => setError(e.message));
  }, [client, period]);

  const cells = advice?.cells ?? [];
  const selected = cells.find((c) => `${c.weekday}-${c.band}` === open);
  const count = (s: AdviceCell["status"]) => cells.filter((c) => c.status === s).length;
  const a = advice?.assumptions;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.title}>Recommended rates</Text>
        <Text style={styles.help}>
          A suggested green fee for each day and time, from how full the tee sheet was and what golfers spent on carts and extras. Nothing changes on its own: if you agree, edit the rate on the Rates tab and in your booking provider.
        </Text>
        <View style={styles.row} role="radiogroup" aria-label="Based on">
          {PERIODS.map((p, i) => (
            <Pressable
              key={p.label}
              role="radio"
              aria-checked={period === i}
              onPress={() => setPeriod(i)}
              style={({ hovered, focused }: WebPress) => [styles.chip, hovered && period !== i && { backgroundColor: colors.bg }, period === i && styles.chipOn, focused && styles.focus]}
            >
              <Text style={[styles.chipText, period === i && { color: "#fff" }]}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
        {advice && (
          <View style={styles.stats}>
            <Stat label="Expected if you follow them all" value={`${advice.weeklyGainCents >= 0 ? "+" : "−"}${money(Math.abs(advice.weeklyGainCents))} a week`} />
            <Stat label="Raise" value={String(count("raise"))} />
            <Stat label="Lower" value={String(count("lower"))} />
            <Stat label="Keep" value={String(count("hold"))} />
            <Stat label="Average fill" value={`${Math.round(advice.averageFillPct)}%`} />
            <Stat label="Based on" value={`${shortDate(advice.from)} to ${shortDate(advice.to)}`} />
          </View>
        )}
      </View>

      {advice && (
        <View style={styles.card}>
          <Text style={[styles.help, { marginBottom: 8 }]}>Each box shows the suggested price, the change from today's nonresident rate, and how full those times were. Tap one to see why.</Text>
          <ScrollView horizontal>
            <View role="table" aria-label="Recommended rates by day and time">
              <View role="row" style={styles.gridRow}>
                <View style={styles.bandCell} />
                {DAYS.map((d) => (
                  <Text key={d} role="columnheader" style={[styles.dayHead]}>{d}</Text>
                ))}
              </View>
              {TIME_BANDS.map((band) => (
                <View key={band.id} role="row" style={styles.gridRow}>
                  <Text role="rowheader" style={[styles.bandCell, styles.bandText]}>{band.label}</Text>
                  {DAYS.map((_, i) => {
                    const c = cells.find((x) => x.weekday === i + 1 && x.band === band.id)!;
                    const key = `${c.weekday}-${c.band}`;
                    const tone = TONE[c.status];
                    const has = c.recommendedCents !== null;
                    return (
                      <Pressable
                        key={key}
                        role="cell"
                        accessibilityLabel={`${DAY_NAMES[i]} ${band.label}: ${has ? `suggested ${money(c.recommendedCents!)}, ${change(c)}` : change(c)}${c.fillPct !== null ? `, ${Math.round(c.fillPct)}% full` : ""}`}
                        aria-selected={open === key}
                        onPress={() => setOpen(open === key ? undefined : key)}
                        style={({ hovered, focused }: WebPress) => [styles.cell, { backgroundColor: tone.bg }, hovered && { borderColor: colors.primary }, open === key && styles.cellOpen, focused && styles.focus]}
                      >
                        <Text style={styles.price}>{has ? money(c.recommendedCents!) : "–"}</Text>
                        <Text style={[styles.delta, { color: tone.fg }]}>{change(c)}</Text>
                        {c.fillPct !== null && <Text style={styles.fill}>{Math.round(c.fillPct)}% full</Text>}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
          {selected && (
            <View style={styles.detail}>
              <Text style={styles.strong}>
                {DAY_NAMES[selected.weekday - 1]}, {TIME_BANDS.find((b) => b.id === selected.band)!.label.toLowerCase()}
              </Text>
              <Text style={[styles.help, { marginVertical: 4 }]}>{selected.reason}</Text>
              <View style={styles.stats}>
                {selected.currentCents !== null && <Stat label={`Today (${selected.currentRateName})`} value={money(selected.currentCents)} />}
                {selected.recommendedCents !== null && <Stat label="Suggested" value={money(selected.recommendedCents)} />}
                <Stat label="Players / open spots" value={`${selected.players} / ${selected.spots}`} />
                {selected.noShowPct !== null && <Stat label="No-shows" value={`${Math.round(selected.noShowPct)}%`} />}
                {selected.revenuePerSpotCents !== null && <Stat label="Money per open spot" value={money(selected.revenuePerSpotCents)} />}
                {selected.projectedRevenuePerSpotCents !== null && selected.status !== "hold" && <Stat label="Expected at suggested price" value={money(selected.projectedRevenuePerSpotCents)} />}
              </View>
            </View>
          )}
        </View>
      )}

      {a && (
        <Text style={styles.help}>
          How it works: there's no way to know yet whether your overall price level is right, so a time as full as your average ({Math.round(advice!.averageFillPct)}% for this period) keeps today's rate, and the rest are priced around it. Golfers who want busy times are assumed to care less about price than golfers at quiet times. Times at least {Math.round(a.fullAt * 100)}% full are treated as turning golfers away. Suggestions stay within {Math.round(a.maxChange * 100)}% of today's rate and aim for no more than {Math.round(a.targetFill * 100)}% full to leave room for walk-ups. Food and pro shop sales aren't counted yet. Price tests at your course will replace these guesses later.
        </Text>
      )}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16 },
  card: { borderWidth: 1, borderColor: colors.border, padding: 14, backgroundColor: colors.card, marginBottom: 14 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 4 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.noShow, marginBottom: 8, fontSize: 13 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: { borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginTop: 12 },
  stat: { minWidth: 110 },
  statLabel: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  statValue: { fontSize: 16, color: colors.text, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 2 },
  gridRow: { flexDirection: "row" },
  bandCell: { width: 120, paddingRight: 8, justifyContent: "center" },
  bandText: { fontSize: 13, fontWeight: "600", color: colors.text, paddingVertical: 8 },
  dayHead: { width: 104, textAlign: "center", fontSize: 12, fontWeight: "700", color: colors.muted, paddingVertical: 6, backgroundColor: colors.strip, borderWidth: 1, borderColor: colors.rowLine, marginLeft: -1 },
  cell: { width: 104, height: 74, borderWidth: 1, borderColor: colors.rowLine, marginLeft: -1, marginTop: -1, alignItems: "center", justifyContent: "center", gap: 1 },
  cellOpen: { borderColor: colors.primary, borderWidth: 2, zIndex: 1 },
  price: { fontSize: 17, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  delta: { fontSize: 12, fontWeight: "700" },
  fill: { fontSize: 11, color: colors.muted },
  detail: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
