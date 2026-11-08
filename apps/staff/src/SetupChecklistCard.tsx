import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Client, SetupChecklist } from "./api";
import { Icon } from "./Icon";
import { colors, radius, type WebPress } from "./theme";

/** Managers' go-live checklist: each step ticks itself off from what's saved. */
export function SetupChecklistCard({ client, onOpen }: { client: Client; onOpen: (where: SetupChecklist["items"][number]["where"]) => void }) {
  const [list, setList] = useState<SetupChecklist>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    client
      .setup()
      .then((l) => live && setList(l))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the checklist"));
    return () => {
      live = false;
    };
  }, [client]);
  if (error) return <Text role="alert" style={styles.error}>{error}</Text>;
  if (!list) return null;
  const ready = list.done === list.total;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text role="heading" aria-level={2} style={styles.title}>Getting ready to go live</Text>
        <Text style={[styles.count, ready && { color: colors.checkedIn }]}>{ready ? "Ready" : `${list.done} of ${list.total} done`}</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${(list.done / list.total) * 100}%` }, ready && { backgroundColor: colors.checkedIn }]} />
      </View>
      {list.items.map((i) => (
        <View key={i.id} style={styles.row}>
          <View style={[styles.mark, i.status === "done" && styles.markDone]} aria-label={i.status === "done" ? "Done" : i.status === "optional" ? "Optional" : "To do"}>
            {i.status === "done" && <Icon name="check" size={12} color="#fff" strokeWidth={3} />}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.name, i.status === "done" && { color: colors.muted }]}>
              {i.title}
              {i.status === "optional" && <Text style={styles.tag}>  OPTIONAL</Text>}
            </Text>
            <Text style={styles.detail}>{i.detail}</Text>
          </View>
          {i.where !== "none" && i.where !== "settings" && i.status !== "done" && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${i.title}`} onPress={() => onOpen(i.where)} style={({ focused }: WebPress) => [styles.open, focused && styles.focus]}>
              <Text style={styles.openText}>Open</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 14, marginBottom: 24 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text },
  count: { fontSize: 13, fontWeight: "700", color: colors.muted },
  track: { height: 6, backgroundColor: "#eceef1", borderRadius: 0, overflow: "hidden", marginBottom: 8 },
  fill: { height: "100%", backgroundColor: colors.primary },
  row: { flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 9, borderTopWidth: 1, borderColor: "#eceef1" },
  mark: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.border, marginTop: 1, alignItems: "center", justifyContent: "center" },
  markDone: { backgroundColor: colors.checkedIn, borderColor: colors.checkedIn },
  name: { fontSize: 14, fontWeight: "600", color: colors.text },
  tag: { fontSize: 10, fontWeight: "700", color: colors.muted, letterSpacing: 0.5 },
  detail: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 2 },
  open: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, minHeight: 30, justifyContent: "center" },
  openText: { fontSize: 13, fontWeight: "600", color: colors.primaryText },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
  error: { color: colors.noShow, marginBottom: 12 },
});
