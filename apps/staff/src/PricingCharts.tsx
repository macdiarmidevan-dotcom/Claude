import { StyleSheet, Text, View } from "react-native";
import { colors, money } from "./theme";

// Small charts and number tiles for the Pricing pages, drawn with plain views so they work the
// same on the web, iPad and phones. Same look as the manager reports: square, thin lines.

export const BAND_COLORS = ["#173f86", "#2563c9", "#b4580e", "#6b4fa0"];
export const UP = colors.checkedIn;
export const DOWN = "#b4580e";
export const TODAY = "#8a94a3";

export function Tiles({ children }: { children: React.ReactNode }) {
  return <View style={styles.tiles}>{children}</View>;
}

export function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, tone ? { color: tone } : null]}>{value}</Text>
      {note ? <Text style={styles.tileNote}>{note}</Text> : <View style={{ height: 17 }} />}
    </View>
  );
}

export function ChartCard({ title, note, children, half }: { title: string; note?: string; children: React.ReactNode; half?: boolean }) {
  return (
    <View style={[styles.card, half && styles.half]}>
      <Text role="heading" aria-level={2} style={styles.cardTitle}>{title}</Text>
      {note && <Text style={styles.cardNote}>{note}</Text>}
      {children}
    </View>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.cardRow}>{children}</View>;
}

export function Legend({ items }: { items: { label: string; color: string; line?: boolean; dot?: boolean }[] }) {
  return (
    <View style={styles.legend}>
      {items.map((i) => (
        <View key={i.label} style={styles.legendItem}>
          <View style={i.line ? [styles.legendLine, { borderColor: i.color }] : [styles.swatch, { backgroundColor: i.color }, i.dot && { borderRadius: 5 }]} />
          <Text style={styles.legendText}>{i.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** Horizontal bars, one row each, longest first as given. */
export function HBars({ rows, max }: { rows: { label: string; sub?: string; value: number; text: string; color?: string }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <Text style={styles.cardNote}>Nothing in this period yet.</Text>;
  return (
    <View>
      {rows.map((r) => (
        <View key={r.label} style={styles.hRow} role="img" aria-label={`${r.label}: ${r.text}`}>
          <View style={styles.hLabel}>
            <Text style={styles.hLabelText} numberOfLines={1}>{r.label}</Text>
            {r.sub && <Text style={styles.hSub} numberOfLines={1}>{r.sub}</Text>}
          </View>
          <View style={styles.hBar}>
            <View style={styles.hTrack}>
              <View style={{ width: `${Math.max(0.5, (r.value / top) * 100)}%`, height: "100%", backgroundColor: r.color ?? colors.primary }} />
            </View>
            <Text style={styles.hValue}>{r.text}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Columns grouped by category (e.g. a day), with an optional dashed reference line (e.g. the average). */
export function GroupedColumns({ groups, series, max, format, reference, height = 170 }: {
  groups: { label: string; values: (number | null)[] }[];
  series: { label: string; color: string }[];
  max: number;
  format: (v: number) => string;
  reference?: { value: number; label: string };
  height?: number;
}) {
  return (
    <View>
      <View style={[styles.plotWrap, { height }]}>
        <View style={styles.yAxis}>
          <Text style={styles.axisText}>{format(max)}</Text>
          <Text style={styles.axisText}>{format(max / 2)}</Text>
          <Text style={styles.axisText}>{format(0)}</Text>
        </View>
        <View style={styles.plot}>
          <View style={[styles.gridLine, { top: 0 }]} />
          <View style={[styles.gridLine, { top: "50%" }]} />
          {reference && <View style={[styles.refLine, { bottom: `${(reference.value / max) * 100}%` }]} />}
          {groups.map((g) => (
            <View key={g.label} style={styles.group}>
              {g.values.map((v, i) => (
                <View
                  key={i}
                  role="img"
                  aria-label={`${g.label} ${series[i]!.label}: ${v === null ? "no data" : format(v)}`}
                  style={[styles.column, { height: `${v === null ? 0 : Math.min(100, (v / max) * 100)}%`, backgroundColor: series[i]!.color }]}
                />
              ))}
            </View>
          ))}
        </View>
      </View>
      <View style={styles.xAxis}>
        {groups.map((g) => (
          <Text key={g.label} style={[styles.axisText, styles.xLabel]}>{g.label}</Text>
        ))}
      </View>
      <Legend items={[...series.map((s) => ({ label: s.label, color: s.color })), ...(reference ? [{ label: reference.label, color: colors.text, line: true }] : [])]} />
    </View>
  );
}

/** Columns above and below a zero line, for gains and losses. */
export function SignedColumns({ items, format, height = 170 }: { items: { label: string; value: number }[]; format: (v: number) => string; height?: number }) {
  // A little headroom so the value printed above the tallest bar stays inside the chart.
  const top = Math.max(1, ...items.map((i) => Math.abs(i.value))) * 1.18;
  const hasNeg = items.some((i) => i.value < 0);
  const zero = hasNeg ? 50 : 0; // percent from the bottom
  return (
    <View>
      <View style={[styles.plotWrap, { height }]}>
        <View style={styles.yAxis}>
          <Text style={styles.axisText}>{format(top)}</Text>
          {hasNeg ? <Text style={styles.axisText}>{format(0)}</Text> : <Text style={styles.axisText}>{format(top / 2)}</Text>}
          <Text style={styles.axisText}>{hasNeg ? format(-top) : format(0)}</Text>
        </View>
        <View style={styles.plot}>
          <View style={[styles.zeroLine, { bottom: `${zero}%` }]} />
          {items.map((i) => {
            const share = (Math.abs(i.value) / top) * (hasNeg ? 50 : 100);
            return (
              <View key={i.label} style={styles.signedSlot} role="img" aria-label={`${i.label}: ${format(i.value)}`}>
                <View
                  style={[
                    styles.signedBar,
                    { height: `${share}%`, backgroundColor: i.value >= 0 ? UP : DOWN },
                    i.value >= 0 ? { bottom: `${zero}%` } : { top: `${100 - zero}%` },
                  ]}
                />
                <Text style={[styles.barValue, i.value >= 0 ? { bottom: `${zero + share}%` } : { top: `${100 - zero + share}%` }]}>{i.value === 0 ? "" : format(i.value)}</Text>
              </View>
            );
          })}
        </View>
      </View>
      <View style={styles.xAxis}>
        {items.map((i) => (
          <Text key={i.label} style={[styles.axisText, styles.xLabel]}>{i.label}</Text>
        ))}
      </View>
    </View>
  );
}

/** Today's price against the suggested one on a shared price scale, one row each. */
export function PriceMoves({ rows, min, max }: { rows: { label: string; today: number | null; suggested: number | null }[]; min: number; max: number }) {
  const span = Math.max(100, max - min);
  const at = (c: number) => `${((c - min) / span) * 100}%` as const;
  return (
    <View>
      {rows.map((r) => {
        const has = r.today !== null && r.suggested !== null;
        const lo = has ? Math.min(r.today!, r.suggested!) : 0;
        const hi = has ? Math.max(r.today!, r.suggested!) : 0;
        const tone = !has || r.suggested === r.today ? TODAY : r.suggested! > r.today! ? UP : DOWN;
        return (
          <View key={r.label} style={styles.moveRow} role="img" aria-label={has ? `${r.label}: today ${money(r.today!)}, suggested ${money(r.suggested!)}` : `${r.label}: not enough data`}>
            <Text style={styles.moveLabel}>{r.label}</Text>
            <View style={styles.moveTrack}>
              <View style={styles.moveAxis} />
              {has && (
                <>
                  <View style={[styles.moveSpan, { left: at(lo), width: `${((hi - lo) / span) * 100}%`, backgroundColor: tone }]} />
                  <View style={[styles.dot, { left: at(r.today!), backgroundColor: "#fff", borderColor: TODAY }]} />
                  <View style={[styles.dot, { left: at(r.suggested!), backgroundColor: tone, borderColor: tone }]} />
                </>
              )}
            </View>
            <Text style={[styles.moveValue, { color: tone }]}>{has ? money(r.suggested!) : "–"}</Text>
          </View>
        );
      })}
      <View style={styles.moveScale}>
        <Text style={styles.axisText}>{money(min)}</Text>
        <Text style={styles.axisText}>{money(max)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 12 },
  tile: { flexGrow: 1, flexBasis: 170, minWidth: 150, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, padding: 12 },
  tileLabel: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  tileValue: { fontSize: 24, fontWeight: "700", color: colors.text, marginTop: 4, fontVariant: ["tabular-nums"] },
  tileNote: { fontSize: 12, color: colors.muted, marginTop: 3, minHeight: 17 },
  cardRow: { flexDirection: "row", flexWrap: "wrap", columnGap: 12 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 12 },
  half: { flexGrow: 1, flexShrink: 1, flexBasis: 420, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 4 },
  cardNote: { fontSize: 12, color: colors.muted, lineHeight: 17, marginBottom: 10 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 10, alignItems: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendText: { fontSize: 12, color: colors.muted },
  swatch: { width: 10, height: 10 },
  legendLine: { width: 16, height: 0, borderTopWidth: 2, borderStyle: "dashed" },
  hRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 3, paddingVertical: 5 },
  hBar: { flexGrow: 1, flexBasis: 220, flexDirection: "row", alignItems: "center", gap: 10 },
  hLabel: { flexBasis: 250, flexGrow: 0, flexShrink: 1, minWidth: 0 },
  hLabelText: { fontSize: 13, color: colors.text, fontWeight: "600" },
  hSub: { fontSize: 11, color: colors.muted },
  hTrack: { flex: 1, height: 14, backgroundColor: "#eceef1" },
  hValue: { width: 84, textAlign: "right", fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"] },
  plotWrap: { flexDirection: "row" },
  yAxis: { width: 48, justifyContent: "space-between", paddingRight: 6, alignItems: "flex-end" },
  axisText: { fontSize: 11, color: colors.muted, fontVariant: ["tabular-nums"] },
  plot: { flex: 1, flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, position: "relative" },
  gridLine: { position: "absolute", left: 0, right: 0, borderTopWidth: 1, borderColor: colors.rowLine },
  refLine: { position: "absolute", left: 0, right: 0, borderTopWidth: 2, borderColor: colors.text, borderStyle: "dashed", zIndex: 2 },
  zeroLine: { position: "absolute", left: 0, right: 0, borderTopWidth: 1, borderColor: colors.muted },
  group: { flex: 1, flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 2, paddingHorizontal: 6 },
  column: { flex: 1, maxWidth: 22 },
  xAxis: { flexDirection: "row", marginLeft: 48, marginTop: 4 },
  xLabel: { flex: 1, textAlign: "center" },
  signedSlot: { flex: 1, position: "relative", alignItems: "center" },
  signedBar: { position: "absolute", width: "56%", maxWidth: 46 },
  barValue: { position: "absolute", fontSize: 11, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"], paddingVertical: 2 },
  moveRow: { flexDirection: "row", alignItems: "center", gap: 10, height: 26 },
  moveLabel: { width: 44, fontSize: 12, fontWeight: "600", color: colors.text },
  moveTrack: { flex: 1, height: 14, justifyContent: "center", position: "relative", marginHorizontal: 6 },
  moveAxis: { position: "absolute", left: 0, right: 0, top: 6, borderTopWidth: 1, borderColor: colors.rowLine },
  moveSpan: { position: "absolute", top: 5, height: 4 },
  dot: { position: "absolute", top: 2, width: 10, height: 10, marginLeft: -5, borderRadius: 5, borderWidth: 2 },
  moveValue: { width: 58, textAlign: "right", fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  moveScale: { flexDirection: "row", justifyContent: "space-between", marginLeft: 60, marginRight: 74, marginTop: 2 },
});
