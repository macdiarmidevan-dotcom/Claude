import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { TIME_BANDS, type AdviceCell } from "@golf/core";
import type { AdviceBasis, Client, RateAdvice } from "./api";
import { colors, money, type WebPress } from "./theme";
import { BAND_COLORS, ChartCard, DOWN, GroupedColumns, Legend, PriceMoves, Row, SignedColumns, Tile, Tiles, TODAY, UP } from "./PricingCharts";

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
        {advice && <Text style={[styles.help, { marginTop: 10 }]}>Based on {shortDate(advice.from)} to {shortDate(advice.to)}.</Text>}
      </View>

      {advice && <AdviceGlance advice={advice} count={count} />}

      {advice && (
        <View style={styles.card}>
          <Text style={[styles.help, { marginBottom: 8 }]}>Each box shows the suggested price, the change from today's nonresident rate, and how full those times were. Tap one to see why.</Text>
          <ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
            <View role="table" aria-label="Recommended rates by day and time" style={{ flexGrow: 1 }}>
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

      {advice && <AdviceCharts advice={advice} />}

      {a && (
        <Text style={styles.help}>
          How it works: there's no way to know yet whether your overall price level is right, so a time as full as your average ({Math.round(advice!.averageFillPct)}% for this period) keeps today's rate, and the rest are priced around it. Golfers who want busy times are assumed to care less about price than golfers at quiet times. Times at least {Math.round(a.fullAt * 100)}% full are treated as turning golfers away. Suggestions stay within {Math.round(a.maxChange * 100)}% of today's rate and aim for no more than {Math.round(a.targetFill * 100)}% full to leave room for walk-ups. Food and pro shop sales aren't counted yet. Price tests at your course will replace these guesses later.
        </Text>
      )}

      {advice && <AdviceData advice={advice} />}
    </ScrollView>
  );
}

const whole = (cents: number) => `${cents < 0 ? "−" : ""}$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
const signedWhole = (cents: number) => (Math.round(cents / 100) === 0 ? "$0" : `${cents > 0 ? "+" : "−"}${whole(Math.abs(cents))}`);

/** The headline numbers: what following the advice is worth, how full the course is, and how many prices move. */
function AdviceGlance({ advice, count }: { advice: RateAdvice; count: (s: AdviceCell["status"]) => number }) {
  const priced = advice.cells.filter((c) => c.recommendedCents !== null);
  const spots = priced.reduce((s, c) => s + c.spots, 0);
  const now = priced.reduce((s, c) => s + c.greenFeeCents + c.extrasCents, 0);
  const expected = priced.reduce((s, c) => s + (c.projectedRevenuePerSpotCents ?? 0) * c.spots, 0);
  const moves = priced.filter((c) => c.status !== "hold").map((c) => (c.recommendedCents! - c.currentCents!) / c.currentCents!);
  const full = advice.cells.filter((c) => c.turnedAway).length;
  const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.round(Math.abs(x) * 100)}%`;
  const maxPct = Math.round(advice.assumptions.maxChange * 100);
  return (
    <Tiles>
      <Tile label="Expected gain a week" value={signedWhole(advice.weeklyGainCents)} note={`About ${signedWhole(advice.weeklyGainCents * 52)} a year if every suggestion is followed`} tone={advice.weeklyGainCents > 0 ? UP : advice.weeklyGainCents < 0 ? DOWN : undefined} />
      <Tile label="Money per open spot" value={spots ? money(Math.round(now / spots)) : "–"} note={spots ? `${money(Math.round(expected / spots))} expected at suggested prices` : "Not enough data"} />
      <Tile label="Average fill" value={`${Math.round(advice.averageFillPct)}%`} note={`${full} of 28 times ${full === 1 ? "was" : "were"} ${Math.round(advice.assumptions.fullAt * 100)}% full or more`} />
      <Tile label="Prices to change" value={`${count("raise")} up · ${count("lower")} down`} note={`${count("hold")} kept, ${count("no_data") + count("no_rate")} without enough data`} />
      <Tile label="Size of changes" value={moves.length ? `${pct(Math.min(...moves))} to ${pct(Math.max(...moves))}` : "None"} note={`Never more than ${maxPct}% either way`} />
    </Tiles>
  );
}

/** Charts: how full each day and time was, what moves, and where the money comes from. */
function AdviceCharts({ advice }: { advice: RateAdvice }) {
  const cells = advice.cells;
  const at = (day: number, band: string) => cells.find((c) => c.weekday === day && c.band === band)!;
  const prices = cells.flatMap((c) => (c.currentCents !== null && c.recommendedCents !== null ? [c.currentCents, c.recommendedCents] : []));
  const lo = prices.length ? Math.floor(Math.min(...prices) / 500) * 500 : 0;
  const hi = prices.length ? Math.ceil(Math.max(...prices) / 500) * 500 : 10000;
  const byDay = DAYS.map((label, i) => ({ label, value: cells.filter((c) => c.weekday === i + 1).reduce((s, c) => s + c.weeklyGainCents, 0) }));
  const perSpot = DAYS.map((label, i) => ({ label, values: TIME_BANDS.map((b) => at(i + 1, b.id).revenuePerSpotCents) }));
  const topPerSpot = Math.max(1000, ...perSpot.flatMap((g) => g.values.map((v) => v ?? 0)));
  const series = TIME_BANDS.map((b, i) => ({ label: b.label, color: BAND_COLORS[i]! }));
  return (
    <>
      <Row>
        <ChartCard half title="How full each day and time was" note={`Players who came over open spots. The dashed line is the course average (${Math.round(advice.averageFillPct)}%): times above it are priced up, times below it down.`}>
          <GroupedColumns
            groups={DAYS.map((label, i) => ({ label, values: TIME_BANDS.map((b) => at(i + 1, b.id).fillPct) }))}
            series={series}
            max={Math.min(100, Math.ceil(Math.max(10, ...cells.map((c) => c.fillPct ?? 0)) / 10) * 10 + 10)}
            format={(v) => `${Math.round(v)}%`}
            reference={{ value: advice.averageFillPct, label: "Course average" }}
          />
        </ChartCard>
        <ChartCard half title="Expected gain a week, by day" note="Extra green fees, carts and extras a week if that day's suggestions are followed.">
          <SignedColumns items={byDay} format={signedWhole} />
        </ChartCard>
      </Row>
      <ChartCard title="Today's price and the suggested one" note="Nonresident adult green fee. The hollow dot is today's rate and the solid dot the suggestion: green is a raise, orange a cut, grey keeps the price.">
        <Row>
          {TIME_BANDS.map((b) => (
            <View key={b.id} style={styles.moveBox}>
              <Text style={styles.moveTitle}>{b.label}</Text>
              <PriceMoves rows={DAYS.map((label, i) => ({ label, today: at(i + 1, b.id).currentCents, suggested: at(i + 1, b.id).recommendedCents }))} min={lo} max={hi} />
            </View>
          ))}
        </Row>
        <Legend items={[{ label: "Today", color: TODAY, dot: true }, { label: "Raise", color: UP, dot: true }, { label: "Lower", color: DOWN, dot: true }]} />
      </ChartCard>
      <ChartCard title="Money per open spot" note="Green fees plus carts and extras over every open spot on the tee sheet, as it went in this period. Busy times that already earn the most are where a raise costs the fewest golfers.">
        <GroupedColumns groups={perSpot} series={series} max={Math.ceil(topPerSpot / 1000) * 1000} format={(v) => whole(v)} />
      </ChartCard>
    </>
  );
}

const COLUMNS: { label: string; width: number; help: string }[] = [
  { label: "Day", width: 96, help: "" },
  { label: "Time", width: 116, help: "" },
  { label: "Tee times", width: 76, help: "Open tee times in the period (blocked times left out)" },
  { label: "Open spots", width: 84, help: "Player spots on those tee times" },
  { label: "Players", width: 68, help: "Players who came" },
  { label: "No-shows", width: 76, help: "Booked players who didn't show" },
  { label: "Fill", width: 64, help: "Players over open spots" },
  { label: "vs average", width: 80, help: "Fill compared with the course average; 1.00 is average" },
  { label: "Green fee paid", width: 104, help: "Average first-loop green fee per player, after resident, senior and other rates" },
  { label: "Extras per player", width: 116, help: "Carts, rentals and other extras per player" },
  { label: "Money per spot", width: 104, help: "Green fees plus extras over open spots" },
  { label: "Today's rate", width: 210, help: "Nonresident adult rate at these times" },
  { label: "Price response", width: 104, help: "Assumed share of players lost for each share of price added" },
  { label: "Turned away", width: 88, help: "At least 90% full, so counted as turning golfers away" },
  { label: "Suggested", width: 104, help: "" },
  { label: "Players a week", width: 104, help: "Expected change in players a week at the suggested price" },
  { label: "Money a week", width: 104, help: "Expected change in green fees and extras a week" },
];

const signed = (cents: number) => (cents === 0 ? "$0.00" : `${cents > 0 ? "+" : "−"}${money(Math.abs(cents))}`);

/** Every number that goes into the suggestions, one row per day and time, with the settings used. */
function AdviceData({ advice }: { advice: RateAdvice }) {
  const a = advice.assumptions;
  const bandIndex = (c: AdviceCell) => TIME_BANDS.findIndex((b) => b.id === c.band);
  const rows = [...advice.cells].sort((x, y) => x.weekday - y.weekday || bandIndex(x) - bandIndex(y));
  const total = (k: "teeTimes" | "spots" | "players" | "noShows" | "greenFeeCents" | "extrasCents" | "weeklyGainCents") => rows.reduce((s, c) => s + c[k], 0);
  const players = total("players");
  const spots = total("spots");
  const settings: [string, string][] = [
    ["Period", `${shortDate(advice.from)} to ${shortDate(advice.to)} (${advice.weeks} weeks${advice.basis === "last_year" ? ", one year ago" : ""})`],
    ["Course average fill", `${advice.averageFillPct}%, from times with at least ${a.minSpots} open spots`],
    ["Times treated as turning golfers away", `${Math.round(a.fullAt * 100)}% full or more, with ${Math.round((a.turnedAway - 1) * 100)}% more golfers assumed to have wanted them`],
    ["Most players expected", `${Math.round(a.targetFill * 100)}% of open spots, leaving room for walk-ups`],
    ["Largest change", `${Math.round(a.maxChange * 100)}% from today's rate, in whole dollars`],
    ["Smallest gain worth a change", `${Math.round(a.minGain * 1000) / 10}% more money per open spot`],
    ["Price response", `At an average time it's set so today's rate earns the most, then multiplied by (average fill ÷ fill) to the power ${a.busyBend}`],
    ["Not counted yet", "Food, bar and pro shop sales, weather, holidays and how far ahead people book"],
  ];
  const right = { textAlign: "right" as const };
  const td = (key: string, text: string, width: number, extra?: object) => (
    <Text key={key} role="cell" style={[styles.td, { flexGrow: width, flexBasis: width }, extra]}>
      {text}
    </Text>
  );
  const w = COLUMNS.map((c) => c.width);
  return (
    <View style={[styles.card, { marginTop: 14 }]}>
      <Text role="heading" aria-level={2} style={styles.title}>The data behind these rates</Text>
      <Text style={[styles.help, { marginBottom: 10 }]}>Everything the suggestions are worked out from, for the period picked above.</Text>
      <View role="table" aria-label="Settings used" style={{ marginBottom: 14 }}>
        {settings.map(([k, v]) => (
          <View key={k} role="row" style={styles.settingRow}>
            <Text role="rowheader" style={styles.settingKey}>{k}</Text>
            <Text role="cell" style={styles.settingValue}>{v}</Text>
          </View>
        ))}
      </View>
      <ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
        <View role="table" aria-label="Data for each day and time" style={{ flexGrow: 1 }}>
          <View role="row" style={[styles.tr, { backgroundColor: colors.strip }]}>
            {COLUMNS.map((c, i) => (
              <Text key={c.label} role="columnheader" accessibilityHint={c.help || undefined} style={[styles.th, { flexGrow: c.width, flexBasis: c.width }, i >= 2 && right]}>
                {c.label}
              </Text>
            ))}
          </View>
          {rows.map((c) => {
            const has = c.recommendedCents !== null;
            const dash = (v: string | null) => v ?? "–";
            return (
              <View key={`${c.weekday}-${c.band}`} role="row" style={styles.tr}>
                {td("day", DAY_NAMES[c.weekday - 1]!, w[0]!, { fontWeight: "600" })}
                {td("time", TIME_BANDS[bandIndex(c)]!.label, w[1]!)}
                {td("tt", String(c.teeTimes), w[2]!, right)}
                {td("sp", String(c.spots), w[3]!, right)}
                {td("pl", String(c.players), w[4]!, right)}
                {td("ns", String(c.noShows), w[5]!, right)}
                {td("fill", dash(c.fillPct === null ? null : `${c.fillPct.toFixed(1)}%`), w[6]!, right)}
                {td("rel", dash(c.relativeFill === null ? null : c.relativeFill.toFixed(2)), w[7]!, right)}
                {td("gf", dash(c.avgGreenFeeCents === null ? null : money(c.avgGreenFeeCents)), w[8]!, right)}
                {td("ex", dash(c.extrasPerPlayerCents === null ? null : money(c.extrasPerPlayerCents)), w[9]!, right)}
                {td("rps", dash(c.revenuePerSpotCents === null ? null : money(c.revenuePerSpotCents)), w[10]!, right)}
                {td("rate", dash(c.currentCents === null ? null : `${money(c.currentCents)} · ${c.currentRateName}`), w[11]!, right)}
                {td("resp", dash(c.priceResponse === null ? null : c.priceResponse.toFixed(2)), w[12]!, right)}
                {td("ta", has ? (c.turnedAway ? "Yes" : "No") : "–", w[13]!, right)}
                {td("sug", has ? money(c.recommendedCents!) : change(c), w[14]!, has ? { ...right, fontWeight: "700" } : { ...right, color: colors.muted })}
                {td("pw", has ? `${c.weeklyPlayersChange > 0 ? "+" : ""}${c.weeklyPlayersChange}` : "–", w[15]!, right)}
                {td("mw", has ? signed(c.weeklyGainCents) : "–", w[16]!, right)}
              </View>
            );
          })}
          <View role="row" style={[styles.tr, { backgroundColor: colors.strip }]}>
            {td("day", "Whole week", w[0]! + w[1]!, { fontWeight: "700" })}
            {td("tt", String(total("teeTimes")), w[2]!, { ...right, fontWeight: "700" })}
            {td("sp", String(spots), w[3]!, { ...right, fontWeight: "700" })}
            {td("pl", String(players), w[4]!, { ...right, fontWeight: "700" })}
            {td("ns", String(total("noShows")), w[5]!, { ...right, fontWeight: "700" })}
            {td("fill", spots ? `${Math.round((players / spots) * 1000) / 10}%` : "–", w[6]!, { ...right, fontWeight: "700" })}
            {td("rel", "", w[7]!)}
            {td("gf", players ? money(Math.round(total("greenFeeCents") / players)) : "–", w[8]!, { ...right, fontWeight: "700" })}
            {td("ex", players ? money(Math.round(total("extrasCents") / players)) : "–", w[9]!, { ...right, fontWeight: "700" })}
            {td("rps", spots ? money(Math.round((total("greenFeeCents") + total("extrasCents")) / spots)) : "–", w[10]!, { ...right, fontWeight: "700" })}
            {td("gap", "", w.slice(11, 16).reduce((s, x) => s + x, 0))}
            {td("mw", signed(total("weeklyGainCents")), w[16]!, { ...right, fontWeight: "700" })}
          </View>
        </View>
      </ScrollView>
      <Text style={[styles.help, { marginTop: 10 }]}>
        Fill and money count players who came; no-shows are left out. "vs average" above 1.00 means busier than the course's average time. Price response −0.80 means about 8% fewer players for a price 10% higher, and 8% more for a price 10% lower.
      </Text>
    </View>
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
  moveBox: { flexGrow: 1, flexBasis: 220, minWidth: 0, paddingVertical: 6, paddingRight: 12 },
  moveTitle: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", marginBottom: 4 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginTop: 12 },
  stat: { minWidth: 110 },
  statLabel: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  statValue: { fontSize: 16, color: colors.text, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 2 },
  gridRow: { flexDirection: "row" },
  bandCell: { width: 120, paddingRight: 8, justifyContent: "center" },
  bandText: { fontSize: 13, fontWeight: "600", color: colors.text, paddingVertical: 8 },
  dayHead: { flexGrow: 1, flexBasis: 104, textAlign: "center", fontSize: 12, fontWeight: "700", color: colors.muted, paddingVertical: 6, backgroundColor: colors.strip, borderWidth: 1, borderColor: colors.rowLine, marginLeft: -1 },
  cell: { flexGrow: 1, flexBasis: 104, height: 74, borderWidth: 1, borderColor: colors.rowLine, marginLeft: -1, marginTop: -1, alignItems: "center", justifyContent: "center", gap: 1 },
  cellOpen: { borderColor: colors.primary, borderWidth: 2, zIndex: 1 },
  price: { fontSize: 17, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  delta: { fontSize: 12, fontWeight: "700" },
  fill: { fontSize: 11, color: colors.muted },
  settingRow: { flexDirection: "row", flexWrap: "wrap", borderBottomWidth: 1, borderColor: colors.rowLine, paddingVertical: 6, columnGap: 12 },
  settingKey: { width: 280, fontSize: 13, fontWeight: "600", color: colors.text },
  settingValue: { flex: 1, minWidth: 220, fontSize: 13, color: colors.text },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.rowLine },
  th: { fontSize: 12, fontWeight: "700", color: colors.muted, paddingVertical: 7, paddingHorizontal: 6 },
  td: { fontSize: 13, color: colors.text, paddingVertical: 6, paddingHorizontal: 6, fontVariant: ["tabular-nums"] },
  detail: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
