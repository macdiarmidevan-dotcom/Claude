import { createContext, useContext, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { ADD_ON_GROUPS, ADD_ONS, addOnSettings, type AddOnKey, type AddOnSettings } from "@golf/core";
import type { Client } from "./api";
import { Icon, type IconName } from "./Icon";
import { colors } from "./theme";

// Add-ons: the parts of the software a course switches on or off to suit how it runs. The menu,
// the tee sheet and other screens read them through useAddOn, so a change shows straight away.

const AddOnsContext = createContext<AddOnSettings>(addOnSettings());
export const AddOnsProvider = AddOnsContext.Provider;

/** Whether the course has this add-on switched on. */
export function useAddOn(key: AddOnKey) {
  return useContext(AddOnsContext)[key];
}

const ICON: Record<AddOnKey, IconName> = {
  radar: "radar",
  weather_delays: "cloud",
  tee_sheet_prices: "tag",
  color_key_open: "swatches",
  tee_sheet_sync: "sync",
  messages: "message",
  gift_cards: "gift",
  house_accounts: "user",
  leagues: "flag",
  staff_schedule: "calendar",
  pro_shop: "bag",
  food_bar: "coffee",
  ask_data: "sparkle",
  rate_advice: "tag",
};

export function AddOnsScreen({ client, isManager, settings, onChange }: { client: Client; isManager: boolean; settings: AddOnSettings; onChange: (s: AddOnSettings) => void }) {
  const [busy, setBusy] = useState<AddOnKey>();
  const [error, setError] = useState<string>();
  const on = ADD_ONS.filter((a) => settings[a.key]).length;

  async function toggle(key: AddOnKey, enabled: boolean) {
    setBusy(key);
    setError(undefined);
    try {
      onChange(await client.setAddOn(key, enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that add-on");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.intro}>
        Switch on the parts of the software your course uses and hide the rest. Turning something off only hides it: nothing is deleted, and turning it back on brings everything back.{" "}
        {on} of {ADD_ONS.length} are on.
      </Text>
      {!isManager && <Text style={[styles.intro, { color: colors.text }]}>Only a manager can change add-ons.</Text>}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {ADD_ON_GROUPS.map((g) => (
        <View key={g.id} style={styles.group}>
          <Text role="heading" aria-level={2} style={styles.groupTitle}>{g.label}</Text>
          <View style={styles.grid}>
            {ADD_ONS.filter((a) => a.group === g.id).map((a) => {
              const enabled = settings[a.key];
              return (
                <View key={a.key} style={[styles.card, enabled && styles.cardOn]}>
                  <View style={[styles.iconBox, enabled && { backgroundColor: colors.primaryLight }]}>
                    <Icon name={ICON[a.key]} size={20} color={enabled ? colors.primary : colors.muted} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={styles.cardTop}>
                      <Text style={styles.name}>{a.name}</Text>
                      <Text style={[styles.status, enabled && { color: colors.checkedIn }]}>{enabled ? "On" : "Off"}</Text>
                    </View>
                    <Text style={styles.description}>{a.description}</Text>
                  </View>
                  <Switch
                    accessibilityLabel={a.name}
                    value={enabled}
                    disabled={!isManager || busy === a.key}
                    onValueChange={(v) => toggle(a.key, v)}
                    trackColor={{ true: colors.primary, false: colors.border }}
                    thumbColor="#fff"
                    {...({ activeThumbColor: "#fff" } as object)}
                  />
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, maxWidth: 1000 },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 12, maxWidth: 760 },
  error: { color: colors.noShow, fontSize: 13, marginBottom: 10 },
  group: { marginBottom: 18 },
  groupTitle: { fontSize: 12, fontWeight: "700", color: colors.muted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: { flexGrow: 1, flexBasis: 420, minWidth: 260, maxWidth: 489, flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 0, padding: 12, backgroundColor: colors.card },
  cardOn: { borderColor: "#9cc9ad" },
  iconBox: { width: 38, height: 38, borderRadius: 0, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 14, fontWeight: "700", color: colors.text },
  status: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  description: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 2 },
});
