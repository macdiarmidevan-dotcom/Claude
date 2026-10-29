import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Client, GiftCard, GiftCardDetail, GiftCardMethod, GolferAccount, HouseAccount, HouseAccountDetail, StatementDetail } from "./api";
import { CardChargeModal, useCardReader } from "./CardReader";
import { useSearch } from "./Golfers";
import { colors, money, type WebPress } from "./theme";

// Gift cards (money held for the golfer, spent later) and house accounts (charges now, billed
// once a month). Anyone can sell a card or take a payment; managers open accounts, set limits
// and make the monthly statements.

type Tab = "gift" | "house";

const parseCents = (text: string) => {
  const clean = text.replace(/[$,\s]/g, "");
  return /^-?\d+(\.\d{0,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
};
const signed = (cents: number) => (cents < 0 ? `−${money(-cents)}` : money(cents));
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateOnly = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const KIND_LABEL: Record<GiftCardDetail["history"][number]["kind"], string> = { sold: "Sold", reload: "Added", redeem: "Spent", adjust: "Adjusted", void: "Voided" };

export function AccountsScreen({ client, isManager }: { client: Client; isManager: boolean }) {
  const [tab, setTab] = useState<Tab>("gift");
  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={styles.tabs}>
        {(
          [
            ["gift", "Gift cards"],
            ["house", "House accounts"],
          ] as const
        ).map(([id, label]) => (
          <Pressable key={id} role="tab" aria-selected={tab === id} onPress={() => setTab(id)} style={({ focused }: WebPress) => [styles.tab, tab === id && styles.tabOn, focused && styles.focus]}>
            <Text style={[styles.tabText, tab === id && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "gift" ? <GiftCards client={client} isManager={isManager} /> : <HouseAccounts client={client} isManager={isManager} />}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Gift cards

function GiftCards({ client, isManager }: { client: Client; isManager: boolean }) {
  const [list, setList] = useState<GiftCard[]>();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string>();
  const [selling, setSelling] = useState(false);
  const [sold, setSold] = useState<GiftCardDetail>();
  const [error, setError] = useState<string>();
  const load = () => client.giftCards(q.trim()).then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [client, q]);

  if (open) return <GiftCardView client={client} id={open} isManager={isManager} onBack={() => (setOpen(undefined), load())} />;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {sold && (
        <View role="status" style={[styles.card, { borderColor: colors.checkedIn, marginTop: 0, marginBottom: 12 }]}>
          <Text style={styles.help}>Gift card ready. Write this code on the card, or hand over the printed receipt:</Text>
          <Text selectable style={styles.code}>
            {sold.code}
          </Text>
          <Text style={styles.strong}>Balance {money(sold.balanceCents)}</Text>
          <SmallButton label="Done" onPress={() => setSold(undefined)} />
        </View>
      )}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {selling ? (
        <SellGiftCard
          client={client}
          isManager={isManager}
          onClose={() => setSelling(false)}
          onSold={(g) => {
            setSelling(false);
            setSold(g);
            load();
          }}
        />
      ) : (
        <Button label="Sell or reload a gift card" primary onPress={() => setSelling(true)} />
      )}
      <TextInput accessibilityLabel="Find a gift card" placeholder="Find by code, recipient or golfer" value={q} onChangeText={setQ} autoCapitalize="characters" style={[styles.input, { marginTop: 14 }]} />
      {!list ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : list.length === 0 ? (
        <Text style={[styles.help, { marginTop: 12 }]}>{q ? "No gift cards match." : "No gift cards sold yet."}</Text>
      ) : (
        <View style={{ marginTop: 10 }}>
          {list.map((g) => (
            <Pressable
              key={g.id}
              accessibilityRole="button"
              onPress={() => setOpen(g.id)}
              style={({ hovered, focused }: WebPress) => [styles.listRow, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
            >
              <View style={{ flex: 1, minWidth: 180 }}>
                <Text style={[styles.mono, g.status === "void" && { color: colors.muted, textDecorationLine: "line-through" }]}>{g.code}</Text>
                <Text style={styles.help}>
                  {g.recipientName ?? g.golfer?.name ?? "No name"} · sold {day(g.createdAt)} for {money(g.initialCents)}
                </Text>
              </View>
              <Text style={[styles.strong, g.balanceCents === 0 && { color: colors.muted }]}>{g.status === "void" ? "Voided" : money(g.balanceCents)}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function SellGiftCard({ client, isManager, onClose, onSold }: { client: Client; isManager: boolean; onClose: () => void; onSold: (g: GiftCardDetail) => void }) {
  const [reload, setReload] = useState(false);
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("50");
  const [method, setMethod] = useState<GiftCardMethod>("card");
  const [recipient, setRecipient] = useState("");
  const [q, setQ] = useState("");
  const [golfer, setGolfer] = useState<GolferAccount>();
  const { results } = useSearch(client, golfer ? "" : q);
  const [charging, setCharging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reader = useCardReader();
  const cents = parseCents(amount);
  const valid = cents !== undefined && cents >= 100 && (!reload || code.trim().length >= 6);

  async function sell(cardPaymentId?: string) {
    setBusy(true);
    setError(undefined);
    try {
      onSold(
        await client.sellGiftCard({
          amountCents: cents!,
          method,
          ...(cardPaymentId ? { cardPaymentId } : {}),
          ...(reload ? { code: code.trim() } : { golferId: golfer?.id ?? null, recipientName: recipient.trim() || null }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't sell the gift card");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.card, { marginTop: 0 }]}>
      <Text role="heading" aria-level={2} style={styles.title}>
        {reload ? "Add money to a gift card" : "Sell a gift card"}
      </Text>
      <View style={styles.row}>
        <Chip label="New card" on={!reload} onPress={() => setReload(false)} />
        <Chip label="Add to an existing card" on={reload} onPress={() => setReload(true)} />
      </View>
      {reload && <TextInput accessibilityLabel="Gift card code" placeholder="Code on the card, e.g. GC-7K2M-9QXA" autoCapitalize="characters" value={code} onChangeText={setCode} style={[styles.input, { marginBottom: 8 }]} />}
      <View style={styles.row}>
        {[25, 50, 100, 200].map((d) => (
          <Chip key={d} label={`$${d}`} on={cents === d * 100} onPress={() => setAmount(String(d))} />
        ))}
        <TextInput accessibilityLabel="Amount" placeholder="Other amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={[styles.input, { width: 130 }]} />
      </View>
      {!reload && (
        <>
          <TextInput accessibilityLabel="Who it's for" placeholder="Who it's for (optional), e.g. Dad" value={recipient} onChangeText={setRecipient} style={[styles.input, { marginBottom: 8 }]} />
          {golfer ? (
            <View style={styles.row}>
              <Text style={styles.text}>
                On <Text style={styles.strong}>{golfer.name}</Text>'s account, so it shows at their check-in
              </Text>
              <SmallButton label="Remove" onPress={() => setGolfer(undefined)} />
            </View>
          ) : (
            <TextInput accessibilityLabel="Golfer account (optional)" placeholder="Put it on a golfer's account (optional)" value={q} onChangeText={setQ} style={[styles.input, { marginBottom: 6 }]} />
          )}
          {!golfer &&
            results?.slice(0, 4).map((g) => (
              <Pressable key={g.id} accessibilityRole="button" onPress={() => setGolfer(g)} style={({ hovered }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }]}>
                <Text style={styles.text}>
                  {g.name} <Text style={styles.help}>· {g.phone}</Text>
                </Text>
              </Pressable>
            ))}
        </>
      )}
      <Text style={[styles.label, { marginTop: 6 }]}>Paid by</Text>
      <View style={styles.row}>
        <Chip label="Card" on={method === "card"} onPress={() => setMethod("card")} />
        <Chip label="Cash" on={method === "cash"} onPress={() => setMethod("cash")} />
        <Chip label="Check" on={method === "check"} onPress={() => setMethod("check")} />
        {isManager && <Chip label="Comp (give it away)" on={method === "comp"} onPress={() => setMethod("comp")} />}
      </View>
      <Text style={styles.help}>A gift card is money held for the golfer. It counts as revenue when it's spent, not when it's sold.</Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.row, { marginTop: 8 }]}>
        <Button
          label={busy ? "Saving…" : cents ? `${method === "comp" ? "Give" : "Take"} ${money(cents)}` : "Sell"}
          primary
          disabled={busy || !valid}
          onPress={() => (method === "card" && reader.terminal ? setCharging(true) : sell())}
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
      {charging && reader.terminal && cents && (
        <CardChargeModal
          client={client}
          terminal={reader.terminal}
          amountCents={cents}
          description="Gift card"
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

function GiftCardView({ client, id, isManager, onBack }: { client: Client; id: string; isManager: boolean; onBack: () => void }) {
  const [g, setG] = useState<GiftCardDetail>();
  const [change, setChange] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    client.giftCard(id).then(setG).catch((e) => setError(e.message));
  }, [client, id]);
  const adjust = (input: { changeCents?: number; void?: boolean; note: string }) =>
    client
      .adjustGiftCard(id, input)
      .then((x) => (setG(x), setChange(""), setNote("")))
      .catch((e) => setError(e.message));
  if (!g) return error ? <Text role="alert" style={[styles.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />;
  const cents = parseCents(change);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8} style={{ marginBottom: 10 }}>
        <Text style={styles.link}>‹ Gift cards</Text>
      </Pressable>
      <Text selectable role="heading" style={styles.code}>
        {g.code}
      </Text>
      <Text style={styles.help}>
        {g.recipientName ? `For ${g.recipientName} · ` : ""}
        {g.golfer ? `On ${g.golfer.name}'s account · ` : ""}sold {day(g.createdAt)}
        {g.issuedBy ? ` by ${g.issuedBy}` : ""}
      </Text>
      <View style={[styles.row, { marginTop: 10 }]}>
        <Stat label="Balance" value={g.status === "void" ? "Voided" : money(g.balanceCents)} />
        <Stat label="Sold for" value={money(g.initialCents)} />
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.card}>
        <Text style={styles.title}>History</Text>
        {g.history.map((h, i) => (
          <View key={i} style={styles.line}>
            <Text style={[styles.text, { flex: 1 }]}>
              {KIND_LABEL[h.kind]}
              {h.saleNumber ? ` · sale #${h.saleNumber}` : h.bookingId ? " · round" : ""}
              {h.method ? ` · ${h.method}` : ""}
              {h.note ? ` · ${h.note}` : ""}
              <Text style={styles.help}>
                {" "}
                · {day(h.at)}
                {h.staff ? `, ${h.staff}` : ""}
              </Text>
            </Text>
            <Text style={[styles.strong, { color: h.changeCents < 0 ? colors.text : colors.checkedIn }]}>
              {h.changeCents < 0 ? "−" : "+"}
              {money(Math.abs(h.changeCents))}
            </Text>
            <Text style={[styles.help, { width: 80, textAlign: "right" }]}>{money(h.balanceAfter)}</Text>
          </View>
        ))}
      </View>
      {isManager && g.status === "active" && (
        <View style={styles.card}>
          <Text style={styles.title}>Fix the balance</Text>
          <View style={styles.row}>
            <TextInput accessibilityLabel="Change" placeholder="+10 or -5" value={change} onChangeText={setChange} keyboardType="numbers-and-punctuation" style={[styles.input, { width: 120 }]} />
            <TextInput accessibilityLabel="Reason" placeholder="Reason (required)" value={note} onChangeText={setNote} style={[styles.input, { flex: 1, minWidth: 180 }]} />
          </View>
          <View style={styles.row}>
            <Button label="Change balance" disabled={!cents || !note.trim()} onPress={() => adjust({ changeCents: cents!, note })} />
            <Button label="Void card" danger disabled={!note.trim()} onPress={() => adjust({ void: true, note })} />
          </View>
          <Text style={styles.help}>Voiding takes the whole balance off, e.g. for a card reported stolen.</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------
// House accounts

function HouseAccounts({ client, isManager }: { client: Client; isManager: boolean }) {
  const [list, setList] = useState<HouseAccount[]>();
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const month = lastMonth();
  const load = () => client.houseAccounts().then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [client]);
  if (open) return <AccountView client={client} id={open} isManager={isManager} onBack={() => (setOpen(undefined), load())} />;
  const owed = (list ?? []).reduce((s, a) => s + Math.max(0, a.balanceCents), 0);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {notice && (
        <View role="status" style={[styles.card, { borderColor: colors.checkedIn, marginTop: 0, marginBottom: 12 }]}>
          <Text style={styles.strong}>{notice}</Text>
          <SmallButton label="OK" onPress={() => setNotice(undefined)} />
        </View>
      )}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <Stat label="Owed on all accounts" value={money(owed)} />
        <Stat label="Accounts" value={String(list?.filter((a) => a.status !== "closed").length ?? "–")} />
      </View>
      {isManager && (
        <View style={styles.row}>
          {!adding && <Button label="Open a house account" primary onPress={() => setAdding(true)} />}
          <Button
            label={`Make ${monthName(month)} statements`}
            onPress={() =>
              client
                .runStatements(month)
                .then((r) => (setNotice(r.statements ? `Made ${r.statements} ${r.statements === 1 ? "statement" : "statements"} for ${monthName(month)}.` : `No new statements for ${monthName(month)}.`), load()))
                .catch((e) => setError(e.message))
            }
          />
        </View>
      )}
      {adding && <OpenAccount client={client} onClose={() => setAdding(false)} onOpened={(a) => (setAdding(false), setOpen(a.id))} />}
      {!list ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : list.length === 0 ? (
        <Text style={[styles.help, { marginTop: 12 }]}>No house accounts yet. Members who charge to an account are set up here.</Text>
      ) : (
        <View style={{ marginTop: 10 }}>
          {list.map((a) => (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              onPress={() => setOpen(a.id)}
              style={({ hovered, focused }: WebPress) => [styles.listRow, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
            >
              <View style={{ flex: 1, minWidth: 200 }}>
                <Text style={[styles.strong, a.status !== "active" && { color: colors.muted }]}>
                  {a.golfer.name}
                  {a.status !== "active" ? ` (${a.status === "suspended" ? "on hold" : "closed"})` : ""}
                </Text>
                <Text style={styles.help}>
                  {a.creditLimitCents !== null ? `Limit ${money(a.creditLimitCents)}` : "No limit"}
                  {a.lastStatement ? ` · last statement ${money(a.lastStatement.closingCents)}, due ${dateOnly(a.lastStatement.dueOn)}` : ""}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.strong}>{signed(a.balanceCents)}</Text>
                {a.unbilledCents !== 0 && <Text style={styles.help}>{signed(a.unbilledCents)} since the last statement</Text>}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function OpenAccount({ client, onClose, onOpened }: { client: Client; onClose: () => void; onOpened: (a: HouseAccountDetail) => void }) {
  const [q, setQ] = useState("");
  const [golfer, setGolfer] = useState<GolferAccount>();
  const { results } = useSearch(client, golfer ? "" : q);
  const [limit, setLimit] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const limitCents = limit.trim() ? parseCents(limit) : null;
  return (
    <View style={styles.card}>
      <Text role="heading" aria-level={2} style={styles.title}>
        Open a house account
      </Text>
      {golfer ? (
        <View style={styles.row}>
          <Text style={styles.strong}>{golfer.name}</Text>
          <SmallButton label="Change" onPress={() => setGolfer(undefined)} />
        </View>
      ) : (
        <TextInput accessibilityLabel="Golfer" placeholder="Search golfer accounts" value={q} onChangeText={setQ} style={styles.input} />
      )}
      {!golfer &&
        results?.slice(0, 5).map((g) => (
          <Pressable key={g.id} accessibilityRole="button" onPress={() => (setGolfer(g), setEmail(g.email))} style={({ hovered }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }]}>
            <Text style={styles.text}>
              {g.name} <Text style={styles.help}>· {g.phone}</Text>
            </Text>
          </Pressable>
        ))}
      <View style={[styles.row, { marginTop: 8 }]}>
        <View style={{ flex: 1, minWidth: 160 }}>
          <Text style={styles.label}>Limit, $ (blank for none)</Text>
          <TextInput accessibilityLabel="Credit limit" value={limit} onChangeText={setLimit} keyboardType="decimal-pad" placeholder="500" style={styles.input} />
        </View>
        <View style={{ flex: 2, minWidth: 200 }}>
          <Text style={styles.label}>Send statements to</Text>
          <TextInput accessibilityLabel="Statement email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" style={styles.input} />
        </View>
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <Button
          label="Open account"
          primary
          disabled={!golfer || limitCents === undefined}
          onPress={() =>
            client
              .openHouseAccount({ golferId: golfer!.id, creditLimitCents: limitCents, billingEmail: email.trim() || null })
              .then(onOpened)
              .catch((e) => setError(e.message))
          }
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

function AccountView({ client, id, isManager, onBack }: { client: Client; id: string; isManager: boolean; onBack: () => void }) {
  const [a, setA] = useState<HouseAccountDetail>();
  const [statement, setStatement] = useState<string>();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"check" | "cash" | "card">("check");
  const [note, setNote] = useState("");
  const [adj, setAdj] = useState({ amount: "", description: "" });
  const [limit, setLimit] = useState<string>();
  const [charging, setCharging] = useState(false);
  const [error, setError] = useState<string>();
  const reader = useCardReader();
  useEffect(() => {
    client.houseAccount(id).then(setA).catch((e) => setError(e.message));
  }, [client, id]);
  async function run(fn: () => Promise<HouseAccountDetail>) {
    setError(undefined);
    try {
      setA(await fn());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    }
  }
  if (statement) return <StatementView client={client} id={statement} isManager={isManager} onBack={() => setStatement(undefined)} />;
  if (!a) return error ? <Text role="alert" style={[styles.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />;
  const cents = parseCents(amount) ?? (amount.trim() ? undefined : a.balanceCents > 0 ? a.balanceCents : undefined);
  const pay = (cardPaymentId?: string) =>
    run(() => client.payHouseAccount(a.id, { amountCents: cents!, method, note: note.trim() || null, ...(cardPaymentId ? { cardPaymentId } : {}) })).then((ok) => ok && (setAmount(""), setNote("")));
  const adjCents = parseCents(adj.amount);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8} style={{ marginBottom: 10 }}>
        <Text style={styles.link}>‹ House accounts</Text>
      </Pressable>
      <Text role="heading" style={styles.h1}>
        {a.golfer.name}
      </Text>
      <Text style={styles.help}>
        {a.golfer.phone} · statements to {a.billingEmail ?? "no email"} · {a.status === "active" ? "can charge" : a.status === "suspended" ? "on hold, can't charge" : "closed"}
      </Text>
      <View style={[styles.row, { marginTop: 10 }]}>
        <Stat label={a.balanceCents < 0 ? "In credit" : "Owes"} value={money(Math.abs(a.balanceCents))} />
        <Stat label="Since the last statement" value={signed(a.unbilledCents)} />
        <Stat label={a.creditLimitCents !== null ? `Left of ${money(a.creditLimitCents)} limit` : "Limit"} value={a.availableCents !== null ? money(a.availableCents) : "None"} />
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}

      <View style={styles.card}>
        <Text style={styles.title}>Take a payment</Text>
        <View style={styles.row}>
          <Chip label="Check" on={method === "check"} onPress={() => setMethod("check")} />
          <Chip label="Cash" on={method === "cash"} onPress={() => setMethod("cash")} />
          <Chip label="Card" on={method === "card"} onPress={() => setMethod("card")} />
        </View>
        <View style={styles.row}>
          <TextInput
            accessibilityLabel="Amount"
            placeholder={a.balanceCents > 0 ? `Amount (owes ${money(a.balanceCents)})` : "Amount"}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            style={[styles.input, { width: 200 }]}
          />
          <TextInput accessibilityLabel="Note" placeholder={method === "check" ? "Check number" : "Note"} value={note} onChangeText={setNote} style={[styles.input, { flex: 1, minWidth: 140 }]} />
          <Button label={cents && cents > 0 ? `Take ${money(cents)}` : "Take payment"} primary disabled={!cents || cents <= 0} onPress={() => (method === "card" && reader.terminal ? setCharging(true) : pay())} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Statements</Text>
        {a.statements.length === 0 && <Text style={styles.help}>None yet. Managers make them once a month is over.</Text>}
        {a.statements.map((s) => (
          <Pressable key={s.id} accessibilityRole="button" onPress={() => setStatement(s.id)} style={({ hovered, focused }: WebPress) => [styles.line, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}>
            <Text style={[styles.text, { flex: 1 }]}>{monthName(s.periodStart.slice(0, 7))}</Text>
            <Text style={styles.help}>due {dateOnly(s.dueOn)}</Text>
            <Text style={[styles.strong, { width: 90, textAlign: "right" }]}>{money(s.closingCents)}</Text>
            <Text style={{ color: colors.primary }}>›</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Activity</Text>
        {a.entries.length === 0 && <Text style={styles.help}>Nothing charged yet.</Text>}
        {a.entries.map((e) => (
          <View key={e.id} style={styles.line}>
            <Text style={[styles.text, { flex: 1 }]}>
              {e.description}
              <Text style={styles.help}>
                {" "}
                · {day(e.at)}
                {e.staff ? `, ${e.staff}` : ""}
                {e.statementId ? "" : " · not billed yet"}
              </Text>
            </Text>
            <Text style={[styles.strong, e.amountCents < 0 && { color: colors.checkedIn }]}>
              {e.amountCents < 0 ? "−" : ""}
              {money(Math.abs(e.amountCents))}
            </Text>
          </View>
        ))}
      </View>

      {isManager && (
        <View style={styles.card}>
          <Text style={styles.title}>Manage the account</Text>
          <View style={styles.row}>
            {limit === undefined ? (
              <Button label={a.creditLimitCents !== null ? `Change limit (${money(a.creditLimitCents)})` : "Set a limit"} onPress={() => setLimit(a.creditLimitCents !== null ? String(a.creditLimitCents / 100) : "")} />
            ) : (
              <>
                <TextInput accessibilityLabel="New limit" placeholder="Blank for no limit" value={limit} onChangeText={setLimit} keyboardType="decimal-pad" style={[styles.input, { width: 160 }]} />
                <Button
                  label="Save limit"
                  primary
                  disabled={!!limit.trim() && parseCents(limit) === undefined}
                  onPress={() => run(() => client.updateHouseAccount(a.id, { creditLimitCents: limit.trim() ? parseCents(limit)! : null })).then((ok) => ok && setLimit(undefined))}
                />
              </>
            )}
            {a.status === "active" ? (
              <Button label="Put on hold" onPress={() => run(() => client.updateHouseAccount(a.id, { status: "suspended" }))} />
            ) : a.status === "suspended" ? (
              <Button label="Allow charges again" onPress={() => run(() => client.updateHouseAccount(a.id, { status: "active" }))} />
            ) : null}
            {a.status !== "closed" && <Button label="Close account" danger disabled={a.balanceCents !== 0} onPress={() => run(() => client.updateHouseAccount(a.id, { status: "closed" }))} />}
          </View>
          <Text style={[styles.label, { marginTop: 8 }]}>Charge or credit something that isn't a sale (dues, a courtesy credit)</Text>
          <View style={styles.row}>
            <TextInput accessibilityLabel="Adjustment amount" placeholder="50 or -20" value={adj.amount} onChangeText={(x) => setAdj({ ...adj, amount: x })} keyboardType="numbers-and-punctuation" style={[styles.input, { width: 120 }]} />
            <TextInput accessibilityLabel="What it's for" placeholder="What it's for" value={adj.description} onChangeText={(x) => setAdj({ ...adj, description: x })} style={[styles.input, { flex: 1, minWidth: 180 }]} />
            <Button
              label={adjCents ? (adjCents > 0 ? `Charge ${money(adjCents)}` : `Credit ${money(-adjCents)}`) : "Add"}
              disabled={!adjCents || !adj.description.trim()}
              onPress={() => run(() => client.adjustHouseAccount(a.id, { amountCents: adjCents!, description: adj.description })).then((ok) => ok && setAdj({ amount: "", description: "" }))}
            />
          </View>
        </View>
      )}
      {charging && reader.terminal && cents && (
        <CardChargeModal
          client={client}
          terminal={reader.terminal}
          amountCents={cents}
          description={`House account: ${a.golfer.name}`}
          onPaid={(p) => {
            setCharging(false);
            pay(p.id);
          }}
          onClose={() => setCharging(false)}
        />
      )}
    </ScrollView>
  );
}

/** One month's statement, laid out to print or save as a PDF from the browser. */
function StatementView({ client, id, isManager, onBack }: { client: Client; id: string; isManager: boolean; onBack: () => void }) {
  const [s, setS] = useState<StatementDetail>();
  const [error, setError] = useState<string>();
  const [emailed, setEmailed] = useState<string>();
  useEffect(() => {
    client.statement(id).then(setS).catch((e) => setError(e.message));
  }, [client, id]);
  if (!s) return error ? <Text role="alert" style={[styles.error, { padding: 16 }]}>{error}</Text> : <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8}>
          <Text style={styles.link}>‹ {s.account.golfer.name}</Text>
        </Pressable>
        {Platform.OS === "web" && <SmallButton label="Print" onPress={() => window.print()} />}
        {isManager && (
          <SmallButton
            label={emailed ? "Emailed" : "Email to golfer"}
            onPress={() =>
              client
                .emailStatement(s.id)
                .then((c) => setEmailed(c.messages[0]?.status === "sent" ? `Emailed to ${c.messages[0].to}` : (c.messages[0]?.reason ?? "Not sent")))
                .catch((e) => setError(e.message))
            }
          />
        )}
      </View>
      {emailed && <Text style={styles.help}>{emailed}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={[styles.card, { maxWidth: 720 }]}>
        <Text style={styles.h1}>Statement, {monthName(s.periodStart.slice(0, 7))}</Text>
        <Text style={styles.text}>{s.account.golfer.name}</Text>
        <Text style={styles.help}>
          {dateOnly(s.periodStart)} to {dateOnly(s.periodEnd)} · payment due {dateOnly(s.dueOn)}
        </Text>
        <View style={[styles.line, { marginTop: 10 }]}>
          <Text style={[styles.text, { flex: 1 }]}>Balance from last statement</Text>
          <Text style={styles.text}>{signed(s.openingCents)}</Text>
        </View>
        {s.entries.map((e) => (
          <View key={e.id} style={styles.line}>
            <Text style={[styles.help, { width: 110 }]}>{day(e.at)}</Text>
            <Text style={[styles.text, { flex: 1 }]}>{e.description}</Text>
            <Text style={styles.text}>
              {e.amountCents < 0 ? "−" : ""}
              {money(Math.abs(e.amountCents))}
            </Text>
          </View>
        ))}
        <View style={[styles.line, { borderBottomWidth: 0 }]}>
          <Text style={[styles.help, { flex: 1 }]}>Charges {money(s.chargesCents)} · payments and credits {money(s.paymentsCents)}</Text>
        </View>
        <View style={[styles.line, { borderBottomWidth: 0 }]}>
          <Text style={[styles.strong, { flex: 1, fontSize: 16 }]}>Amount due</Text>
          <Text style={[styles.strong, { fontSize: 16 }]}>{signed(s.closingCents)}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.help}>{label}</Text>
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

function Button({ label, onPress, primary, danger, disabled }: { label: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, danger && styles.buttonDanger, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={({ focused }: WebPress) => [styles.small, focused && styles.focus]}>
      <Text style={styles.smallText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 16, backgroundColor: colors.card },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { color: colors.muted, fontWeight: "600", fontSize: 14 },
  tabTextOn: { color: colors.primary },
  page: { padding: 16, maxWidth: 1000 },
  h1: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 8 },
  text: { color: colors.text, fontSize: 14 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  link: { color: colors.primary, fontWeight: "600", textDecorationLine: "underline", fontSize: 14 },
  error: { color: colors.noShow, marginVertical: 6 },
  code: { fontSize: 24, fontWeight: "700", letterSpacing: 1, color: colors.text, fontFamily: Platform.OS === "web" ? "ui-monospace, Menlo, monospace" : undefined, marginVertical: 4 },
  mono: { fontSize: 14, fontWeight: "600", color: colors.text, fontFamily: Platform.OS === "web" ? "ui-monospace, Menlo, monospace" : undefined },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, marginTop: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  line: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  listRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 3, backgroundColor: colors.card, marginBottom: 6 },
  result: { paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 3, marginBottom: 4, backgroundColor: "#fff" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  stat: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingVertical: 8, paddingHorizontal: 12, minWidth: 150, backgroundColor: "#fff" },
  statValue: { fontSize: 18, fontWeight: "700", color: colors.text },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonDanger: { borderColor: colors.noShow },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  small: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, minHeight: 30, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  smallText: { color: colors.text, fontWeight: "600", fontSize: 12 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
