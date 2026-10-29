import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, GolferPass, PassType, SalePaymentMethod, Wallet } from "./api";
import { CardChargeModal, useCardReader } from "./CardReader";
import { colors, money, type WebPress } from "./theme";

// A golfer's punch cards, season pass and loyalty points, on their account page. The pro shop
// sells passes here; managers fix balances by hand.

const SELL_METHODS: { method: SalePaymentMethod; label: string }[] = [
  { method: "card", label: "Card" },
  { method: "cash", label: "Cash" },
  { method: "gift_card", label: "Gift card" },
];

export const passSummary = (p: GolferPass) =>
  [
    p.kind === "punch_card" ? `${p.roundsLeft} of ${p.roundsTotal} rounds left` : "Unlimited rounds, holder only",
    p.coversCart ? "cart included" : null,
    p.expiresAt ? `${Date.parse(p.expiresAt) <= Date.now() ? "expired" : "good until"} ${new Date(p.expiresAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}` : "no end date",
  ]
    .filter(Boolean)
    .join(" · ");

const REASON: Record<Wallet["loyalty"]["history"][number]["reason"], string> = {
  round: "Round",
  sale: "Pro shop",
  redeem: "Used at check-in",
  adjust: "Adjusted",
  refund: "Refund",
};

export function WalletSection({ client, golferId, isManager }: { client: Client; golferId: string; isManager: boolean }) {
  const [wallet, setWallet] = useState<Wallet>();
  const [types, setTypes] = useState<PassType[]>([]);
  const [selling, setSelling] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    client.wallet(golferId).then(setWallet).catch((e) => setError(e.message));
    client.passTypes().then((t) => setTypes(t.filter((x) => x.active))).catch(() => undefined);
  }, [client, golferId]);

  async function run(fn: () => Promise<Wallet>) {
    setError(undefined);
    try {
      setWallet(await fn());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    }
  }

  if (!wallet) return error ? <Text role="alert" style={styles.error}>{error}</Text> : null;
  const { loyalty } = wallet;
  const shown = wallet.passes.filter((p) => p.status === "active");
  return (
    <View style={{ maxWidth: 820 }}>
      <Text role="heading" style={styles.h2}>Passes and points</Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <View style={[styles.box, { flex: 1, minWidth: 260 }]}>
          <Text style={styles.title}>Punch cards and passes</Text>
          {shown.length === 0 && <Text style={styles.help}>None yet.</Text>}
          {shown.map((p) => (
            <View key={p.id} style={styles.pass}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.strong, !p.usable && { color: colors.muted }]}>{p.name}</Text>
                <Text style={styles.help}>{passSummary(p)}</Text>
              </View>
              {isManager && <SmallButton label="Cancel" onPress={() => run(() => client.cancelPass(golferId, p.id))} />}
            </View>
          ))}
          {selling ? (
            <SellPass client={client} golferId={golferId} types={types} onSold={(w) => (setWallet(w), setSelling(false))} onClose={() => setSelling(false)} />
          ) : (
            types.length > 0 && <SmallButton label="Sell a pass" primary onPress={() => setSelling(true)} />
          )}
        </View>
        <View style={[styles.box, { flex: 1, minWidth: 260 }]}>
          <Text style={styles.title}>Loyalty points</Text>
          {!loyalty.enabled && loyalty.points === 0 ? (
            <Text style={styles.help}>Loyalty points are off. A manager can turn them on under Pro shop › Passes & points.</Text>
          ) : (
            <>
              <Text style={styles.big}>{loyalty.points.toLocaleString()} points</Text>
              <Text style={styles.help}>
                Worth {money(loyalty.rewardsAvailable * loyalty.rewardCents)} off a round ({loyalty.rewardPoints} points = {money(loyalty.rewardCents)}). Earns {loyalty.pointsPerDollar}{" "}
                {loyalty.pointsPerDollar === 1 ? "point" : "points"} per dollar.
              </Text>
              {loyalty.history.slice(0, 5).map((h, i) => (
                <View key={i} style={styles.ledger}>
                  <Text style={[styles.help, { flex: 1, marginBottom: 0 }]}>
                    {new Date(h.at).toLocaleDateString([], { month: "short", day: "numeric" })} · {REASON[h.reason]}
                    {h.note ? `: ${h.note}` : ""}
                  </Text>
                  <Text style={[styles.strong, { color: h.change > 0 ? colors.checkedIn : colors.text }]}>
                    {h.change > 0 ? "+" : ""}
                    {h.change}
                  </Text>
                </View>
              ))}
            </>
          )}
          {isManager &&
            (adjusting ? (
              <AdjustPoints onSave={(change, note) => run(() => client.adjustPoints(golferId, change, note)).then((ok) => ok && setAdjusting(false))} onClose={() => setAdjusting(false)} />
            ) : (
              <SmallButton label="Adjust points" onPress={() => setAdjusting(true)} />
            ))}
        </View>
      </View>
    </View>
  );
}

function SellPass({ client, golferId, types, onSold, onClose }: { client: Client; golferId: string; types: PassType[]; onSold: (w: Wallet) => void; onClose: () => void }) {
  const [typeId, setTypeId] = useState(types[0]?.id);
  const [method, setMethod] = useState<SalePaymentMethod>("card");
  const [charging, setCharging] = useState(false);
  const [error, setError] = useState<string>();
  const reader = useCardReader();
  const type = types.find((t) => t.id === typeId);

  async function sell(cardPaymentId?: string) {
    setError(undefined);
    try {
      onSold(await client.sellPass(golferId, { passTypeId: typeId!, paymentMethod: method, ...(cardPaymentId ? { cardPaymentId } : {}) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't sell the pass");
    }
  }

  return (
    <View style={{ marginTop: 10 }}>
      <View style={styles.chips}>
        {types.map((t) => (
          <Chip key={t.id} label={`${t.name} · ${money(t.priceCents)}`} on={t.id === typeId} onPress={() => setTypeId(t.id)} />
        ))}
      </View>
      <View style={[styles.chips, { marginTop: 8 }]}>
        {SELL_METHODS.map((m) => (
          <Chip key={m.method} label={m.label} on={method === m.method} onPress={() => setMethod(m.method)} />
        ))}
      </View>
      {method === "card" && reader.needsReader && <Text style={styles.warn}>Pick this device's card reader in Settings, or run the card on another terminal.</Text>}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.chips, { marginTop: 10 }]}>
        <SmallButton label={type ? `Take ${money(type.priceCents)}` : "Pick a pass"} primary disabled={!type} onPress={() => (method === "card" && reader.terminal && type!.priceCents > 0 ? setCharging(true) : sell())} />
        <SmallButton label="Back" onPress={onClose} />
      </View>
      {charging && reader.terminal && type && (
        <CardChargeModal
          client={client}
          terminal={reader.terminal}
          amountCents={type.priceCents}
          description={type.name}
          onPaid={(p) => {
            setCharging(false);
            sell(p.id);
          }}
          onClose={() => setCharging(false)}
        />
      )}
    </View>
  );
}

function AdjustPoints({ onSave, onClose }: { onSave: (change: number, note: string) => void; onClose: () => void }) {
  const [change, setChange] = useState("");
  const [note, setNote] = useState("");
  const n = /^[+-]?\d+$/.test(change.trim()) ? Number(change.trim()) : undefined;
  return (
    <View style={{ marginTop: 10 }}>
      <TextInput accessibilityLabel="Points to add or take away" placeholder="Points, e.g. 50 or -50" value={change} onChangeText={setChange} style={styles.input} />
      <TextInput accessibilityLabel="Reason" placeholder="Why (required)" value={note} onChangeText={setNote} style={styles.input} />
      <View style={styles.chips}>
        <SmallButton label="Save" primary disabled={!n || !note.trim()} onPress={() => onSave(n!, note)} />
        <SmallButton label="Back" onPress={onClose} />
      </View>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.chip, on && styles.chipOn, focused && styles.focus]}
    >
      <Text style={[styles.chipText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
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
  h2: { fontSize: 16, fontWeight: "700", color: colors.text, marginTop: 24, marginBottom: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  box: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card },
  title: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 8 },
  big: { fontSize: 20, fontWeight: "700", color: colors.text },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 8 },
  warn: { color: colors.warn, fontSize: 13, marginTop: 8 },
  error: { color: colors.noShow, marginVertical: 6 },
  pass: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  ledger: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff", marginBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 12, minHeight: 34, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start", marginTop: 8 },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
