// Ужимание готового рендера под лимит размера (например, 30 МБ):
// битрейт считается из длительности, кодирует NVENC (если есть) или x264.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { probeMedia, type MediaProbe } from "./ffmpeg";
import { detectEncoder, type EncoderChoice } from "./render-native/encoder";
import { getSettings } from "./settings";

const exec = promisify(execFile);
const FFMPEG = ffmpegPath as unknown as string;

/**
 * Если в настройках задан лимит и файл больше него — пережимает файл
 * на месте (имя сохраняется). Иначе ничего не делает.
 */
export async function enforceSizeLimit(filePath: string): Promise<void> {
  await compressToSize(filePath, getSettings().maxSizeMb ?? 0);
}

/** Пережимает файл на месте под лимит в МБ (0 = ничего не делать). */
export async function compressToSize(filePath: string, maxMb: number): Promise<void> {
  if (!maxMb || !fs.existsSync(filePath)) return;
  const maxBytes = maxMb * 1024 * 1024;
  if (fs.statSync(filePath).size <= maxBytes) return;

  const s = getSettings();
  const encoder: EncoderChoice =
    s.encoder === "cpu" || s.encoder === "nvenc" ? s.encoder : await detectEncoder();

  const probe = await probeMedia(filePath);
  const tmp = filePath.replace(/\.mp4$/i, "") + ".sizelimit.mp4";

  try {
    // 5% запас на mp4-контейнер и неточность попадания энкодера в битрейт
    let budgetKbit = (maxBytes * 8 * 0.95) / 1000;
    for (let attempt = 0; attempt < 3; attempt++) {
      await encodePass(filePath, tmp, probe, budgetKbit, encoder);
      const size = fs.statSync(tmp).size;
      if (size <= maxBytes) break;
      // перебрали — ужимаем бюджет пропорционально перебору и пробуем ещё раз
      budgetKbit *= (maxBytes / size) * 0.97;
    }
    fs.rmSync(filePath);
    fs.renameSync(tmp, filePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function encodePass(
  input: string,
  output: string,
  probe: MediaProbe,
  budgetKbit: number,
  encoder: EncoderChoice
) {
  const durSec = Math.max(probe.durationMs / 1000, 0.1);
  const totalKbps = budgetKbit / durSec;

  // аудио 128k; на длинных роликах ужимаем, чтобы не съедало бюджет видео
  let audioKbps = probe.hasAudio ? 128 : 0;
  if (audioKbps > 0 && audioKbps > totalKbps * 0.25) {
    audioKbps = totalKbps * 0.25 >= 96 ? 96 : 64;
  }
  const videoKbps = Math.max(Math.floor(totalKbps - audioKbps), 100);

  // при сильном ужатии высокое разрешение даёт «кашу» — уменьшаем кадр так,
  // чтобы плотность держалась около 0.04 бит/пиксель
  const MIN_BPP = 0.04;
  const bpp = (videoKbps * 1000) / (probe.width * probe.height * probe.fps);
  const scaleArgs: string[] = [];
  if (bpp < MIN_BPP) {
    const factor = Math.sqrt(bpp / MIN_BPP);
    const h = Math.max(Math.round((probe.height * factor) / 2) * 2, 480);
    if (h < probe.height) scaleArgs.push("-vf", `scale=-2:${h}`);
  }

  const maxrate = Math.floor(videoKbps * 1.05);
  const videoArgs =
    encoder === "nvenc"
      ? [
          "-c:v", "h264_nvenc",
          "-preset", "p4",
          "-rc:v", "vbr",
          "-b:v", `${videoKbps}k`,
          "-maxrate", `${maxrate}k`,
          "-bufsize", `${videoKbps * 2}k`,
          "-spatial-aq", "1",
          "-profile:v", "high",
        ]
      : [
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-b:v", `${videoKbps}k`,
          "-maxrate", `${maxrate}k`,
          "-bufsize", `${videoKbps * 2}k`,
        ];

  await exec(
    FFMPEG,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", input,
      ...scaleArgs,
      ...videoArgs,
      "-pix_fmt", "yuv420p",
      ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", `${Math.round(audioKbps)}k`] : ["-an"]),
      "-movflags", "+faststart",
      output,
    ],
    { maxBuffer: 8 * 1024 * 1024 }
  );
}
