import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BalancesReport, Client, Departments, InventoryReport, LaborReport, MoneyMethod, Overview, ReportCompare, RoundsSummary } from "./api";
import { addDays, todayIn } from "./dates";
import { colors, radius, type WebPress } from "./theme";

// Manager reports: the revenue dashboard and rounds and utilization, with revenue per round and
// the rate mix. Both tabs share the same dates, so switching between them keeps the period.

export type Preset = "today" | "yesterday" | "7d" | "30d" | "month" | "last-month" | "ytd";
export interface ReportRange {
  preset: Preset;
  compare: ReportCompare;
}
export const DEFAULT_RANGE: ReportRange = { preset: "30d", compare: "previous" };

const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "ytd", label: "Year to date" },
];
const COMPARES: { id: ReportCompare; label: string }[] = [
  { id: "previous", label: "Previous period" },
  { id: "last_year", label: "Same dates last year" },
  { id: "none", label: "No comparison" },
];

function datesFor(preset: Preset, today: string): [string, string] {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "today":
      return [today, today];
    case "yesterday":
      return [addDays(today, -1), addDays(today, -1)];
    case "7d":
      return [addDays(today, -6), today];
    case "30d":
      return [addDays(today, -29), today];
    case "month":
      return [monthStart, today];
    case "last-month": {
      const end = addDays(monthStart, -1);
      return [`${end.slice(0, 7)}-01`, end];
    }
    case "ytd":
      return [`${today.slice(0, 4)}-01-01`, today];
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const short = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
const span = (from: string, to: string) => (from === to ? short(from) : `${short(from)} to ${short(to)}${from.slice(0, 4) !== to.slice(0, 4) || from.slice(0, 4) !== String(new Date().getFullYear()) ? `, ${to.slice(0, 4)}` : ""}`);
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const cents2 = (cents: number | null) => (cents == null ? "–" : `$${(cents / 100).toFixed(2)}`);
const count = (n: number) => n.toLocaleString("en-US");
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;

const DEPARTMENTS: { key: keyof Omit<Departments, "totalCents">; label: string; color: string }[] = [
  { key: "greenFeesCents", label: "Green fees", color: "#1f6fd1" },
  { key: "cartsAndExtrasCents", label: "Carts and extras", color: "#7fb0ea" },
  { key: "proShopCents", label: "Pro shop", color: "#2e7d4f" },
  { key: "foodBevCents", label: "Food and drink", color: "#c27c0e" },
  { key: "eventsCents", label: "Leagues and outings", color: "#7b4fb3" },
];
const SOURCE_LABEL: Record<string, string> = { staff: "Pro shop / walk-in", phone: "Phone", teeitup: "TeeItUp", golfnow: "GolfNow", import: "Imported" };

function useOverview(client: Client, timeZone: string, range: ReportRange) {
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState<string>();
  const [from, to] = datesFor(range.preset, todayIn(timeZone));
  useEffect(() => {
    let live = true;
    setError(undefined);
    client
      .overview(from, to, range.compare)
      .then((o) => live && setData(o))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the report"));
    return () => {
      live = false;
    };
  }, [client, from, to, range.compare]);
  const current = data && data.from === from && data.to === to && (data.compare?.kind ?? "none") === range.compare ? data : undefined;
  return { data: current, stale: data, error };
}

export function OverviewReport({ client, timeZone, view, range, onRange }: { client: Client; timeZone: string; view: "revenue" | "rounds"; range: ReportRange; onRange: (r: ReportRange) => void }) {
  const { data, stale, error } = useOverview(client, timeZone, range);
  const shown = data ?? stale;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.bar}>
        <View style={styles.choices}>
          {PRESETS.map((p) => (
            <Chip key={p.id} label={p.label} on={range.preset === p.id} onPress={() => onRange({ ...range, preset: p.id })} />
          ))}
        </View>
        <View style={[styles.choices, { marginTop: 6 }]}>
          <Text style={styles.compareLabel}>Compare with</Text>
          {COMPARES.map((c) => (
            <Chip key={c.id} label={c.label} on={range.compare === c.id} onPress={() => onRange({ ...range, compare: c.id })} small />
          ))}
          {shown && Platform.OS === "web" && (
            <Pressable accessibilityRole="button" onPress={() => downloadCsv(shown, view)} style={({ focused }: WebPress) => [styles.csv, focused && styles.focus]}>
              <Text style={styles.csvText}>Download CSV</Text>
            </Pressable>
          )}
        </View>
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!shown && !error && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
      {shown && (
        <View style={{ opacity: data ? 1 : 0.55 }}>
          <Text style={styles.period}>
            {span(shown.from, shown.to)}
            {shown.compare && <Text style={styles.periodMuted}>{`  ·  compared with ${span(shown.compare.from, shown.compare.to)}`}</Text>}
          </Text>
          {view === "revenue" ? <RevenueView o={shown} /> : <RoundsView o={shown} />}
        </View>
      )}
    </ScrollView>
  );
}

/** Reports › Labor: what the hours on the time clock cost, against the revenue they brought in. */
export function LaborReportScreen({ client, timeZone, range, onRange, onOpenStaff }: { client: Client; timeZone: string; range: ReportRange; onRange: (r: ReportRange) => void; onOpenStaff?: () => void }) {
  const [data, setData] = useState<LaborReport>();
  const [error, setError] = useState<string>();
  const [from, to] = datesFor(range.preset, todayIn(timeZone));
  useEffect(() => {
    let live = true;
    setError(undefined);
    client
      .labor(from, to)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the report"));
    return () => {
      live = false;
    };
  }, [client, from, to]);
  const fresh = data && data.from === from && data.to === to;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={[styles.bar, styles.choices]}>
        {PRESETS.map((p) => (
          <Chip key={p.id} label={p.label} on={range.preset === p.id} onPress={() => onRange({ ...range, preset: p.id })} />
        ))}
        {data && Platform.OS === "web" && (
          <Pressable accessibilityRole="button" onPress={() => laborCsv(data)} style={({ focused }: WebPress) => [styles.csv, focused && styles.focus]}>
            <Text style={styles.csvText}>Download CSV</Text>
          </Pressable>
        )}
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
      {data && (
        <View style={{ opacity: fresh ? 1 : 0.55 }}>
          <Text style={styles.period}>{span(data.from, data.to)}</Text>
          <LaborView r={data} onOpenStaff={onOpenStaff} />
        </View>
      )}
    </ScrollView>
  );
}

function LaborView({ r, onOpenStaff }: { r: LaborReport; onOpenStaff?: () => void }) {
  const t = r.totals;
  const hoursText = (h: number) => `${h.toLocaleString("en-US", { maximumFractionDigits: 1 })} h`;
  // Days for a month or less, weeks up to about four months, months after that.
  const size = r.days.length <= 31 ? "day" : r.days.length <= 120 ? "week" : "month";
  const groups = new Map<string, { label: string; from: string; costCents: number; revenueCents: number; hours: number }>();
  r.days.forEach((d, i) => {
    const key = size === "day" ? d.date : size === "week" ? String(Math.floor(i / 7)) : d.date.slice(0, 7);
    const g = groups.get(key) ?? { label: size === "month" ? MONTHS[Number(d.date.slice(5, 7)) - 1] : short(d.date), from: d.date, costCents: 0, revenueCents: 0, hours: 0 };
    g.costCents += d.costCents;
    g.revenueCents += d.revenueCents;
    g.hours += d.hours;
    groups.set(key, g);
  });
  const list = [...groups.values()];
  const share = (g: { costCents: number; revenueCents: number }) => (g.revenueCents ? (g.costCents / g.revenueCents) * 100 : null);
  // Round the top of the scale up to a multiple of 10%, so the axis reads cleanly.
  const max = Math.max(10, Math.ceil(Math.max(0, ...list.map((g) => share(g) ?? 0)) / 10) * 10);
  const every = Math.ceil(list.length / 8);
  return (
    <>
      <View style={styles.tiles}>
        <Tile label="Labor cost" value={dollars(t.costCents)} note={t.laborPct == null ? "No revenue in this period" : `${t.laborPct}% of revenue`} />
        <Tile label="Hours worked" value={hoursText(t.hours)} note={t.overtimeHours ? `${hoursText(t.overtimeHours)} overtime` : "No overtime"} />
        <Tile label="Revenue per labor hour" value={t.revenuePerHourCents == null ? "–" : cents2(t.revenuePerHourCents)} note={`${dollars(t.revenueCents)} revenue`} />
        <Tile label="Rounds per labor hour" value={t.roundsPerHour == null ? "–" : String(t.roundsPerHour)} note={`${count(t.rounds)} rounds`} />
      </View>

      {(r.missingPay > 0 || r.openPunches > 0) && (
        <View style={styles.notice}>
          {r.missingPay > 0 && (
            <Text style={styles.noticeText}>
              {`${r.missingPay} ${r.missingPay === 1 ? "person has" : "people have"} hours but no pay set, so their hours cost nothing here. Set pay in Staff accounts.`}
              {onOpenStaff && (
                <Text role="link" onPress={onOpenStaff} style={styles.link}>
                  {"  Open Staff accounts"}
                </Text>
              )}
            </Text>
          )}
          {r.openPunches > 0 && <Text style={styles.noticeText}>{`${r.openPunches} ${r.openPunches === 1 ? "person is" : "people are"} clocked in now. Their hours count once they clock out.`}</Text>}
        </View>
      )}

      <Card title="Labor cost as a share of revenue" note={`Hourly pay is for hours on the time clock, with time and a half past ${r.overtimeRule.afterHours} hours in a Monday to Sunday week. Salaries are spread evenly over every day.`}>
        {list.length < 2 ? (
          <Text style={styles.cardNote}>Pick a longer period to see a trend.</Text>
        ) : (
          <View>
            <View style={styles.chartArea}>
              <View style={styles.yAxis}>
                <Text style={styles.axisText}>{`${max}%`}</Text>
                <Text style={styles.axisText}>{`${max / 2}%`}</Text>
                <Text style={styles.axisText}>0%</Text>
              </View>
              <View style={styles.plot}>
                <View style={[styles.gridLine, { top: 0 }]} />
                <View style={[styles.gridLine, { top: "50%" }]} />
                {list.map((g) => {
                  const s = share(g);
                  return (
                    <View
                      key={g.from}
                      role="img"
                      aria-label={`${g.label}: labor ${dollars(g.costCents)} of ${dollars(g.revenueCents)} revenue${s == null ? "" : `, ${s.toFixed(1)}%`}`}
                      style={styles.barSlot}
                    >
                      <View style={{ width: "100%", maxWidth: 28, height: `${Math.min(100, ((s ?? 0) / max) * 100)}%`, backgroundColor: colors.primary }} />
                    </View>
                  );
                })}
              </View>
            </View>
            <View style={styles.xAxis}>
              {list.map((g, i) => (
                <Text key={g.from} numberOfLines={1} style={[styles.axisText, styles.xLabel]}>
                  {i % every === 0 ? g.label : ""}
                </Text>
              ))}
            </View>
            <Text style={[styles.cardNote, { marginTop: 8, marginBottom: 0 }]}>Days with no revenue (closed or rained out) have no bar.</Text>
          </View>
        )}
      </Card>

      <View style={styles.columns}>
        <Card title="By job" half>
          <View style={[styles.tr, styles.th]}>
            <Text style={[styles.thText, { flex: 1 }]}>Job</Text>
            <Text style={[styles.thText, styles.numS]}>Hours</Text>
            <Text style={[styles.thText, styles.num]}>Cost</Text>
            <Text style={[styles.thText, styles.numS]}>Share</Text>
          </View>
          {r.byType.length === 0 && <Text style={styles.cardNote}>Nobody worked in this period.</Text>}
          {r.byType.map((x) => (
            <View key={x.type} style={styles.tr}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.td}>{x.type}</Text>
                <Text style={styles.help}>{`${x.people} ${x.people === 1 ? "person" : "people"}`}</Text>
              </View>
              <Text style={[styles.td, styles.numS]}>{x.hours.toLocaleString("en-US")}</Text>
              <Text style={[styles.td, styles.num]}>{dollars(x.costCents)}</Text>
              <Text style={[styles.td, styles.numS, { color: colors.muted }]}>{t.costCents ? `${Math.round((x.costCents / t.costCents) * 100)}%` : "–"}</Text>
            </View>
          ))}
          <View style={[styles.tr, { borderBottomWidth: 0 }]}>
            <Text style={[styles.td, { flex: 1, fontWeight: "700" }]}>Total</Text>
            <Text style={[styles.td, styles.numS, { fontWeight: "700" }]}>{t.hours.toLocaleString("en-US")}</Text>
            <Text style={[styles.td, styles.num, { fontWeight: "700" }]}>{dollars(t.costCents)}</Text>
            <Text style={styles.numS} />
          </View>
          <Text style={[styles.cardNote, { marginTop: 8 }]}>
            {`Hourly ${dollars(t.hourlyCents)} (overtime ${dollars(t.overtimeCents)} of it), salaries ${dollars(t.salaryCents)}.`}
          </Text>
        </Card>

        <Card title="By person" half note="Worked hours from the time clock next to the hours they were scheduled.">
          <View style={[styles.tr, styles.th]}>
            <Text style={[styles.thText, { flex: 1 }]}>Person</Text>
            <Text style={[styles.thText, styles.numS]}>Worked</Text>
            <Text style={[styles.thText, styles.numS]}>Sched.</Text>
            <Text style={[styles.thText, styles.num]}>Cost</Text>
          </View>
          {r.people.length === 0 && <Text style={styles.cardNote}>Nobody worked in this period.</Text>}
          {r.people.map((p) => (
            <View key={p.id} style={styles.tr}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.td} numberOfLines={1}>{p.name}</Text>
                <Text style={[styles.help, p.missingPay && { color: colors.warn, fontWeight: "700" }]} numberOfLines={1}>
                  {`${p.type} · ${p.pay ? (p.pay.type === "hourly" ? `${cents2(p.pay.cents)}/hr` : `${dollars(p.pay.cents)}/yr`) : "No pay set"}`}
                </Text>
              </View>
              <View style={styles.numS}>
                <Text style={styles.td}>{p.hours}</Text>
                {p.overtimeHours > 0 && <Text style={[styles.help, { color: colors.warn }]}>{`${p.overtimeHours} OT`}</Text>}
              </View>
              <Text style={[styles.td, styles.numS, { color: colors.muted }]}>{p.scheduledHours || "–"}</Text>
              <Text style={[styles.td, styles.num]}>{dollars(p.costCents)}</Text>
            </View>
          ))}
        </Card>
      </View>
    </>
  );
}

/** Loads a report for the picked dates, keeping the last one on screen while the next loads. */
function useRangeReport<T extends { from: string; to: string }>(load: (from: string, to: string) => Promise<T>, timeZone: string, range: ReportRange) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [from, to] = datesFor(range.preset, todayIn(timeZone));
  useEffect(() => {
    let live = true;
    setError(undefined);
    load(from, to)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the report"));
    return () => {
      live = false;
    };
    // load is a client method, stable for the client's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);
  return { data, error, fresh: !!data && data.from === from && data.to === to };
}

function RangeShell<T extends { from: string; to: string }>({ range, onRange, state, csv, children }: { range: ReportRange; onRange: (r: ReportRange) => void; state: { data?: T; error?: string; fresh: boolean }; csv?: (d: T) => void; children: (d: T) => React.ReactNode }) {
  const { data, error, fresh } = state;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={[styles.bar, styles.choices]}>
        {PRESETS.map((p) => (
          <Chip key={p.id} label={p.label} on={range.preset === p.id} onPress={() => onRange({ ...range, preset: p.id })} />
        ))}
        {data && csv && Platform.OS === "web" && (
          <Pressable accessibilityRole="button" onPress={() => csv(data)} style={({ focused }: WebPress) => [styles.csv, focused && styles.focus]}>
            <Text style={styles.csvText}>Download CSV</Text>
          </Pressable>
        )}
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
      {data && (
        <View style={{ opacity: fresh ? 1 : 0.55 }}>
          <Text style={styles.period}>{span(data.from, data.to)}</Text>
          {children(data)}
        </View>
      )}
    </ScrollView>
  );
}

function Row({ cells, head, bold }: { cells: (string | number | React.ReactNode)[]; head?: boolean; bold?: boolean }) {
  return (
    <View style={[styles.tr, head && styles.th]}>
      {cells.map((c, i) => {
        const style = [head ? styles.thText : styles.td, i === 0 ? { flex: 1, minWidth: 0 } : styles.numS, bold && { fontWeight: "700" as const }];
        return typeof c === "string" || typeof c === "number" ? (
          <Text key={i} style={style} numberOfLines={i === 0 ? 1 : undefined}>
            {c}
          </Text>
        ) : (
          <View key={i} style={i === 0 ? { flex: 1, minWidth: 0 } : styles.numS}>
            {c}
          </View>
        );
      })}
    </View>
  );
}

const pctText = (n: number | null) => (n == null ? "–" : `${n}%`);

/** Reports › Inventory: what sold and at what margin, what's on the shelf, and what to reorder. */
export function InventoryReportScreen({ client, timeZone, range, onRange }: { client: Client; timeZone: string; range: ReportRange; onRange: (r: ReportRange) => void }) {
  const state = useRangeReport(client.inventoryReport, timeZone, range);
  return (
    <RangeShell range={range} onRange={onRange} state={state} csv={inventoryCsv}>
      {(r) => (
        <>
          <View style={styles.tiles}>
            <Tile label="Shop sales" value={dollars(r.sales.revenueCents)} note={`${count(r.sales.units)} items, before tax`} />
            <Tile label="Gross margin" value={pctText(r.sales.marginPct)} note={`${dollars(r.sales.marginCents)} over cost`} />
            <Tile label="Stock at cost" value={dollars(r.stock.costCents)} note={`${dollars(r.stock.retailCents)} at retail, ${count(r.stock.units)} items`} />
            <Tile label="To reorder" value={count(r.reorder.length)} note={r.reorder.length ? "At or below reorder level" : "Nothing low"} />
          </View>
          {(r.sales.uncostedRevenueCents > 0 || r.stock.missingCost > 0) && (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                {`${dollars(r.sales.uncostedRevenueCents)} of sales had no product cost, so margin leaves them out.`}
                {r.stock.missingCost ? ` ${r.stock.missingCost} product${r.stock.missingCost === 1 ? "" : "s"} on the shelf ${r.stock.missingCost === 1 ? "has" : "have"} no cost. Add costs in Pro shop › Products.` : ""}
              </Text>
            </View>
          )}
          <View style={styles.columns}>
            <Card title="By category" half note="Cost is each product's cost today.">
              <Row head cells={["Category", "Items", "Sales", "Margin"]} />
              {r.categories.length === 0 && <Text style={styles.cardNote}>Nothing sold in this period.</Text>}
              {r.categories.map((c) => (
                <Row key={c.category} cells={[c.foodBev ? `${c.category} (food & drink)` : c.category, count(c.units), dollars(c.revenueCents), pctText(c.marginPct)]} />
              ))}
            </Card>
            <Card title="Reorder list" half note="Products at or below their reorder level, lowest first.">
              <Row head cells={["Product", "On hand", "Reorder at", "Sold"]} />
              {r.reorder.length === 0 && <Text style={styles.cardNote}>Nothing needs reordering.</Text>}
              {r.reorder.map((p) => (
                <Row key={p.id} cells={[p.sku ? `${p.name} · ${p.sku}` : p.name, <Text style={[styles.td, p.stock <= 0 && { color: colors.noShow, fontWeight: "700" }]}>{p.stock}</Text>, p.reorderLevel, p.soldInPeriod]} />
              ))}
            </Card>
          </View>
          <Card title="Best sellers">
            <Row head cells={["Product", "Items", "Sales", "Margin $", "Margin"]} />
            {r.items.slice(0, 15).map((i) => (
              <Row key={`${i.productId ?? i.name}`} cells={[i.name, count(i.units), dollars(i.revenueCents), i.marginCents == null ? "–" : dollars(i.marginCents), pctText(i.marginPct)]} />
            ))}
            {r.items.length > 15 && <Text style={[styles.cardNote, { marginTop: 8 }]}>{`And ${r.items.length - 15} more in the CSV.`}</Text>}
          </Card>
          <View style={styles.columns}>
            <Card title="Slow movers" half note="On the shelf the whole period with nothing sold. Cash tied up you could free with a markdown.">
              <Row head cells={["Product", "On hand", "At cost", "At retail"]} />
              {r.slowMovers.length === 0 && <Text style={styles.cardNote}>Everything on the shelf sold at least once.</Text>}
              {r.slowMovers.map((p) => (
                <Row key={p.id} cells={[p.name, p.stock, p.costCents == null ? "–" : dollars(p.costCents), dollars(p.retailCents)]} />
              ))}
            </Card>
            <Card title="Shrink" half note="Stock counts and adjustments. Negative is stock that went missing or was damaged; positive was found.">
              <Row head cells={["Product", "Items", "At cost"]} />
              {r.shrink.length === 0 && <Text style={styles.cardNote}>No count differences in this period.</Text>}
              {r.shrink.map((s) => (
                <Row key={s.id} cells={[s.name, <Text style={[styles.td, { color: s.units < 0 ? colors.noShow : colors.checkedIn }]}>{s.units > 0 ? `+${s.units}` : s.units}</Text>, dollars(s.costCents)]} />
              ))}
              {r.shrink.length > 0 && (
                <Row bold cells={["Total", r.shrink.reduce((t, s) => t + s.units, 0), dollars(r.shrink.reduce((t, s) => t + s.costCents, 0))]} />
              )}
            </Card>
          </View>
        </>
      )}
    </RangeShell>
  );
}

function inventoryCsv(r: InventoryReport) {
  const cell = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  saveCsv(`river-bend-inventory-${r.from}-to-${r.to}.csv`, [
    ["Product", "Category", "Items sold", "Sales", "Cost", "Margin", "Margin %"].join(","),
    ...r.items.map((i) => [quote(i.name), quote(i.category), i.units, cell(i.revenueCents), cell(i.costCents), cell(i.marginCents), i.marginPct ?? ""].join(",")),
    "",
    ["Reorder", "SKU", "On hand", "Reorder level", "Sold in period"].join(","),
    ...r.reorder.map((p) => [quote(p.name), quote(p.sku ?? ""), p.stock, p.reorderLevel, p.soldInPeriod].join(",")),
  ]);
}

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

/** Reports › Payments & balances: money taken by tender, and what the course holds for or is owed by golfers. */
export function BalancesReportScreen({ client, timeZone, range, onRange }: { client: Client; timeZone: string; range: ReportRange; onRange: (r: ReportRange) => void }) {
  const state = useRangeReport(client.balancesReport, timeZone, range);
  return (
    <RangeShell range={range} onRange={onRange} state={state} csv={balancesCsv}>
      {(r) => {
        const methods = (Object.keys(METHOD_LABEL) as MoneyMethod[]).filter((m) => r.collected[m]);
        const h = r.held;
        return (
          <>
            <View style={styles.tiles}>
              <Tile label="Money taken" value={dollars(r.collected.totalCents)} note="In the period, every tender" />
              <Tile label="Held for golfers" value={dollars(h.totalCents)} note="Right now: cards, credits and points" />
              <Tile label="Owed on house accounts" value={dollars(r.receivable.cents)} note={`${r.receivable.accounts} account${r.receivable.accounts === 1 ? "" : "s"}`} />
              <Tile label="Gift card balances" value={dollars(h.giftCards.cents)} note={`${h.giftCards.cards} card${h.giftCards.cards === 1 ? "" : "s"} with money left`} />
            </View>
            <View style={styles.columns}>
              <Card title="Money taken by tender" half note="Prepaid online was collected by the booking provider, not the shop. Comps are rounds and items given away.">
                <Row head cells={["Tender", "Amount"]} />
                {methods.length === 0 && <Text style={styles.cardNote}>Nothing taken in this period.</Text>}
                {methods.map((m) => (
                  <Row key={m} cells={[METHOD_LABEL[m], dollars(r.collected[m])]} />
                ))}
                <Row bold cells={["Total", dollars(r.collected.totalCents)]} />
                <Text style={[styles.cardNote, { marginTop: 8 }]}>
                  {`Includes ${dollars(r.other.giftCardsSoldCents)} of gift cards sold and ${dollars(r.other.accountPaymentsCents)} of house account payments, which aren't revenue.`}
                </Text>
              </Card>
              <Card title="Held for golfers" half note="Balances as of now that golfers can still spend. Your accountant carries these as liabilities.">
                <Row head cells={["", "Count", "Value"]} />
                <Row cells={["Gift cards", count(h.giftCards.cards), dollars(h.giftCards.cents)]} />
                <Row cells={["Rain checks", count(h.rainChecks.open), dollars(h.rainChecks.cents)]} />
                <Row cells={[`Punch cards (${count(h.punchCards.roundsLeft)} rounds left)`, count(h.punchCards.cards), dollars(h.punchCards.cents)]} />
                <Row cells={[`Loyalty points (${count(h.loyalty.points)} points)`, count(h.loyalty.golfers), dollars(h.loyalty.cents)]} />
                <Row cells={["Season passes", count(h.seasonPasses.active), "–"]} />
                <Row bold cells={["Total", "", dollars(h.totalCents)]} />
                <Text style={[styles.cardNote, { marginTop: 8 }]}>
                  {`Gift cards in the period: ${dollars(h.giftCards.soldInPeriodCents)} sold, ${dollars(h.giftCards.redeemedInPeriodCents)} spent.`}
                  {h.rainChecks.expiredCents ? ` ${dollars(h.rainChecks.expiredCents)} of rain checks expired unused.` : ""}
                  {h.punchCards.unpriced ? ` ${h.punchCards.unpriced} punch card${h.punchCards.unpriced === 1 ? " has" : "s have"} no price on file, so ${h.punchCards.unpriced === 1 ? "it isn't" : "they aren't"} valued.` : ""}
                </Text>
              </Card>
            </View>
            <Card title="House accounts" note="What members owe the course on their accounts, as of now.">
              <View style={styles.tiles}>
                <Tile label="Owed" value={dollars(r.receivable.cents)} />
                <Tile label="Charged in period" value={dollars(r.receivable.chargedInPeriodCents)} />
                <Tile label="Paid in period" value={dollars(r.receivable.paidInPeriodCents)} />
                <Tile label="Over their limit" value={count(r.receivable.overLimit)} note={r.receivable.creditCents ? `${dollars(r.receivable.creditCents)} in credit` : undefined} />
              </View>
              <Row head cells={["Largest balances", "Owed", "Limit"]} />
              {r.receivable.largest.length === 0 && <Text style={styles.cardNote}>No one owes anything.</Text>}
              {r.receivable.largest.map((a) => (
                <Row key={a.id} cells={[a.status === "suspended" ? `${a.name} (on hold)` : a.name, <Text style={[styles.td, a.limitCents != null && a.balanceCents > a.limitCents && { color: colors.noShow, fontWeight: "700" }]}>{dollars(a.balanceCents)}</Text>, a.limitCents == null ? "None" : dollars(a.limitCents)]} />
              ))}
            </Card>
          </>
        );
      }}
    </RangeShell>
  );
}

function balancesCsv(r: BalancesReport) {
  const cell = (c: number) => (c / 100).toFixed(2);
  saveCsv(`river-bend-balances-${r.from}-to-${r.to}.csv`, [
    ["Tender", "Amount"].join(","),
    ...(Object.keys(METHOD_LABEL) as MoneyMethod[]).filter((m) => r.collected[m]).map((m) => [METHOD_LABEL[m], cell(r.collected[m])].join(",")),
    ["Total", cell(r.collected.totalCents)].join(","),
    "",
    ["Held for golfers", "Count", "Value"].join(","),
    ["Gift cards", r.held.giftCards.cards, cell(r.held.giftCards.cents)].join(","),
    ["Rain checks", r.held.rainChecks.open, cell(r.held.rainChecks.cents)].join(","),
    ["Punch cards", r.held.punchCards.cards, cell(r.held.punchCards.cents)].join(","),
    ["Loyalty points", r.held.loyalty.golfers, cell(r.held.loyalty.cents)].join(","),
    ["Owed on house accounts", r.receivable.accounts, cell(r.receivable.cents)].join(","),
  ]);
}

function saveCsv(name: string, lines: string[]) {
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function laborCsv(r: LaborReport) {
  const cell = (c: number) => (c / 100).toFixed(2);
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    ["Date", "Hours", "Labor cost", "Revenue", "Labor %"].join(","),
    ...r.days.map((d) => [d.date, d.hours, cell(d.costCents), cell(d.revenueCents), d.laborPct ?? ""].join(",")),
    "",
    ["Person", "Job", "Pay type", "Pay", "Hours", "Overtime hours", "Scheduled hours", "Cost"].join(","),
    ...r.people.map((p) => [quote(p.name), quote(p.type), p.pay?.type ?? "", p.pay ? cell(p.pay.cents) : "", p.hours, p.overtimeHours, p.scheduledHours, cell(p.costCents)].join(",")),
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `river-bend-labor-${r.from}-to-${r.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Chip({ label, on, onPress, small }: { label: string; on: boolean; onPress: () => void; small?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      aria-pressed={on}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.chip, small && styles.chipSmall, on && styles.chipOn, focused && styles.focus]}
    >
      <Text style={[styles.chipText, small && { fontSize: 12 }, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

/** "▲ 12.4%" against the comparison, or nothing when there's nothing to compare with. */
function Change({ now, before, invert, points }: { now: number | null; before: number | null | undefined; invert?: boolean; points?: boolean }) {
  if (before == null || now == null) return null;
  if (!points && before === 0) return now === 0 ? <Text style={styles.changeFlat}>No change</Text> : <Text style={styles.changeFlat}>New</Text>;
  const diff = points ? Math.round((now - before) * 10) / 10 : Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
  if (diff === 0) return <Text style={styles.changeFlat}>No change</Text>;
  const good = invert ? diff < 0 : diff > 0;
  return (
    <Text style={[styles.change, { color: good ? colors.checkedIn : colors.noShow }]}>
      {diff > 0 ? "▲" : "▼"} {Math.abs(diff).toFixed(1)}
      {points ? " pts" : "%"}
    </Text>
  );
}

function Tile({ label, value, children, note }: { label: string; value: string; children?: React.ReactNode; note?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <View style={styles.tileFoot}>
        {children}
        {note && <Text style={styles.tileNote}>{note}</Text>}
      </View>
    </View>
  );
}

function Card({ title, children, note, half }: { title: string; children: React.ReactNode; note?: string; half?: boolean }) {
  return (
    <View style={[styles.card, half && styles.half]}>
      <Text role="heading" aria-level={2} style={styles.cardTitle}>{title}</Text>
      {note && <Text style={styles.cardNote}>{note}</Text>}
      {children}
    </View>
  );
}

// ---- Revenue ----

type Bucket = { label: string; from: string; values: number[]; total: number };

/** Days for a month or less, weeks up to about four months, months after that. */
function buckets(o: Overview): Bucket[] {
  const days = o.from === o.to ? [] : (() => {
    const list: string[] = [];
    for (let d = o.from; d <= o.to; d = addDays(d, 1)) list.push(d);
    return list;
  })();
  const byDate = new Map(o.days.map((d) => [d.date, d]));
  const size = days.length <= 31 ? "day" : days.length <= 120 ? "week" : "month";
  const out = new Map<string, Bucket>();
  days.forEach((date, i) => {
    const key = size === "day" ? date : size === "week" ? String(Math.floor(i / 7)) : date.slice(0, 7);
    if (!out.has(key)) out.set(key, { label: size === "month" ? MONTHS[Number(date.slice(5, 7)) - 1] : short(date), from: date, values: DEPARTMENTS.map(() => 0), total: 0 });
    const b = out.get(key)!;
    const d = byDate.get(date);
    if (!d) return;
    DEPARTMENTS.forEach((dep, j) => {
      b.values[j] += d[dep.key];
      b.total += d[dep.key];
    });
  });
  return [...out.values()];
}

function TrendChart({ o }: { o: Overview }) {
  const list = buckets(o);
  if (list.length === 0) return <Text style={styles.cardNote}>Pick a longer period to see a trend.</Text>;
  const max = Math.max(1, ...list.map((b) => b.total));
  const every = Math.ceil(list.length / 8);
  return (
    <View>
      <View style={styles.chartArea}>
        <View style={styles.yAxis}>
          <Text style={styles.axisText}>{dollars(max)}</Text>
          <Text style={styles.axisText}>{dollars(max / 2)}</Text>
          <Text style={styles.axisText}>$0</Text>
        </View>
        <View style={styles.plot}>
          <View style={[styles.gridLine, { top: 0 }]} />
          <View style={[styles.gridLine, { top: "50%" }]} />
          {list.map((b) => (
            <View key={b.from} style={styles.barSlot} aria-label={`${b.label}: ${dollars(b.total)}`} role="img">
              <View style={{ height: `${(b.total / max) * 100}%`, width: "100%", maxWidth: 28, flexDirection: "column-reverse" }}>
                {b.values.map((v, j) => (v > 0 ? <View key={j} style={{ flex: v, backgroundColor: DEPARTMENTS[j].color }} /> : null))}
              </View>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.xAxis}>
        {list.map((b, i) => (
          <Text key={b.from} numberOfLines={1} style={[styles.axisText, styles.xLabel]}>
            {i % every === 0 ? b.label : ""}
          </Text>
        ))}
      </View>
      <View style={styles.legend}>
        {DEPARTMENTS.map((d) => (
          <View key={d.key} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: d.color }]} />
            <Text style={styles.legendText}>{d.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function RevenueView({ o }: { o: Overview }) {
  const p = o.previous;
  const total = o.revenue.totalCents;
  return (
    <>
      <View style={styles.tiles}>
        <Tile label="Total revenue" value={dollars(total)} note={p ? `vs ${dollars(p.revenue.totalCents)}` : undefined}>
          <Change now={total} before={p?.revenue.totalCents} />
        </Tile>
        <Tile label="Rounds" value={count(o.rounds.rounds)} note={p ? `vs ${count(p.rounds.rounds)}` : undefined}>
          <Change now={o.rounds.rounds} before={p?.rounds.rounds} />
        </Tile>
        <Tile label="Revenue per round" value={cents2(o.yield.revenuePerRoundCents)} note={p ? `vs ${cents2(p.yield.revenuePerRoundCents)}` : undefined}>
          <Change now={o.yield.revenuePerRoundCents} before={p?.yield.revenuePerRoundCents} />
        </Tile>
        <Tile label="Occupancy" value={o.rounds.occupancy == null ? "–" : `${o.rounds.occupancy}%`} note={p?.rounds.occupancy != null ? `vs ${p.rounds.occupancy}%` : undefined}>
          <Change now={o.rounds.occupancy} before={p?.rounds.occupancy} points />
        </Tile>
      </View>

      <Card title="Revenue over time">
        <TrendChart o={o} />
      </Card>

      <View style={styles.columns}>
        <Card title="By department" half>
          <View style={[styles.tr, styles.th]}>
            <Text style={[styles.thText, { flex: 1 }]}>Department</Text>
            <Text style={[styles.thText, styles.num]}>Revenue</Text>
            {p && <Text style={[styles.thText, styles.num]}>Change</Text>}
          </View>
          {DEPARTMENTS.map((d) => {
            const v = o.revenue[d.key];
            return (
              <View key={d.key} style={styles.tr}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.rowLine}>
                    <View style={[styles.swatch, { backgroundColor: d.color }]} />
                    <Text style={styles.td}>{d.label}</Text>
                    <Text style={styles.share}>{total ? `${Math.round((v / total) * 100)}%` : ""}</Text>
                  </View>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${total ? (v / total) * 100 : 0}%`, backgroundColor: d.color }]} />
                  </View>
                </View>
                <Text style={[styles.td, styles.num]}>{dollars(v)}</Text>
                {p && (
                  <View style={styles.num}>
                    <Change now={v} before={p.revenue[d.key]} />
                  </View>
                )}
              </View>
            );
          })}
          <View style={[styles.tr, { borderBottomWidth: 0 }]}>
            <Text style={[styles.td, { flex: 1, fontWeight: "700" }]}>Total</Text>
            <Text style={[styles.td, styles.num, { fontWeight: "700" }]}>{dollars(total)}</Text>
            {p && (
              <View style={styles.num}>
                <Change now={total} before={p.revenue.totalCents} />
              </View>
            )}
          </View>
        </Card>

        <Card title="Revenue per round" half note="What each round brings in. Rounds are players who came (no-shows left out).">
          <YieldRow label="Average green fee" help="Green fees divided by rounds" now={o.yield.avgGreenFeeCents} before={p?.yield.avgGreenFeeCents} />
          <YieldRow label="Total revenue per round" help="Everything (carts, pro shop, food) divided by rounds" now={o.yield.revenuePerRoundCents} before={p?.yield.revenuePerRoundCents} />
          <YieldRow label="Revenue per available spot" help="Green fees spread over every open spot on the tee sheet, filled or not" now={o.yield.revPattCents} before={p?.yield.revPattCents} />
          <View style={[styles.tr, { borderBottomWidth: 0 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.td}>Average discount</Text>
              <Text style={styles.help}>{o.topRateCents ? `Below the top green fee of ${cents2(o.topRateCents)}` : "No green fees set up"}</Text>
            </View>
            <Text style={[styles.td, styles.num, { fontWeight: "700" }]}>{o.avgDiscountPct == null ? "–" : `${o.avgDiscountPct}%`}</Text>
            {p && (
              <View style={styles.num}>
                <Change now={o.avgDiscountPct} before={p.avgDiscountPct} invert points />
              </View>
            )}
          </View>
        </Card>
      </View>
    </>
  );
}

function YieldRow({ label, help, now, before }: { label: string; help: string; now: number | null; before: number | null | undefined }) {
  return (
    <View style={styles.tr}>
      <View style={{ flex: 1 }}>
        <Text style={styles.td}>{label}</Text>
        <Text style={styles.help}>{help}</Text>
      </View>
      <Text style={[styles.td, styles.num, { fontWeight: "700" }]}>{cents2(now)}</Text>
      {before !== undefined && (
        <View style={styles.num}>
          <Change now={now} before={before} />
        </View>
      )}
    </View>
  );
}

// ---- Rounds and the tee sheet ----

function heatColor(share: number) {
  // From the page gray to a dark brand blue. The curve spreads out the low and middle shares,
  // where most tee times sit.
  const a = [242, 243, 245];
  const b = [21, 74, 140];
  const t = Math.pow(Math.max(0, Math.min(1, share)), 0.6);
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
}

function HeatMap({ o }: { o: Overview }) {
  const hours = [...new Set(o.heat.filter((h) => h.spots > 0).map((h) => h.hour))].sort((a, b) => a - b);
  const at = new Map(o.heat.map((h) => [`${h.weekday}-${h.hour}`, h]));
  if (hours.length === 0) return <Text style={styles.cardNote}>No open tee times in this period.</Text>;
  return (
    <ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ flexGrow: 1 }}>
        <View style={styles.heatRow}>
          <Text style={styles.heatDay} />
          {hours.map((h) => (
            <Text key={h} style={[styles.axisText, styles.heatHead]}>
              {hourLabel(h)}
            </Text>
          ))}
        </View>
        {WEEKDAYS.map((name, i) => (
          <View key={name} style={styles.heatRow}>
            <Text style={[styles.axisText, styles.heatDay]}>{name}</Text>
            {hours.map((h) => {
              const c = at.get(`${i + 1}-${h}`);
              const share = c && c.spots ? c.players / c.spots : null;
              return (
                <View
                  key={h}
                  role="img"
                  aria-label={`${name} ${hourLabel(h)}: ${share == null ? "no tee times" : `${Math.round(share * 100)}% full, ${c!.players} of ${c!.spots} spots`}`}
                  style={[styles.heatCell, { backgroundColor: share == null ? "transparent" : heatColor(share) }, share == null && styles.heatEmpty]}
                >
                  {share != null && <Text style={[styles.heatText, share > 0.35 && { color: "#fff" }]}>{Math.round(share * 100)}</Text>}
                </View>
              );
            })}
          </View>
        ))}
        <View style={[styles.legend, { marginTop: 8 }]}>
          <Text style={styles.legendText}>% of spots filled:</Text>
          {[0, 0.25, 0.5, 0.75, 1].map((s) => (
            <View key={s} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: heatColor(s), borderWidth: 1, borderColor: colors.border }]} />
              <Text style={styles.legendText}>{Math.round(s * 100)}</Text>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

function SplitBar({ title, parts, prev }: { title: string; parts: [string, number, string][]; prev?: number[] }) {
  const total = parts.reduce((t, p) => t + p[1], 0);
  const prevTotal = prev?.reduce((t, n) => t + n, 0);
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.splitTitle}>{title}</Text>
      <View style={[styles.track, { height: 12, flexDirection: "row" }]}>
        {parts.map(([label, n, color]) => (n > 0 ? <View key={label} style={{ flex: n, backgroundColor: color }} /> : null))}
      </View>
      <View style={styles.splitLegend}>
        {parts.map(([label, n, color], i) => (
          <View key={label} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: color }]} />
            <Text style={styles.legendText}>
              {label} <Text style={{ fontWeight: "700", color: colors.text }}>{count(n)}</Text>
              {total ? ` (${Math.round((n / total) * 100)}%)` : ""}
              {prev && prevTotal ? `, was ${Math.round((prev[i] / prevTotal) * 100)}%` : ""}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function RoundsView({ o }: { o: Overview }) {
  const r = o.rounds;
  const p = o.previous?.rounds;
  const sources = Object.entries(r.bySource).sort((a, b) => b[1] - a[1]);
  const SOURCE_COLORS = ["#1f6fd1", "#7fb0ea", "#2e7d4f", "#c27c0e", "#7b4fb3"];
  const firstLoops = o.rateMix.filter((m) => !m.isReplay).reduce((t, m) => t + m.rounds, 0);
  const prevMix = new Map((o.previous?.rateMix ?? []).map((m) => [m.code, m]));
  return (
    <>
      <View style={styles.tiles}>
        <Tile label="Rounds" value={count(r.rounds)} note={p ? `vs ${count(p.rounds)}` : undefined}>
          <Change now={r.rounds} before={p?.rounds} />
        </Tile>
        <Tile label="Occupancy" value={r.occupancy == null ? "–" : `${r.occupancy}%`} note={`${count(r.rounds)} of ${count(r.spots)} spots`}>
          <Change now={r.occupancy} before={p?.occupancy} points />
        </Tile>
        <Tile label="Empty spots" value={count(Math.max(0, r.spots - r.rounds))} note={p ? `vs ${count(Math.max(0, p.spots - p.rounds))}` : undefined}>
          <Change now={r.spots - r.rounds} before={p ? p.spots - p.rounds : undefined} invert />
        </Tile>
        <Tile label="No-shows" value={count(r.noShows)} note={p ? `vs ${count(p.noShows)}` : undefined}>
          <Change now={r.noShows} before={p?.noShows} invert />
        </Tile>
      </View>

      <Card title="When the tee sheet fills" note="Share of open spots booked, by day of the week and hour. Blank squares had no open tee times.">
        <HeatMap o={o} />
      </Card>

      <View style={styles.columns}>
        <Card title="Who's playing" half>
          <SplitBar title="Holes" parts={[["18 holes", r.holes18, "#1f6fd1"], ["9 holes", r.holes9, "#7fb0ea"]]} prev={p && [p.holes18, p.holes9]} />
          <SplitBar title="Walking or riding" parts={[["Riding", r.riding, "#2e7d4f"], ["Walking", r.walking, "#9cc9ad"]]} prev={p && [p.riding, p.walking]} />
          <SplitBar title="Booked through" parts={sources.map(([s, n], i) => [SOURCE_LABEL[s] ?? s, n, SOURCE_COLORS[i % SOURCE_COLORS.length]])} />
          <WeekSplit r={r} p={p} />
        </Card>

        <Card title="Rate mix" half note="Which green fees the rounds were sold at. An 18-hole round on a 9-hole course is a first loop plus a replay; shares count first loops.">
          <View style={[styles.tr, styles.th]}>
            <Text style={[styles.thText, { flex: 1 }]}>Rate</Text>
            <Text style={[styles.thText, styles.numS]}>Rounds</Text>
            <Text style={[styles.thText, styles.numS]}>Share</Text>
            <Text style={[styles.thText, styles.num]}>Revenue</Text>
            <Text style={[styles.thText, styles.numS]}>Avg</Text>
          </View>
          {o.rateMix.length === 0 && <Text style={styles.cardNote}>No green fees in this period.</Text>}
          {o.rateMix.map((m) => {
            const before = prevMix.get(m.code);
            return (
              <View key={m.code} style={styles.tr}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.td} numberOfLines={1}>
                    {m.name}
                    {m.isReplay && <Text style={styles.tag}>  REPLAY</Text>}
                  </Text>
                  {before && <Text style={styles.help}>{`was ${count(before.rounds)} rounds`}</Text>}
                </View>
                <Text style={[styles.td, styles.numS]}>{count(m.rounds)}</Text>
                <Text style={[styles.td, styles.numS, { color: colors.muted }]}>{m.isReplay || !firstLoops ? "–" : `${Math.round((m.rounds / firstLoops) * 100)}%`}</Text>
                <Text style={[styles.td, styles.num]}>{dollars(m.revenueCents)}</Text>
                <Text style={[styles.td, styles.numS]}>{cents2(m.avgCents)}</Text>
              </View>
            );
          })}
          {o.avgDiscountPct != null && (
            <Text style={[styles.cardNote, { marginTop: 8 }]}>
              {`The average first-loop round sold ${o.avgDiscountPct}% below the top rate of ${cents2(o.topRateCents)}.`}
            </Text>
          )}
        </Card>
      </View>
    </>
  );
}

function WeekSplit({ r, p }: { r: RoundsSummary; p?: RoundsSummary }) {
  const row = (label: string, now: RoundsSummary["weekday"], before?: RoundsSummary["weekday"]) => (
    <View style={styles.tr}>
      <Text style={[styles.td, { flex: 1 }]}>{label}</Text>
      <Text style={[styles.td, styles.numS]}>{count(now.rounds)}</Text>
      <Text style={[styles.td, styles.numS, { fontWeight: "700" }]}>{now.occupancy == null ? "–" : `${now.occupancy}%`}</Text>
      <View style={styles.numS}>
        <Change now={now.occupancy} before={before?.occupancy} points />
      </View>
    </View>
  );
  return (
    <View>
      <Text style={styles.splitTitle}>Weekdays and weekends</Text>
      <View style={[styles.tr, styles.th]}>
        <Text style={[styles.thText, { flex: 1 }]}>Days</Text>
        <Text style={[styles.thText, styles.numS]}>Rounds</Text>
        <Text style={[styles.thText, styles.numS]}>Full</Text>
        <Text style={[styles.thText, styles.numS]}>{p ? "Change" : ""}</Text>
      </View>
      {row("Mon to Thu", r.weekday, p?.weekday)}
      {row("Fri to Sun", r.weekend, p?.weekend)}
    </View>
  );
}

function downloadCsv(o: Overview, view: "revenue" | "rounds") {
  const cell = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines =
    view === "revenue"
      ? [
          ["Date", ...DEPARTMENTS.map((d) => d.label), "Total"].join(","),
          ...o.days.map((d) => [d.date, ...DEPARTMENTS.map((x) => cell(d[x.key])), cell(d.totalCents)].join(",")),
          ["Total", ...DEPARTMENTS.map((x) => cell(o.revenue[x.key])), cell(o.revenue.totalCents)].join(","),
        ]
      : [
          ["Rate", "Replay", "Rounds", "Revenue", "Average"].join(","),
          ...o.rateMix.map((m) => [quote(m.name), m.isReplay ? "yes" : "no", m.rounds, cell(m.revenueCents), cell(m.avgCents)].join(",")),
          "",
          ["Weekday", "Hour", "Players", "Open spots"].join(","),
          ...o.heat.map((h) => [WEEKDAYS[h.weekday - 1], `${String(h.hour).padStart(2, "0")}:00`, h.players, h.spots].join(",")),
        ];
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `river-bend-${view}-${o.from}-to-${o.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 48, maxWidth: 1240 },
  bar: { marginBottom: 12 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
  compareLabel: { fontSize: 12, color: colors.muted, fontWeight: "600", marginRight: 2 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, minHeight: 32, justifyContent: "center", backgroundColor: colors.card },
  chipSmall: { minHeight: 28, paddingHorizontal: 10 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.text },
  csv: { marginLeft: "auto", borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 10, minHeight: 28, justifyContent: "center", backgroundColor: colors.card },
  csvText: { fontSize: 12, fontWeight: "600", color: colors.primaryText },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
  error: { color: colors.noShow, marginVertical: 8 },
  period: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 10 },
  periodMuted: { fontSize: 13, fontWeight: "400", color: colors.muted },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 12 },
  tile: { flexGrow: 1, flexBasis: 150, minWidth: 140, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 12 },
  tileLabel: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  tileValue: { fontSize: 22, fontWeight: "700", color: colors.text, marginTop: 4, fontVariant: ["tabular-nums"] },
  tileFoot: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4, minHeight: 18 },
  tileNote: { fontSize: 12, color: colors.muted },
  change: { fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  changeFlat: { fontSize: 12, color: colors.muted },
  columns: { flexDirection: "row", flexWrap: "wrap", gap: 12, alignItems: "flex-start" },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 14, marginBottom: 12 },
  half: { flexGrow: 1, flexBasis: 420, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 4 },
  cardNote: { fontSize: 12, color: colors.muted, lineHeight: 17, marginBottom: 8 },
  chartArea: { flexDirection: "row", height: 180, marginTop: 8 },
  yAxis: { width: 64, justifyContent: "space-between", alignItems: "flex-end", paddingRight: 6 },
  plot: { flex: 1, flexDirection: "row", alignItems: "flex-end", gap: 2, borderBottomWidth: 1, borderColor: colors.border, position: "relative" },
  gridLine: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: "#eceef1" },
  barSlot: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" },
  xAxis: { flexDirection: "row", marginLeft: 64, gap: 2, marginTop: 4 },
  xLabel: { flex: 1, textAlign: "left", overflow: "visible" },
  axisText: { fontSize: 11, color: colors.muted, fontVariant: ["tabular-nums"] },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 10, alignItems: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendText: { fontSize: 12, color: colors.muted },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  tr: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: "#eceef1" },
  th: { paddingVertical: 6, borderColor: colors.border },
  thText: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  td: { fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"] },
  num: { width: 86, textAlign: "right", alignItems: "flex-end" },
  numS: { width: 62, textAlign: "right", alignItems: "flex-end" },
  help: { fontSize: 11, color: colors.muted, marginTop: 1 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  share: { fontSize: 12, color: colors.muted, marginLeft: "auto" },
  track: { height: 6, backgroundColor: "#eceef1", borderRadius: 2, overflow: "hidden", marginTop: 5 },
  fill: { height: "100%" },
  tag: { fontSize: 10, fontWeight: "700", color: colors.muted, letterSpacing: 0.5 },
  heatRow: { flexDirection: "row", alignItems: "center", gap: 3, marginBottom: 3 },
  heatDay: { width: 34 },
  heatHead: { flex: 1, minWidth: 34, textAlign: "center" },
  heatCell: { flex: 1, minWidth: 34, height: 30, borderRadius: 2, alignItems: "center", justifyContent: "center" },
  heatEmpty: { borderWidth: 1, borderColor: "#eceef1", borderStyle: "dashed" },
  heatText: { fontSize: 11, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
  notice: { backgroundColor: "#fff6e0", borderWidth: 1, borderColor: "#ecd9a6", borderRadius: radius, padding: 10, gap: 4, marginBottom: 12 },
  noticeText: { fontSize: 13, color: colors.text, lineHeight: 19 },
  link: { color: colors.primaryText, fontWeight: "700" },
  splitTitle: { fontSize: 12, fontWeight: "700", color: colors.text, marginBottom: 4 },
  splitLegend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 6 },
});
