import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, SheetBooking, SheetTeeTime } from "./api";
import { colors, formatTime, money, statusColor, statusLabel } from "./theme";

interface Props {
  client: Client;
  teeTime: SheetTeeTime;
  sheet: SheetTeeTime[];
  courseHoles: number;
  onChanged: () => void;
  onClose: () => void;
}

/** Native confirm dialogs on iOS/Android, window.confirm on the web. */
function confirm(title: string, message: string, action: string): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Keep", style: "cancel", onPress: () => resolve(false) },
      { text: action, style: "destructive", onPress: () => resolve(true) },
    ]),
  );
}

export function TeeTimePanel({ client, teeTime, sheet, courseHoles, onChanged, onClose }: Props) {
  const [error, setError] = useState<string>();
  const [moving, setMoving] = useState<SheetBooking>();
  const [cartsFor, setCartsFor] = useState<SheetBooking>();
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

      {error && <Text style={styles.error}>{error}</Text>}

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
          {b.cartNumbers.length > 0 && (
            <Text style={styles.carts}>
              {b.cartNumbers.length === 1 ? "Cart" : "Carts"} {b.cartNumbers.join(", ")}
            </Text>
          )}
          {cartsFor?.id !== b.id && moving?.id !== b.id && (
            <View style={styles.actions}>
              {b.status !== "checked_in" && <Action label="Check in" primary onPress={() => setCartsFor(b)} />}
              {b.status === "checked_in" && <Action label="Change carts" onPress={() => setCartsFor(b)} />}
              {b.status === "confirmed" && <Action label="No-show" onPress={() => run(() => client.noShow(b.id))} />}
              {b.status !== "checked_in" && <Action label="Move" onPress={() => setMoving(b)} />}
              {b.status === "confirmed" && (
                <Action
                  label="Cancel"
                  danger
                  onPress={async () => {
                    if (await confirm("Cancel booking?", `${b.customerName}, ${b.players} players`, "Cancel booking")) {
                      run(() => client.cancel(b.id));
                    }
                  }}
                />
              )}
            </View>
          )}
          {cartsFor?.id === b.id && (
            <CartForm
              booking={b}
              onSave={(carts) => {
                setCartsFor(undefined);
                run(() => (b.status === "checked_in" ? client.setCarts(b.id, carts) : client.checkIn(b.id, carts)));
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

      {teeTime.status === "open" && spotsLeft > 0 && (
        <WalkInForm
          maxPlayers={spotsLeft}
          courseHoles={courseHoles}
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
      style={({ pressed }) => [
        styles.action,
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

function CartForm({ booking, onSave, onCancel }: { booking: SheetBooking; onSave: (carts: string[]) => void; onCancel: () => void }) {
  const [value, setValue] = useState(booking.cartNumbers.join(", "));
  const carts = value.split(/[\s,]+/).filter(Boolean);
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.muted}>Cart numbers (leave empty if walking)</Text>
      <TextInput
        style={[styles.input, { marginTop: 6 }]}
        placeholder="e.g. 12, 14"
        value={value}
        onChangeText={setValue}
        keyboardType="numbers-and-punctuation"
        autoFocus
      />
      <View style={styles.actions}>
        <Action label={booking.status === "checked_in" ? "Save carts" : "Confirm check-in"} primary onPress={() => onSave(carts)} />
        <Action label="Back" onPress={onCancel} />
      </View>
    </View>
  );
}

function WalkInForm({ maxPlayers, courseHoles, onSubmit }: { maxPlayers: number; courseHoles: number; onSubmit: (name: string, players: number, holes: number, cart: boolean, resident: boolean) => void }) {
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
      <Row label="Rate">
        <Toggle label="Nonresident" on={!resident} onPress={() => setResident(false)} />
        <Toggle label="Resident" on={resident} onPress={() => setResident(true)} />
      </Row>
      <Action
        label="Add to tee sheet"
        primary
        onPress={() => {
          if (!name.trim()) return;
          onSubmit(name.trim(), players, holes, cart, resident);
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
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 10, color: colors.text },
  toggle: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, minWidth: 44, minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", marginRight: 6, marginBottom: 4 },
  toggleOn: { backgroundColor: colors.green, borderColor: colors.green },
});
