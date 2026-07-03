import { continueRender, delayRender, staticFile } from "remotion";
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

// Gilroy — локальный OTF из public/fonts (его нет в Google Fonts).
// weight "100 900": единственное начертание Medium используется для любого
// запрошенного веса — так браузер не рисует faux-bold и превью совпадает
// с нативным рендером.
if (typeof document !== "undefined") {
  try {
    const handle = delayRender("Loading Gilroy");
    const face = new FontFace(
      "Gilroy",
      `url("${staticFile("fonts/Gilroy-500.otf")}") format("opentype")`,
      { weight: "100 900" }
    );
    face
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => {})
      .then(() => continueRender(handle));
  } catch {
    // вне контекста Remotion/браузера шрифт не нужен
  }
}

export const FONT_FAMILIES: Record<string, string> = {
  Gilroy: "Gilroy",
  Montserrat: montserrat.fontFamily,
  Unbounded: unbounded.fontFamily,
  Oswald: oswald.fontFamily,
  JetBrainsMono: jetbrains.fontFamily,
  PlayfairDisplay: playfair.fontFamily,
  Caveat: caveat.fontFamily,
};

/** Вбудовані шрифти для випадаючого списку в UI */
export const BUILTIN_FONTS = [
  "Gilroy",
  "Montserrat",
  "Unbounded",
  "Oswald",
  "JetBrainsMono",
  "PlayfairDisplay",
  "Caveat",
];
