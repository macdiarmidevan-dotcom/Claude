import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "./theme";

/** A section's title bar. On narrow screens it carries the button that opens the menu. */
export function Header({ title, subtitle, onOpenMenu, children }: { title: string; subtitle?: string; onOpenMenu?: () => void; children?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      {onOpenMenu && (
        <Pressable accessibilityRole="button" accessibilityLabel="Open menu" onPress={onOpenMenu} style={styles.menuButton} hitSlop={6}>
          <Text style={styles.menuIcon}>☰</Text>
        </Pressable>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text role="heading" aria-level={1} style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.headerSub} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 16, minHeight: 60, paddingVertical: 8 },
  menuButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  menuIcon: { fontSize: 22, color: colors.text },
  headerTitle: { fontSize: 20, fontWeight: "700", color: colors.text },
  headerSub: { fontSize: 13, color: colors.muted, marginTop: 1 },
});
