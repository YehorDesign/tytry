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
