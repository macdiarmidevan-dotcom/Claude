import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { HELP_ARTICLES, HELP_CATEGORIES, searchHelp, type HelpArticle, type HelpCategory } from "@golf/core";
import type { ScrollViewInstance } from "react-native";
import type { Client, HelpAnswer, HelpTurn, Me, SupportRequest, SupportTopic } from "./api";
import { colors, radius, type WebPress } from "./theme";

// The help center: search the guides, ask the assistant, or email support.

type View_ =
  | { kind: "home" }
  | { kind: "category"; id: HelpCategory }
  | { kind: "article"; id: string; back: View_ }
  | { kind: "ask" }
  | { kind: "email" };

type ChatEntry = { role: "user"; content: string } | ({ role: "assistant" } & HelpAnswer) | { role: "error"; content: string };

const SUGGESTED = ["How do I add a walk-in?", "How do I give a rain check?", "How do I push the tee sheet back for frost?", "How do I swap a shift?"];

export function HelpCenter({ client, me, isManager, page }: { client: Client; me?: Me; isManager: boolean; page: string | null }) {
  const [view, setView] = useState<View_>({ kind: "home" });
  const [query, setQuery] = useState("");
  // The conversation survives opening an article and coming back.
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => scroll.current?.scrollTo({ y: 0, animated: false }), [view]);

  const open = (id: string) => setView({ kind: "article", id, back: view });
  const home = () => (setView({ kind: "home" }), setQuery(""));

  return (
    <ScrollView ref={scroll} style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {view.kind === "home" ? (
        <Home query={query} setQuery={setQuery} isManager={isManager} onOpen={open} onCategory={(id) => setView({ kind: "category", id })} onAsk={() => setView({ kind: "ask" })} onEmail={() => setView({ kind: "email" })} />
      ) : view.kind === "category" ? (
        <Category id={view.id} onBack={home} onOpen={open} />
      ) : view.kind === "article" ? (
        <Article id={view.id} onBack={() => setView(view.back)} onHome={home} onOpen={(id) => setView({ kind: "article", id, back: view.back })} onAsk={() => setView({ kind: "ask" })} onEmail={() => setView({ kind: "email" })} />
      ) : view.kind === "ask" ? (
        <Ask client={client} page={page} chat={chat} setChat={setChat} onBack={home} onOpen={open} onEmail={() => setView({ kind: "email" })} />
      ) : (
        <EmailSupport client={client} me={me} page={page} onBack={home} />
      )}
    </ScrollView>
  );
}

// Home: search, the three ways to get help, and the guides by topic.

function Home(props: {
  query: string;
  setQuery: (q: string) => void;
  isManager: boolean;
  onOpen: (id: string) => void;
  onCategory: (id: HelpCategory) => void;
  onAsk: () => void;
  onEmail: () => void;
}) {
  const results = useMemo(() => searchHelp(props.query), [props.query]);
  const { width } = useWindowDimensions();
  const cols = width >= 1100 ? 4 : width >= 700 ? 2 : 1;
  const popular = ["check-in", "walk-in", "move-remove", "rain-check", "weather-delay", "cash-drawer"].map((id) => HELP_ARTICLES.find((a) => a.id === id)!);

  return (
    <>
      <View style={styles.hero}>
        <Text role="heading" aria-level={1} style={styles.heroTitle}>How can we help?</Text>
        <Text style={styles.heroSub}>Search the guides, ask the assistant, or email the support team.</Text>
        <TextInput
          accessibilityLabel="Search help articles"
          placeholder="Search help articles, e.g. rain check"
          placeholderTextColor={colors.placeholder}
          value={props.query}
          onChangeText={props.setQuery}
          style={styles.search}
          autoCorrect={false}
        />
      </View>

      {props.query.trim() ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{results.length ? `${results.length} article${results.length === 1 ? "" : "s"}` : "No articles found"}</Text>
          {results.length ? (
            <View style={styles.list}>
              {results.map((a, i) => <ArticleRow key={a.id} article={a} last={i === results.length - 1} onPress={() => props.onOpen(a.id)} />)}
            </View>
          ) : (
            <Text style={styles.muted}>Try other words, or ask the assistant below.</Text>
          )}
        </View>
      ) : null}

      <View style={[styles.grid, { marginTop: 18 }]}>
        <ActionCard cols={cols === 1 ? 1 : 3} icon="?" title="Ask the assistant" body="Get a quick answer about how the software works, in plain language." cta="Ask a question" onPress={props.onAsk} />
        <ActionCard cols={cols === 1 ? 1 : 3} icon="@" title="Email support" body="Something not working, or a question about billing? Write to the support team." cta="Contact support" onPress={props.onEmail} />
        <ActionCard cols={cols === 1 ? 1 : 3} icon="≡" title="Browse the guides" body={`${HELP_ARTICLES.length} step-by-step articles for the pro shop, starter and managers.`} cta="See all topics" onPress={() => props.onCategory("tee-sheet")} />
      </View>

      <View style={styles.section}>
        <Text role="heading" aria-level={2} style={styles.sectionTitle}>Browse by topic</Text>
        <View style={styles.grid}>
          {HELP_CATEGORIES.map((c) => {
            const count = HELP_ARTICLES.filter((a) => a.category === c.id).length;
            return (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                accessibilityLabel={`${c.label}, ${count} articles`}
                onPress={() => props.onCategory(c.id)}
                style={({ hovered, focused }: WebPress) => [styles.topic, { flexBasis: `${100 / cols - 2}%` as `${number}%` }, (hovered || focused) && styles.cardHover, focused && styles.focus]}
              >
                <Text style={styles.topicTitle}>{c.label}</Text>
                <Text style={styles.muted}>{c.blurb}</Text>
                <Text style={styles.topicCount}>{count} {count === 1 ? "article" : "articles"}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text role="heading" aria-level={2} style={styles.sectionTitle}>Popular articles</Text>
        <View style={styles.list}>
          {popular.map((a, i) => <ArticleRow key={a.id} article={a} last={i === popular.length - 1} onPress={() => props.onOpen(a.id)} />)}
        </View>
      </View>
    </>
  );
}

function ActionCard({ icon, title, body, cta, onPress, cols }: { icon: string; title: string; body: string; cta: string; onPress: () => void; cols: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.action, { flexBasis: `${100 / cols - 2}%` as `${number}%` }, (hovered || focused) && styles.cardHover, focused && styles.focus]}
    >
      <View style={styles.actionIcon}>
        <Text style={styles.actionIconText}>{icon}</Text>
      </View>
      <Text style={styles.actionTitle}>{title}</Text>
      <Text style={[styles.muted, { flexGrow: 1 }]}>{body}</Text>
      <Text style={styles.cta}>{cta} →</Text>
    </Pressable>
  );
}

function ArticleRow({ article, onPress, last }: { article: HelpArticle; onPress: () => void; last?: boolean }) {
  return (
    <Pressable
      accessibilityRole="link"
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.row, last && { borderBottomWidth: 0 }, (hovered || focused) && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle}>
          {article.title}
          {article.managersOnly ? <Text style={styles.tag}>  MANAGERS</Text> : null}
        </Text>
        <Text style={styles.muted} numberOfLines={2}>{article.summary}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function Crumbs({ items }: { items: { label: string; onPress?: () => void }[] }) {
  return (
    <View style={styles.crumbs}>
      {items.map((c, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center" }}>
          {i > 0 && <Text style={styles.crumbSep}>/</Text>}
          {c.onPress ? (
            <Pressable accessibilityRole="link" onPress={c.onPress} hitSlop={6}>
              <Text style={styles.crumbLink}>{c.label}</Text>
            </Pressable>
          ) : (
            <Text style={styles.crumbHere} numberOfLines={1}>{c.label}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

// A topic: its articles, with the other topics alongside.

function Category({ id, onBack, onOpen }: { id: HelpCategory; onBack: () => void; onOpen: (id: string) => void }) {
  const [current, setCurrent] = useState(id);
  const cat = HELP_CATEGORIES.find((c) => c.id === current)!;
  const articles = HELP_ARTICLES.filter((a) => a.category === current);
  return (
    <>
      <Crumbs items={[{ label: "Help center", onPress: onBack }, { label: cat.label }]} />
      <View style={styles.chips}>
        {HELP_CATEGORIES.map((c) => (
          <Pressable
            key={c.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: c.id === current }}
            onPress={() => setCurrent(c.id)}
            style={({ focused }: WebPress) => [styles.chip, c.id === current && styles.chipOn, focused && styles.focus]}
          >
            <Text style={[styles.chipText, c.id === current && { color: "#fff" }]}>{c.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text role="heading" aria-level={1} style={styles.pageTitle}>{cat.label}</Text>
      <Text style={[styles.muted, { marginBottom: 12 }]}>{cat.blurb}</Text>
      <View style={styles.list}>
        {articles.map((a, i) => <ArticleRow key={a.id} article={a} last={i === articles.length - 1} onPress={() => onOpen(a.id)} />)}
      </View>
    </>
  );
}

// One article.

function Article({ id, onBack, onHome, onOpen, onAsk, onEmail }: { id: string; onBack: () => void; onHome: () => void; onOpen: (id: string) => void; onAsk: () => void; onEmail: () => void }) {
  const a = HELP_ARTICLES.find((x) => x.id === id);
  const [helpful, setHelpful] = useState<boolean>();
  useEffect(() => setHelpful(undefined), [id]);
  if (!a) return <Text style={styles.muted}>That article isn't here any more.</Text>;
  const cat = HELP_CATEGORIES.find((c) => c.id === a.category)!;
  const related = HELP_ARTICLES.filter((x) => x.category === a.category && x.id !== a.id).slice(0, 4);
  const steps = a.body.length > 1;
  return (
    <>
      <Crumbs items={[{ label: "Help center", onPress: onHome }, { label: cat.label, onPress: onBack }, { label: a.title }]} />
      <View style={styles.articleCard}>
        <Text role="heading" aria-level={1} style={styles.pageTitle}>{a.title}</Text>
        <Text style={[styles.muted, { marginBottom: 14 }]}>
          {a.summary}
          {a.managersOnly ? "  ·  Managers only" : ""}
        </Text>
        {a.body.map((p, i) => (
          <View key={i} style={styles.step}>
            {steps && (
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
            )}
            <Text style={styles.stepText}>{p}</Text>
          </View>
        ))}
        <View style={styles.helpful}>
          {helpful === undefined ? (
            <>
              <Text style={styles.muted}>Was this helpful?</Text>
              <SmallButton label="Yes" onPress={() => setHelpful(true)} />
              <SmallButton label="No" onPress={() => setHelpful(false)} />
            </>
          ) : helpful ? (
            <Text style={styles.muted}>Thanks for letting us know.</Text>
          ) : (
            <Text style={styles.muted}>
              Sorry about that.{" "}
              <Text accessibilityRole="link" style={styles.inlineLink} onPress={onAsk}>Ask the assistant</Text> or{" "}
              <Text accessibilityRole="link" style={styles.inlineLink} onPress={onEmail}>email support</Text>.
            </Text>
          )}
        </View>
      </View>
      {related.length > 0 && (
        <View style={styles.section}>
          <Text role="heading" aria-level={2} style={styles.sectionTitle}>Related articles</Text>
          <View style={styles.list}>
            {related.map((r, i) => <ArticleRow key={r.id} article={r} last={i === related.length - 1} onPress={() => onOpen(r.id)} />)}
          </View>
        </View>
      )}
    </>
  );
}

// The assistant.

function Ask({ client, page, chat, setChat, onBack, onOpen, onEmail }: {
  client: Client;
  page: string | null;
  chat: ChatEntry[];
  setChat: (fn: (c: ChatEntry[]) => ChatEntry[]) => void;
  onBack: () => void;
  onOpen: (id: string) => void;
  onEmail: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setText("");
    setBusy(true);
    const history: HelpTurn[] = chat.flatMap((e): HelpTurn[] => (e.role === "user" ? [{ role: "user", content: e.content }] : e.role === "assistant" ? [{ role: "assistant", content: e.answer }] : []));
    setChat((c) => [...c, { role: "user", content: question }]);
    try {
      const answer = await client.askHelp({ question, history, page });
      setChat((c) => [...c, { role: "assistant", ...answer }]);
    } catch (e) {
      setChat((c) => [...c, { role: "error", content: e instanceof Error ? e.message : "Couldn't reach the assistant. Try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Crumbs items={[{ label: "Help center", onPress: onBack }, { label: "Ask the assistant" }]} />
      <View style={styles.articleCard}>
        <Text role="heading" aria-level={1} style={styles.pageTitle}>Ask the assistant</Text>
        <Text style={styles.muted}>Ask how to do something in the software. Answers come from the help guides, so check with a manager before anything involving refunds or money.</Text>

        <View style={styles.chat} accessibilityLiveRegion="polite">
          {chat.length === 0 && (
            <View>
              <Text style={[styles.sectionLabel, { marginBottom: 8 }]}>Try asking</Text>
              <View style={styles.chips}>
                {SUGGESTED.map((s) => (
                  <Pressable key={s} accessibilityRole="button" onPress={() => ask(s)} style={({ hovered, focused }: WebPress) => [styles.chip, (hovered || focused) && styles.cardHover, focused && styles.focus]}>
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
                <Text style={styles.botLabel}>{e.via === "ai" ? "Assistant" : "From the help guides"}</Text>
                <Text style={styles.stepText}>{e.answer}</Text>
                {e.articles.length > 0 && (
                  <View style={{ marginTop: 8, gap: 4 }}>
                    <Text style={styles.sectionLabel}>Read more</Text>
                    {e.articles.map((a) => (
                      <Pressable key={a.id} accessibilityRole="link" onPress={() => onOpen(a.id)} hitSlop={4} style={({ focused }: WebPress) => [styles.source, focused && styles.focus]}>
                        <Text style={styles.inlineLink}>{a.title}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            ),
          )}
          {busy && (
            <View style={[styles.botBubble, { flexDirection: "row", gap: 8, alignItems: "center" }]}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.muted}>Looking that up…</Text>
            </View>
          )}
        </View>

        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Your question"
            placeholder="Ask a question, e.g. how do I move a group?"
            placeholderTextColor={colors.placeholder}
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => ask(text)}
            returnKeyType="send"
            style={[styles.search, { flex: 1, marginTop: 0 }]}
            maxLength={1000}
          />
          <SmallButton label="Ask" primary disabled={!text.trim() || busy} onPress={() => ask(text)} />
        </View>
        <Text style={[styles.muted, { marginTop: 10, fontSize: 13 }]}>
          Didn't get what you need?{" "}
          <Text accessibilityRole="link" style={styles.inlineLink} onPress={onEmail}>Email support</Text>
          {chat.length > 0 ? (
            <>
              {"  ·  "}
              <Text accessibilityRole="link" style={styles.inlineLink} onPress={() => setChat(() => [])}>Start over</Text>
            </>
          ) : null}
        </Text>
      </View>
    </>
  );
}

// Email support.

const TOPICS: { id: SupportTopic; label: string }[] = [
  { id: "question", label: "Question" },
  { id: "problem", label: "Something isn't working" },
  { id: "billing", label: "Billing" },
  { id: "idea", label: "Feature idea" },
];

function EmailSupport({ client, me, page, onBack }: { client: Client; me?: Me; page: string | null; onBack: () => void }) {
  const [topic, setTopic] = useState<SupportTopic>("question");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState(me?.user?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<SupportRequest>();
  const [mine, setMine] = useState<SupportRequest[]>();

  const load = () => client.supportRequests().then(setMine, () => setMine([]));
  useEffect(() => void load(), []);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo.trim());
  const ready = subject.trim() !== "" && body.trim() !== "" && emailOk;

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await client.sendSupport({ topic, subject: subject.trim(), body: body.trim(), replyTo: replyTo.trim(), page });
      setSent(r);
      setSubject("");
      setBody("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Crumbs items={[{ label: "Help center", onPress: onBack }, { label: "Email support" }]} />
      <View style={styles.articleCard}>
        <Text role="heading" aria-level={1} style={styles.pageTitle}>Email support</Text>
        {sent ? (
          <View style={styles.sentBox} role="status">
            <Text style={styles.sentTitle}>Your request is in</Text>
            <Text style={styles.stepText}>
              Reference <Text style={{ fontWeight: "700" }}>{sent.reference}</Text>. We'll reply to {sent.replyTo}. Quote the reference if you write again about this.
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <SmallButton label="Send another" onPress={() => setSent(undefined)} />
              <SmallButton label="Back to help center" onPress={onBack} />
            </View>
          </View>
        ) : (
          <>
            <Text style={[styles.muted, { marginBottom: 14 }]}>Tell us what's going on. The more detail, the faster we can help.</Text>
            <Text style={styles.label}>Topic</Text>
            <View style={styles.chips}>
              {TOPICS.map((t) => (
                <Pressable
                  key={t.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: topic === t.id }}
                  onPress={() => setTopic(t.id)}
                  style={({ focused }: WebPress) => [styles.chip, topic === t.id && styles.chipOn, focused && styles.focus]}
                >
                  <Text style={[styles.chipText, topic === t.id && { color: "#fff" }]}>{t.label}</Text>
                </Pressable>
              ))}
            </View>
            <Field label="Subject" value={subject} onChangeText={setSubject} placeholder="e.g. Card reader won't connect" maxLength={200} />
            <Field
              label="Message"
              value={body}
              onChangeText={setBody}
              placeholder="What were you doing, what happened, and what did you expect?"
              multiline
              maxLength={5000}
              style={[styles.input, { minHeight: 130, textAlignVertical: "top" }]}
            />
            <Field label="Reply to" value={replyTo} onChangeText={setReplyTo} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
            {page && <Text style={[styles.muted, { fontSize: 13 }]}>We'll include that you were on the {page} page.</Text>}
            {error && <Text role="alert" style={styles.error}>{error}</Text>}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
              <SmallButton label={busy ? "Sending…" : "Send to support"} primary disabled={busy || !ready} onPress={send} />
              <SmallButton label="Cancel" onPress={onBack} />
            </View>
          </>
        )}
      </View>

      <View style={styles.section}>
        <Text role="heading" aria-level={2} style={styles.sectionTitle}>Your requests</Text>
        {mine === undefined ? (
          <ActivityIndicator color={colors.primary} />
        ) : mine.length === 0 ? (
          <Text style={styles.muted}>Nothing sent yet.</Text>
        ) : (
          <View style={styles.list}>
            {mine.map((r, i) => (
              <View key={r.id} style={[styles.row, i === mine.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{r.subject}</Text>
                  <Text style={styles.muted}>
                    {r.reference} · {TOPICS.find((t) => t.id === r.topic)?.label} · {new Date(r.at).toLocaleDateString([], { month: "short", day: "numeric" })}
                    {r.staff && me?.user?.name !== r.staff ? ` · ${r.staff}` : ""}
                  </Text>
                </View>
                <Text style={[styles.status, r.status === "failed" && { color: colors.noShow, borderColor: colors.noShow }]}>{r.status === "sent" ? "Sent" : "Not sent"}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </>
  );
}

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, style, ...input } = props;
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} autoCorrect={false} placeholderTextColor={colors.placeholder} style={style ?? styles.input} {...input} />
    </View>
  );
}

function SmallButton({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, disabled && { opacity: 0.5 }, hovered && !disabled && { opacity: 0.9 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40, width: "100%", maxWidth: 1080, alignSelf: "center" },
  hero: { backgroundColor: colors.rail, borderRadius: radius, paddingHorizontal: 24, paddingVertical: 28 },
  heroTitle: { color: "#fff", fontSize: 26, fontWeight: "700" },
  heroSub: { color: colors.railMuted, fontSize: 15, marginTop: 4, marginBottom: 16 },
  search: { backgroundColor: "#fff", borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 14, minHeight: 46, fontSize: 15, color: colors.text, maxWidth: 640 },
  section: { marginTop: 24 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 10 },
  sectionLabel: { fontSize: 12, fontWeight: "700", color: colors.muted, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  action: { flexGrow: 1, minWidth: 220, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 16, gap: 6, minHeight: 170 },
  actionIcon: { width: 36, height: 36, borderRadius: radius, backgroundColor: colors.primaryLight, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  actionIconText: { color: colors.primaryText, fontSize: 18, fontWeight: "700" },
  actionTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  cta: { color: colors.primaryText, fontWeight: "700", fontSize: 14, marginTop: 6 },
  cardHover: { borderColor: colors.primary },
  topic: { flexGrow: 1, minWidth: 200, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 14, gap: 3 },
  topicTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  topicCount: { fontSize: 12, color: colors.primaryText, fontWeight: "600", marginTop: 6 },
  list: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowTitle: { fontSize: 15, fontWeight: "600", color: colors.text, marginBottom: 2 },
  tag: { fontSize: 10, fontWeight: "700", color: colors.muted, letterSpacing: 0.5 },
  chevron: { fontSize: 22, color: colors.muted },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  crumbs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginBottom: 12 },
  crumbSep: { color: colors.muted, marginHorizontal: 6 },
  crumbLink: { color: colors.primaryText, fontSize: 14, fontWeight: "600" },
  crumbHere: { color: colors.muted, fontSize: 14 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 14 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 10, minHeight: 32, justifyContent: "center", backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text, fontWeight: "600" },
  pageTitle: { fontSize: 22, fontWeight: "700", color: colors.text, marginBottom: 4 },
  articleCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 20, maxWidth: 760 },
  step: { flexDirection: "row", gap: 12, marginBottom: 12 },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primaryLight, alignItems: "center", justifyContent: "center", marginTop: 1 },
  stepNumText: { color: colors.primaryText, fontSize: 12, fontWeight: "700" },
  stepText: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 23 },
  helpful: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14, marginTop: 6 },
  inlineLink: { color: colors.primaryText, fontWeight: "600", textDecorationLine: "underline" },
  chat: { marginTop: 16, gap: 10, minHeight: 80 },
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.primary, borderRadius: radius, paddingHorizontal: 12, paddingVertical: 8 },
  userText: { color: "#fff", fontSize: 15, lineHeight: 21 },
  botBubble: { alignSelf: "flex-start", maxWidth: "92%", backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 12 },
  botLabel: { fontSize: 11, fontWeight: "700", color: colors.muted, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 },
  source: { alignSelf: "flex-start" },
  composer: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 16 },
  label: { fontSize: 13, fontWeight: "600", color: colors.text, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text, backgroundColor: "#fff" },
  error: { color: colors.noShow, marginTop: 8 },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 16, minHeight: 40, justifyContent: "center", backgroundColor: "#fff" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  sentBox: { borderWidth: 1, borderColor: colors.checkedIn, backgroundColor: "#eef7f1", borderRadius: radius, padding: 16, marginTop: 8 },
  sentTitle: { fontSize: 16, fontWeight: "700", color: colors.checkedIn, marginBottom: 4 },
  status: { fontSize: 12, fontWeight: "700", color: colors.checkedIn, borderWidth: 1, borderColor: colors.checkedIn, borderRadius: radius, paddingHorizontal: 6, paddingVertical: 2 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
