import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, SafeAreaView, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Settings } from "./src/api";
import { SetupScreen } from "./src/SetupScreen";
import { Workspace } from "./src/Workspace";
import { colors } from "./src/theme";
import { DEMO, DEMO_URL } from "./src/demo";

const SETTINGS_KEY = "golf-staff-settings";

// On the web the whole app uses IBM Plex Sans; phones and iPads keep the system font.
if (Platform.OS === "web" && typeof document !== "undefined" && !document.getElementById("app-font")) {
  const link = document.createElement("link");
  link.id = "app-font";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap";
  document.head.appendChild(link);
  const style = document.createElement("style");
  style.textContent = "div, span, input, textarea, button, select { font-family: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif !important; }";
  document.head.appendChild(style);
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  // The demo build fills in a pretend course so visitors can just press Connect.
  const [lastSettings, setLastSettings] = useState<Settings | undefined>(
    DEMO ? { apiUrl: DEMO_URL, courseSlug: "river-bend", apiKey: "", station: "proshop" } : undefined,
  );

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY)
      // Devices set up before stations existed default to the starter.
      .then((raw) => raw && setSettings({ station: "starter", ...JSON.parse(raw) }))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  function save(s: Settings) {
    setSettings(s);
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s)).catch(() => undefined);
  }

  function signOut() {
    setLastSettings(settings && { ...settings, apiKey: "" });
    setSettings(undefined);
    AsyncStorage.removeItem(SETTINGS_KEY).catch(() => undefined);
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {!loaded ? (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : settings ? (
        <Workspace settings={settings} onChangeSettings={save} onSignOut={signOut} />
      ) : (
        <SetupScreen initial={lastSettings} onSave={save} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.rail },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
