import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, PaymentMethod, SheetBooking, SheetTeeTime, Station, Waiver } from "./api";
import { WaiverModal } from "./WaiverModal";
import { GolferPicker } from "./Golfers";
import { colors, type WebPress, formatTime, money, paymentMethodLabel, statusColor, statusLabel } from "./theme";

interface Props {
  client: Client;
  teeTime: SheetTeeTime;
  sheet: SheetTeeTime[];
  courseHoles: number;
  station: Station;
  onChanged: () => void;
  onClose: () => void;
}

export function TeeTimePanel({ client, teeTime, sheet, courseHoles, station, onChanged, onClose }: Props) {
  const [error, setError] = useState<string>();
  const [moving, setMoving] = useState<SheetBooking>();
  // sendOff: the starter is sending the group off the tee; otherwise just editing carts.
  const [cartsFor, setCartsFor] = useState<{ booking: SheetBooking; sendOff: boolean }>();
  const [payingFor, setPayingFor] = useState<SheetBooking>();
  // Finding or creating the golfer's account. With checkIn, check-in carries on once it's linked.
  const [accountFor, setAccountFor] = useState<{ id: string; checkIn: boolean }>();
  // Asked on the page rather than in a pop-up dialog, which some browsers and screen readers block.
  const [cancelling, setCancelling] = useState<string>();
  // Carts waiting on their drivers' waiver signatures before they're saved.
  const [signing, setSigning] = useState<{ booking: SheetBooking; carts: string[]; unsigned: string[]; sendOff: boolean; waiver: Waiver }>();
  const [note, setNote] = useState(teeTime.note ?? "");
  const spotsLeft = teeTime.maxPlayers - teeTime.bookedPlayers;
  const active = teeTime.bookings.filter((b) => b.status !== "cancelled");

  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  return (
    <ScrollView style={styles.panel} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.time}>{formatTime(teeTime.localTime)}</Text>
          <Text style={styles.muted}>
            {teeTime.status === "blocked" ? "Blocked" : `${spotsLeft} of ${teeTime.maxPlayers} spots open`}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
          <Text style={{ fontSize: 16, color: colors.muted }}>Close</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">{error}</Text>}

      <Text style={styles.section}>Groups</Text>
      {active.length === 0 && <Text style={styles.muted}>No one booked yet.</Text>}
      {active.map((b) => (
        <View key={b.id} style={styles.booking}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={styles.name}>{b.customerName}</Text>
            <Text style={[styles.badge, { color: statusColor[b.status], borderColor: statusColor[b.status] }]}>
              {statusLabel[b.status]}
            </Text>
          </View>
          <Text style={styles.muted}>
            {b.players} {b.players === 1 ? "player" : "players"} · {b.holes} holes · {money(b.totalCents)}
            {b.customerPhone ? ` · ${b.customerPhone}` : ""}
          </Text>
          <PaymentLine booking={b} />
          {station === "proshop" && (
            <Text style={[styles.account, !b.golferId && { color: colors.warn }]}>
              {b.golferId ? "✓ On golfer account" : "No golfer account linked yet"}
            </Text>
          )}
          {b.cartNumbers.length > 0 && (
            <Text style={styles.carts}>
              {b.cartNumbers.length === 1 ? "Cart" : "Carts"} {b.cartNumbers.join(", ")}
            </Text>
          )}
          {station === "starter" && b.status === "confirmed" && (
            <Text style={styles.warning}>Not checked in at the pro shop yet</Text>
          )}
          {cartsFor?.booking.id !== b.id && moving?.id !== b.id && payingFor?.id !== b.id && cancelling !== b.id && accountFor?.id !== b.id && (
            <View style={styles.actions}>
              {station === "proshop" && (b.status === "confirmed" || b.status === "no_show") && (
                <Action
                  label={b.payment.balanceCents > 0 ? `Take ${money(b.payment.balanceCents)} & check in` : "Check in"}
                  primary
                  onPress={() =>
                    // The first check-in creates the golfer's account; after that it's a name search.
                    !b.golferId ? setAccountFor({ id: b.id, checkIn: true }) : b.payment.balanceCents > 0 ? setPayingFor(b) : run(() => client.checkIn(b.id))
                  }
                />
              )}
              {station === "proshop" && b.status !== "no_show" && (
                <Action label={b.golferId ? "Change golfer" : "Link golfer"} onPress={() => setAccountFor({ id: b.id, checkIn: false })} />
              )}
              {station === "starter" && b.status === "checked_in" && (
                <Action label="Send off the tee" primary onPress={() => setCartsFor({ booking: b, sendOff: true })} />
              )}
              {(b.status === "checked_in" || b.status === "teed_off") && (
                <Action label={b.cartNumbers.length ? "Change carts" : "Add carts"} onPress={() => setCartsFor({ booking: b, sendOff: false })} />
              )}
              {b.status === "confirmed" && <Action label="No-show" onPress={() => run(() => client.noShow(b.id))} />}
              {(b.status === "confirmed" || b.status === "checked_in") && <Action label="Move" onPress={() => setMoving(b)} />}
              {b.status === "confirmed" && (
                <Action label="Cancel" danger onPress={() => setCancelling(b.id)} />
              )}
            </View>
          )}
          {cancelling === b.id && (
            <View style={{ marginTop: 10 }} accessibilityLiveRegion="polite">
              <Text style={styles.muted}>
                Cancel {b.customerName}'s booking for {b.players} {b.players === 1 ? "player" : "players"}? Their spots open up again.
              </Text>
              <View style={styles.actions}>
                <Action
                  label="Cancel booking"
                  danger
                  onPress={() => {
                    setCancelling(undefined);
                    run(() => client.cancel(b.id));
                  }}
                />
                <Action label="Keep booking" onPress={() => setCancelling(undefined)} />
              </View>
            </View>
          )}
          {accountFor?.id === b.id && (
            <>
              <GolferPicker
                client={client}
                booking={b}
                onLinked={() => {
                  const { checkIn } = accountFor;
                  setAccountFor(undefined);
                  onChanged();
                  if (checkIn) b.payment.balanceCents > 0 ? setPayingFor(b) : run(() => client.checkIn(b.id));
                }}
                onCancel={() => setAccountFor(undefined)}
              />
              {accountFor.checkIn && (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  style={{ marginTop: 8 }}
                  onPress={() => {
                    setAccountFor(undefined);
                    b.payment.balanceCents > 0 ? setPayingFor(b) : run(() => client.checkIn(b.id));
                  }}
                >
                  <Text style={styles.skip}>Golfer won't give details? Check in without an account</Text>
                </Pressable>
              )}
            </>
          )}
          {payingFor?.id === b.id && (
            <PaymentForm
              booking={b}
              onPay={(method) => {
                setPayingFor(undefined);
                run(() => client.checkIn(b.id, method));
              }}
              onCancel={() => setPayingFor(undefined)}
            />
          )}
          {cartsFor?.booking.id === b.id && (
            <CartForm
              booking={b}
              sendOff={cartsFor.sendOff}
              onSave={async (carts) => {
                const { sendOff } = cartsFor;
                setCartsFor(undefined);
                const unsigned = carts.filter((c) => !b.signedCarts.includes(c));
                if (unsigned.length === 0) {
                  return run(() => (sendOff ? client.teeOff(b.id, carts, []) : client.setCarts(b.id, carts, [])));
                }
                try {
                  setSigning({ booking: b, carts, unsigned, sendOff, waiver: await client.waiver() });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't load the cart waiver");
                }
              }}
              onCancel={() => setCartsFor(undefined)}
            />
          )}
          {moving?.id === b.id && (
            <MovePicker
              sheet={sheet}
              booking={b}
              onPick={(to) => {
                setMoving(undefined);
                run(() => client.move(b.id, to));
              }}
              onCancel={() => setMoving(undefined)}
            />
          )}
        </View>
      ))}

      {signing && (
        <WaiverModal
          waiver={signing.waiver}
          carts={signing.unsigned}
          onCancel={() => setSigning(undefined)}
          onDone={(signatures) => {
            const { booking, carts, sendOff } = signing;
            setSigning(undefined);
            run(() =>
              sendOff ? client.teeOff(booking.id, carts, signatures) : client.setCarts(booking.id, carts, signatures),
            );
          }}
        />
      )}

      {teeTime.status === "open" && spotsLeft > 0 && (
        <WalkInForm
          maxPlayers={spotsLeft}
          courseHoles={courseHoles}
          // Residency is checked and priced at the pro shop, so the starter doesn't pick a rate.
          showRate={station === "proshop"}
          onSubmit={(name, players, holes, cart, resident) =>
            run(() =>
              client.book({
                teeTimeId: teeTime.id,
                holes,
                // Walk-ins without an email get a placeholder so the booking can still be made.
                customer: { name, email: `walkin+${Date.now()}@walkin.local` },
                players: Array.from({ length: players }, () => ({
                  residency: resident ? "resident" : "nonresident",
                  ageGroup: "adult",
                })),
                addOns: cart ? [{ code: "gas_cart", quantity: players }] : [],
              }),
            )
          }
        />
      )}

      <Text style={styles.section}>Tee time</Text>
      <TextInput
        style={styles.input}
        placeholder="Note, e.g. Ladies league"
        value={note}
        onChangeText={setNote}
        onBlur={() => note !== (teeTime.note ?? "") && run(() => client.setTeeTime(teeTime.id, { note: note || null }))}
      />
      <View style={styles.actions}>
        {teeTime.status === "open" ? (
          <Action label="Block this time" onPress={() => run(() => client.setTeeTime(teeTime.id, { status: "blocked", note: note || null }))} />
        ) : (
          <Action label="Reopen this time" primary onPress={() => run(() => client.setTeeTime(teeTime.id, { status: "open" }))} />
        )}
      </View>
    </ScrollView>
  );
}

function Action({ label, onPress, primary, danger }: { label: string; onPress: () => void; primary?: boolean; danger?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed, focused }: WebPress) => [
        styles.action,
        focused && { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
        primary && { backgroundColor: colors.green, borderColor: colors.green },
        danger && { borderColor: colors.noShow },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.actionText, primary && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

function MovePicker({ sheet, booking, onPick, onCancel }: { sheet: SheetTeeTime[]; booking: SheetBooking; onPick: (id: string) => void; onCancel: () => void }) {
  const options = sheet.filter(
    (t) => t.id !== booking.teeTimeId && t.status === "open" && t.maxPlayers - t.bookedPlayers >= booking.players,
  );
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.muted}>Move to a time with room for {booking.players}:</Text>
      <ScrollView horizontal style={{ marginVertical: 8 }}>
        {options.map((t) => (
          <Pressable key={t.id} accessibilityRole="button" onPress={() => onPick(t.id)} style={styles.chip}>
            <Text style={{ color: colors.greenText, fontWeight: "600" }}>{formatTime(t.localTime)}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Action label="Don't move" onPress={onCancel} />
    </View>
  );
}

function CartForm({ booking, sendOff, onSave, onCancel }: { booking: SheetBooking; sendOff: boolean; onSave: (carts: string[]) => void; onCancel: () => void }) {
  const [value, setValue] = useState(booking.cartNumbers.join(", "));
  const carts = value.split(/[\s,]+/).filter(Boolean);
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.muted}>Cart numbers (leave empty if walking). Each driver signs the cart waiver next.</Text>
      <TextInput
        style={[styles.input, { marginTop: 6 }]}
        placeholder="e.g. 12, 14"
        value={value}
        onChangeText={setValue}
        keyboardType="numbers-and-punctuation"
        autoFocus
      />
      <View style={styles.actions}>
        <Action label={sendOff ? "Send off" : "Save carts"} primary onPress={() => onSave(carts)} />
        <Action label="Back" onPress={onCancel} />
      </View>
    </View>
  );
}

function PaymentLine({ booking }: { booking: SheetBooking }) {
  const { status, balanceCents, methods } = booking.payment;
  if (status === "paid") {
    const how = methods.map((m) => paymentMethodLabel[m] ?? m).join(" + ");
    return <Text style={[styles.payment, { color: colors.checkedIn }]}>Paid{how ? ` (${how})` : ""}</Text>;
  }
  return (
    <Text style={[styles.payment, { color: colors.noShow }]}>
      {status === "partial" ? "Part paid, owes " : "Not paid, owes "}
      {money(balanceCents)}
    </Text>
  );
}

const PAYMENT_OPTIONS: { method: PaymentMethod; label: string }[] = [
  { method: "card", label: "Card" },
  { method: "cash", label: "Cash" },
  { method: "punch_card", label: "Punch card" },
  { method: "gift_card", label: "Gift card" },
  { method: "comp", label: "Comp" },
];

function PaymentForm({ booking, onPay, onCancel }: { booking: SheetBooking; onPay: (m: PaymentMethod) => void; onCancel: () => void }) {
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.muted}>How is {booking.customerName} paying {money(booking.payment.balanceCents)}?</Text>
      <View style={styles.actions}>
        {PAYMENT_OPTIONS.map((o) => (
          <Action key={o.method} label={o.label} primary={o.method === "card"} onPress={() => onPay(o.method)} />
        ))}
        <Action label="Back" onPress={onCancel} />
      </View>
    </View>
  );
}

function WalkInForm({ maxPlayers, courseHoles, showRate, onSubmit }: { maxPlayers: number; courseHoles: number; showRate: boolean; onSubmit: (name: string, players: number, holes: number, cart: boolean, resident: boolean) => void }) {
  const [name, setName] = useState("");
  const [chosenPlayers, setPlayers] = useState(1);
  // Spots can fill while the form is open; never offer more than are left.
  const players = Math.min(chosenPlayers, maxPlayers);
  const [holes, setHoles] = useState(courseHoles);
  const [cart, setCart] = useState(false);
  const [resident, setResident] = useState(false);
  return (
    <View style={styles.walkIn}>
      <Text style={styles.section}>Add a walk-in</Text>
      <TextInput style={styles.input} placeholder="Name" value={name} onChangeText={setName} />
      <Row label="Players">
        {Array.from({ length: maxPlayers }, (_, i) => i + 1).map((n) => (
          <Toggle key={n} label={String(n)} on={players === n} onPress={() => setPlayers(n)} />
        ))}
      </Row>
      <Row label="Holes">
        {[courseHoles, courseHoles * 2].filter((h) => h <= 18).map((h) => (
          <Toggle key={h} label={String(h)} on={holes === h} onPress={() => setHoles(h)} />
        ))}
      </Row>
      <Row label="Carts">
        <Toggle label="Walking" on={!cart} onPress={() => setCart(false)} />
        <Toggle label="Gas carts" on={cart} onPress={() => setCart(true)} />
      </Row>
      {showRate && (
        <Row label="Rate">
          <Toggle label="Nonresident" on={!resident} onPress={() => setResident(false)} />
          <Toggle label="Resident" on={resident} onPress={() => setResident(true)} />
        </Row>
      )}
      <Action
        label="Add to tee sheet"
        primary
        onPress={() => {
          if (!name.trim()) return;
          onSubmit(name.trim(), players, holes, cart, showRate && resident);
          setName("");
        }}
      />
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
      <Text style={[styles.muted, { width: 70 }]}>{label}</Text>
      {children}
    </View>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={[styles.toggle, on && styles.toggleOn]}>
      <Text style={{ color: on ? "#fff" : colors.text, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: colors.card },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  time: { fontSize: 30, fontWeight: "700", color: colors.text },
  close: { padding: 8 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.noShow, backgroundColor: "#fbebeb", padding: 10, borderRadius: 8, marginBottom: 10 },
  section: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
  booking: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginBottom: 10 },
  name: { fontSize: 17, fontWeight: "600", color: colors.text },
  badge: { fontSize: 12, fontWeight: "700", borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  action: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44, justifyContent: "center" },
  actionText: { fontSize: 15, fontWeight: "600", color: colors.text },
  chip: { borderWidth: 1, borderColor: colors.green, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, marginRight: 6 },
  walkIn: { marginTop: 4 },
  carts: { color: colors.greenText, fontWeight: "700", fontSize: 14, marginTop: 4 },
  payment: { fontWeight: "700", fontSize: 14, marginTop: 4 },
  warning: { color: colors.warn, fontSize: 14, marginTop: 4 },
  account: { color: colors.greenText, fontSize: 14, marginTop: 4, fontWeight: "600" },
  skip: { color: colors.muted, fontSize: 14, textDecorationLine: "underline" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 10, color: colors.text },
  toggle: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, minWidth: 44, minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", marginRight: 6, marginBottom: 4 },
  toggleOn: { backgroundColor: colors.green, borderColor: colors.green },
});
