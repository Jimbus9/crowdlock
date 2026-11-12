// The app's look, in one place: every colour, letter size and gap. Screens and
// shared parts read from here and nowhere else, so a change of look is a
// one-file edit. Crowdlock's own neutral identity — not any one Crowdlock's.
//
// Every text pairing below was measured at 4.5 to 1 or better, light and dark.
import { useColorScheme } from "react-native";

const light = {
  page: "#FBF8F1",       // paper
  panel: "#F0EBDD",      // card
  ink: "#1B2420",        // text
  soft: "#4F5B54",       // small grey text
  rule: "#D9D2BF",       // lines
  brand: "#1F4D3A",      // bottle green: main button, links, the mark
  onBrand: "#FFFFFF",
  accent: "#C28A1E",     // ochre: the middle head of the mark; never text
  know: "#7A4B00",       // "know this before you go on"
  stop: "#A3111D",       // "this can't be undone"
  good: "#0A6B3B",       // checked and fine
};

const dark: typeof light = {
  page: "#101713",
  panel: "#1A241E",
  ink: "#F1EEE3",
  soft: "#AAB5AC",
  rule: "#2F3B33",
  brand: "#9FD3B4",      // fern
  onBrand: "#0C2218",
  accent: "#DDAE4E",
  know: "#F0B95A",
  stop: "#FF8A8A",
  good: "#5FD39B",
};

// The two banners keep their own fixed colours in both modes.
export const banner = {
  test: { bg: "#FFD84D", text: "#222222" },
  real: { bg: "#A3111D", text: "#FFFFFF" },
};

// Manrope, bundled in the app (assets/fonts, SIL Open Font Licence). On
// Android the family name is the file name. Weight comes from the file, so
// styles choose a family and never set fontWeight.
export const font = { regular: "Manrope-Regular", bold: "Manrope-Bold", mono: "monospace" };

export const size = { small: 14, body: 16, lead: 18, h2: 20, h1: 26, big: 32 };
export const gap = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
export const radius = 4;
export const touch = 48;      // smallest thing anyone has to tap
export const mainButton = 54;

export type Theme = typeof light & { dark: boolean };

export function themeFor(scheme: string | null | undefined): Theme {
  return scheme === "dark" ? { ...dark, dark: true } : { ...light, dark: false };
}

/** The colours for the phone's own light or dark setting. */
export function useTheme(): Theme {
  return themeFor(useColorScheme());
}
