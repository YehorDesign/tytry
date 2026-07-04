import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const exec = promisify(execFile);

const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = ffprobeStatic.path;

export type ProbeResult = {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
};

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,duration",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream) throw new Error("No video stream found in file");

  const [num, den] = String(stream.r_frame_rate ?? "30/1").split("/").map(Number);
  const fps = den ? num / den : 30;
  const durationSec = Number(stream.duration) || Number(data.format?.duration) || 0;
  if (!durationSec) throw new Error("Could not determine video duration");

  return {
    width: Number(stream.width),
    height: Number(stream.height),
    durationMs: Math.round(durationSec * 1000),
    fps: Math.round(fps * 100) / 100,
  };
}

export const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;

export type MediaProbe = ProbeResult & { hasAudio: boolean; isImage: boolean };

/** Проба видео или картинки + наличие аудиодорожки. */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  if (IMAGE_EXT.test(filePath)) {
    const { stdout } = await exec(FFPROBE, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      filePath,
    ]);
    const stream = JSON.parse(stdout).streams?.[0];
    if (!stream) throw new Error("Not a valid image file");
    return {
      width: Number(stream.width),
      height: Number(stream.height),
      durationMs: 3000, // картинка: длительность по умолчанию, тянется тримом
      fps: 30,
      hasAudio: false,
      isImage: true,
    };
  }
  const video = await probeVideo(filePath);
  const hasAudio = await exec(FFPROBE, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_type",
    "-of", "json",
    filePath,
  ])
    .then(({ stdout }) => (JSON.parse(stdout).streams?.length ?? 0) > 0)
    .catch(() => false);
  return { ...video, hasAudio, isImage: false };
}

/** Длительность аудиофайла (для библиотеки музыки). */
export async function probeAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ]);
  const sec = Number(JSON.parse(stdout).format?.duration) || 0;
  if (!sec) throw new Error("Could not read audio duration");
  return Math.round(sec * 1000);
}

export type FlattenClip = {
  path: string;
  kind: "video" | "image";
  inMs: number;
  outMs: number;
  hasAudio: boolean;
  /** размеры исходника — для расчёта вписывания и зума */
  width: number;
  height: number;
  /** длительность исходника — для «продления кадра» (outMs дальше конца) */
  sourceDurationMs?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
};

type FilterGraph = {
  args: string[]; // входы (-i и опции перед ними)
  filters: string[]; // цепочки filter_complex
  videoOut: string;
  audioOut: string;
};

/**
 * Общая часть склейки: каждый клип тримится, приводится к канвасу (scale+pad)
 * и единому fps/аудиоформату, затем concat. Клипы без звука получают тишину.
 */
function buildConcatGraph(
  clips: FlattenClip[],
  width: number,
  height: number,
  fps: number,
  withVideo: boolean
): FilterGraph {
  const args: string[] = [];
  const filters: string[] = [];
  const pairs: string[] = [];

  clips.forEach((clip, i) => {
    const durSec = Math.max(clip.outMs - clip.inMs, 1) / 1000;
    if (clip.kind === "image") {
      args.push("-loop", "1", "-t", durSec.toFixed(3), "-i", clip.path);
    } else {
      args.push("-i", clip.path);
    }

    // «продлить кадр»: outMs дальше конца исходника → морозим последний кадр
    const srcDur = clip.sourceDurationMs ?? clip.outMs;
    const videoEndMs = clip.kind === "video" ? Math.min(clip.outMs, srcDur) : clip.outMs;
    const freezeSec =
      clip.kind === "video" ? Math.max(clip.outMs - videoEndMs, 0) / 1000 : 0;

    if (withVideo) {
      const trim =
        clip.kind === "image"
          ? ""
          : `trim=start=${(clip.inMs / 1000).toFixed(3)}:end=${(videoEndMs / 1000).toFixed(3)},setpts=PTS-STARTPTS,` +
            (freezeSec > 0.001
              ? `tpad=stop_mode=clone:stop_duration=${freezeSec.toFixed(3)},`
              : "");
      // вписываем в канвас с учётом зума и сдвига: scale → overlay на чёрный фон
      // (края за пределами канваса обрезаются overlay-ем — это и есть «кроп»)
      const fit = Math.min(width / clip.width, height / clip.height);
      const zoom = clip.zoom ?? 1;
      const tw = Math.max(Math.round((clip.width * fit * zoom) / 2) * 2, 2);
      const th = Math.max(Math.round((clip.height * fit * zoom) / 2) * 2, 2);
      const ox = Math.round((width - tw) / 2 + (clip.panX ?? 0) * width);
      const oy = Math.round((height - th) / 2 + (clip.panY ?? 0) * height);
      filters.push(
        `[${i}:v]${trim}scale=${tw}:${th},setsar=1,fps=${fps}[vs${i}]`,
        `color=black:s=${width}x${height}:r=${fps}:d=${durSec.toFixed(3)}[bg${i}]`,
        `[bg${i}][vs${i}]overlay=${ox}:${oy}:shortest=1,format=yuv420p[v${i}]`
      );
    }

    if (clip.kind === "video" && clip.hasAudio) {
      filters.push(
        `[${i}:a]atrim=start=${(clip.inMs / 1000).toFixed(3)}:end=${(videoEndMs / 1000).toFixed(3)},` +
          `asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo` +
          (freezeSec > 0.001 ? `,apad=pad_dur=${freezeSec.toFixed(3)}` : "") +
          `[a${i}]`
      );
    } else {
      // тишина той же длительности, чтобы concat не съехал
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${durSec.toFixed(3)}[a${i}]`
      );
    }
    pairs.push(withVideo ? `[v${i}][a${i}]` : `[a${i}]`);
  });

  filters.push(
    withVideo
      ? `${pairs.join("")}concat=n=${clips.length}:v=1:a=1[vc][ac]`
      : `${pairs.join("")}concat=n=${clips.length}:v=0:a=1[ac]`
  );
  return { args, filters, videoOut: "[vc]", audioOut: "[ac]" };
}

/**
 * Склеивает таймлайн монтажа (клипы встык + музыка) в промежуточный mp4.
 * Дальше по нему работает обычный рендер субтитров.
 */
export async function flattenTimeline(opts: {
  clips: FlattenClip[];
  width: number;
  height: number;
  fps: number;
  musicPath?: string | null;
  musicVolume?: number;
  outPath: string;
}) {
  const { clips, width, height, fps, musicPath, outPath } = opts;
  const graph = buildConcatGraph(clips, width, height, fps, true);
  const args = ["-y", ...graph.args];
  let audioOut = graph.audioOut;

  if (musicPath) {
    const musicIdx = clips.length;
    args.push("-stream_loop", "-1", "-i", musicPath);
    const vol = Math.min(Math.max(opts.musicVolume ?? 0.3, 0), 1);
    graph.filters.push(`[${musicIdx}:a]volume=${vol.toFixed(3)}[am]`);
    graph.filters.push(
      `${graph.audioOut}[am]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
    );
    audioOut = "[aout]";
  }

  args.push(
    "-filter_complex", graph.filters.join(";"),
    "-map", graph.videoOut,
    "-map", audioOut,
    // промежуточный файл: почти без потерь, финальный энкод будет дальше
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "14",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath
  );
  await exec(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
}

/** Аудио склейки клипов (без музыки) → моно-WAV 16 кГц для Deepgram. */
export async function extractTimelineAudio(clips: FlattenClip[], outPath: string) {
  const graph = buildConcatGraph(clips, 16, 16, 30, false);
  await exec(
    FFMPEG,
    [
      "-y",
      ...graph.args,
      "-filter_complex", graph.filters.join(";"),
      "-map", graph.audioOut,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-f", "wav",
      outPath,
    ],
    { maxBuffer: 32 * 1024 * 1024 }
  );
}

/** Извлекает моно-WAV 16 кГц для отправки в Deepgram. */
export async function extractAudio(videoPath: string, outPath: string) {
  await exec(FFMPEG, [
    "-y",
    "-i", videoPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-f", "wav",
    outPath,
  ]);
}

export async function extractThumbnail(videoPath: string, outPath: string, atSec = 0.3) {
  await exec(FFMPEG, [
    "-y",
    "-ss", String(atSec),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=320:-2",
    outPath,
  ]);
}
