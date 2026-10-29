import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, DayClose, Me, MoneyMethod, Report } from "./api";
import { addDays, dayParts, todayIn, weekStart } from "./dates";
import { colors, money, radius, type WebPress } from "./theme";

type Period = "today" | "yesterday" | "week" | "last-week" | "month" | "last-month";

const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "last-week", label: "Last week" },
  { id: "month", label: "This month" },
  { id: "last-month", label: "Last month" },
];

const METHOD_LABEL: Record<MoneyMethod, string> = {
  cash: "Cash",
  card: "Card",
  check: "Check",
  gift_card: "Gift card",
  house_account: "Charged to house accounts",
  punch_card: "Punch card",
  season_pass: "Season pass",
  loyalty: "Loyalty points",
  rain_check: "Rain check",
  prepaid: "Prepaid online",
  comp: "Comp",
};

const SOURCE_LABEL: Record<string, string> = { staff: "Pro shop / walk-in", phone: "Phone", teeitup: "TeeItUp", golfnow: "GolfNow", import: "Imported" };

function rangeFor(period: Period, today: string): [string, string] {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (period) {
    case "today":
      return [today, today];
    case "yesterday":
      return [addDays(today, -1), addDays(today, -1)];
    case "week":
      return [weekStart(today), today];
    case "last-week":
      return [addDays(weekStart(today), -7), addDays(weekStart(today), -1)];
    case "month":
      return [monthStart, today];
    case "last-month": {
      const end = addDays(monthStart, -1);
      return [`${end.slice(0, 7)}-01`, end];
    }
  }
}

const shortDate = (date: string) => {
  const d = dayParts(date);
  return `${d.weekday} ${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
};

/**
 * Reports for managers (revenue, money taken, rounds and hours) and the end-of-day close,
 * which anyone at the pro shop can do by counting the cash drawer.
 */
export function ReportsScreen({ client, me, timeZone }: { client: Client; me: Me | undefined; timeZone: string }) {
  const isManager = me?.role === "manager";
  const today = todayIn(timeZone);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <DayCloseCard client={client} today={today} isManager={isManager} />
      {isManager ? <ManagerReports client={client} today={today} /> : <Text style={styles.muted}>Sales and revenue reports are for managers.</Text>}
    </ScrollView>
  );
}

function ManagerReports({ client, today }: { client: Client; today: string }) {
  const [period, setPeriod] = useState<Period>("today");
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState<string>();
  const [from, to] = rangeFor(period, today);

  useEffect(() => {
    setReport(undefined);
    setError(undefined);
    client.report(from, to).then(setReport).catch((e) => setError(e.message));
  }, [client, from, to]);

  const r = report;
  return (
    <View>
      <View style={[styles.row, { marginTop: 20, marginBottom: 12 }]}>
        <Text role="heading" aria-level={2} style={[styles.title, { flex: 1, minWidth: 200 }]}>
          {from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`}
        </Text>
        {r && Platform.OS === "web" && <Button label="Download CSV" onPress={() => downloadCsv(r)} />}
      </View>
      <View style={[styles.choices, { marginBottom: 14 }]}>
        {PERIODS.map((p) => (
          <Chip key={p.id} label={p.label} on={period === p.id} onPress={() => setPeriod(p.id)} />
        ))}
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!r ? (
        !error && <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <View style={styles.stats}>
            <Stat label="Revenue (before tax)" value={money(r.revenue.totalCents)} />
            <Stat label="Money taken" value={money(r.collected.totalCents)} />
            <Stat label="Sales tax collected" value={money(r.revenue.salesTaxCents)} />
            <Stat label="Rounds played" value={String(r.rounds.played)} />
            <Stat label="Occupancy" value={r.rounds.occupancy === null ? "–" : `${r.rounds.occupancy}%`} />
            <Stat label="No-shows" value={String(r.rounds.noShows)} warn={r.rounds.noShows > 0} />
            <Stat label="Staff hours" value={`${r.labor.hours} h`} />
          </View>

          <View style={[styles.row, { alignItems: "flex-start", marginTop: 12 }]}>
            <Breakdown
              title="Revenue"
              rows={[
                ["Green fees", r.revenue.greenFeesCents],
                ["Carts and extras", r.revenue.cartsAndExtrasCents],
                ["Pro shop", r.revenue.proShopCents],
                ...(r.revenue.foodBevCents ? ([["Food and drink", r.revenue.foodBevCents]] as [string, number][]) : []),
                ...(r.revenue.eventsCents ? ([["Leagues and outings", r.revenue.eventsCents]] as [string, number][]) : []),
              ]}
              total={["Total", r.revenue.totalCents]}
              note={r.revenue.proShopRefundsCents ? `Pro shop refunds: ${money(r.revenue.proShopRefundsCents)} (already left out)` : undefined}
            />
            <Breakdown
              title="Money taken"
              rows={(Object.keys(METHOD_LABEL) as MoneyMethod[]).filter((m) => r.collected[m]).map((m) => [METHOD_LABEL[m], r.collected[m]])}
              total={["Total", r.collected.totalCents]}
              note={[
                "Prepaid online was collected by the booking provider, not at the course.",
                r.other.giftCardsSoldCents ? `Includes ${money(r.other.giftCardsSoldCents)} of gift cards sold, which count as revenue when they're spent.` : "",
                r.other.accountPaymentsCents ? `Includes ${money(r.other.accountPaymentsCents)} paid on house accounts, already counted as revenue when charged.` : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
            <Breakdown title="Pro shop by category" rows={r.revenue.proShopByCategory.map((c) => [`${c.category} (${c.items})`, c.cents])} empty="No pro shop sales." />
            {r.revenue.foodBevByCategory.length > 0 && <Breakdown title="Food and drink by category" rows={r.revenue.foodBevByCategory.map((c) => [`${c.category} (${c.items})`, c.cents])} />}
            <View style={[styles.card, styles.breakdown]}>
              <Text style={styles.label}>Players by booking source</Text>
              {Object.keys(r.rounds.bySource).length === 0 && <Text style={styles.muted}>No bookings.</Text>}
              {Object.entries(r.rounds.bySource)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <View key={k} style={styles.rowBetween}>
                    <Text style={styles.text}>{SOURCE_LABEL[k] ?? k}</Text>
                    <Text style={styles.text}>{v}</Text>
                  </View>
                ))}
            </View>
          </View>

          <Text style={[styles.label, { marginTop: 18 }]}>By day</Text>
          <ScrollView horizontal contentContainerStyle={{ minWidth: "100%" }}>
            <View role="table" aria-label="Revenue by day" style={[styles.table, { flex: 1, minWidth: 720 }]}>
              <View role="row" style={[styles.tableRow, styles.head]}>
                {["Day", "Rounds", "Green fees", "Carts & extras", "Pro shop", "Sales tax", "Taken"].map((h, i) => (
                  <Text key={h} role="columnheader" style={[styles.headText, i === 0 ? { flex: 1 } : styles.num]}>
                    {h}
                  </Text>
                ))}
              </View>
              {r.days.length === 0 && <Text style={[styles.text, { padding: 12 }]}>Nothing in this period yet.</Text>}
              {r.days.map((d) => (
                <View key={d.date} role="row" style={styles.tableRow}>
                  <Text role="cell" style={[styles.text, { flex: 1 }]}>{shortDate(d.date)}</Text>
                  <Text role="cell" style={[styles.text, styles.num]}>{d.rounds}</Text>
                  <Text role="cell" style={[styles.text, styles.num]}>{money(d.greenFeesCents)}</Text>
                  <Text role="cell" style={[styles.text, styles.num]}>{money(d.cartsAndExtrasCents)}</Text>
                  <Text role="cell" style={[styles.text, styles.num]}>{money(d.proShopCents)}</Text>
                  <Text role="cell" style={[styles.text, styles.num]}>{money(d.taxCents)}</Text>
                  <Text role="cell" style={[styles.strong, styles.num]}>{money(d.collectedCents)}</Text>
                </View>
              ))}
              {r.days.length > 1 && (
                <View role="row" style={[styles.tableRow, styles.head]}>
                  <Text role="cell" style={[styles.strong, { flex: 1 }]}>Total</Text>
                  <Text role="cell" style={[styles.strong, styles.num]}>{r.rounds.played}</Text>
                  <Text role="cell" style={[styles.strong, styles.num]}>{money(r.revenue.greenFeesCents)}</Text>
                  <Text role="cell" style={[styles.strong, styles.num]}>{money(r.revenue.cartsAndExtrasCents)}</Text>
                  <Text role="cell" style={[styles.strong, styles.num]}>{money(r.revenue.proShopCents)}</Text>
                  <Text role="cell" style={[styles.strong, styles.num]}>{money(r.revenue.salesTaxCents)}</Text>
                  <Text role="cell" style={[styles.strong, styles.num]}>{money(r.collected.totalCents)}</Text>
                </View>
              )}
            </View>
          </ScrollView>
          <Text style={styles.muted}>
            Green fees and carts count on the day of the round; money taken counts on the day it was paid. No-shows and cancellations are left out of revenue.
          </Text>
        </>
      )}
    </View>
  );
}

/** Counts the cash drawer against what the tee sheet and register took in cash today. */
function DayCloseCard({ client, today, isManager }: { client: Client; today: string; isManager: boolean }) {
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<DayClose>();
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [redo, setRedo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setDay(undefined);
    setRedo(false);
    setCounted("");
    setNote("");
    client.dayClose(date).then(setDay).catch((e) => setError(e.message));
  }, [client, date]);

  const cents = /^\d+(\.\d{0,2})?$/.test(counted.replace(/[$,\s]/g, "")) ? Math.round(Number(counted.replace(/[$,\s]/g, "")) * 100) : undefined;
  const diff = cents === undefined || !day ? undefined : cents - day.expected.cash;

  async function close() {
    setBusy(true);
    setError(undefined);
    try {
      setDay(await client.closeDay(date, { countedCashCents: cents!, note: note.trim() || null }));
      setRedo(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't close the day");
    } finally {
      setBusy(false);
    }
  }

  const showForm = day && (!day.close || redo);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text role="heading" aria-level={2} style={[styles.title, { flex: 1, minWidth: 180 }]}>
          Close the day
        </Text>
        <Button label="‹" label2="Previous day" onPress={() => setDate(addDays(date, -1))} />
        <Text style={styles.strong}>{date === today ? "Today" : shortDate(date)}</Text>
        <Button label="›" label2="Next day" disabled={date >= today} onPress={() => setDate(addDays(date, 1))} />
      </View>
      {!day ? (
        error ? <Text role="alert" style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <View style={[styles.stats, { marginTop: 10 }]}>
            {(Object.keys(METHOD_LABEL) as MoneyMethod[])
              .filter((m) => m === "cash" || m === "card" || day.expected[m])
              .map((m) => (
                <Stat key={m} label={`${METHOD_LABEL[m]} taken`} value={money(day.expected[m])} />
              ))}
          </View>
          {day.close && !redo && (
            <View style={[styles.notice, day.close.overShortCents !== 0 && { backgroundColor: "#fbebeb" }]} accessibilityLiveRegion="polite">
              <Text style={styles.strong}>
                Closed by {day.close.closedBy ?? "a shared device"} at{" "}
                {new Date(day.close.closedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. Counted {money(day.close.countedCashCents)} cash against{" "}
                {money(day.close.expectedCashCents)} expected:{" "}
                {day.close.overShortCents === 0 ? "balanced" : day.close.overShortCents > 0 ? `${money(day.close.overShortCents)} over` : `${money(-day.close.overShortCents)} short`}.
              </Text>
              {day.close.note && <Text style={styles.text}>{day.close.note}</Text>}
              {day.close.expectedCashCents !== day.expected.cash && (
                <Text style={styles.text}>More cash has been taken since then ({money(day.expected.cash)} now).</Text>
              )}
              {isManager && (
                <View style={[styles.choices, { marginTop: 8 }]}>
                  <Button label="Count again" onPress={() => setRedo(true)} />
                </View>
              )}
            </View>
          )}
          {showForm && (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.text}>Count the cash in the drawer (leaving out the starting float) and enter it here.</Text>
              <View style={[styles.row, { marginTop: 8 }]}>
                <TextInput accessibilityLabel="Cash counted" placeholder="Cash counted, e.g. 412.50" value={counted} onChangeText={setCounted} keyboardType="decimal-pad" style={[styles.input, { width: 220 }]} />
                {diff !== undefined && (
                  <Text style={[styles.strong, { color: diff === 0 ? colors.checkedIn : colors.noShow }]}>
                    {diff === 0 ? "Balanced" : diff > 0 ? `${money(diff)} over` : `${money(-diff)} short`}
                  </Text>
                )}
              </View>
              {diff !== undefined && diff !== 0 && (
                <TextInput accessibilityLabel="Why it's over or short" placeholder="Why it's over or short (required)" value={note} onChangeText={setNote} style={[styles.input, { marginTop: 8 }]} />
              )}
              {error && <Text role="alert" style={styles.error}>{error}</Text>}
              <View style={[styles.choices, { marginTop: 10 }]}>
                <Button label={busy ? "Closing…" : "Close the day"} primary disabled={busy || cents === undefined || (diff !== 0 && !note.trim())} onPress={close} />
                {redo && <Button label="Cancel" onPress={() => setRedo(false)} />}
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}

/** A spreadsheet of the period for the bookkeeper, one row per day. */
function downloadCsv(r: Report) {
  const cell = (c: number) => (c / 100).toFixed(2);
  const lines = [
    ["Date", "Rounds", "Green fees", "Carts and extras", "Pro shop", "Food and drink", "Leagues and outings", "Sales tax", "Money taken"].join(","),
    ...r.days.map((d) =>
      [d.date, d.rounds, cell(d.greenFeesCents), cell(d.cartsAndExtrasCents), cell(d.proShopCents), cell(d.foodBevCents), cell(d.eventsCents), cell(d.taxCents), cell(d.collectedCents)].join(","),
    ),
    [
      "Total",
      r.rounds.played,
      cell(r.revenue.greenFeesCents),
      cell(r.revenue.cartsAndExtrasCents),
      cell(r.revenue.proShopCents),
      cell(r.revenue.foodBevCents),
      cell(r.revenue.eventsCents),
      cell(r.revenue.salesTaxCents),
      cell(r.collected.totalCents),
    ].join(","),
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `river-bend-${r.from}-to-${r.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Breakdown({ title, rows, total, note, empty }: { title: string; rows: [string, number][]; total?: [string, number]; note?: string; empty?: string }) {
  return (
    <View style={[styles.card, styles.breakdown]}>
      <Text style={styles.label}>{title}</Text>
      {rows.length === 0 && <Text style={styles.muted}>{empty ?? "Nothing yet."}</Text>}
      {rows.map(([k, v]) => (
        <View key={k} style={styles.rowBetween}>
          <Text style={styles.text}>{k}</Text>
          <Text style={styles.text}>{money(v)}</Text>
        </View>
      ))}
      {total && rows.length > 0 && (
        <View style={[styles.rowBetween, styles.totalLine]}>
          <Text style={styles.strong}>{total[0]}</Text>
          <Text style={styles.strong}>{money(total[1])}</Text>
        </View>
      )}
      {note && <Text style={styles.small}>{note}</Text>}
    </View>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, warn && { color: colors.noShow }]}>{value}</Text>
      <Text style={styles.small}>{label}</Text>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, on && styles.buttonOn, hovered && !on && { backgroundColor: colors.bg }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function Button(props: { label: string; label2?: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const { label, label2, onPress, primary, disabled } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label2 ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, primary && styles.buttonOn, hovered && !primary && { backgroundColor: colors.bg }, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, paddingVertical: 2 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
  title: { fontSize: 16, fontWeight: "700", color: colors.text },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 12 },
  breakdown: { flex: 1, minWidth: 240 },
  totalLine: { borderTopWidth: 1, borderColor: colors.border, marginTop: 4, paddingTop: 4 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, paddingVertical: 8, minWidth: 140 },
  statValue: { fontSize: 18, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card },
  tableRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderColor: colors.border },
  head: { backgroundColor: colors.bg },
  headText: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  num: { width: 100, textAlign: "right", fontVariant: ["tabular-nums"] },
  label: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
  text: { color: colors.text, fontSize: 13, lineHeight: 19 },
  strong: { color: colors.text, fontSize: 13, fontWeight: "700" },
  small: { color: colors.muted, fontSize: 11, marginTop: 6 },
  muted: { color: colors.muted, fontSize: 12, marginTop: 8 },
  notice: { backgroundColor: colors.primaryLight, borderRadius: radius, padding: 10, marginTop: 10, gap: 4 },
  error: { color: colors.noShow, marginVertical: 8 },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, minHeight: 32, justifyContent: "center", backgroundColor: colors.card },
  buttonOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { fontSize: 13, fontWeight: "600", color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: colors.text, backgroundColor: "#fff" },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
