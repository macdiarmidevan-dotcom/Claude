import { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Settings } from "./src/api";
import { SetupScreen } from "./src/SetupScreen";
import { TeeSheetScreen } from "./src/TeeSheetScreen";
import { colors } from "./src/theme";

const SETTINGS_KEY = "golf-staff-settings";

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const [lastSettings, setLastSettings] = useState<Settings>();

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
        <TeeSheetScreen settings={settings} onChangeSettings={save} onSignOut={signOut} />
      ) : (
        <SetupScreen initial={lastSettings} onSave={save} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.green },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
