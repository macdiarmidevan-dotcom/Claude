import { useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { colors } from "./theme";

// Signatures are stored in this coordinate box, whatever size the pad is drawn at.
const BOX_W = 600;
const BOX_H = 200;

/** A finger-drawn signature. Reports SVG path data, or "" when cleared. */
export function SignaturePad({ onChange }: { onChange: (path: string) => void }) {
  const [strokes, setStrokes] = useState<string[]>([]);
  const current = useRef("");
  const size = useRef({ w: BOX_W, h: BOX_H });
  const [, redraw] = useState(0);

  const toBox = (x: number, y: number) =>
    `${((x / size.current.w) * BOX_W).toFixed(1)} ${((y / size.current.h) * BOX_H).toFixed(1)}`;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Keep the surrounding scroll view from stealing the stroke.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          current.current = `M${toBox(e.nativeEvent.locationX, e.nativeEvent.locationY)}`;
          redraw((n) => n + 1);
        },
        onPanResponderMove: (e) => {
          current.current += ` L${toBox(e.nativeEvent.locationX, e.nativeEvent.locationY)}`;
          redraw((n) => n + 1);
        },
        onPanResponderRelease: () => {
          const stroke = current.current;
          current.current = "";
          setStrokes((prev) => {
            const next = [...prev, stroke];
            onChange(next.join(" "));
            return next;
          });
        },
      }),
    [onChange],
  );

  function clear() {
    setStrokes([]);
    onChange("");
  }

  const onLayout = (e: LayoutChangeEvent) => {
    size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };

  return (
    <View>
      <View style={styles.pad} onLayout={onLayout} {...responder.panHandlers} accessibilityLabel="Signature pad">
        <Svg width="100%" height="100%" viewBox={`0 0 ${BOX_W} ${BOX_H}`} pointerEvents="none">
          {[...strokes, current.current].filter(Boolean).map((d, i) => (
            <Path key={i} d={d} stroke={colors.text} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </Svg>
        {strokes.length === 0 && !current.current && (
          <Text style={styles.hint} pointerEvents="none">
            Sign here with your finger
          </Text>
        )}
        <View style={styles.line} pointerEvents="none" />
      </View>
      <Pressable accessibilityRole="button" onPress={clear} style={styles.clear}>
        <Text style={{ color: colors.muted, fontWeight: "600" }}>Clear signature</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {
    aspectRatio: BOX_W / BOX_H,
    width: "100%",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: "#fdfdfb",
    overflow: "hidden",
    // Stops the browser scrolling the page while signing on the web.
    touchAction: "none",
  } as object,
  hint: { position: "absolute", alignSelf: "center", top: "40%", color: colors.muted, fontSize: 15 },
  line: { position: "absolute", left: 24, right: 24, bottom: "22%", height: 1, backgroundColor: colors.border },
  clear: { alignSelf: "flex-end", paddingVertical: 8 },
});
