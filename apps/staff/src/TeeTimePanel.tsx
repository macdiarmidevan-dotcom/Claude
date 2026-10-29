import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { quotePlayer } from "@golf/core";
import type { ScrollViewInstance } from "react-native";
import type { Client, Course, RoundChoice, GolferAccount, PaymentMethod, Product, SalePaymentMethod, SheetBooking, SheetTeeTime, Station, Waiver, Redemption, Wallet } from "./api";
import { WaiverModal } from "./WaiverModal";
import { CardChargeModal, useCardReader } from "./CardReader";
import { GolferPicker, useSearch } from "./Golfers";
import { colors, type WebPress, formatTime, money, paymentMethodLabel, statusColor, statusLabel } from "./theme";

interface Props {
  client: Client;
  teeTime: SheetTeeTime;
  sheet: SheetTeeTime[];
  courseHoles: number;
  /** For showing what a walk-in or guests will cost before they're added. */
  course: Course;
  station: Station;
  onOpenGolfer?: (golferId: string) => void;
  onChanged: () => void;
  onClose: () => void;
  /** The group whose name was tapped on the tee sheet: shown highlighted and scrolled to. */
  focusBookingId?: string;
  /** Guests dragged onto a group on the tee sheet, waiting for staff to confirm. */
  guestRequest?: { bookingId: string; count: number; key: number };
}

export function TeeTimePanel({ client, teeTime, sheet, courseHoles, course, station, onOpenGolfer, onChanged, onClose, focusBookingId, guestRequest }: Props) {
  const price = (p: { players: number; holes: number; resident: boolean; riding: boolean }) => priceRound(course, teeTime.startsAt, p);
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
  const [guestsFor, setGuestsFor] = useState<{ id: string; count: number }>();
  useEffect(() => {
    if (guestRequest) setGuestsFor({ id: guestRequest.bookingId, count: guestRequest.count });
  }, [guestRequest?.key]);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const cardTops = useRef(new Map<string, number>());
  useEffect(() => {
    const y = focusBookingId && cardTops.current.get(focusBookingId);
    // The first group is already in view under the time; only scroll for ones further down.
    if (y && y > 200) scrollRef.current?.scrollTo({ y: y - 8, animated: true });
  }, [focusBookingId]);
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
    <ScrollView ref={scrollRef} style={styles.panel} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.time}>{formatTime(teeTime.localTime)}</Text>
          <Text style={styles.muted}>
            {teeTime.status === "blocked" ? "Blocked" : `${spotsLeft} of ${teeTime.maxPlayers} spots open`}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
          <Text style={{ fontSize: 14, color: colors.muted }}>Close</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.error} accessibilityLiveRegion="assertive" role="alert">{error}</Text>}

      <Text style={styles.section}>Groups</Text>
      {active.length === 0 && <Text style={styles.muted}>No one booked yet.</Text>}
      {active.map((b) => (
        <View
          key={b.id}
          style={[styles.booking, b.id === focusBookingId && styles.bookingFocus]}
          onLayout={(e) => {
            const y = e.nativeEvent.layout.y;
            const first = !cardTops.current.has(b.id);
            cardTops.current.set(b.id, y);
            if (first && b.id === focusBookingId && y > 200) scrollRef.current?.scrollTo({ y: y - 8, animated: false });
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            {b.golferId && onOpenGolfer ? (
              <Pressable accessibilityRole="link" accessibilityLabel={`Open ${b.customerName}'s golfer account`} onPress={() => onOpenGolfer(b.golferId!)} hitSlop={6}>
                <Text style={[styles.name, styles.nameLink]}>{b.customerName} ›</Text>
              </Pressable>
            ) : (
              <Text style={styles.name}>{b.customerName}</Text>
            )}
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
              {b.golferId ? "✓ On golfer account (tap the name to open it)" : "No golfer account linked yet"}
            </Text>
          )}
          <Text style={styles.muted}>{b.riding ? "Riding" : "Walking"}</Text>
          {b.cartNumbers.length > 0 && (
            <Text style={styles.carts}>
              {b.cartNumbers.length === 1 ? "Cart" : "Carts"} {b.cartNumbers.join(", ")}
            </Text>
          )}
          {station === "starter" && b.status === "confirmed" && (
            <Text style={styles.warning}>Not checked in at the pro shop yet</Text>
          )}
          {cartsFor?.booking.id !== b.id && moving?.id !== b.id && payingFor?.id !== b.id && cancelling !== b.id && accountFor?.id !== b.id && guestsFor?.id !== b.id && (
            <View style={styles.actions}>
              {station === "proshop" && (b.status === "confirmed" || b.status === "no_show") && (
                <CheckInButton
                  label="Check in"
                  detail={b.payment.balanceCents > 0 ? `${money(b.payment.balanceCents)} due` : "Paid"}
                  onPress={() =>
                    // The first check-in creates the golfer's account; after that it's a name search.
                    !b.golferId ? setAccountFor({ id: b.id, checkIn: true }) : setPayingFor(b)
                  }
                />
              )}
              {station === "starter" && b.status === "checked_in" && (
                // The starter's half of check-in: carts and waivers at the tee box, then off they go.
                <CheckInButton label="Check in at the tee" detail="Carts, then send off" onPress={() => setCartsFor({ booking: b, sendOff: true })} />
              )}
              {station === "proshop" && b.status !== "no_show" && (
                <Action label={b.golferId ? "Change golfer" : "Link golfer"} onPress={() => setAccountFor({ id: b.id, checkIn: false })} />
              )}
              {(b.status === "checked_in" || b.status === "teed_off") && (
                <Action label={b.cartNumbers.length ? "Change carts" : "Add carts"} onPress={() => setCartsFor({ booking: b, sendOff: false })} />
              )}
              {spotsLeft > 0 && b.status !== "no_show" && <Action label="Add guests" onPress={() => setGuestsFor({ id: b.id, count: 1 })} />}
              {b.status === "confirmed" && <Action label="No-show" onPress={() => run(() => client.noShow(b.id))} />}
              {b.status === "no_show" && <Action label="Undo no-show" onPress={() => run(() => client.undoNoShow(b.id))} />}
              {(b.status === "confirmed" || b.status === "checked_in") && <Action label="Move" onPress={() => setMoving(b)} />}
              {(b.status === "confirmed" || b.status === "no_show") && (
                <Action label="Remove" danger onPress={() => setCancelling(b.id)} />
              )}
            </View>
          )}
          {guestsFor?.id === b.id && (
            <GuestForm
              booking={b}
              initialCount={guestsFor.count}
              maxGuests={spotsLeft}
              showRate={station === "proshop"}
              price={price}
              onCancel={() => setGuestsFor(undefined)}
              onSave={(count, riding, resident) => {
                setGuestsFor(undefined);
                run(() => client.addGuests(b.id, { count, riding, ...(station === "proshop" && resident ? { residency: "resident" as const } : {}) }));
              }}
            />
          )}
          {cancelling === b.id && (
            <RemoveForm
              booking={b}
              onCancel={() => setCancelling(undefined)}
              onRemove={(count) => {
                setCancelling(undefined);
                run(() => (count >= b.players ? client.cancel(b.id) : client.removePlayers(b.id, count)));
              }}
            />
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
                  if (checkIn) setPayingFor(b);
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
                    setPayingFor(b);
                  }}
                >
                  <Text style={styles.skip}>Golfer won't give details? Check in without an account</Text>
                </Pressable>
              )}
            </>
          )}
          {payingFor?.id === b.id && (
            <CheckoutForm
              client={client}
              booking={b}
              price={price}
              onPay={(method, items, round, cardPaymentId, redeem) => {
                setPayingFor(undefined);
                run(() => client.checkIn(b.id, method, items, round, cardPaymentId, redeem));
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
          price={price}
          client={client}
          onSubmit={(name, golfer, players, holes, cart, resident) =>
            run(async () => {
              const booking = (await client.book({
                teeTimeId: teeTime.id,
                holes,
                // A golfer found in the system books under their account; anyone else gets a
                // placeholder email so the booking can still be made.
                customer: golfer ? { name: golfer.name, email: golfer.email, phone: golfer.phone } : { name, email: `walkin+${Date.now()}@walkin.local` },
                players: Array.from({ length: players }, () => ({
                  residency: resident ? "resident" : "nonresident",
                  ageGroup: "adult",
                })),
                addOns: cart ? [{ code: "gas_cart", quantity: players }] : [],
              })) as { id: string };
              if (golfer) await client.linkGolfer(booking.id, golfer.id);
            })
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
        primary && { backgroundColor: colors.primary, borderColor: colors.primary },
        danger && { borderColor: colors.noShow },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.actionText, primary && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

/** The one thing staff come to a group for, so it's the biggest button on the card. */
function CheckInButton({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${detail}`}
      onPress={onPress}
      style={({ pressed, focused }: WebPress) => [
        styles.checkIn,
        focused && ({ outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid", outlineOffset: 2 } as object),
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text style={styles.checkInText}>✓ {label}</Text>
      <Text style={styles.checkInDetail}>{detail}</Text>
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
            <Text style={{ color: colors.primaryText, fontWeight: "600" }}>{formatTime(t.localTime)}</Text>
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
        <Action label={sendOff ? "Check in & send off" : "Save carts"} primary onPress={() => onSave(carts)} />
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
  // A card the course tracks on paper, not one sold on the golfer's account.
  { method: "punch_card", label: "Paper punch card" },
  { method: "gift_card", label: "Gift card" },
  { method: "comp", label: "Comp" },
];

type PriceFn = (p: { players: number; holes: number; resident: boolean; riding: boolean }) => number | undefined;

/**
 * What a group will pay: each player's green fee at this time (with the replay rate for a
 * second loop) plus a gas cart each when riding. Matches what the server charges, except on
 * holidays, which the server prices; undefined when the course has no rate that fits.
 */
function priceRound(course: Course, startsAt: string, p: { players: number; holes: number; resident: boolean; riding: boolean }) {
  try {
    const loops = Math.max(1, Math.round(p.holes / course.holes));
    const player = { residency: p.resident ? "resident" : "nonresident", ageGroup: "adult" } as const;
    const fee = quotePlayer(course.rates ?? [], player, { startsAt, timeZone: course.timeZone }, loops).totalCents;
    const cart = p.riding ? (course.addOns.find((a) => a.code === "gas_cart")?.priceCents ?? 0) : 0;
    return (fee + cart) * p.players;
  } catch {
    return undefined;
  }
}

function PriceLine({ cents, what }: { cents: number | undefined; what: string }) {
  return (
    <View style={styles.priceLine} accessibilityLiveRegion="polite">
      <Text style={styles.muted}>{what}</Text>
      <Text style={styles.priceTotal}>{cents === undefined ? "No rate set" : `Total ${money(cents)}`}</Text>
    </View>
  );
}

const ITEM_METHODS: { method: SalePaymentMethod; label: string }[] = [
  { method: "card", label: "Card" },
  { method: "cash", label: "Cash" },
  { method: "gift_card", label: "Gift card" },
];

/**
 * Checking a group in at the pro shop: take what's owed for the round and ring up anything
 * else they're buying (water, snacks, balls) in the same step.
 */
function CheckoutForm({
  client,
  booking,
  price,
  onPay,
  onCancel,
}: {
  client: Client;
  booking: SheetBooking;
  price: PriceFn;
  onPay: (
    m: PaymentMethod | undefined,
    items?: { lines: { productId: string; quantity: number }[]; paymentMethod: SalePaymentMethod },
    round?: RoundChoice,
    cardPaymentId?: string,
    redeem?: Redemption,
  ) => void;
  onCancel: () => void;
}) {
  const [products, setProducts] = useState<Product[]>();
  const [taxBps, setTaxBps] = useState(0);
  const [cart, setCart] = useState<{ product: Product; quantity: number }[]>([]);
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("card");
  // Punch cards and comps cover the round only, so items need a way to pay of their own.
  const [itemMethod, setItemMethod] = useState<SalePaymentMethod>("card");

  useEffect(() => {
    client.products().then(setProducts).catch(() => setProducts([]));
    client.posSettings().then((x) => setTaxBps(x.salesTaxBps)).catch(() => undefined);
  }, [client]);

  // The rate and walking/riding can be changed at the counter until the group has paid anything.
  const canReprice = booking.payment.paidCents === 0;
  const [resident, setResident] = useState(booking.resident);
  const [riding, setRiding] = useState(booking.riding);
  const changed = canReprice && (resident !== booking.resident || riding !== booking.riding);
  const repriced = changed ? price({ players: booking.players, holes: booking.holes, resident, riding }) : undefined;
  const round: RoundChoice | undefined = changed && repriced !== undefined ? { residency: resident ? "resident" : "nonresident", riding } : undefined;
  const roundOwed = round ? repriced! : booking.payment.balanceCents;

  // The golfer's punch cards, season pass and points come off the round before anything else.
  const [wallet, setWallet] = useState<Wallet>();
  useEffect(() => {
    if (booking.golferId) client.wallet(booking.golferId).then(setWallet).catch(() => undefined);
  }, [client, booking.golferId]);
  const passes = wallet?.passes.filter((p) => p.usable) ?? [];
  const [passUse, setPassUse] = useState<{ id: string; rounds: number }>();
  const pass = passes.find((p) => p.id === passUse?.id);
  const [rewards, setRewards] = useState(0);
  // Each round on a pass covers one player's green fee, plus their cart if the pass includes it.
  const perPlayer = (() => {
    if (round) {
      const walk = price({ players: 1, holes: booking.holes, resident, riding: false }) ?? 0;
      const ride = riding ? (price({ players: 1, holes: booking.holes, resident, riding: true }) ?? walk) - walk : 0;
      return { green: walk, cart: ride };
    }
    return { green: booking.greenFeeCents / booking.players, cart: booking.cartCents / booking.players };
  })();
  const passCovers = pass && passUse ? Math.min(roundOwed, Math.round((perPlayer.green + (pass.coversCart ? perPlayer.cart : 0)) * passUse.rounds)) : 0;
  const rewardCents = wallet?.loyalty.rewardCents ?? 0;
  const maxRewards = wallet && rewardCents > 0 ? Math.min(wallet.loyalty.rewardsAvailable, Math.floor((roundOwed - passCovers) / rewardCents)) : 0;
  const usedRewards = Math.min(rewards, maxRewards);
  const pointsOff = usedRewards * rewardCents;
  const owed = roundOwed - passCovers - pointsOff;
  const redeem: Redemption | undefined =
    pass || usedRewards
      ? { ...(pass && passUse ? { pass: { golferPassId: pass.id, rounds: passUse.rounds } } : {}), ...(usedRewards ? { points: usedRewards * wallet!.loyalty.rewardPoints } : {}) }
      : undefined;
  const add = (p: Product) =>
    setCart((c) => (c.some((x) => x.product.id === p.id) ? c.map((x) => (x.product.id === p.id ? { ...x, quantity: x.quantity + 1 } : x)) : [...c, { product: p, quantity: 1 }]));
  const setQty = (id: string, n: number) => setCart((c) => (n < 1 ? c.filter((x) => x.product.id !== id) : c.map((x) => (x.product.id === id ? { ...x, quantity: n } : x))));
  const sameMethod = method === "card" || method === "cash" || method === "gift_card";
  const payItemsWith: SalePaymentMethod = sameMethod ? (method as SalePaymentMethod) : itemMethod;
  const itemsSubtotal = cart.reduce((s, x) => s + x.product.priceCents * x.quantity, 0);
  const itemsTax = Math.round((cart.filter((x) => x.product.taxable).reduce((s, x) => s + x.product.priceCents * x.quantity, 0) * taxBps) / 10_000);
  const total = owed + itemsSubtotal + itemsTax;
  const roundMethod = owed > 0 ? method : undefined;
  const itemsWith = owed > 0 ? payItemsWith : itemMethod;
  // One tap on the reader pays everything going on the card.
  const cardCents = (roundMethod === "card" ? owed : 0) + (cart.length && itemsWith === "card" ? itemsSubtotal + itemsTax : 0);
  const reader = useCardReader();
  const [charging, setCharging] = useState(false);
  const pay = (cardPaymentId?: string) =>
    onPay(roundMethod, cart.length ? { lines: cart.map((x) => ({ productId: x.product.id, quantity: x.quantity })), paymentMethod: itemsWith } : undefined, round, cardPaymentId, redeem);
  const match = q.trim().toLowerCase();
  // Quick picks: drinks and snacks first, since that's what golfers grab on the way out.
  const shown = (products ?? [])
    .filter((p) => (match ? p.name.toLowerCase().includes(match) || p.sku?.toLowerCase() === match : true))
    .sort((a, b) => Number(b.category === "Food & drink") - Number(a.category === "Food & drink"))
    .slice(0, match ? 12 : 8);

  return (
    <View style={{ marginTop: 10 }}>
      <Text style={styles.section}>Check in {booking.customerName}</Text>
      {canReprice && (
        <>
          <Row label="Rate">
            <Toggle label="Nonresident" on={!resident} onPress={() => setResident(false)} />
            <Toggle label="Resident" on={resident} onPress={() => setResident(true)} />
          </Row>
          <Row label="Walk/ride">
            <Toggle label="Walking" on={!riding} onPress={() => setRiding(false)} />
            <Toggle label="Riding" on={riding} onPress={() => setRiding(true)} />
          </Row>
          {changed && repriced === undefined && <Text style={styles.warning}>No rate is set for that, so the round stays at its booked price.</Text>}
        </>
      )}
      <View style={styles.billRow}>
        <Text style={styles.muted}>
          Round: {booking.players} {booking.players === 1 ? "player" : "players"}, {booking.holes} holes, {(round ? riding : booking.riding) ? "riding" : "walking"}
          {round ? `, ${resident ? "resident" : "nonresident"}` : ""}
        </Text>
        <Text style={styles.name}>{roundOwed > 0 ? money(roundOwed) : "Paid"}</Text>
      </View>
      {passCovers > 0 && pass && (
        <View style={styles.billRow}>
          <Text style={styles.muted}>
            {pass.name}, {passUse!.rounds} {passUse!.rounds === 1 ? "round" : "rounds"}
          </Text>
          <Text style={[styles.name, { color: colors.checkedIn }]}>−{money(passCovers)}</Text>
        </View>
      )}
      {pointsOff > 0 && (
        <View style={styles.billRow}>
          <Text style={styles.muted}>{(usedRewards * wallet!.loyalty.rewardPoints).toLocaleString()} loyalty points</Text>
          <Text style={[styles.name, { color: colors.checkedIn }]}>−{money(pointsOff)}</Text>
        </View>
      )}
      {cart.map((x) => (
        <View key={x.product.id} style={styles.billRow}>
          <Text style={[styles.muted, { flex: 1 }]} numberOfLines={1}>
            {x.product.name}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Toggle label="−" on={false} onPress={() => setQty(x.product.id, x.quantity - 1)} />
            <Text style={{ minWidth: 18, textAlign: "center", color: colors.text }}>{x.quantity}</Text>
            <Toggle label="+" on={false} onPress={() => setQty(x.product.id, x.quantity + 1)} />
          </View>
          <Text style={[styles.name, { width: 72, textAlign: "right" }]}>{money(x.product.priceCents * x.quantity)}</Text>
        </View>
      ))}
      {itemsTax > 0 && (
        <View style={styles.billRow}>
          <Text style={styles.muted}>Sales tax on items</Text>
          <Text style={styles.muted}>{money(itemsTax)}</Text>
        </View>
      )}
      <View style={[styles.billRow, { borderBottomWidth: 0 }]}>
        <Text style={styles.name}>Total</Text>
        <Text style={styles.priceTotal}>{money(total)}</Text>
      </View>

      {roundOwed > 0 && passes.length > 0 && (
        <>
          <Text style={[styles.muted, { marginTop: 8, marginBottom: 6 }]}>Use a pass</Text>
          <View style={styles.actions}>
            <Toggle label="No" on={!pass} onPress={() => setPassUse(undefined)} />
            {passes.map((p) => (
              <Toggle
                key={p.id}
                label={p.kind === "punch_card" ? `${p.name} (${p.roundsLeft} left)` : p.name}
                on={pass?.id === p.id}
                onPress={() => setPassUse({ id: p.id, rounds: p.kind === "season_pass" ? 1 : Math.min(booking.players, p.roundsLeft ?? 1) })}
              />
            ))}
          </View>
          {pass?.kind === "punch_card" && (
            <Row label="Rounds">
              {Array.from({ length: Math.min(booking.players, pass.roundsLeft ?? 0) }, (_, i) => i + 1).map((n) => (
                <Toggle key={n} label={String(n)} on={passUse!.rounds === n} onPress={() => setPassUse({ id: pass.id, rounds: n })} />
              ))}
            </Row>
          )}
          {pass?.kind === "season_pass" && <Text style={styles.muted}>A season pass covers the holder only.</Text>}
        </>
      )}
      {roundOwed > 0 && wallet && wallet.loyalty.rewardsAvailable > 0 && (maxRewards > 0 || usedRewards > 0) && (
        <>
          <Text style={[styles.muted, { marginTop: 8, marginBottom: 6 }]}>
            Use points ({wallet.loyalty.points.toLocaleString()} available, {wallet.loyalty.rewardPoints} = {money(rewardCents)} off)
          </Text>
          <View style={styles.actions}>
            {Array.from({ length: maxRewards + 1 }, (_, n) => n).map((n) => (
              <Toggle key={n} label={n === 0 ? "No" : money(n * rewardCents)} on={usedRewards === n} onPress={() => setRewards(n)} />
            ))}
          </View>
        </>
      )}

      <Text style={[styles.muted, { marginTop: 8, marginBottom: 6 }]}>Add items</Text>
      <TextInput style={[styles.input, { marginBottom: 6 }]} accessibilityLabel="Search pro shop items" placeholder="Search items, e.g. water" value={q} onChangeText={setQ} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {!products ? (
          <Text style={styles.muted}>Loading items…</Text>
        ) : (
          shown.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={`Add ${p.name}, ${money(p.priceCents)}`}
              onPress={() => add(p)}
              style={({ hovered, focused }: WebPress) => [styles.itemChip, (hovered || focused) && { borderColor: colors.primary }]}
            >
              <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={1}>
                {p.name} · {money(p.priceCents)}
              </Text>
            </Pressable>
          ))
        )}
      </View>

      {owed > 0 && (
        <>
          <Text style={[styles.muted, { marginTop: 12, marginBottom: 6 }]}>Round paid by</Text>
          <View style={styles.actions}>
            {PAYMENT_OPTIONS.map((o) => (
              <Toggle key={o.method} label={o.label} on={method === o.method} onPress={() => setMethod(o.method)} />
            ))}
          </View>
        </>
      )}
      {cart.length > 0 && (owed === 0 || !sameMethod) && (
        <>
          <Text style={[styles.muted, { marginTop: 12, marginBottom: 6 }]}>Items paid by</Text>
          <View style={styles.actions}>
            {ITEM_METHODS.map((o) => (
              <Toggle key={o.method} label={o.label} on={itemMethod === o.method} onPress={() => setItemMethod(o.method)} />
            ))}
          </View>
        </>
      )}
      {cardCents > 0 && reader.needsReader && (
        <Text style={[styles.warning, { marginTop: 10 }]}>Pick this device's card reader in Settings to send cards to it. Until then, run the card on another terminal.</Text>
      )}
      <View style={styles.actions}>
        <Action
          label={total > 0 ? `Take ${money(total)} & check in` : "Check in"}
          primary
          onPress={() => (cardCents > 0 && reader.terminal ? setCharging(true) : pay())}
        />
        <Action label="Back" onPress={onCancel} />
      </View>
      {charging && reader.terminal && (
        <CardChargeModal
          client={client}
          terminal={reader.terminal}
          amountCents={cardCents}
          description={`Check-in: ${booking.customerName}`}
          onPaid={(p) => {
            setCharging(false);
            pay(p.id);
          }}
          onClose={() => setCharging(false)}
        />
      )}
    </View>
  );
}

function WalkInForm(props: {
  client: Client;
  maxPlayers: number;
  courseHoles: number;
  showRate: boolean;
  price: PriceFn;
  onSubmit: (name: string, golfer: GolferAccount | null, players: number, holes: number, cart: boolean, resident: boolean) => void;
}) {
  const { client, maxPlayers, courseHoles, showRate, price, onSubmit } = props;
  const [name, setName] = useState("");
  // The golfer account picked from the search, if the walk-in is already in the system.
  const [golfer, setGolfer] = useState<GolferAccount | null>(null);
  const { results } = useSearch(client, golfer ? "" : name);
  const [chosenPlayers, setPlayers] = useState(1);
  // Spots can fill while the form is open; never offer more than are left.
  const players = Math.min(chosenPlayers, maxPlayers);
  const [holes, setHoles] = useState(courseHoles);
  const [cart, setCart] = useState(false);
  const [resident, setResident] = useState(false);
  return (
    <View style={styles.walkIn}>
      <Text style={styles.section}>Add a walk-in</Text>
      <TextInput
        style={[styles.input, golfer && { marginBottom: 4 }]}
        accessibilityLabel="Golfer's name, phone or email"
        placeholder="Search golfers by name, phone or email"
        value={name}
        onChangeText={(t) => {
          setName(t);
          setGolfer(null);
        }}
      />
      {golfer ? (
        <Text style={[styles.account, { marginBottom: 10 }]}>
          ✓ {golfer.name} · {golfer.phone} · {golfer.roundsPlayed} {golfer.roundsPlayed === 1 ? "round" : "rounds"}
        </Text>
      ) : (
        results &&
        name.trim().length >= 2 && (
          <View style={styles.suggestions} accessibilityLiveRegion="polite">
            {results.slice(0, 6).map((g) => (
              <Pressable
                key={g.id}
                accessibilityRole="button"
                accessibilityLabel={`Use ${g.name}, ${g.phone}`}
                onPress={() => {
                  setGolfer(g);
                  setName(g.name);
                }}
                style={({ hovered, focused }: WebPress) => [styles.suggestion, (hovered || focused) && { backgroundColor: colors.primaryLight }]}
              >
                <Text style={styles.name}>{g.name}</Text>
                <Text style={styles.muted}>
                  {g.phone} · {g.email}
                </Text>
              </Pressable>
            ))}
            <Text style={[styles.muted, { padding: 8 }]}>
              {results.length ? "Not them? Keep typing to add the name as a new walk-in." : "No golfer accounts match. The name will be added as a new walk-in."}
            </Text>
          </View>
        )
      )}
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
      <Row label="Walk/ride">
        <Toggle label="Walking" on={!cart} onPress={() => setCart(false)} />
        <Toggle label="Riding" on={cart} onPress={() => setCart(true)} />
      </Row>
      {showRate && (
        <Row label="Rate">
          <Toggle label="Nonresident" on={!resident} onPress={() => setResident(false)} />
          <Toggle label="Resident" on={resident} onPress={() => setResident(true)} />
        </Row>
      )}
      <PriceLine cents={price({ players, holes, resident: showRate && resident, riding: cart })} what={`${players} ${players === 1 ? "player" : "players"}, ${holes} holes, ${cart ? "riding" : "walking"}`} />
      <Action
        label="Add to tee sheet"
        primary
        onPress={() => {
          if (!name.trim()) return;
          onSubmit(name.trim(), golfer, players, holes, cart, showRate && resident);
          setName("");
          setGolfer(null);
        }}
      />
    </View>
  );
}

/** Adds guests to a golfer's group. They're priced into the group's booking, not the golfer's own account. */
/** Takes the whole group off the tee sheet, or just the players who aren't coming. */
function RemoveForm({ booking, onRemove, onCancel }: { booking: SheetBooking; onRemove: (count: number) => void; onCancel: () => void }) {
  const [count, setCount] = useState(booking.players);
  const whole = count >= booking.players;
  const label = whole ? (booking.players === 1 ? "Remove" : "Remove whole group") : `Remove ${count} ${count === 1 ? "player" : "players"}`;
  return (
    <View style={{ marginTop: 10 }} accessibilityLiveRegion="polite">
      <Text style={[styles.name, { marginBottom: 8 }]}>Remove from the tee sheet</Text>
      {booking.players > 1 && (
        <Row label="Remove">
          {Array.from({ length: booking.players - 1 }, (_, i) => i + 1).map((n) => (
            <Toggle key={n} label={`${n} ${n === 1 ? "player" : "players"}`} on={count === n} onPress={() => setCount(n)} />
          ))}
          <Toggle label="Whole group" on={whole} onPress={() => setCount(booking.players)} />
        </Row>
      )}
      <Text style={styles.muted}>
        {whole
          ? `${booking.customerName}'s booking for ${booking.players} ${booking.players === 1 ? "player" : "players"} is cancelled and the spots open up again.`
          : `${booking.customerName} stays booked with ${booking.players - count} ${booking.players - count === 1 ? "player" : "players"}. Guests come off first, with their carts, and the bill drops to match.`}
      </Text>
      {booking.payment.paidCents > 0 && (
        <Text style={styles.warning}>They've already paid {money(booking.payment.paidCents)}. Anything they're owed back has to be refunded separately.</Text>
      )}
      <View style={styles.actions}>
        <Action label={label} danger onPress={() => onRemove(count)} />
        <Action label="Keep them" onPress={onCancel} />
      </View>
    </View>
  );
}

function GuestForm(props: {
  booking: SheetBooking;
  initialCount: number;
  maxGuests: number;
  showRate: boolean;
  price: PriceFn;
  onSave: (count: number, riding: boolean, resident: boolean) => void;
  onCancel: () => void;
}) {
  const { booking, initialCount, maxGuests, showRate, price, onSave, onCancel } = props;
  const [count, setCount] = useState(Math.max(1, Math.min(initialCount, maxGuests)));
  const [riding, setRiding] = useState(booking.riding);
  const [resident, setResident] = useState(false);
  if (maxGuests < 1) {
    return (
      <View style={{ marginTop: 10 }}>
        <Text style={styles.muted}>This tee time is full.</Text>
        <View style={styles.actions}>
          <Action label="OK" onPress={onCancel} />
        </View>
      </View>
    );
  }
  return (
    <View style={{ marginTop: 10 }} accessibilityLiveRegion="polite">
      <Text style={[styles.name, { marginBottom: 8 }]}>Add guests with {booking.customerName}</Text>
      <Row label="Guests">
        {Array.from({ length: maxGuests }, (_, i) => i + 1).map((n) => (
          <Toggle key={n} label={String(n)} on={count === n} onPress={() => setCount(n)} />
        ))}
      </Row>
      <Row label="Walk/ride">
        <Toggle label="Walking" on={!riding} onPress={() => setRiding(false)} />
        <Toggle label="Riding" on={riding} onPress={() => setRiding(true)} />
      </Row>
      {showRate && (
        <Row label="Rate">
          <Toggle label="Nonresident" on={!resident} onPress={() => setResident(false)} />
          <Toggle label="Resident" on={resident} onPress={() => setResident(true)} />
        </Row>
      )}
      <PriceLine
        cents={price({ players: count, holes: booking.holes, resident: showRate && resident, riding })}
        what={`${count} ${count === 1 ? "guest" : "guests"}, ${booking.holes} holes, ${riding ? "riding" : "walking"}`}
      />
      <Text style={styles.muted}>Guests are added to this group's bill and listed on {booking.customerName}'s account, but their fees don't count as {booking.customerName}'s own spending.</Text>
      <View style={styles.actions}>
        <Action label={`Add ${count} ${count === 1 ? "guest" : "guests"}`} primary onPress={() => onSave(count, riding, resident)} />
        <Action label="Cancel" onPress={onCancel} />
      </View>
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
  time: { fontSize: 24, fontWeight: "700", color: colors.text },
  close: { padding: 8 },
  muted: { color: colors.muted, fontSize: 13 },
  error: { color: colors.noShow, backgroundColor: "#fbebeb", padding: 10, borderRadius: 3, marginBottom: 10 },
  section: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
  booking: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 12, marginBottom: 10 },
  bookingFocus: { borderColor: colors.primary, borderWidth: 2, padding: 11 },
  checkIn: { flexBasis: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.primary, borderRadius: 3, paddingHorizontal: 16, minHeight: 48 },
  checkInText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  checkInDetail: { color: "#dce9fa", fontSize: 13, fontWeight: "600" },
  name: { fontSize: 15, fontWeight: "600", color: colors.text },
  badge: { fontSize: 12, fontWeight: "700", borderWidth: 1, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  action: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, paddingVertical: 10, minHeight: 36, justifyContent: "center" },
  actionText: { fontSize: 14, fontWeight: "600", color: colors.text },
  chip: { borderWidth: 1, borderColor: colors.primary, borderRadius: 3, paddingHorizontal: 12, paddingVertical: 8, marginRight: 6 },
  walkIn: { marginTop: 4 },
  suggestions: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, marginTop: -6, marginBottom: 10, backgroundColor: colors.card },
  suggestion: { paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border },
  carts: { color: colors.primaryText, fontWeight: "700", fontSize: 13, marginTop: 4 },
  payment: { fontWeight: "700", fontSize: 13, marginTop: 4 },
  warning: { color: colors.warn, fontSize: 13, marginTop: 4 },
  nameLink: { color: colors.primary, textDecorationLine: "underline" },
  account: { color: colors.primaryText, fontSize: 13, marginTop: 4, fontWeight: "600" },
  skip: { color: colors.muted, fontSize: 13, textDecorationLine: "underline" },
  priceLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, marginBottom: 10 },
  priceTotal: { fontSize: 16, fontWeight: "700", color: colors.text },
  billRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border },
  itemChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.card },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 12, fontSize: 14, marginBottom: 10, color: colors.text },
  toggle: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, minWidth: 44, minHeight: 34, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", marginRight: 6, marginBottom: 4 },
  toggleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
});
