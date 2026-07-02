// Композитинг: ffmpeg читает исходник + сырые RGBA-кадры оверлея из stdin,
// накладывает и кодирует NVENC'ом (или libx264, если GPU-энкодера нет).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const exec = promisify(execFile);
const FFMPEG = ffmpegPath as unknown as string;

export type EncoderChoice = "nvenc" | "cpu";

let detected: EncoderChoice | null = null;

/** Проверяет, реально ли работает NVENC (наличие в сборке + живой драйвер). */
export async function detectEncoder(): Promise<EncoderChoice> {
  if (detected) return detected;
  try {
    await exec(
      FFMPEG,
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=black:size=256x144:rate=30:duration=0.2",
        "-c:v", "h264_nvenc", "-f", "null", "-",
      ],
      { timeout: 15000 }
    );
    detected = "nvenc";
  } catch {
    detected = "cpu";
  }
  return detected;
}

function videoArgs(encoder: EncoderChoice): string[] {
  if (encoder === "nvenc") {
    return [
      "-c:v", "h264_nvenc",
      "-preset", "p4",
      "-rc:v", "vbr",
      "-cq", "22",
      "-b:v", "0",
      "-spatial-aq", "1",
      "-profile:v", "high",
    ];
  }
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19"];
}

export type CompositorOptions = {
  input: string;
  output: string;
  /** размер кадров оверлея (может быть полосой, а не всем кадром) */
  width: number;
  height: number;
  /** вертикальное смещение полосы оверлея в кадре видео */
  overlayY: number;
  fps: number;
  encoder: EncoderChoice;
  /** копировать аудио (false = перекодировать в aac — запасной вариант) */
  copyAudio: boolean;
  onEncodedFrames?: (frames: number) => void;
};

export type Compositor = {
  proc: ChildProcess;
  /** пишет кадр с учётом backpressure */
  writeFrame(buf: Buffer | Uint8Array): Promise<void>;
  /** закрывает stdin и ждёт завершения ffmpeg */
  finish(): Promise<void>;
  /** промис ошибки/завершения (reject при ненулевом коде) */
  done: Promise<void>;
};

export function startCompositor(opts: CompositorOptions): Compositor {
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", opts.input,
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${opts.width}x${opts.height}`,
    "-r", String(opts.fps),
    "-thread_queue_size", "128",
    "-i", "pipe:0",
    "-filter_complex", `[0:v][1:v]overlay=0:${opts.overlayY}:eof_action=pass[vout]`,
    "-map", "[vout]",
    "-map", "0:a?",
    ...(opts.copyAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]),
    ...videoArgs(opts.encoder),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    opts.output,
  ];

  const proc = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });

  let stderrTail = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  proc.stdout!.on("data", (chunk: Buffer) => {
    const m = chunk.toString().match(/frame=\s*(\d+)/g);
    if (m && opts.onEncodedFrames) {
      const last = m[m.length - 1].match(/(\d+)/);
      if (last) opts.onEncodedFrames(parseInt(last[1], 10));
    }
  });

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail.trim().slice(-1500)}`));
    });
  });
  // stdin может закрыться раньше (ошибка ffmpeg) — не роняем процесс EPIPE'ом
  proc.stdin!.on("error", () => {});

  // не ждём drain на каждом кадре: держим окно в 32 МБ,
  // иначе round-trip'ы по backpressure режут пропускную способность вдвое
  const WINDOW = 32 * 1024 * 1024;
  const writeFrame = (buf: Buffer | Uint8Array) =>
    new Promise<void>((resolve) => {
      if (!proc.stdin!.writable) {
        // ffmpeg уже умер — причину отдаст done
        resolve();
        return;
      }
      proc.stdin!.write(buf);
      if (proc.stdin!.writableLength > WINDOW) {
        proc.stdin!.once("drain", () => resolve());
      } else {
        resolve();
      }
    });

  const finish = async () => {
    await new Promise<void>((resolve) => proc.stdin!.end(resolve));
    await done;
  };

  return { proc, writeFrame, finish, done };
}
