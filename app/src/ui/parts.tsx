// The app's shared parts: one button, one card, one warning, one step bar,
// one bottom bar — used on every screen so the app looks and behaves the same
// everywhere. Presentation only: nothing here touches keys or money.
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { font, gap, mainButton, radius, size, touch, useTheme } from "./theme";

/** The Crowdlock mark: three people arm in arm. The one in the middle is you. */
export function Logo({ px = 30 }: { px?: number }) {
  const t = useTheme();
  return (
    <Svg width={px} height={px} viewBox="0 0 96 96" accessibilityElementsHidden importantForAccessibility="no">
      <Path
        d="M9,78 V55 a13,13 0 0 1 26,0 V78 M35,55 a13,13 0 0 1 26,0 V78 M61,55 a13,13 0 0 1 26,0 V78"
        fill="none" stroke={t.brand} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round"
      />
      <Circle cx={22} cy={27} r={7.5} fill={t.brand} />
      <Circle cx={74} cy={27} r={7.5} fill={t.brand} />
      <Circle cx={48} cy={27} r={7.5} fill={t.accent} />
    </Svg>
  );
}

/** A button. "main" is the one big action on a screen; "second" is visibly smaller; "link" is words only. */
export function Btn({ label, onPress, kind = "main", disabled }: { label: string; onPress: () => void; kind?: "main" | "second" | "link" | "danger"; disabled?: boolean }) {
  const t = useTheme();
  const box =
    kind === "main" ? { backgroundColor: t.brand, minHeight: mainButton }
    : kind === "second" ? { borderWidth: 1, borderColor: t.soft, minHeight: touch }
    : { minHeight: touch };
  const colour = kind === "main" ? t.onBrand : kind === "danger" ? t.stop : kind === "link" ? t.brand : t.ink;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        { borderRadius: radius, paddingHorizontal: gap.l, paddingVertical: gap.s, alignItems: "center", justifyContent: "center", marginTop: gap.m },
        box, (pressed || disabled) && { opacity: 0.5 },
      ]}
    >
      <Text style={{ fontFamily: font.bold, fontSize: kind === "main" ? 17 : size.body, color: colour, textAlign: "center", textDecorationLine: kind === "link" ? "underline" : "none" }}>{label}</Text>
    </Pressable>
  );
}

/** A panel that groups one thing. */
export function Card({ children, plain }: { children: ReactNode; plain?: boolean }) {
  const t = useTheme();
  return <View style={{ backgroundColor: plain ? "transparent" : t.panel, borderWidth: 1, borderColor: t.rule, borderRadius: radius, padding: gap.l, marginTop: gap.m }}>{children}</View>;
}

/**
 * A warning, at one of two levels. The level is always said in words and
 * marked with a shape as well as a colour: a square "!" for "this can't be
 * undone", a round "i" for "know this before you go on".
 */
export function Warning({ level, title, children }: { level: "know" | "stop"; title: string; children?: ReactNode }) {
  const t = useTheme();
  const colour = level === "stop" ? t.stop : t.know;
  const says = level === "stop" ? "This can't be undone" : "Know this before you go on";
  return (
    <View accessibilityRole="alert" style={{ flexDirection: "row", gap: gap.m, backgroundColor: t.panel, borderLeftWidth: 6, borderLeftColor: colour, borderRadius: radius, padding: gap.m, marginTop: gap.m }}>
      <View style={{ width: 26, height: 26, borderRadius: level === "stop" ? 6 : 13, backgroundColor: colour, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontFamily: font.bold, color: t.panel, fontSize: size.body }}>{level === "stop" ? "!" : "i"}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: font.bold, fontSize: 13, color: colour }}>{says}</Text>
        <Text style={{ fontFamily: font.bold, fontSize: size.body, color: t.ink }}>{title}</Text>
        {typeof children === "string" ? <Text style={{ fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: t.ink, marginTop: 2 }}>{children}</Text> : children}
      </View>
    </View>
  );
}

export const STEPS = ["Understand", "Sign", "Get bitcoin", "Lock", "Commit to a purchase", "Take it home"];

/** Where someone is on the six steps: bars, and the same thing in words. */
export function StepBar({ step }: { step: number }) {
  const t = useTheme();
  const next = step < 6 ? ` Next: ${STEPS[step].toLowerCase()}.` : "";
  return (
    <View style={{ marginTop: gap.m }} accessible accessibilityLabel={`Step ${step} of 6: ${STEPS[step - 1]}.${next}`}>
      <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>
        {STEPS.map((_, i) => {
          const n = i + 1;
          return <View key={n} style={{ flex: 1, height: n === step ? 14 : 10, borderRadius: 7, borderWidth: 2, borderColor: n === step ? t.brand : t.soft, backgroundColor: n === step ? t.brand : n < step ? t.soft : "transparent" }} />;
        })}
      </View>
      <Text style={{ fontFamily: font.regular, fontSize: size.small, color: t.soft, marginTop: gap.s }}>Step {step} of 6: {STEPS[step - 1]}.{next}</Text>
    </View>
  );
}

/** A row that leads somewhere: a title, a line under it, and an arrow. */
export function NavRow({ title, sub, state, onPress }: { title: string; sub?: string; state?: { text: string; good?: boolean }; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={[title, sub, state?.text].filter(Boolean).join(". ")} onPress={onPress}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: gap.m, borderWidth: 1, borderColor: t.rule, borderRadius: radius, paddingHorizontal: 14, paddingVertical: gap.m, minHeight: 56, marginTop: gap.m }, pressed && { opacity: 0.5 }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: font.bold, fontSize: size.body, color: t.ink }}>{title}</Text>
        {!!sub && <Text style={{ fontFamily: font.regular, fontSize: size.small, color: t.soft }}>{sub}</Text>}
        {!!state && <Text style={{ fontFamily: font.bold, fontSize: size.small, color: state.good ? t.good : t.ink }}>{state.text}</Text>}
      </View>
      <Text style={{ fontFamily: font.regular, fontSize: 24, color: t.soft }}>›</Text>
    </Pressable>
  );
}

/** A small rounded button for the top of a screen: Back, Help. Always words, never a bare picture. */
export function Pill({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
      style={({ pressed }) => [{ minHeight: 40, paddingHorizontal: 14, borderWidth: 1, borderColor: t.rule, borderRadius: 20, alignItems: "center", justifyContent: "center" }, pressed && { opacity: 0.5 }]}>
      <Text style={{ fontFamily: font.bold, fontSize: 15, color: t.ink }}>{label}</Text>
    </Pressable>
  );
}

/** The top of every screen: Back (or the mark and a title) on the left, Help on the right. */
export function TopBar({ title, showLogo, onBack, onHelp }: { title?: string; showLogo?: boolean; onBack?: () => void; onHelp?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: gap.s, paddingHorizontal: gap.l, paddingTop: gap.m, paddingBottom: gap.xs, minHeight: 60, backgroundColor: t.page }}>
      {onBack ? <Pill label="‹ Back" onPress={onBack} /> : showLogo ? <Logo /> : null}
      <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, fontFamily: font.bold, fontSize: size.h2, color: t.ink }}>{title ?? ""}</Text>
      {onHelp && <Pill label="Help" onPress={onHelp} />}
    </View>
  );
}

export type TabName = "home" | "bitcoin" | "crowdlocks" | "more";
const TABS: { name: TabName; label: string }[] = [
  { name: "home", label: "Home" }, { name: "bitcoin", label: "My bitcoin" }, { name: "crowdlocks", label: "Crowdlocks" }, { name: "more", label: "More" },
];

function TabIcon({ name, colour }: { name: TabName; colour: string }) {
  const p = { fill: "none", stroke: colour, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      {name === "home" && <Path d="M4 11.5 12 4l8 7.5V20h-5v-5H9v5H4z" {...p} />}
      {name === "bitcoin" && <><Circle cx={12} cy={12} r={8.5} {...p} /><Path d="M12 7.5v9M9 9.5h4.2a1.8 1.8 0 0 1 0 3.6H9h4.6a1.8 1.8 0 0 1 0 3.6H9" {...p} /></>}
      {name === "crowdlocks" && <><Circle cx={8} cy={9} r={3} {...p} /><Circle cx={16.5} cy={9.5} r={2.5} {...p} /><Path d="M2.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5M15 14.6c2.6-.3 5 1 5.6 4.4" {...p} /></>}
      {name === "more" && <Path d="M4 7h16M4 12h16M4 17h16" {...p} />}
    </Svg>
  );
}

/** The four places, always on screen, each a picture with its word. The chosen one is bold with a bar over it. */
export function TabBar({ tab, onTab }: { tab: TabName; onTab: (t: TabName) => void }) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: t.rule, backgroundColor: t.page }}>
      {TABS.map((x) => {
        const on = x.name === tab;
        return (
          <Pressable key={x.name} accessibilityRole="tab" accessibilityLabel={x.label} accessibilityState={{ selected: on }} onPress={() => onTab(x.name)}
            style={{ flex: 1, alignItems: "center", paddingTop: 9, paddingBottom: 10, minHeight: 58, borderTopWidth: 3, borderTopColor: on ? t.brand : "transparent" }}>
            <TabIcon name={x.name} colour={on ? t.ink : t.soft} />
            <Text style={{ fontFamily: on ? font.bold : font.regular, fontSize: 12, color: on ? t.ink : t.soft, marginTop: 2 }}>{x.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
