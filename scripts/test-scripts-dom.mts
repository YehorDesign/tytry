// Проверка DOM-движка (превью в плеере = тот же CaptionedVideo, что и запасной
// chrome-рендер): иврит должен подтянуть Rubik и встать справа налево.
// Кадр рендерится из готового remotion-bundle через renderStill.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";

const ROOT = process.cwd();
const UPLOADS = path.join(ROOT, "workspace", "uploads");
const video = fs
  .readdirSync(UPLOADS)
  .filter((f) => f.endsWith(".mp4"))
  .sort(
    (a, b) =>
      fs.statSync(path.join(UPLOADS, a)).size - fs.statSync(path.join(UPLOADS, b)).size
  )[0];
if (!video) throw new Error("нет ни одного mp4 в workspace/uploads");

// мини-сервер: chrome должен получить видео по http
const PORT = 3987;
const server = http.createServer((req, res) => {
  const file = path.join(UPLOADS, video);
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace("bytes=", "").split("-");
    const start = Number(s);
    const end = e ? Number(e) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "video/mp4" });
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(PORT, r));

const CASES: Record<string, { texts: [string, string, string]; font?: string }> = {
  hebrew: { texts: ["אחת", "שתיים", "שלוש"] },
  japanese: { texts: ["こんにちは", "世界", "です"] },
  korean: { texts: ["안녕하세요", "세계", "입니다"] },
  hindi: { texts: ["नमस्ते", "दुनिया", "आज"] },
  // у DynaPuff нет кириллицы: и превью, и рендер должны уйти в Montserrat
  dynapuff_cyrillic: { texts: ["привіт", "світ", "тут"], font: "DynaPuff" },
};

const serveUrl = path.join(ROOT, "remotion-bundle");
for (const [name, { texts, font }] of Object.entries(CASES)) {
  const inputProps = {
    videoSrc: `http://localhost:${PORT}/video.mp4`,
    words: texts.map((text, i) => ({
      id: `w${i}`,
      text,
      startMs: i * 600,
      endMs: (i + 1) * 600,
    })),
    styleId: "hormozi",
    overrides: {
      highlightColor: "#FF0000",
      textColor: "#FFFFFF",
      ...(font ? { fontFamily: font } : {}),
    },
    width: 1080,
    height: 1920,
    durationMs: 2000,
  };
  const composition = await selectComposition({
    serveUrl,
    id: "CaptionedVideo",
    inputProps,
  });
  const out = path.join(ROOT, "scripts", `out-scripts-dom-${name}.png`);
  await renderStill({ composition, serveUrl, output: out, frame: 5, inputProps, overwrite: true });
  console.log("wrote", out);
}
server.close();
