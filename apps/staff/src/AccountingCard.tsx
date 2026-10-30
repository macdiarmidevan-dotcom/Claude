import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { AccountingFormat, AccountingSettings, AccountKey, Client, Journal } from "./api";
import { colors, money, type WebPress } from "./theme";

// The bookkeeper's daily summary: one balanced journal entry per day for the report's dates, in a
// file QuickBooks Online or Xero imports, with the course's own account names.

const FORMATS: { id: AccountingFormat; label: string }[] = [
  { id: "quickbooks", label: "QuickBooks Online" },
  { id: "xero", label: "Xero" },
];

const GROUPS: { title: string; keys: AccountKey[] }[] = [
  { title: "Where money taken goes", keys: ["cash", "card", "check", "prepaid", "house_account"] },
  { title: "Revenue", keys: ["green_fees", "carts_extras", "pro_shop", "food_bev", "events"] },
  { title: "Held for golfers, taxes and discounts", keys: ["gift_card", "rain_check", "punch_card", "season_pass", "loyalty", "comp", "sales_tax", "clearing"] },
];
const KEY_LABEL: Record<AccountKey, string> = {
  cash: "Cash",
  card: "Card payments",
  check: "Checks",
  house_account: "House accounts (receivable)",
  gift_card: "Gift cards (liability)",
  rain_check: "Rain checks (liability)",
  loyalty: "Loyalty points used",
  punch_card: "Punch card rounds",
  season_pass: "Season pass rounds",
  prepaid: "Prepaid online (booking provider)",
  comp: "Comps",
  green_fees: "Green fees",
  carts_extras: "Carts and extras",
  pro_shop: "Pro shop",
  food_bev: "Food and drink",
  events: "Leagues and outings",
  sales_tax: "Sales tax payable",
  clearing: "Timing difference (clearing)",
};

const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function AccountingCard({ client, from, to }: { client: Client; from: string; to: string }) {
  const [settings, setSettings] = useState<AccountingSettings>();
  const [journal, setJournal] = useState<Journal>();
  const [showJournal, setShowJournal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState<Partial<Record<AccountKey, string>>>({});
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  // On a phone the account name says enough; the description column would squeeze the amounts.
  const narrow = useWindowDimensions().width < 600;
  useEffect(() => {
    client.accountingSettings().then(setSettings).catch((e) => setError(e.message));
  }, [client]);
  useEffect(() => {
    setJournal(undefined);
    if (showJournal) client.journal(from, to).then(setJournal).catch((e) => setError(e.message));
  }, [client, from, to, showJournal]);

  async function download() {
    setError(undefined);
    try {
      const file = await client.exportJournal(from, to, settings!.format);
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(new Blob([file.csv], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = file.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
      setNotice(file.days ? `Saved ${file.fileName}: ${file.days} ${file.days === 1 ? "day" : "days"}.` : "Nothing to export for these dates.");
      setSettings(await client.accountingSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make the file");
    }
  }

  if (!settings) return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.primary} />;
  const last = settings.recentExports[0];
  return (
    <View style={styles.card}>
      <Text role="heading" aria-level={3} style={styles.title}>
        Send to accounting
      </Text>
      <Text style={styles.help}>
        One journal entry per day for {from === to ? shortDate(from) : `${shortDate(from)} to ${shortDate(to)}`}, ready to import. Money taken is debited to where it went; revenue, sales tax and
        gift cards sold are credited.
      </Text>
      <View style={[styles.row, { marginTop: 10 }]}>
        {FORMATS.map((f) => (
          <Chip key={f.id} label={f.label} on={settings.format === f.id} onPress={() => client.saveAccountingSettings({ format: f.id }).then(setSettings).catch((e) => setError(e.message))} />
        ))}
      </View>
      <View style={styles.row}>
        <Button label="Download import file" primary onPress={download} />
        <Button label={showJournal ? "Hide the entries" : "Show the entries"} onPress={() => setShowJournal(!showJournal)} />
        <Button label={editing ? "Done with account names" : "Account names"} onPress={() => (setEditing(!editing), setNames({}))} />
      </View>
      {last && (
        <Text style={styles.help}>
          Last exported: {last.from === last.to ? shortDate(last.from) : `${shortDate(last.from)} to ${shortDate(last.to)}`} ({last.format === "xero" ? "Xero" : "QuickBooks"}),{" "}
          {new Date(last.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {last.staff ? ` by ${last.staff}` : ""}
        </Text>
      )}
      {notice && <Text role="status" style={[styles.help, { color: colors.checkedIn }]}>{notice}</Text>}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}

      {editing && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.help}>
            Use the names (QuickBooks) or codes (Xero) from the chart of accounts. Two kinds of money can share an account, for example cash and checks both going to Undeposited Funds.
          </Text>
          {GROUPS.map((g) => (
            <View key={g.title} style={{ marginTop: 10 }}>
              <Text style={styles.label}>{g.title}</Text>
              {g.keys.map((k) => (
                <View key={k} style={styles.nameRow}>
                  <Text style={[styles.text, { width: 230 }]}>{KEY_LABEL[k]}</Text>
                  <TextInput
                    accessibilityLabel={`${KEY_LABEL[k]} account`}
                    value={names[k] ?? settings.accounts[k]}
                    placeholder={settings.defaults[k]}
                    onChangeText={(v) => setNames({ ...names, [k]: v })}
                    style={[styles.input, { flex: 1, minWidth: 180 }]}
                  />
                </View>
              ))}
            </View>
          ))}
          <View style={[styles.row, { marginTop: 10 }]}>
            <Button
              label="Save account names"
              primary
              disabled={!Object.keys(names).length}
              onPress={() =>
                client
                  .saveAccountingSettings({ accounts: names })
                  .then((x) => (setSettings(x), setNames({}), setNotice("Account names saved.")))
                  .catch((e) => setError(e.message))
              }
            />
          </View>
        </View>
      )}

      {showJournal &&
        (!journal ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 10 }} />
        ) : journal.days.length === 0 ? (
          <Text style={[styles.help, { marginTop: 10 }]}>Nothing was taken or earned on these dates.</Text>
        ) : (
          journal.days.map((d) => (
            <View key={d.date} style={{ marginTop: 12 }}>
              <Text style={styles.strong}>{shortDate(d.date)}</Text>
              <View role="table">
                <View role="row" style={[styles.jRow, styles.jHead]}>
                  <Text role="columnheader" style={[styles.label, { flex: 2 }]}>
                    Account
                  </Text>
                  {!narrow && (
                    <Text role="columnheader" style={[styles.label, { flex: 2 }]}>
                      What
                    </Text>
                  )}
                  <Text role="columnheader" style={[styles.label, styles.num, narrow && { width: 84 }]}>
                    Debit
                  </Text>
                  <Text role="columnheader" style={[styles.label, styles.num, narrow && { width: 84 }]}>
                    Credit
                  </Text>
                </View>
                {d.lines.map((l, i) => (
                  <View key={i} role="row" style={styles.jRow}>
                    <Text role="cell" style={[styles.text, { flex: 2 }]}>
                      {l.account}
                    </Text>
                    {!narrow && (
                      <Text role="cell" style={[styles.help, { flex: 2 }]}>
                        {l.description}
                      </Text>
                    )}
                    <Text role="cell" style={[styles.text, styles.num, narrow && { width: 84 }]}>
                      {l.debitCents ? money(l.debitCents) : ""}
                    </Text>
                    <Text role="cell" style={[styles.text, styles.num, narrow && { width: 84 }]}>
                      {l.creditCents ? money(l.creditCents) : ""}
                    </Text>
                  </View>
                ))}
                <View role="row" style={[styles.jRow, { borderBottomWidth: 0 }]}>
                  <Text role="cell" style={[styles.strong, { flex: narrow ? 2 : 4 }]}>
                    Total
                  </Text>
                  <Text role="cell" style={[styles.strong, styles.num, narrow && { width: 84 }]}>
                    {money(d.totalCents)}
                  </Text>
                  <Text role="cell" style={[styles.strong, styles.num, narrow && { width: 84 }]}>
                    {money(d.totalCents)}
                  </Text>
                </View>
              </View>
            </View>
          ))
        ))}
      {showJournal && journal?.days.some((d) => d.lines.some((l) => l.key === "clearing")) && (
        <Text style={[styles.help, { marginTop: 8 }]}>
          The clearing line is rounds paid on a different day than they were played. It evens out across days; ask the bookkeeper to reconcile it monthly.
        </Text>
      )}
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
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, marginTop: 16 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 6 },
  text: { color: colors.text, fontSize: 14 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  error: { color: colors.noShow, marginVertical: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  nameRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 8, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  jRow: { flexDirection: "row", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border, alignItems: "center" },
  jHead: { borderBottomWidth: 2 },
  num: { width: 100, textAlign: "right" },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
