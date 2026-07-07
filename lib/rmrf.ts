// Надёжное удаление файлов/папок.
//
// ВАЖНО: fs.rmSync в Node 24.13 на Windows МОЛЧА не удаляет пути с
// не-ASCII символами (например профиль «C:\Users\Пользователь») — ни файлы,
// ни папки, без единой ошибки. fs.promises.rm при этом работает корректно.
// Поэтому все удаления в проекте идут через эти хелперы, а не fs.rmSync.
import fs from "node:fs";

/** Удаляет файл или папку (рекурсивно), с ретраями против хендлов Windows. */
export async function rmrf(target: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rm(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      // подождём и попробуем ещё раз
    }
    if (!fs.existsSync(target)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Синхронное удаление ОДНОГО файла (для мест, где await неудобен).
 * unlinkSync багом rmSync не затронут.
 */
export function rmFileSync(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    // нет файла — и не надо
  }
}
