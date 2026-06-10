import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadUnbounded } from "@remotion/google-fonts/Unbounded";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadPlayfair } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadCaveat } from "@remotion/google-fonts/Caveat";

const montserrat = loadMontserrat("normal", {
  weights: ["500", "600", "700", "800", "900"],
  subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext"],
});
const unbounded = loadUnbounded("normal", {
  weights: ["700", "900"],
  subsets: ["latin", "cyrillic"],
});
const oswald = loadOswald("normal", {
  weights: ["600", "700"],
  subsets: ["latin", "cyrillic"],
});
const jetbrains = loadJetBrains("normal", {
  weights: ["700", "800"],
  subsets: ["latin", "cyrillic"],
});
const playfair = loadPlayfair("normal", {
  weights: ["700", "900"],
  subsets: ["latin", "cyrillic"],
});
loadPlayfair("italic", {
  weights: ["700", "900"],
  subsets: ["latin", "cyrillic"],
});
const caveat = loadCaveat("normal", {
  weights: ["700"],
  subsets: ["latin", "cyrillic"],
});

export const FONT_FAMILIES: Record<string, string> = {
  Montserrat: montserrat.fontFamily,
  Unbounded: unbounded.fontFamily,
  Oswald: oswald.fontFamily,
  JetBrainsMono: jetbrains.fontFamily,
  PlayfairDisplay: playfair.fontFamily,
  Caveat: caveat.fontFamily,
};

/** Вбудовані шрифти для випадаючого списку в UI */
export const BUILTIN_FONTS = [
  "Montserrat",
  "Unbounded",
  "Oswald",
  "JetBrainsMono",
  "PlayfairDisplay",
  "Caveat",
];
