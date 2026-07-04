// Смоук-тест зума/позиции кадра в склейке: npx tsx scripts/test-frame.mts
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { flattenTimeline, probeMedia, probeVideo } from "../lib/ffmpeg";

const uploads = path.join(process.cwd(), "workspace", "uploads");
const f = fs.readdirSync(uploads).filter((x) => /\.mp4$/i.test(x))[0];
const src = path.join(uploads, f);
const meta = await probeMedia(src);

const outDir = path.join(process.cwd(), "workspace", "test-frame");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "framed.mp4");

await flattenTimeline({
  clips: [
    // 2 секунды: зум 1.8 + сдвиг вправо-вниз
    {
      path: src, kind: "video", inMs: 0, outMs: 2000, hasAudio: meta.hasAudio,
      width: meta.width, height: meta.height, zoom: 1.8, panX: 0.15, panY: 0.1,
    },
    // 2 секунды: без трансформа (контроль)
    {
      path: src, kind: "video", inMs: 0, outMs: 2000, hasAudio: meta.hasAudio,
      width: meta.width, height: meta.height,
    },
  ],
  width: 1080,
  height: 1920,
  fps: 30,
  outPath,
});
const out = await probeVideo(outPath);
console.log(`framed: ${out.durationMs}ms ${out.width}x${out.height} (expected ~4000ms 1080x1920)`);

// кадры из обеих половин для сравнения
for (const [name, at] of [["zoomed", "1"], ["plain", "3"]] as const) {
  execFileSync(ffmpegPath as unknown as string, [
    "-y", "-ss", at, "-i", outPath, "-frames:v", "1",
    path.join(outDir, `${name}.png`),
  ]);
}
console.log("OK, PNGs in", outDir);
