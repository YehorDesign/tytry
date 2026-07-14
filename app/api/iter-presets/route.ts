// Пресеты вариаций (итераций-хуков): какие сцены дублируются/вырезаются
// в хук и сколько таких вариаций. Сцены хранятся ПО НОМЕРУ (1-based индекс
// клипа на таймлайне) — пресет применим к любому видео с достаточным
// количеством сцен.
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WORKSPACE, ensureWorkspace } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type IterPreset = {
  id: string;
  name: string;
  createdAt: string;
  /** каждая вариация: список сцен хука по порядку (move = вырезание) */
  iterations: { clips: { scene: number; move?: boolean }[] }[];
};

const FILE = path.join(WORKSPACE, "iter-presets.json");

function listIterPresets(): IterPreset[] {
  try {
    const presets = JSON.parse(fs.readFileSync(FILE, "utf8")) as IterPreset[];
    return presets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function writeAtomic(presets: IterPreset[]) {
  ensureWorkspace();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(presets, null, 2), "utf8");
  fs.renameSync(tmp, FILE);
}

export async function GET() {
  return NextResponse.json({ presets: listIterPresets() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<IterPreset>;
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  // санитайзинг: только валидные номера сцен и флаг move
  const iterations = (Array.isArray(body.iterations) ? body.iterations : [])
    .map((it) => ({
      clips: (Array.isArray(it?.clips) ? it.clips : [])
        .filter((c) => Number.isFinite(c?.scene) && c.scene >= 1 && c.scene <= 500)
        .map((c) => ({
          scene: Math.round(c.scene),
          ...(c.move ? { move: true } : {}),
        })),
    }))
    .filter((it) => it.clips.length > 0)
    .slice(0, 50);
  if (iterations.length === 0) {
    return NextResponse.json({ error: "No iterations to save" }, { status: 400 });
  }
  const preset: IterPreset = {
    id: crypto.randomBytes(6).toString("hex"),
    name: body.name.trim().slice(0, 60),
    createdAt: new Date().toISOString(),
    iterations,
  };
  writeAtomic([...listIterPresets().filter((p) => p.name !== preset.name), preset]);
  return NextResponse.json({ preset, presets: listIterPresets() });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  writeAtomic(listIterPresets().filter((p) => p.id !== id));
  return NextResponse.json({ presets: listIterPresets() });
}
