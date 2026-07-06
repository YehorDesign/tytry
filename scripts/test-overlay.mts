import fs from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { ensureFontsRegistered } from "../lib/render-native/fonts";
import { createScene } from "../lib/render-native/scene";

ensureFontsRegistered();
const scene = createScene({
  words: [{ id: "w1", text: "привет", startMs: 500, endMs: 1000 }],
  styleId: "hormozi",
  overrides: {},
  width: 1080,
  height: 1920,
  fps: 30,
  overlays: [
    {
      id: "ov1",
      text: "Чорний текст на білій плашці, як у тіктоці",
      startMs: 0,
      endMs: 2000,
      y: 0.3,
      sizeRatio: 0.042,
    },
  ],
});
console.log("key f0 (overlay only):", scene.frameKey(0));
console.log("key f20 (page+overlay):", scene.frameKey(20));
console.log("key f70 (nothing):", scene.frameKey(70));
const band = scene.verticalBand();
console.log("band:", JSON.stringify(band));
const c = createCanvas(1080, band.height);
const ctx = c.getContext("2d");
const drew = scene.drawFrame(ctx, 0, band.top);
const d = ctx.getImageData(0, 0, 1080, band.height).data;
let nonEmpty = 0;
for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonEmpty++;
console.log("drew:", drew, "opaque px:", nonEmpty);

// полный кадр в PNG для визуальной проверки
const full = createCanvas(1080, 1920);
const fctx = full.getContext("2d");
fctx.fillStyle = "#333";
fctx.fillRect(0, 0, 1080, 1920);
scene.drawFrame(fctx, 5, 0);
fs.writeFileSync("scripts/_test-overlay.png", full.toBuffer("image/png"));
console.log("png saved");
