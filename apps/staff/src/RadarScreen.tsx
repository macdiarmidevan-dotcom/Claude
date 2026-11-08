import { useEffect, useState } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Icon } from "./Icon";
import { colors, type WebPress } from "./theme";

// Weather radar from the National Weather Service, so the pro shop and starter can see storms
// coming before deciding on a weather delay. KLOT (Chicago, in Romeoville) covers River Bend.
// Each device can pick another radar station, which it remembers with its other settings.

export const DEFAULT_RADAR_STATION = "KLOT";
const REFRESH_MS = 5 * 60_000;

const loopUrl = (station: string, at: number) => `https://radar.weather.gov/ridge/standard/${station}_loop.gif?t=${at}`;
const mapUrl = (station: string) => `https://radar.weather.gov/station/${station.toLowerCase()}/standard`;

export function RadarScreen({ station, onChangeStation }: { station?: string; onChangeStation: (station: string) => void }) {
  const code = (station || DEFAULT_RADAR_STATION).toUpperCase();
  const { width } = useWindowDimensions();
  const [at, setAt] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState(code);

  // A fresh loop every few minutes; the radar itself updates about that often.
  useEffect(() => {
    setFailed(false);
    const timer = setInterval(() => setAt(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, [code]);

  const imageWidth = Math.min(760, width - 32);
  const updated = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const valid = /^[A-Z]{4}$/.test(draft.trim().toUpperCase());

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.card}>
        <View style={styles.top}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <Text role="heading" aria-level={2} style={styles.title}>Radar loop · {code}</Text>
            <Text style={styles.help}>The last hour of rain and storms around the course from the National Weather Service. Refreshed at {updated}.</Text>
          </View>
          <Button icon label="Refresh" onPress={() => (setFailed(false), setAt(Date.now()))} />
          <Button label="Open live map" onPress={() => Linking.openURL(mapUrl(code))} />
        </View>
        {failed ? (
          <View style={[styles.fallback, { width: imageWidth, height: imageWidth * (550 / 600) }]}>
            <Text style={styles.strong}>The radar picture didn't load.</Text>
            <Text style={[styles.help, { textAlign: "center" }]}>Check the internet connection, or open the live map instead.</Text>
          </View>
        ) : (
          <Image
            accessibilityLabel={`Weather radar loop from station ${code}`}
            source={{ uri: loopUrl(code, at) }}
            onError={() => setFailed(true)}
            resizeMode="contain"
            style={[styles.radar, { width: imageWidth, height: imageWidth * (550 / 600) }]}
          />
        )}
        <Text style={[styles.help, { marginTop: 10 }]}>Lightning or heavy rain heading your way? Push tee times back with the weather delay button on the tee sheet.</Text>
      </View>

      <View style={styles.card}>
        <Text role="heading" aria-level={2} style={styles.title}>Radar station</Text>
        {changing ? (
          <View style={styles.row}>
            <View style={{ minWidth: 160 }}>
              <Text style={styles.label}>Station code</Text>
              <TextInput
                accessibilityLabel="Station code"
                value={draft}
                onChangeText={setDraft}
                autoCapitalize="characters"
                maxLength={4}
                placeholder="KLOT"
                placeholderTextColor={colors.placeholder}
                style={styles.input}
              />
            </View>
            <Button
              label="Save"
              primary
              disabled={!valid}
              onPress={() => {
                onChangeStation(draft.trim().toUpperCase());
                setChanging(false);
              }}
            />
            <Button label="Cancel" onPress={() => (setDraft(code), setChanging(false))} />
          </View>
        ) : (
          <View style={styles.row}>
            <Text style={[styles.help, { flex: 1, minWidth: 200 }]}>
              This device shows station {code}. Pick the National Weather Service radar closest to the course; its four-letter code is on the live map.
            </Text>
            <Button label="Change" onPress={() => setChanging(true)} />
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function Button({ label, onPress, primary, disabled, icon }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; icon?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, hovered && !primary && { backgroundColor: colors.bg }, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      {icon && <Icon name="sync" size={14} color={colors.text} />}
      <Text style={[styles.buttonText, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, maxWidth: 820 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 0, padding: 14, backgroundColor: colors.card, marginBottom: 14 },
  top: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 4 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  radar: { borderRadius: 0, backgroundColor: "#0d1117" },
  fallback: { borderRadius: 0, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", gap: 6, padding: 20 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 8 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 0, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  button: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 0, paddingHorizontal: 12, minHeight: 34, backgroundColor: "#fff" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
