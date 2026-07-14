// Распаковка ZIP-архивов.
//
// ВАЖНО: extract-zip (yauzl) внутри main-процесса Electron на Windows может
// МОЛЧА зависнуть посреди записи файла (патченый asar-fs + стримы). Поэтому
// основной путь — системный bsdtar, он есть и в Windows 10+, и в macOS,
// понимает zip и работает отдельным процессом. extract-zip остаётся фолбэком
// на случай отсутствия tar.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import extract from "extract-zip";

const exec = promisify(execFile);

/** Жёсткий потолок на распаковку одного архива — лучше ошибка, чем вечный вис. */
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

export async function extractZip(zipPath: string, dir: string): Promise<void> {
  try {
    await exec("tar", ["-xf", zipPath, "-C", dir], {
      timeout: EXTRACT_TIMEOUT_MS,
      windowsHide: true,
    });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // tar есть, но архив он не осилил — не маскируем ошибку фолбэком
    if (code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`tar: ${msg.slice(-300)}`);
    }
  }
  await extract(zipPath, { dir });
}
