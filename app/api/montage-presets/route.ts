// Пресеты монтажа: какие сцены (по номеру исходника: «3.mp4» → 3) остаются,
// в каком порядке, и где заканчивается каждая сцена ОТНОСИТЕЛЬНО озвучки
// (endFrac — доля длительности озвучки). Применяется к видео с другими
// таймингами: границы пересчитываются от его собственной озвучки.
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WORKSPACE, ensureWorkspace } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type MontagePresetScene = {
  /** номер сцены из имени исходника */
  num: number;
  /** конец сцены как доля длительности озвучки (может быть > 1 — хвост после неё) */
  endFrac?: number;
  /** конец сцены как позиция на «ломаной слов» (точная пословная привязка) */
  endWord?: number;
  /** трим начала как доля исходника */
  inFrac?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  speed?: number;
};

export type MontagePreset = {
  id: string;
  name: string;
  createdAt: string;
  /** число слов озвучки оригинала — пословная привязка включается при совпадении */
  voWords?: number;
  scenes: MontagePresetScene[];
};

const FILE = path.join(WORKSPACE, "montage-presets.json");

function listMontagePresets(): MontagePreset[] {
  try {
    const presets = JSON.parse(fs.readFileSync(FILE, "utf8")) as MontagePreset[];
    return presets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function writeAtomic(presets: MontagePreset[]) {
  ensureWorkspace();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(presets, null, 2), "utf8");
  fs.renameSync(tmp, FILE);
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

export async function GET() {
  return NextResponse.json({ presets: listMontagePresets() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<MontagePreset>;
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  const scenes = (Array.isArray(body.scenes) ? body.scenes : [])
    .map((s) => {
      const n = num(s?.num, 1, 500);
      if (n === undefined) return null;
      const scene: MontagePresetScene = { num: Math.round(n) };
      const endWord = num(s.endWord, 0, 4000);
      if (endWord !== undefined) scene.endWord = endWord;
      const endFrac = num(s.endFrac, -10, 10);
      const inFrac = num(s.inFrac, 0, 0.95);
      const zoom = num(s.zoom, 0.2, 5);
      const panX = num(s.panX, -0.5, 0.5);
      const panY = num(s.panY, -0.5, 0.5);
      const speed = num(s.speed, 0.25, 4);
      if (endFrac !== undefined) scene.endFrac = endFrac;
      if (inFrac !== undefined) scene.inFrac = inFrac;
      if (zoom !== undefined) scene.zoom = zoom;
      if (panX !== undefined) scene.panX = panX;
      if (panY !== undefined) scene.panY = panY;
      if (speed !== undefined) scene.speed = speed;
      return scene;
    })
    .filter((s): s is MontagePresetScene => s !== null)
    .slice(0, 100);
  if (scenes.length === 0) {
    return NextResponse.json({ error: "No scenes to save" }, { status: 400 });
  }
  const voWords = num(body.voWords, 1, 2000);
  const preset: MontagePreset = {
    id: crypto.randomBytes(6).toString("hex"),
    name: body.name.trim().slice(0, 60),
    createdAt: new Date().toISOString(),
    ...(voWords !== undefined ? { voWords: Math.round(voWords) } : {}),
    scenes,
  };
  writeAtomic([...listMontagePresets().filter((p) => p.name !== preset.name), preset]);
  return NextResponse.json({ preset, presets: listMontagePresets() });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  writeAtomic(listMontagePresets().filter((p) => p.id !== id));
  return NextResponse.json({ presets: listMontagePresets() });
}
