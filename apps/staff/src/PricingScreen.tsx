import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, PriceAddOn, PriceRate, RateInput } from "./api";
import { colors, formatTime, money, type WebPress } from "./theme";

// Pricing: green fee rates, and the carts, rentals and other extras golfers add to a round. Everyone can look;
// managers add, change and remove. The tee sheet, walk-ins and check-in all price from these.

const dollars = (text: string) => {
  const clean = text.replace(/[$,\s]/g, "");
  return /^\d+(\.\d{0,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Holidays"];
const WEEKDAYS = [1, 2, 3, 4];
const WEEKENDS = [5, 6, 7, 8];
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7, 8];
const same = (a: number[], b: number[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** "Mon–Thu", "Fri–Sun and holidays", "Every day", or a list. */
export function daysText(days: number[]) {
  const sorted = [...days].sort((a, b) => a - b);
  if (same(sorted, EVERY_DAY)) return "Every day";
  const holidays = sorted.includes(8);
  const week = sorted.filter((d) => d <= 7);
  const contiguous = week.length > 2 && week.every((d, i) => i === 0 || d === week[i - 1]! + 1);
  const part = week.length === 0 ? "" : contiguous ? `${DAY_NAMES[week[0]! - 1]}–${DAY_NAMES[week.at(-1)! - 1]}` : week.map((d) => DAY_NAMES[d - 1]).join(", ");
  return holidays ? (part ? `${part} and holidays` : "Holidays") : part;
}

export function rateTerms(r: Pick<PriceRate, "days" | "startTime" | "endTime" | "residency" | "ageGroups">) {
  const parts = [daysText(r.days)];
  if (r.startTime && r.endTime) parts.push(`${formatTime(r.startTime)} to ${formatTime(r.endTime)}`);
  else if (r.startTime) parts.push(`from ${formatTime(r.startTime)}`);
  else if (r.endTime) parts.push(`before ${formatTime(r.endTime)}`);
  parts.push(r.residency === "resident" ? "Residents" : r.residency === "nonresident" ? "Nonresidents" : "Everyone");
  if (r.ageGroups?.length) parts.push(r.ageGroups.map((a) => a[0]!.toUpperCase() + a.slice(1) + "s").join(" and "));
  return parts.join(" · ");
}

function useRun(load: () => void, onChanged?: () => void) {
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      load();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    }
  };
  return { error, setError, run };
}

export function PricingScreen({ client, isManager, onChanged }: { client: Client; isManager: boolean; onChanged?: () => void }) {
  const [rates, setRates] = useState<PriceRate[]>();
  const [editing, setEditing] = useState<string>(); // a rate id, or "new"
  const load = () => {
    client.rates().then(setRates).catch((e) => setError(e.message));
  };
  const { error, setError, run } = useRun(load, onChanged);
  useEffect(load, [client]);

  const section = (title: string, help: string, list: PriceRate[] | undefined) => (
    <View style={styles.card}>
      <Text role="heading" aria-level={2} style={styles.title}>{title}</Text>
      <Text style={styles.help}>{help}</Text>
      {list?.length === 0 && <Text style={[styles.help, { marginTop: 8 }]}>None set up.</Text>}
      {list?.map((r) =>
        editing === r.id ? (
          <RateForm key={r.id} rate={r} onSave={(input) => run(() => client.updateRate(r.id, input)).then((ok) => ok && setEditing(undefined))} onClose={() => setEditing(undefined)} />
        ) : (
          <View key={r.id} style={styles.line}>
            <View style={{ flex: 1, minWidth: 220 }}>
              <Text style={styles.strong}>{r.name}</Text>
              <Text style={styles.help}>{rateTerms(r)}</Text>
            </View>
            <Text style={styles.price}>{money(r.priceCents)}</Text>
            {isManager && (
              <View style={styles.actions}>
                <Button label="Edit" onPress={() => setEditing(r.id)} />
                <Button label="Remove" onPress={() => run(() => client.updateRate(r.id, { active: false }))} />
              </View>
            )}
          </View>
        ),
      )}
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <Text style={[styles.help, { marginBottom: 12 }]}>
        Each player pays the most specific rate that fits their tee time and profile: a rate for seniors beats one for everyone, and a rate with hours beats an all-day one. Bookings keep the price they were made at.
      </Text>
      {isManager &&
        (editing === "new" ? (
          <View style={styles.card}>
            <Text role="heading" aria-level={2} style={styles.title}>New rate</Text>
            <RateForm onSave={(input) => run(() => client.addRate(input)).then((ok) => ok && setEditing(undefined))} onClose={() => setEditing(undefined)} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", marginBottom: 12 }}>
            <Button label="Add a rate" primary onPress={() => setEditing("new")} />
          </View>
        ))}
      {section("Green fees", "The price of one loop of the course.", rates?.filter((r) => !r.isReplay))}
      {section("Replay rates", "Charged for each extra loop in the same round, such as holes 10–18 on a 9-hole course.", rates?.filter((r) => r.isReplay))}
      <Extras client={client} isManager={isManager} onChanged={onChanged} />
      {!isManager && <Text style={styles.help}>Only a manager can change prices.</Text>}
    </ScrollView>
  );
}

function RateForm({ rate, onSave, onClose }: { rate?: PriceRate; onSave: (input: RateInput) => void; onClose: () => void }) {
  const [name, setName] = useState(rate?.name ?? "");
  const [price, setPrice] = useState(rate ? (rate.priceCents / 100).toFixed(2) : "");
  const [days, setDays] = useState<number[]>(rate?.days ?? WEEKDAYS);
  const [from, setFrom] = useState(rate?.startTime ?? "");
  const [until, setUntil] = useState(rate?.endTime ?? "");
  const [residency, setResidency] = useState<RateInput["residency"]>(rate?.residency ?? null);
  const [ages, setAges] = useState<NonNullable<RateInput["ageGroups"]>>(rate?.ageGroups ?? []);
  const [replay, setReplay] = useState(rate?.isReplay ?? false);
  const priceCents = dollars(price);
  const time = (t: string) => (t.trim() === "" ? null : /^([01]\d|2[0-3]):[0-5]\d$/.test(t.trim()) ? t.trim() : undefined);
  const start = time(from);
  const end = time(until);
  const badWindow = !!start && !!end && start >= end;
  const valid = name.trim() && priceCents !== undefined && days.length > 0 && start !== undefined && end !== undefined && !badWindow;
  const toggleDay = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b));
  const toggleAge = (a: "adult" | "senior" | "junior") => setAges(ages.includes(a) ? ages.filter((x) => x !== a) : [...ages, a]);
  return (
    <View style={styles.form}>
      <View style={styles.row}>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Weekday twilight" />
        <Field label="Price, $" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="19.00" small />
      </View>
      <Text style={styles.label}>Days</Text>
      <View style={styles.row}>
        <Chip label="Mon–Thu" on={same(days, WEEKDAYS)} onPress={() => setDays(WEEKDAYS)} />
        <Chip label="Fri–Sun and holidays" on={same(days, WEEKENDS)} onPress={() => setDays(WEEKENDS)} />
        <Chip label="Every day" on={same(days, EVERY_DAY)} onPress={() => setDays(EVERY_DAY)} />
      </View>
      <View style={styles.row} role="group" aria-label="Days">
        {DAY_NAMES.map((n, i) => (
          <Chip key={n} label={n} on={days.includes(i + 1)} onPress={() => toggleDay(i + 1)} checkbox />
        ))}
      </View>
      <View style={styles.row}>
        <Field label="Starts at (optional)" value={from} onChangeText={setFrom} placeholder="16:00" small />
        <Field label="Ends at (optional)" value={until} onChangeText={setUntil} placeholder="12:00" small />
      </View>
      {(start === undefined || end === undefined) && <Text style={styles.error}>Write times like 07:00 or 16:30.</Text>}
      {badWindow && <Text style={styles.error}>The start time must be before the end time.</Text>}
      <Text style={styles.label}>Who</Text>
      <View style={styles.row}>
        <Chip label="Everyone" on={!residency} onPress={() => setResidency(null)} />
        <Chip label="Residents" on={residency === "resident"} onPress={() => setResidency("resident")} />
        <Chip label="Nonresidents" on={residency === "nonresident"} onPress={() => setResidency("nonresident")} />
      </View>
      <View style={styles.row} role="group" aria-label="Ages">
        <Chip label="All ages" on={ages.length === 0} onPress={() => setAges([])} />
        <Chip label="Adults" on={ages.includes("adult")} onPress={() => toggleAge("adult")} checkbox />
        <Chip label="Seniors" on={ages.includes("senior")} onPress={() => toggleAge("senior")} checkbox />
        <Chip label="Juniors" on={ages.includes("junior")} onPress={() => toggleAge("junior")} checkbox />
      </View>
      <View style={styles.row}>
        <Chip label="First loop" on={!replay} onPress={() => setReplay(false)} />
        <Chip label="Replay (extra loop)" on={replay} onPress={() => setReplay(true)} />
      </View>
      {valid && <Text style={styles.help}>{rateTerms({ days, startTime: start ?? null, endTime: end ?? null, residency, ageGroups: ages })} · {money(priceCents!)}</Text>}
      <View style={styles.row}>
        <Button
          label={rate ? "Save" : "Add rate"}
          primary
          disabled={!valid}
          onPress={() => onSave({ name: name.trim(), priceCents: priceCents!, days, startTime: start ?? null, endTime: end ?? null, residency, ageGroups: ages.length ? ages : null, isReplay: replay })}
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

/** Carts, rentals and other extras a golfer can add to a round, shown on the Pricing page. */
function Extras({ client, isManager, onChanged }: { client: Client; isManager: boolean; onChanged?: () => void }) {
  const [addOns, setAddOns] = useState<PriceAddOn[]>();
  const [editing, setEditing] = useState<string>();
  const load = () => {
    client.addOns().then(setAddOns).catch((e) => setError(e.message));
  };
  const { error, setError, run } = useRun(load, onChanged);
  useEffect(load, [client]);
  return (
      <View style={styles.card}>
        {error && <Text role="alert" style={styles.error}>{error}</Text>}
        <Text role="heading" aria-level={2} style={styles.title}>Carts and rentals</Text>
        <Text style={styles.help}>Extras a golfer can add to a round, priced per person. The gas cart is what riding golfers pay, so it can be repriced but not removed.</Text>
        {addOns?.length === 0 && <Text style={[styles.help, { marginTop: 8 }]}>None set up.</Text>}
        {addOns?.map((a) =>
          editing === a.id ? (
            <AddOnForm key={a.id} addOn={a} onSave={(input) => run(() => client.updateAddOn(a.id, input)).then((ok) => ok && setEditing(undefined))} onClose={() => setEditing(undefined)} />
          ) : (
            <View key={a.id} style={styles.line}>
              <View style={{ flex: 1, minWidth: 200 }}>
                <Text style={styles.strong}>{a.name}</Text>
                {a.locked && <Text style={styles.help}>Charged to riding golfers</Text>}
              </View>
              <Text style={styles.price}>{money(a.priceCents)}</Text>
              {isManager && (
                <View style={styles.actions}>
                  <Button label="Edit" onPress={() => setEditing(a.id)} />
                  {!a.locked && <Button label="Remove" onPress={() => run(() => client.updateAddOn(a.id, { active: false }))} />}
                </View>
              )}
            </View>
          ),
        )}
        {isManager &&
          (editing === "new" ? (
            <AddOnForm onSave={(input) => run(() => client.addAddOn(input)).then((ok) => ok && setEditing(undefined))} onClose={() => setEditing(undefined)} />
          ) : (
            <View style={{ flexDirection: "row", marginTop: 12 }}>
              <Button label="Add an extra" primary onPress={() => setEditing("new")} />
            </View>
          ))}
      </View>
  );
}

function AddOnForm({ addOn, onSave, onClose }: { addOn?: PriceAddOn; onSave: (input: { name: string; priceCents: number }) => void; onClose: () => void }) {
  const [name, setName] = useState(addOn?.name ?? "");
  const [price, setPrice] = useState(addOn ? (addOn.priceCents / 100).toFixed(2) : "");
  const priceCents = dollars(price);
  const valid = name.trim() && priceCents !== undefined;
  return (
    <View style={styles.form}>
      <View style={styles.row}>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Range balls (large bucket)" />
        <Field label="Price per person, $" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="8.00" small />
      </View>
      <View style={styles.row}>
        <Button label={addOn ? "Save" : "Add"} primary disabled={!valid} onPress={() => onSave({ name: name.trim(), priceCents: priceCents! })} />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

function Field(props: { label: string; small?: boolean } & React.ComponentProps<typeof TextInput>) {
  const { label, small, ...input } = props;
  return (
    <View style={{ minWidth: small ? 140 : 220, flex: small ? 0 : 1, flexBasis: small ? 180 : undefined }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.placeholder} style={styles.input} {...input} />
    </View>
  );
}

function Chip({ label, on, onPress, checkbox }: { label: string; on: boolean; onPress: () => void; checkbox?: boolean }) {
  return (
    <Pressable
      accessibilityRole={checkbox ? "checkbox" : "radio"}
      accessibilityState={checkbox ? { checked: on } : { selected: on }}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.chip, hovered && !on && { backgroundColor: colors.bg }, on && styles.chipOn, focused && styles.focus]}
    >
      <Text style={[styles.chipText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function Button({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, hovered && !primary && !disabled && { backgroundColor: colors.bg }, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, maxWidth: 900 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, marginBottom: 14 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 4 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.noShow, marginBottom: 8, fontSize: 13 },
  line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border },
  price: { fontSize: 15, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"], minWidth: 70, textAlign: "right" },
  actions: { flexDirection: "row", gap: 6 },
  form: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: colors.border },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 12, minHeight: 34, justifyContent: "center", backgroundColor: "#fff" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
