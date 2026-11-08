import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "./theme";

/** A section's title bar (the dark toolbar under the menu). On narrow screens it carries the button that opens the menu. */
export function Header({ title, subtitle, note, onOpenMenu, children }: { title: string; subtitle?: string; /** Shown on the same line, after the title. */ note?: string; onOpenMenu?: () => void; children?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      {onOpenMenu && (
        <Pressable accessibilityRole="button" accessibilityLabel="Open menu" onPress={onOpenMenu} style={styles.menuButton} hitSlop={6}>
          <Text style={styles.menuIcon}>☰</Text>
        </Pressable>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
          <Text role="heading" aria-level={1} style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          {note ? <Text style={styles.headerNote} numberOfLines={1}>{note}</Text> : null}
        </View>
        {subtitle ? <Text style={styles.headerSub} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // zIndex: menus that drop down from the bar sit over the page below it.
  // The dark toolbar under the menu: the page title on the left, its buttons on the right.
  header: { zIndex: 10, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.toolbar, paddingHorizontal: 16, minHeight: 50, paddingVertical: 7 },
  menuButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 0 },
  menuIcon: { fontSize: 18, color: colors.railText },
  headerTitle: { fontSize: 17, fontWeight: "600", color: "#ffffff" },
  headerNote: { fontSize: 13, color: "#a9b7ae" },
  headerSub: { fontSize: 12, color: colors.railMuted, marginTop: 1 },
});
