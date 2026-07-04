// Нативный рендер проекта: кадры субтитров рисуются skia-канвасом и по пайпу
// уходят в ffmpeg, который накладывает их на исходник и кодирует (NVENC/CPU).
// Кадры с одинаковым визуальным состоянием рисуются один раз.
import { createCanvas } from "@napi-rs/canvas";
import type { Project } from "../types";
import { detectEncoder, startCompositor, type EncoderChoice } from "./encoder";
import { ensureFontsRegistered } from "./fonts";
import { createScene } from "./scene";

export type NativeRenderOptions = {
  inputPath: string;
  outputPath: string;
  encoder?: EncoderChoice | "auto";
  onProgress?: (progress: number) => void;
};

export async function renderProjectNative(project: Project, opts: NativeRenderOptions) {
  if (!project.words || project.words.length === 0) {
    throw new Error("No captions yet — transcribe first");
  }
  ensureFontsRegistered();

  const { width, height, durationMs } = project.video;
  let fps = project.video.fps;
  if (!Number.isFinite(fps) || fps < 5 || fps > 120) fps = 30;
  const totalFrames = Math.ceil((durationMs / 1000) * fps);

  const encoder: EncoderChoice =
    !opts.encoder || opts.encoder === "auto" ? await detectEncoder() : opts.encoder;

  const scene = createScene({
    words: project.words,
    styleId: project.styleId,
    overrides: project.overrides ?? {},
    width,
    height,
    fps,
    disclaimer: project.disclaimer,
  });

  // рендерим только полосу, где живут субтитры — в разы меньше данных в пайп
  const band = scene.verticalBand();
  const canvas = createCanvas(width, band.height);
  const ctx = canvas.getContext("2d");
  const blank = Buffer.alloc(width * band.height * 4); // прозрачный кадр

  const attempt = async (enc: EncoderChoice, copyAudio: boolean) => {
    const comp = startCompositor({
      input: opts.inputPath,
      output: opts.outputPath,
      width,
      height: band.height,
      overlayY: band.top,
      fps,
      encoder: enc,
      copyAudio,
      onEncodedFrames: (frames) => {
        opts.onProgress?.(Math.min(frames / totalFrames, 1));
      },
    });

    const debug = !!process.env.TYTRY_RENDER_DEBUG;
    let tDraw = 0;
    let tWrite = 0;
    let uniqueFrames = 0;

    let lastKey = "";
    let lastBuf: Buffer = blank;
    for (let frame = 0; frame < totalFrames; frame++) {
      const key = scene.frameKey(frame);
      if (key !== lastKey) {
        lastKey = key;
        if (key === "b") {
          lastBuf = blank;
        } else {
          const t0 = debug ? performance.now() : 0;
          uniqueFrames++;
          ctx.clearRect(0, 0, width, band.height);
          scene.drawFrame(ctx, frame, band.top);
          // getImageData отдаёт straight-alpha RGBA — то, что ждёт overlay
          const data = ctx.getImageData(0, 0, width, band.height).data;
          lastBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          if (debug) tDraw += performance.now() - t0;
        }
      }
      const t1 = debug ? performance.now() : 0;
      await comp.writeFrame(lastBuf);
      if (debug) tWrite += performance.now() - t1;
    }
    await comp.finish();
    if (debug) {
      console.log(
        `[render-debug] band=${band.top}+${band.height} unique=${uniqueFrames}/${totalFrames} ` +
          `draw=${(tDraw / 1000).toFixed(1)}s write-wait=${(tWrite / 1000).toFixed(1)}s`
      );
    }
  };

  try {
    await attempt(encoder, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // самые частые причины падения: аудиокодек не лезет в mp4 → перекодируем;
    // NVENC отвалился (лимит сессий/драйвер) → пробуем CPU
    if (/audio|aac|codec|muxer/i.test(message) && !/nvenc/i.test(message)) {
      await attempt(encoder, false);
    } else if (encoder === "nvenc") {
      await attempt("cpu", false);
    } else {
      throw err;
    }
  }
  opts.onProgress?.(1);
}
