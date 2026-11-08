import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ASK_DATA_EXAMPLES, DATA_TOPIC_LABEL, dateSpan, type DataAnswer, type DataSource, type DataTurn } from "@golf/core";
import type { Client } from "./api";
import { Icon } from "./Icon";
import { colors, radius, type WebPress } from "./theme";

// Reports › Ask: a manager asks about the numbers in plain words. The server answers with Claude
// when it's set up, or with a quick summary of the closest report; either way each answer links
// to the reports it came from, opened on the same dates.

export type AskEntry = { role: "user"; content: string } | ({ role: "assistant" } & DataAnswer) | { role: "error"; content: string };

const sourceLabel = (s: DataSource) => `${DATA_TOPIC_LABEL[s.tab]}, ${dateSpan(s.from, s.to)}`;

export function AskDataScreen({ client, chat, setChat, onOpen }: { client: Client; chat: AskEntry[]; setChat: (fn: (c: AskEntry[]) => AskEntry[]) => void; onOpen: (s: DataSource) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setText("");
    setBusy(true);
    const history: DataTurn[] = chat.flatMap((e): DataTurn[] => (e.role === "user" ? [{ role: "user", content: e.content }] : e.role === "assistant" ? [{ role: "assistant", content: e.answer }] : []));
    setChat((c) => [...c, { role: "user", content: question }]);
    try {
      const answer = await client.askData({ question, history });
      setChat((c) => [...c, { role: "assistant", ...answer }]);
    } catch (e) {
      setChat((c) => [...c, { role: "error", content: e instanceof Error ? e.message : "Couldn't get an answer. Try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.card}>
        <View style={styles.titleRow}>
          <Icon name="sparkle" size={18} color={colors.primary} />
          <Text role="heading" aria-level={2} style={styles.title}>Ask your data</Text>
        </View>
        <Text style={styles.muted}>Ask about revenue, rounds, labor, the pro shop or balances. Answers come from your reports, and each one links to the report it used.</Text>

        <View style={styles.chat} accessibilityLiveRegion="polite">
          {chat.length === 0 && (
            <View>
              <Text style={styles.label}>Try asking</Text>
              <View style={styles.chips}>
                {ASK_DATA_EXAMPLES.map((s) => (
                  <Pressable key={s} accessibilityRole="button" onPress={() => ask(s)} style={({ hovered, focused }: WebPress) => [styles.chip, (hovered || focused) && styles.chipHover, focused && styles.focus]}>
                    <Text style={styles.chipText}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          {chat.map((e, i) =>
            e.role === "user" ? (
              <View key={i} style={styles.userBubble}>
                <Text style={styles.userText}>{e.content}</Text>
              </View>
            ) : e.role === "error" ? (
              <Text key={i} role="alert" style={styles.error}>{e.content}</Text>
            ) : (
              <View key={i} style={styles.botBubble}>
                <Text style={styles.botLabel}>{e.via === "ai" ? "Answer" : "Quick summary"}</Text>
                <Text style={styles.answer}>{e.answer}</Text>
                {e.sources.length > 0 && (
                  <View style={styles.sources}>
                    {e.sources.map((s) => (
                      <Pressable
                        key={`${s.tab}${s.from}${s.to}`}
                        accessibilityRole="link"
                        accessibilityLabel={`Open ${sourceLabel(s)}`}
                        onPress={() => onOpen(s)}
                        style={({ hovered, focused }: WebPress) => [styles.source, (hovered || focused) && styles.chipHover, focused && styles.focus]}
                      >
                        <Icon name="chart" size={13} color={colors.primaryText} />
                        <Text style={styles.sourceText}>{sourceLabel(s)}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                {e.via === "summary" && i === chat.length - 1 && (
                  <Text style={styles.note}>This is a summary of the closest report. With the AI assistant set up on the server, you can ask follow-ups and questions that span reports.</Text>
                )}
              </View>
            ),
          )}
          {busy && (
            <View style={[styles.botBubble, { flexDirection: "row", gap: 8, alignItems: "center" }]}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.muted}>Reading the reports…</Text>
            </View>
          )}
        </View>

        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Your question"
            placeholder="e.g. How did weekends do this month?"
            placeholderTextColor={colors.placeholder}
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => ask(text)}
            returnKeyType="send"
            style={styles.input}
            maxLength={1000}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!text.trim() || busy}
            onPress={() => ask(text)}
            style={({ focused }: WebPress) => [styles.button, (!text.trim() || busy) && { opacity: 0.5 }, focused && styles.focus]}
          >
            <Text style={styles.buttonText}>Ask</Text>
          </Pressable>
        </View>
        {chat.length > 0 && (
          <Text accessibilityRole="link" style={[styles.link, { marginTop: 10 }]} onPress={() => setChat(() => [])}>
            Start over
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 48, maxWidth: 860 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 16 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  label: { fontSize: 11, fontWeight: "700", color: colors.muted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 },
  chat: { gap: 10, marginTop: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 10, minHeight: 32, justifyContent: "center", backgroundColor: colors.card },
  chipHover: { backgroundColor: colors.primaryLight },
  chipText: { fontSize: 13, color: colors.text, fontWeight: "600" },
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.primary, borderRadius: radius, paddingHorizontal: 12, paddingVertical: 8 },
  userText: { color: "#fff", fontSize: 15, lineHeight: 21 },
  botBubble: { alignSelf: "flex-start", maxWidth: "92%", backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 12 },
  botLabel: { fontSize: 11, fontWeight: "700", color: colors.muted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 },
  answer: { color: colors.text, fontSize: 15, lineHeight: 23 },
  sources: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  source: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 8, minHeight: 28, backgroundColor: colors.card },
  sourceText: { fontSize: 12, fontWeight: "600", color: colors.primaryText },
  note: { fontSize: 12, color: colors.muted, lineHeight: 17, marginTop: 8 },
  error: { color: colors.noShow, fontSize: 14 },
  composer: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 16 },
  input: { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, minHeight: 42, fontSize: 15, color: colors.text },
  button: { backgroundColor: colors.primary, borderRadius: radius, paddingHorizontal: 16, minHeight: 42, justifyContent: "center" },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  link: { color: colors.primaryText, fontSize: 13, fontWeight: "600" },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
