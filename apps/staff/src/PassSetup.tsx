import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, LoyaltySettings, PassKind, PassType } from "./api";
import { colors, money, type WebPress } from "./theme";

// What the course sells (punch cards and season passes) and how loyalty points work. Managers set
// these up; everyone else sees them read-only. Selling a pass happens on the golfer's account.

const dollars = (text: string) => {
  const clean = text.replace(/[$,\s]/g, "");
  return /^\d+(\.\d{0,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
};
const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined);

export const passTerms = (t: PassType) =>
  [
    t.kind === "punch_card" ? `${t.rounds} rounds` : "Unlimited rounds, holder only",
    t.coversCart ? "cart included" : "green fees only",
    t.validDays ? `good for ${t.validDays} days` : "no end date",
  ].join(" · ");

export function PassSetup({ client, isManager }: { client: Client; isManager: boolean }) {
  const [types, setTypes] = useState<PassType[]>();
  const [loyalty, setLoyalty] = useState<LoyaltySettings>();
  const [rainDays, setRainDays] = useState<number>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  const load = () => {
    client.passTypes().then(setTypes).catch((e) => setError(e.message));
    client.loyaltySettings().then(setLoyalty).catch((e) => setError(e.message));
    client.rainCheckSettings().then((r) => setRainDays(r.rainCheckDays)).catch((e) => setError(e.message));
  };
  useEffect(load, [client]);

  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, maxWidth: 860 }}>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.title}>
          Punch cards and season passes
        </Text>
        <Text style={styles.help}>Sell these from a golfer's account. At check-in, each round on a pass covers one player's green fee (and cart, if included).</Text>
        {types?.length === 0 && <Text style={styles.help}>Nothing set up yet.</Text>}
        {types?.map((t) => (
          <View key={t.id} style={styles.line}>
            <View style={{ flex: 1, minWidth: 200 }}>
              <Text style={[styles.strong, !t.active && { color: colors.muted }]}>
                {t.name}
                {t.active ? "" : " (not sold)"}
              </Text>
              <Text style={styles.help}>{passTerms(t)}</Text>
            </View>
            <Text style={styles.strong}>{money(t.priceCents)}</Text>
            {isManager && <Button label={t.active ? "Stop selling" : "Sell again"} onPress={() => run(() => client.updatePassType(t.id, { active: !t.active }))} />}
          </View>
        ))}
        {isManager &&
          (adding ? (
            <NewPassType onSave={(t) => run(() => client.addPassType(t)).then((ok) => ok && setAdding(false))} onClose={() => setAdding(false)} />
          ) : (
            <Button label="Add a pass" primary onPress={() => setAdding(true)} />
          ))}
      </View>

      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.title}>
          Loyalty points
        </Text>
        {loyalty && (isManager ? <LoyaltyForm settings={loyalty} onSave={(s) => run(() => client.saveLoyaltySettings(s))} /> : <LoyaltyText s={loyalty} />)}
      </View>

      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.title}>
          Rain checks
        </Text>
        <Text style={styles.help}>
          When weather cuts a round short, the pro shop gives a rain check from the group's tee time for the holes they didn't play. It's a code they use on a later round.
        </Text>
        {rainDays !== undefined && (isManager ? <RainDaysForm days={rainDays} onSave={(d) => run(() => client.saveRainCheckSettings({ rainCheckDays: d }))} /> : <Text style={styles.text}>Rain checks are good for {rainDays} days.</Text>)}
      </View>
    </ScrollView>
  );
}

function RainDaysForm({ days, onSave }: { days: number; onSave: (d: number) => void }) {
  const [text, setText] = useState(String(days));
  const d = whole(text);
  return (
    <View style={[styles.row, { marginTop: 10, alignItems: "flex-end" }]}>
      <Field label="Good for (days)" value={text} onChangeText={setText} keyboardType="number-pad" />
      <Button label="Save" primary disabled={!d || d === days} onPress={() => onSave(d!)} />
    </View>
  );
}

function LoyaltyText({ s }: { s: LoyaltySettings }) {
  return (
    <Text style={styles.text}>
      {s.pointsPerDollar === 0
        ? "Loyalty points are off."
        : `Golfers earn ${s.pointsPerDollar} ${s.pointsPerDollar === 1 ? "point" : "points"} per dollar on rounds and pro shop sales. ${s.rewardPoints} points take ${money(s.rewardCents)} off a round.`}
    </Text>
  );
}

function LoyaltyForm({ settings, onSave }: { settings: LoyaltySettings; onSave: (s: LoyaltySettings) => void }) {
  const [per, setPer] = useState(String(settings.pointsPerDollar));
  const [pts, setPts] = useState(String(settings.rewardPoints));
  const [off, setOff] = useState((settings.rewardCents / 100).toFixed(2));
  const next = { pointsPerDollar: whole(per), rewardPoints: whole(pts), rewardCents: dollars(off) };
  const valid = next.pointsPerDollar !== undefined && !!next.rewardPoints && next.rewardCents !== undefined;
  return (
    <View>
      <LoyaltyText s={settings} />
      <View style={[styles.row, { marginTop: 10 }]}>
        <Field label="Points per dollar (0 turns points off)" value={per} onChangeText={setPer} keyboardType="number-pad" />
        <Field label="Points for a reward" value={pts} onChangeText={setPts} keyboardType="number-pad" />
        <Field label="Reward, $ off a round" value={off} onChangeText={setOff} keyboardType="decimal-pad" />
      </View>
      <Button label="Save" primary disabled={!valid} onPress={() => onSave(next as LoyaltySettings)} />
    </View>
  );
}

function NewPassType({ onSave, onClose }: { onSave: (t: { name: string; kind: PassKind; priceCents: number; rounds: number | null; validDays: number | null; coversCart: boolean }) => void; onClose: () => void }) {
  const [kind, setKind] = useState<PassKind>("punch_card");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [rounds, setRounds] = useState("10");
  const [days, setDays] = useState("365");
  const [cart, setCart] = useState(false);
  const priceCents = dollars(price);
  const r = whole(rounds);
  const d = days.trim() ? whole(days) : null;
  const valid = name.trim() && priceCents !== undefined && (kind === "season_pass" || !!r) && d !== undefined;
  return (
    <View style={{ marginTop: 12, borderTopWidth: 1, borderColor: colors.border, paddingTop: 12 }}>
      <View style={styles.row}>
        <Chip label="Punch card" on={kind === "punch_card"} onPress={() => setKind("punch_card")} />
        <Chip label="Season pass" on={kind === "season_pass"} onPress={() => setKind("season_pass")} />
      </View>
      <View style={[styles.row, { marginTop: 10 }]}>
        <Field label="Name" value={name} onChangeText={setName} placeholder={kind === "punch_card" ? "10-round punch card" : "Season pass"} />
        <Field label="Price, $" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="260.00" />
        {kind === "punch_card" && <Field label="Rounds" value={rounds} onChangeText={setRounds} keyboardType="number-pad" />}
        <Field label="Good for (days, blank for no end)" value={days} onChangeText={setDays} keyboardType="number-pad" />
      </View>
      <View style={styles.row}>
        <Chip label="Green fees only" on={!cart} onPress={() => setCart(false)} />
        <Chip label="Cart included" on={cart} onPress={() => setCart(true)} />
      </View>
      <View style={[styles.row, { marginTop: 4 }]}>
        <Button
          label="Add"
          primary
          disabled={!valid}
          onPress={() => onSave({ name: name.trim(), kind, priceCents: priceCents!, rounds: kind === "punch_card" ? r! : null, validDays: d ?? null, coversCart: cart })}
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ minWidth: 160, flex: 1 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} style={styles.input} {...input} />
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={onPress} style={({ focused }: WebPress) => [styles.chip, on && styles.chipOn, focused && styles.focus]}>
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
      style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, marginBottom: 14 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 4 },
  text: { color: colors.text, fontSize: 14, lineHeight: 20 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.noShow, marginBottom: 8 },
  line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 12, minHeight: 34, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start", marginTop: 8 },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
