import fs from "node:fs";
import path from "node:path";
import type { Project } from "./types";

// в упакованном приложении Electron подменяет рабочую папку на userData
export const WORKSPACE =
  process.env.TYTRY_WORKSPACE || path.join(process.cwd(), "workspace");
export const UPLOADS_DIR = path.join(WORKSPACE, "uploads");
export const AUDIO_DIR = path.join(WORKSPACE, "audio");
export const RENDERS_DIR = path.join(WORKSPACE, "renders");
export const THUMBS_DIR = path.join(WORKSPACE, "thumbs");
const PROJECTS_DIR = path.join(WORKSPACE, "projects");

export function ensureWorkspace() {
  for (const dir of [WORKSPACE, UPLOADS_DIR, AUDIO_DIR, RENDERS_DIR, THUMBS_DIR, PROJECTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function projectFile(id: string) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Bad project id");
  return path.join(PROJECTS_DIR, `${id}.json`);
}

export function saveProject(project: Project) {
  ensureWorkspace();
  fs.writeFileSync(projectFile(project.id), JSON.stringify(project, null, 2), "utf8");
}

export function loadProject(id: string): Project | null {
  try {
    return JSON.parse(fs.readFileSync(projectFile(id), "utf8")) as Project;
  } catch {
    return null;
  }
}

export function listProjects(): Project[] {
  ensureWorkspace();
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), "utf8")) as Project;
      } catch {
        return null;
      }
    })
    .filter((p): p is Project => p !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateProject(id: string, patch: Partial<Project>): Project | null {
  const project = loadProject(id);
  if (!project) return null;
  const updated = { ...project, ...patch };
  saveProject(updated);
  return updated;
}

export function deleteProject(id: string) {
  const project = loadProject(id);
  if (!project) return;
  // рендер удаляем только из служебной папки; файлы в папке пользователя не трогаем
  const renderPath = project.renderFile
    ? path.isAbsolute(project.renderFile)
      ? project.renderFile
      : path.join(RENDERS_DIR, project.renderFile)
    : null;
  const renderInsideWorkspace =
    renderPath && renderPath.startsWith(path.resolve(RENDERS_DIR) + path.sep);
  for (const file of [
    path.join(UPLOADS_DIR, project.video.fileName),
    path.join(THUMBS_DIR, `${id}.jpg`),
    path.join(AUDIO_DIR, `${id}.wav`),
    renderInsideWorkspace ? renderPath : null,
    projectFile(id),
  ]) {
    if (file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
    }
  }
}
