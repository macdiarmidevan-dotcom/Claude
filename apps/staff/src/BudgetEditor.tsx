import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { BudgetDepartments, Client, RevenueBudget } from "./api";
import { colors, radius, type WebPress } from "./theme";

// Reports › Revenue › Budget: what the course expects to take in each month, by department.
// The revenue dashboard prorates it to whatever dates are picked and shows revenue against it.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const BUDGET_DEPARTMENTS: { key: keyof BudgetDepartments; label: string; short: string }[] = [
  { key: "greenFeesCents", label: "Green fees", short: "Green fees" },
  { key: "cartsAndExtrasCents", label: "Carts and extras", short: "Carts" },
  { key: "proShopCents", label: "Pro shop", short: "Pro shop" },
  { key: "foodBevCents", label: "Food and drink", short: "Food & drink" },
  { key: "eventsCents", label: "Leagues and outings", short: "Leagues" },
];

type Draft = Record<string, Record<keyof BudgetDepartments, string>>;

const asText = (cents: number) => (cents ? String(Math.round(cents / 100)) : "");
const toCents = (text: string): number | undefined => {
  const clean = text.replace(/[$,\s]/g, "");
  if (!clean) return 0;
  return /^\d+(\.\d{0,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
};
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

function draftOf(b: RevenueBudget): Draft {
  return Object.fromEntries(b.months.map((m) => [m.month, Object.fromEntries(BUDGET_DEPARTMENTS.map((d) => [d.key, asText(m[d.key])]))])) as Draft;
}

export function BudgetEditor({ client, initialYear, onClose }: { client: Client; initialYear: number; onClose: (changed: boolean) => void }) {
  const wide = useWindowDimensions().width >= 900;
  const [year, setYear] = useState(initialYear);
  const [saved, setSaved] = useState<RevenueBudget>();
  const [draft, setDraft] = useState<Draft>();
  const [raise, setRaise] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let live = true;
    setSaved(undefined);
    setDraft(undefined);
    setError(undefined);
    setNotice(undefined);
    client
      .budget(year)
      .then((b) => {
        if (!live) return;
        setSaved(b);
        setDraft(draftOf(b));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the budget"));
    return () => {
      live = false;
    };
  }, [client, year]);

  const cell = (month: string, key: keyof BudgetDepartments) => toCents(draft?.[month]?.[key] ?? "");
  const monthTotal = (month: string) => BUDGET_DEPARTMENTS.reduce((s, d) => s + (cell(month, d.key) ?? 0), 0);
  const months = saved?.months.map((m) => m.month) ?? [];
  const yearTotal = months.reduce((s, m) => s + monthTotal(m), 0);
  const dirty = !!saved && !!draft && JSON.stringify(draftOf(saved)) !== JSON.stringify(draft);
  const bad = months.some((m) => BUDGET_DEPARTMENTS.some((d) => cell(m, d.key) === undefined));

  const set = (month: string, key: keyof BudgetDepartments, value: string) => {
    setNotice(undefined);
    setDraft((d) => d && { ...d, [month]: { ...d[month], [key]: value } });
  };

  async function fillFromLastYear() {
    const pct = Number(raise.replace(/[%\s]/g, "") || "0");
    if (!Number.isFinite(pct) || pct < -90 || pct > 200) {
      setError("Enter a percent between -90 and 200");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const last = await client.overview(`${year - 1}-01-01`, `${year - 1}-12-31`, "none");
      const byMonth = new Map<string, BudgetDepartments>();
      for (const d of last.days) {
        const month = `${year}${d.date.slice(4, 7)}`;
        const m = byMonth.get(month) ?? { greenFeesCents: 0, cartsAndExtrasCents: 0, proShopCents: 0, foodBevCents: 0, eventsCents: 0 };
        for (const dep of BUDGET_DEPARTMENTS) m[dep.key] += d[dep.key];
        byMonth.set(month, m);
      }
      if (![...byMonth.values()].some((m) => BUDGET_DEPARTMENTS.some((d) => m[d.key] > 0))) {
        setNotice(`There's no revenue in ${year - 1} to start from. Type the budget in instead.`);
        return;
      }
      // Rounded to the nearest $100, since a budget is a target, not a forecast to the dollar.
      const scaled = (cents: number) => String(Math.round((cents * (1 + pct / 100)) / 10_000) * 100);
      setDraft(
        Object.fromEntries(
          months.map((month) => {
            const m = byMonth.get(month);
            return [month, Object.fromEntries(BUDGET_DEPARTMENTS.map((d) => [d.key, m && m[d.key] ? scaled(m[d.key]) : ""]))];
          }),
        ) as Draft,
      );
      setNotice(`Filled in from ${year - 1}'s revenue${pct ? `, ${pct > 0 ? "plus" : "minus"} ${Math.abs(pct)}%` : ""}. Check it over, then press Save budget.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load last year's revenue");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft || bad) return;
    setBusy(true);
    setError(undefined);
    try {
      const b = await client.saveBudget(
        months.map((month) => ({ month, ...(Object.fromEntries(BUDGET_DEPARTMENTS.map((d) => [d.key, cell(month, d.key) ?? 0])) as BudgetDepartments) })),
      );
      setSaved(b);
      setDraft(draftOf(b));
      setChanged(true);
      setNotice(`Saved the ${year} budget.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the budget");
    } finally {
      setBusy(false);
    }
  }

  const input = (month: string, d: (typeof BUDGET_DEPARTMENTS)[number]) => {
    const invalid = cell(month, d.key) === undefined;
    return (
      <TextInput
        accessibilityLabel={`${d.label} budget for ${MONTHS[Number(month.slice(5)) - 1]} ${year}`}
        value={draft?.[month]?.[d.key] ?? ""}
        onChangeText={(v) => set(month, d.key, v)}
        inputMode="decimal"
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={colors.placeholder}
        style={[styles.input, invalid && styles.inputBad]}
      />
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.head}>
        <Pressable accessibilityRole="button" onPress={() => onClose(changed)} style={({ focused }: WebPress) => [styles.button, focused && styles.focus]}>
          <Text style={styles.buttonText}>‹ Back to revenue</Text>
        </Pressable>
        <View style={styles.yearPick}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous year" disabled={busy} onPress={() => setYear(year - 1)} style={({ focused }: WebPress) => [styles.arrow, focused && styles.focus]}>
            <Text style={styles.arrowText}>‹</Text>
          </Pressable>
          <Text role="heading" aria-level={1} style={styles.title}>{`${year} budget`}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Next year" disabled={busy} onPress={() => setYear(year + 1)} style={({ focused }: WebPress) => [styles.arrow, focused && styles.focus]}>
            <Text style={styles.arrowText}>›</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.help}>
        What you expect each department to bring in, month by month, in dollars. The revenue dashboard spreads each month evenly over its days, so any dates you pick show revenue against the budget for those days. Leave a month blank if it has no budget.
      </Text>

      <View style={styles.fill}>
        <Text style={styles.fillText}>Start from {year - 1}'s revenue, plus</Text>
        <TextInput accessibilityLabel="Percent to add to last year" value={raise} onChangeText={setRaise} inputMode="decimal" style={[styles.input, styles.pct]} />
        <Text style={styles.fillText}>%</Text>
        <Pressable accessibilityRole="button" disabled={busy || !draft} onPress={fillFromLastYear} style={({ focused }: WebPress) => [styles.button, focused && styles.focus, (busy || !draft) && styles.disabled]}>
          <Text style={styles.buttonText}>Fill in</Text>
        </Pressable>
      </View>

      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {notice && <Text role="status" style={styles.notice}>{notice}</Text>}
      {!draft && !error && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}

      {draft && wide && (
        <View style={styles.card}>
          <View style={[styles.tr, styles.th]}>
            <Text style={[styles.thText, styles.monthCol]}>Month</Text>
            {BUDGET_DEPARTMENTS.map((d) => (
              <Text key={d.key} style={[styles.thText, styles.cellCol]}>{d.short}</Text>
            ))}
            <Text style={[styles.thText, styles.totalCol]}>Total</Text>
          </View>
          {months.map((month) => (
            <View key={month} style={styles.tr}>
              <Text style={[styles.td, styles.monthCol]}>{MONTHS[Number(month.slice(5)) - 1]}</Text>
              {BUDGET_DEPARTMENTS.map((d) => (
                <View key={d.key} style={styles.cellCol}>
                  {input(month, d)}
                </View>
              ))}
              <Text style={[styles.td, styles.totalCol]}>{monthTotal(month) ? dollars(monthTotal(month)) : "–"}</Text>
            </View>
          ))}
          <View style={[styles.tr, { borderBottomWidth: 0 }]}>
            <Text style={[styles.td, styles.monthCol, styles.bold]}>Year</Text>
            {BUDGET_DEPARTMENTS.map((d) => (
              <Text key={d.key} style={[styles.td, styles.cellCol, styles.bold, { textAlign: "right", paddingRight: 8 }]}>
                {dollars(months.reduce((s, m) => s + (cell(m, d.key) ?? 0), 0))}
              </Text>
            ))}
            <Text style={[styles.td, styles.totalCol, styles.bold]}>{dollars(yearTotal)}</Text>
          </View>
        </View>
      )}

      {draft && !wide && (
        <View>
          {months.map((month) => (
            <View key={month} style={styles.card}>
              <View style={styles.monthHead}>
                <Text role="heading" aria-level={2} style={styles.monthTitle}>{MONTHS[Number(month.slice(5)) - 1]}</Text>
                <Text style={styles.td}>{monthTotal(month) ? dollars(monthTotal(month)) : "No budget"}</Text>
              </View>
              <View style={styles.grid}>
                {BUDGET_DEPARTMENTS.map((d) => (
                  <View key={d.key} style={styles.gridCell}>
                    <Text style={styles.label}>{d.label}</Text>
                    {input(month, d)}
                  </View>
                ))}
              </View>
            </View>
          ))}
          <Text style={[styles.td, styles.bold, { marginBottom: 12 }]}>{`Year total: ${dollars(yearTotal)}`}</Text>
        </View>
      )}

      {draft && (
        <View style={styles.footer}>
          {bad && <Text style={styles.error}>Fix the amounts in red. Use dollars, like 12500.</Text>}
          <Pressable
            accessibilityRole="button"
            disabled={busy || !dirty || bad}
            onPress={save}
            style={({ focused }: WebPress) => [styles.primary, focused && styles.focus, (busy || !dirty || bad) && styles.disabled]}
          >
            <Text style={styles.primaryText}>{busy ? "Saving…" : "Save budget"}</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 48, maxWidth: 1240 },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 10 },
  yearPick: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontSize: 18, fontWeight: "700", color: colors.text, minWidth: 120, textAlign: "center" },
  arrow: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card },
  arrowText: { fontSize: 18, color: colors.text },
  help: { fontSize: 13, color: colors.muted, lineHeight: 19, marginBottom: 12, maxWidth: 760 },
  fill: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 },
  fillText: { fontSize: 13, color: colors.text },
  pct: { width: 56, textAlign: "right" },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, minHeight: 36, justifyContent: "center", backgroundColor: colors.card },
  buttonText: { fontSize: 13, fontWeight: "600", color: colors.primaryText },
  primary: { backgroundColor: colors.primary, borderRadius: radius, paddingHorizontal: 18, minHeight: 40, justifyContent: "center", alignSelf: "flex-start" },
  primaryText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
  error: { color: colors.noShow, marginVertical: 8 },
  notice: { color: colors.text, backgroundColor: "#eef5ec", borderWidth: 1, borderColor: "#cfe3c9", borderRadius: radius, padding: 10, marginBottom: 12, fontSize: 13 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 14, marginBottom: 12 },
  tr: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: "#eceef1" },
  th: { borderColor: colors.border },
  thText: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  td: { fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"] },
  bold: { fontWeight: "700" },
  monthCol: { width: 96 },
  cellCol: { flex: 1, minWidth: 0 },
  totalCol: { width: 100, textAlign: "right" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 8, minHeight: 34, fontSize: 14, color: colors.text, backgroundColor: colors.card, textAlign: "right", fontVariant: ["tabular-nums"] },
  inputBad: { borderColor: colors.noShow },
  monthHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  monthTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  gridCell: { flexGrow: 1, flexBasis: 140 },
  label: { fontSize: 12, color: colors.muted, marginBottom: 3 },
  footer: { gap: 6 },
});
