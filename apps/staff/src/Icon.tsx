import Svg, { Circle, Path } from "react-native-svg";

// Line icons for the menu and toolbars, drawn on a 24-unit grid in the style of Feather icons.

type Shape = { d: string } | { c: [number, number, number] };

const ICONS = {
  clock: [{ c: [12, 12, 10] }, { d: "M12 6v6l4 2" }],
  sync: [{ d: "M23 4v6h-6" }, { d: "M1 20v-6h6" }, { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" }],
  users: [{ d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" }, { c: [9, 7, 4] }, { d: "M23 21v-2a4 4 0 0 0-3-3.87" }, { d: "M16 3.13a4 4 0 0 1 0 7.75" }],
  user: [{ d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" }, { c: [12, 7, 4] }],
  message: [{ d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }],
  gift: [{ d: "M20 12v10H4V12" }, { d: "M2 7h20v5H2z" }, { d: "M12 22V7" }, { d: "M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" }, { d: "M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" }],
  bag: [{ d: "M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" }, { d: "M3 6h18" }, { d: "M16 10a4 4 0 0 1-8 0" }],
  flag: [{ d: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" }, { d: "M4 22v-7" }],
  coffee: [{ d: "M18 8h1a4 4 0 0 1 0 8h-1" }, { d: "M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" }, { d: "M6 1v3M10 1v3M14 1v3" }],
  chart: [{ d: "M18 20V10M12 20V4M6 20v-6" }],
  check: [{ d: "M20 6L9 17l-5-5" }],
  calendar: [{ d: "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" }, { d: "M16 2v4M8 2v4M3 10h18" }],
  sliders: [{ d: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" }],
  help: [{ c: [12, 12, 10] }, { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }, { d: "M12 17h.01" }],
  cloud: [{ d: "M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" }],
  plusCircle: [{ c: [12, 12, 10] }, { d: "M12 8v8M8 12h8" }],
  plus: [{ d: "M12 5v14M5 12h14" }],
  lock: [{ d: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" }, { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  cart: [{ d: "M1 3h15v13H1z" }, { d: "M16 8h4l3 3v5h-7V8z" }, { c: [5.5, 18.5, 2.5] }, { c: [18.5, 18.5, 2.5] }],
  chevronDown: [{ d: "M6 9l6 6 6-6" }],
  chevronLeft: [{ d: "M15 18l-6-6 6-6" }],
  chevronRight: [{ d: "M9 18l6-6-6-6" }],
  dollar: [{ d: "M12 1v22" }, { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" }],
  circle: [{ c: [12, 12, 9] }],
  radar: [{ c: [12, 12, 10] }, { c: [12, 12, 6] }, { c: [12, 12, 2] }, { d: "M12 12l7-7" }],
  tag: [{ d: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" }, { d: "M7 7h.01" }],
  box: [{ d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" }, { d: "M3.27 6.96L12 12.01l8.73-5.05" }, { d: "M12 22.08V12" }],
  swatches: [{ d: "M3 3h7v7H3z" }, { d: "M14 3h7v7h-7z" }, { d: "M3 14h7v7H3z" }, { d: "M14 14h7v7h-7z" }],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, color = "currentColor", strokeWidth = 2 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {(ICONS[name] as Shape[]).map((s, i) => ("d" in s ? <Path key={i} d={s.d} /> : <Circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} />))}
    </Svg>
  );
}
