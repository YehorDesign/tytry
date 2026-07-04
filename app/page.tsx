"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PlayerRef } from "@remotion/player";
import { CaptionEditor } from "@/components/CaptionEditor";
import { StylePanel } from "@/components/StylePanel";
import { Timeline } from "@/components/Timeline";
import { formatTimestamp, groupWordsIntoPages } from "@/lib/captions";
import { STRINGS, getLocale, setLocale, type Locale } from "@/lib/i18n";
import { getClips, projectDurationMs } from "@/lib/montage";
import { resolveStyle } from "@/lib/styles";
import {
  clipDurationMs,
  totalClipsDurationMs,
  type MusicTrack,
  type Project,
  type ProjectMusic,
  type StyleOverrides,
  type TimelineClip,
  type Word,
  type WordStyle,
} from "@/lib/types";

const PreviewPlayer = dynamic(
  () => import("@/components/PreviewPlayer").then((m) => m.PreviewPlayer),
  { ssr: false }
);

const FPS = 30;
const MIN_SHIFTED_MS = 40; // защита от отрицательных таймингов после сдвига слов

export default function Home() {
  const [locale, setLocaleState] = useState<Locale>("uk");
  const t = STRINGS[locale];

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"style" | "text">("style");
  const [language, setLanguage] = useState("auto");
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragover, setDragover] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);

  // настройки
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [parallelRenders, setParallelRenders] = useState(3);
  const [encoder, setEncoder] = useState("auto");
  const [renderEngine, setRenderEngine] = useState("native");
  const [savingSettings, setSavingSettings] = useState(false);

  // локальное (редактируемое) состояние выбранного проекта
  const [projectName, setProjectName] = useState("");
  const [words, setWords] = useState<Word[]>([]);
  const [styleId, setStyleId] = useState("hormozi");
  const [overrides, setOverrides] = useState<StyleOverrides>({});
  const [clips, setClips] = useState<TimelineClip[] | null>(null);
  const [music, setMusic] = useState<ProjectMusic | null>(null);
  // глобальные правки «по умолчанию» — подставляются при смене пресета и для новых видео
  const [defaultOverrides, setDefaultOverrides] = useState<StyleOverrides>({
    fontFamily: "Gilroy",
  });

  // выделение фраз на таймлайне (по id слов)
  const [selectedWordIds, setSelectedWordIds] = useState<Set<string>>(new Set());

  // мультивыбор проектов в списке
  const [railSelectMode, setRailSelectMode] = useState(false);
  const [railSelected, setRailSelected] = useState<Set<string>>(new Set());

  // музыкальная библиотека
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);

  // сообщение после «прибрати тишу»
  const [silenceMsg, setSilenceMsg] = useState<string | null>(null);

  const playerRef = useRef<PlayerRef | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const montageInputRef = useRef<HTMLInputElement | null>(null);
  const clipsInputRef = useRef<HTMLInputElement | null>(null);
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const transcribeQueueRef = useRef<Project[]>([]);
  const activeTranscribesRef = useRef(0);

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  // длительность таймлайна: при монтаже считаем по локальным клипам
  const timelineDurationMs = clips
    ? totalClipsDurationMs(clips)
    : selected
      ? projectDurationMs(selected)
      : 0;

  useEffect(() => {
    setLocaleState(getLocale());
  }, []);

  const switchLocale = (next: Locale) => {
    setLocale(next);
    setLocaleState(next);
  };

  const STATUS_LABELS: Record<string, string> = {
    uploaded: t.statusUploaded,
    transcribing: t.statusTranscribing,
    ready: t.statusReady,
    rendering: t.statusRendering,
    done: t.statusDone,
    error: t.statusError,
  };

  // ── загрузка списка + поллинг статусов ──
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = (await res.json()) as { projects: Project[] };
      setProjects(data.projects);
      const sel = data.projects.find((p) => p.id === selectedIdRef.current);
      if (sel?.words && sel.words.length > 0) {
        setWords((w) => (w.length === 0 ? sel.words! : w));
      }
    } catch {
      // сервер ещё поднимается — игнорируем
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  // ── музыкальная библиотека ──
  const refreshMusic = useCallback(async () => {
    try {
      const res = await fetch("/api/music");
      const data = (await res.json()) as { tracks: MusicTrack[] };
      setMusicTracks(data.tracks ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshMusic();
  }, [refreshMusic]);

  // ── статус ключа Deepgram и папка вывода ──
  const refreshSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = (await res.json()) as {
        hasDeepgramKey: boolean;
        maskedKey: string | null;
        outputDir: string;
        parallelRenders?: number;
        encoder?: string;
        renderEngine?: string;
        defaultOverrides?: StyleOverrides;
      };
      setHasKey(data.hasDeepgramKey);
      setMaskedKey(data.maskedKey);
      setOutputDir(data.outputDir);
      setParallelRenders(data.parallelRenders ?? 3);
      setEncoder(data.encoder ?? "auto");
      setRenderEngine(data.renderEngine ?? "native");
      if (data.defaultOverrides) setDefaultOverrides(data.defaultOverrides);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const body: Record<string, string | number> = {
        outputDir,
        parallelRenders,
        encoder,
        renderEngine,
      };
      if (keyInput.trim()) body.deepgramApiKey = keyInput.trim();
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setKeyInput("");
      await refreshSettings();
      setSettingsOpen(false);
    } finally {
      setSavingSettings(false);
    }
  };

  const browseFolder = async () => {
    const picked = await window.titryNative?.pickFolder();
    if (picked) setOutputDir(picked);
  };

  // ── позиция плеера ──
  useEffect(() => {
    const interval = setInterval(() => {
      const frame = playerRef.current?.getCurrentFrame();
      if (frame !== undefined && frame !== null) {
        setCurrentMs((frame / FPS) * 1000);
      }
    }, 150);
    return () => clearInterval(interval);
  }, []);

  // ── выбор проекта ──
  const selectProject = useCallback((project: Project) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    selectedIdRef.current = project.id;
    setSelectedId(project.id);
    setProjectName(project.name);
    setWords(project.words ?? []);
    setStyleId(project.styleId);
    setOverrides(project.overrides ?? {});
    setClips(project.clips && project.clips.length > 0 ? project.clips : null);
    setMusic(project.music ?? null);
    setSelectedWordIds(new Set());
    setSilenceMsg(null);
    setCurrentMs(0);
  }, []);

  // ── отложенное сохранение правок ──
  const scheduleSave = useCallback((patch: Partial<Project>) => {
    const id = selectedIdRef.current;
    if (!id) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    }, 600);
  }, []);

  const handleWordsChange = (next: Word[]) => {
    setWords(next);
    scheduleSave({ words: next, styleId, overrides });
  };

  // имя проекта = имя файла рендера (<назва>_subtitled.mp4)
  const handleNameChange = (name: string) => {
    setProjectName(name);
    // сразу обновляем карточку в списке, не дожидаясь поллинга
    setProjects((prev) =>
      prev.map((p) => (p.id === selectedIdRef.current ? { ...p, name } : p))
    );
    scheduleSave({ name });
  };

  // как resolveOutputPath на сервере: что реально попадёт в имя файла
  const renderFileNamePreview =
    (projectName.replace(/[<>:"/\\|?* -]/g, "_").trim().slice(0, 60) ||
      selected?.id) ?? "";

  // ── стиль: без выделения правим проект, с выделением — только выбранные фразы ──
  const selectionActive = selectedWordIds.size > 0;
  const firstSelectedWord = useMemo(
    () => words.find((w) => selectedWordIds.has(w.id)) ?? null,
    [words, selectedWordIds]
  );
  const selectionStyle: WordStyle | null = firstSelectedWord?.style ?? null;
  const panelStyleId = selectionActive ? selectionStyle?.styleId ?? styleId : styleId;
  const panelOverrides = selectionActive
    ? selectionStyle?.overrides ?? overrides
    : overrides;

  const applyStyleToSelection = (style: WordStyle | null) => {
    const next = words.map((w) =>
      selectedWordIds.has(w.id)
        ? style
          ? { ...w, style }
          : (({ style: _drop, ...rest }) => rest)(w)
        : w
    );
    setWords(next);
    scheduleSave({ words: next, styleId, overrides });
  };

  const handleStyleChange = (next: string) => {
    if (selectionActive) {
      applyStyleToSelection({ styleId: next, overrides: defaultOverrides });
      return;
    }
    // при смене пресета правки не обнуляем, а ставим глобальные типовые
    setStyleId(next);
    setOverrides(defaultOverrides);
    scheduleSave({ words, styleId: next, overrides: defaultOverrides });
  };
  const handleOverridesChange = (next: StyleOverrides) => {
    if (selectionActive) {
      applyStyleToSelection({ styleId: panelStyleId, overrides: next });
      return;
    }
    setOverrides(next);
    scheduleSave({ words, styleId, overrides: next });
  };

  const deleteSelectedPhrases = useCallback(() => {
    setSelectedWordIds((sel) => {
      if (sel.size === 0) return sel;
      setWords((prev) => {
        const next = prev.filter((w) => !sel.has(w.id));
        scheduleSave({ words: next });
        return next;
      });
      return new Set();
    });
  }, [scheduleSave]);

  // Delete/Backspace удаляет выделенные фразы (если фокус не в поле ввода)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      deleteSelectedPhrases();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelectedPhrases]);

  // ── клипы монтажа ──
  const handleClipsChange = (next: TimelineClip[]) => {
    setClips(next);
    scheduleSave({ clips: next });
  };

  // ── музыка ──
  const setProjectMusic = (track: MusicTrack | null) => {
    const next: ProjectMusic | null = track
      ? {
          trackId: track.id,
          fileName: track.fileName,
          name: track.name,
          volume: music?.volume ?? 0.25,
        }
      : null;
    setMusic(next);
    scheduleSave({ music: next });
  };

  const setMusicVolume = (volume: number) => {
    if (!music) return;
    const next = { ...music, volume };
    setMusic(next);
    scheduleSave({ music: next });
  };

  const uploadMusic = async (files: FileList) => {
    const formData = new FormData();
    for (const f of Array.from(files)) formData.append("files", f);
    const res = await fetch("/api/music", { method: "POST", body: formData });
    const data = (await res.json()) as { created: MusicTrack[]; tracks: MusicTrack[] };
    setMusicTracks(data.tracks ?? []);
    if (data.created?.[0] && selectedIdRef.current) {
      setProjectMusic(data.created[0]); // сразу ставим загруженный трек в проект
    }
  };

  const deleteMusicFromLibrary = async (id: string) => {
    if (!confirm(t.confirmDeleteTrack)) return;
    const res = await fetch("/api/music", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = (await res.json()) as { tracks: MusicTrack[] };
    setMusicTracks(data.tracks ?? []);
    if (music?.trackId === id) setProjectMusic(null);
  };

  // ── «прибрати тишу»: трим по краям по таймінгам слов ──
  const deleteSilence = () => {
    if (!selected) return;
    if (words.length === 0) {
      setSilenceMsg(t.silenceNeedWords);
      return;
    }
    const sorted = [...words].sort((a, b) => a.startMs - b.startMs);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const PAD = 150; // небольшой запас, чтобы речь не начиналась впритык
    const lead = Math.max(first.startMs - PAD, 0);
    const tail = Math.max(timelineDurationMs - last.endMs - PAD, 0);
    if (lead < 100 && tail < 100) {
      setSilenceMsg(t.silenceNothing);
      return;
    }

    const base = clips ?? getClips(selected);
    const next = base.map((c) => ({ ...c }));
    // границы клипов на таймлайне — сцены без слов не трогаем вовсе
    const starts: number[] = [];
    let acc = 0;
    for (const c of next) {
      starts.push(acc);
      acc += clipDurationMs(c);
    }

    // начало: режем только если первое слово звучит внутри ПЕРВОГО клипа
    let leadTrim = 0;
    if (first.startMs < starts[0] + clipDurationMs(next[0])) {
      leadTrim = Math.min(lead, Math.max(clipDurationMs(next[0]) - 200, 0));
      next[0].inMs += leadTrim;
    }
    // конец: только если последнее слово внутри ПОСЛЕДНЕГО клипа
    // (ендкард/дисклеймер без речи остаётся как есть)
    const lastIdx = next.length - 1;
    let tailTrim = 0;
    if (last.endMs > starts[lastIdx]) {
      tailTrim = Math.min(tail, Math.max(clipDurationMs(next[lastIdx]) - 200, 0));
      next[lastIdx].outMs -= tailTrim;
    }
    if (leadTrim < 1 && tailTrim < 1) {
      setSilenceMsg(t.silenceNothing);
      return;
    }

    // сдвигаем субтитры, чтобы остались на своих словах
    const nextWords =
      leadTrim > 0
        ? words.map((w) => ({
            ...w,
            startMs: Math.max(w.startMs - leadTrim, 0),
            endMs: Math.max(w.endMs - leadTrim, MIN_SHIFTED_MS),
          }))
        : words;

    setClips(next);
    setWords(nextWords);
    setSelectedWordIds(new Set());
    scheduleSave({ clips: next, words: nextWords });
    setSilenceMsg(t.silenceTrimmed(leadTrim, tailTrim));
  };

  // ── глобальные действия со стилем ──
  const applyStyleToAll = useCallback(async () => {
    await fetch("/api/projects/apply-style", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ styleId, overrides }),
    });
    await refresh();
  }, [styleId, overrides, refresh]);

  const saveStyleDefaults = useCallback(async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultStyleId: styleId, defaultOverrides: overrides }),
    });
    setDefaultOverrides(overrides);
  }, [styleId, overrides]);

  // ── очередь транскрибации: не больше 2 одновременно ──
  const pumpTranscribe = useCallback(() => {
    const MAX_PARALLEL = 2;
    while (
      activeTranscribesRef.current < MAX_PARALLEL &&
      transcribeQueueRef.current.length > 0
    ) {
      const p = transcribeQueueRef.current.shift()!;
      activeTranscribesRef.current++;
      fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, language }),
      })
        .catch(() => {})
        .finally(() => {
          activeTranscribesRef.current--;
          refresh().catch(() => {});
          pumpTranscribe();
        });
    }
  }, [language, refresh]);

  // ── загрузка файлов: пачками, чтобы не держать всё в памяти ──
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) =>
        /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name)
      );
      if (list.length === 0) return;
      const BATCH = 3;
      setUploading(`0/${list.length}`);
      try {
        const createdAll: Project[] = [];
        for (let i = 0; i < list.length; i += BATCH) {
          const batch = list.slice(i, i + BATCH);
          const formData = new FormData();
          for (const f of batch) formData.append("files", f);
          try {
            const res = await fetch("/api/upload", { method: "POST", body: formData });
            const data = (await res.json()) as {
              created: Project[];
              errors?: { name: string; error: string }[];
            };
            if (data.errors?.length) console.warn("Upload errors:", data.errors);
            createdAll.push(...data.created);
            transcribeQueueRef.current.push(...data.created);
            pumpTranscribe();
          } catch (err) {
            console.warn("Upload batch failed:", batch.map((f) => f.name), err);
          }
          setUploading(`${Math.min(i + BATCH, list.length)}/${list.length}`);
          if (i === 0 || (i / BATCH) % 5 === 0) await refresh();
        }
        await refresh();
        if (createdAll.length > 0 && !selectedIdRef.current) {
          selectProject(createdAll[0]);
        }
      } finally {
        setUploading(null);
      }
    },
    [language, refresh, selectProject, pumpTranscribe]
  );

  // ── новый монтаж: все выбранные файлы → один проект встык ──
  const uploadMontage = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) =>
        /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp)$/i.test(f.name)
      );
      if (list.length === 0) return;
      setUploading(`0/${list.length}`);
      try {
        const formData = new FormData();
        for (const f of list) formData.append("files", f);
        const res = await fetch("/api/upload?mode=montage", {
          method: "POST",
          body: formData,
        });
        const data = (await res.json()) as {
          created?: Project[];
          errors?: { name: string; error: string }[];
        };
        if (data.errors?.length) console.warn("Montage upload errors:", data.errors);
        await refresh();
        if (data.created?.[0]) {
          selectProject(data.created[0]);
          transcribeQueueRef.current.push(data.created[0]);
          pumpTranscribe();
        }
      } finally {
        setUploading(null);
      }
    },
    [refresh, selectProject, pumpTranscribe]
  );

  // ── добавить клипы (ендкард/дисклеймер) в текущий проект ──
  const appendClips = useCallback(
    async (files: FileList | File[]) => {
      const id = selectedIdRef.current;
      if (!id) return;
      const list = Array.from(files).filter((f) =>
        /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp)$/i.test(f.name)
      );
      if (list.length === 0) return;
      setUploading(`0/${list.length}`);
      try {
        const formData = new FormData();
        for (const f of list) formData.append("files", f);
        const res = await fetch(`/api/upload?projectId=${id}`, {
          method: "POST",
          body: formData,
        });
        const data = (await res.json()) as { project?: Project };
        if (data.project) {
          setClips(data.project.clips ?? null);
        }
        await refresh();
      } finally {
        setUploading(null);
      }
    },
    [refresh]
  );

  const transcribe = async (id: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: "transcribing" as const } : p))
    );
    if (id === selectedIdRef.current) setWords([]);
    await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, language }),
    }).catch(() => {});
    await refresh();
  };

  const render = async (id: string) => {
    await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await refresh();
  };

  const renderAll = async () => {
    const ready = projects.filter(
      (p) => (p.status === "ready" || p.status === "done") && p.words?.length
    );
    for (const p of ready) await render(p.id);
  };

  const removeProject = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!confirm(t.confirmDelete)) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (selectedIdRef.current === id) {
      selectedIdRef.current = null;
      setSelectedId(null);
    }
    await refresh();
  };

  // ── массовое удаление проектов ──
  const toggleRailSelected = (id: string) => {
    setRailSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteRailSelected = async () => {
    if (railSelected.size === 0) return;
    if (!confirm(t.confirmDeleteMany(railSelected.size))) return;
    await fetch("/api/projects", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(railSelected) }),
    });
    if (selectedIdRef.current && railSelected.has(selectedIdRef.current)) {
      selectedIdRef.current = null;
      setSelectedId(null);
    }
    setRailSelected(new Set());
    setRailSelectMode(false);
    await refresh();
  };

  const seek = (ms: number) => {
    playerRef.current?.seekTo(Math.round((ms / 1000) * FPS));
    playerRef.current?.pause();
    setCurrentMs(ms);
  };

  const resolved = resolveStyle(styleId, overrides);
  const pages = useMemo(
    () => groupWordsIntoPages(words, resolved.maxWordsPerPage),
    [words, resolved.maxWordsPerPage]
  );

  // в баннере панели показываем количество ФРАЗ, а не слов
  const selectedPhraseCount = useMemo(
    () =>
      pages.filter((p) => p.words.some((w) => selectedWordIds.has(w.id))).length,
    [pages, selectedWordIds]
  );

  const renderableCount = projects.filter(
    (p) => (p.status === "ready" || p.status === "done") && p.words?.length
  ).length;

  return (
    <div
      className="shell"
      onDragOver={(e) => {
        e.preventDefault();
        setDragover(true);
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragover(false);
        uploadFiles(e.dataTransfer.files);
      }}
    >
      {/* ───── верхняя панель ───── */}
      <header className="topbar">
        <div className="logo">
          ТИТ<em>РИ</em>
          <span className="logo-sub">deepgram × nvenc</span>
        </div>
        <div className="topbar-spacer" />
        <div className="locale-toggle">
          <button
            className={locale === "uk" ? "on" : ""}
            onClick={() => switchLocale("uk")}
          >
            UA
          </button>
          <button
            className={locale === "en" ? "on" : ""}
            onClick={() => switchLocale("en")}
          >
            EN
          </button>
        </div>
        <button
          className="btn"
          style={{ position: "relative" }}
          onClick={() => setSettingsOpen(true)}
          title={t.settingsTitle}
        >
          ⚙
          {hasKey === false && <span className="warn-dot" />}
        </button>
        <select
          className="select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          title={t.speechLanguage}
        >
          <option value="auto">{t.langAuto}</option>
          <option value="uk">{t.langUk}</option>
          <option value="en">{t.langEn}</option>
        </select>
        <button
          className="btn"
          onClick={() => montageInputRef.current?.click()}
          disabled={!!uploading}
          title={t.addClipsHint}
        >
          {t.newMontage}
        </button>
        <button
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={!!uploading}
        >
          {uploading ? `${t.uploading} ${uploading}` : t.addVideos}
        </button>
        <button
          className="btn btn-accent"
          onClick={renderAll}
          disabled={renderableCount === 0}
        >
          {t.renderAll} ({renderableCount})
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,.mp4,.mov,.webm,.mkv"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={montageInputRef}
          type="file"
          accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) uploadMontage(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={clipsInputRef}
          type="file"
          accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) appendClips(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={musicInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) uploadMusic(e.target.files);
            e.target.value = "";
          }}
        />
      </header>

      <div className="workspace">
        {/* ───── список проектов ───── */}
        <aside className="rail">
          <div className="rail-head">
            <span className="rail-title">
              {t.videos} — {projects.length}
            </span>
            <div style={{ flex: 1 }} />
            {projects.length > 0 && !railSelectMode && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setRailSelectMode(true)}
              >
                {t.selectMode}
              </button>
            )}
            {railSelectMode && (
              <>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() =>
                    setRailSelected((prev) =>
                      prev.size === projects.length
                        ? new Set()
                        : new Set(projects.map((p) => p.id))
                    )
                  }
                >
                  {t.selectAll}
                </button>
                <button
                  className="btn btn-sm"
                  style={{ color: "var(--danger)" }}
                  disabled={railSelected.size === 0}
                  onClick={deleteRailSelected}
                >
                  {t.deleteSelectedProjects(railSelected.size)}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setRailSelectMode(false);
                    setRailSelected(new Set());
                  }}
                >
                  ✕
                </button>
              </>
            )}
          </div>
          <div className="rail-list">
            {projects.map((p) => (
              <div
                key={p.id}
                className={`project-card ${p.id === selectedId ? "selected" : ""} ${railSelectMode && railSelected.has(p.id) ? "checked" : ""}`}
                onClick={() =>
                  railSelectMode ? toggleRailSelected(p.id) : selectProject(p)
                }
              >
                {railSelectMode && (
                  <span
                    className={`rail-check ${railSelected.has(p.id) ? "on" : ""}`}
                  >
                    {railSelected.has(p.id) ? "✓" : ""}
                  </span>
                )}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="project-thumb"
                  src={`/api/file/thumbs/${p.id}.jpg`}
                  alt=""
                  onError={(e) =>
                    ((e.target as HTMLImageElement).style.visibility = "hidden")
                  }
                />
                <div className="project-info">
                  <span className="project-name">
                    {p.clips && p.clips.length > 1 ? "🎬 " : ""}
                    {p.name}
                  </span>
                  <span className="project-meta">
                    {p.video.width}×{p.video.height} · {formatTimestamp(p.video.durationMs)}
                    {p.clips && p.clips.length > 1
                      ? ` · ${t.clipsCount(p.clips.length)}`
                      : ""}
                  </span>
                  <span className="status-chip">
                    <span className={`status-dot ${p.status}`} />
                    {p.status === "rendering" && p.renderProgress
                      ? t.renderPct(Math.round(p.renderProgress * 100))
                      : STATUS_LABELS[p.status]}
                  </span>
                </div>
                {!railSelectMode && (
                  <button
                    className="card-delete"
                    title={t.deleteProjectTitle}
                    onClick={(e) => removeProject(p.id, e)}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {projects.length === 0 && (
              <p className="hint" style={{ padding: "8px 6px" }}>
                {t.railEmpty}
              </p>
            )}
          </div>
        </aside>

        {/* ───── сцена ───── */}
        <main className="stage">
          {selected && (
            <div className="stage-head">
              <input
                className="name-input"
                value={projectName}
                spellCheck={false}
                placeholder={t.renderNamePlaceholder}
                title={t.renderNameTitle}
                onChange={(e) => handleNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
              <span className="hint render-name-hint">
                → {renderFileNamePreview}_subtitled.mp4
              </span>
            </div>
          )}
          <div className="stage-canvas">
            {selected ? (
              <PreviewPlayer
                project={selected}
                words={words}
                styleId={styleId}
                overrides={overrides}
                clips={clips}
                music={music}
                playerRef={playerRef}
              />
            ) : (
              <div className="stage-empty">
                <div
                  className={`dropzone ${dragover ? "dragover" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="stage-empty-title">{t.dropTitle}</div>
                  <p className="hint" style={{ whiteSpace: "pre-line" }}>
                    {t.dropHint}
                  </p>
                  <span className="btn btn-accent">{t.chooseFiles}</span>
                </div>
              </div>
            )}
          </div>

          {/* таймлайн */}
          {selected && (pages.length > 0 || (clips && clips.length > 0)) && (
            <Timeline
              t={t}
              words={words}
              maxWordsPerPage={resolved.maxWordsPerPage}
              durationMs={timelineDurationMs}
              currentMs={currentMs}
              selectedWordIds={selectedWordIds}
              clips={clips}
              music={music}
              onWordsChange={handleWordsChange}
              onSelectionChange={setSelectedWordIds}
              onDeleteSelected={deleteSelectedPhrases}
              onClipsChange={handleClipsChange}
              onSeek={seek}
            />
          )}
        </main>

        {/* ───── правая панель ───── */}
        <aside className="panel">
          {selected ? (
            <>
              <div className="tabs">
                <button
                  className={`tab ${tab === "style" ? "active" : ""}`}
                  onClick={() => setTab("style")}
                >
                  {t.tabStyle}
                </button>
                <button
                  className={`tab ${tab === "text" ? "active" : ""}`}
                  onClick={() => setTab("text")}
                >
                  {t.tabText}
                </button>
              </div>
              <div className="panel-body">
                {selected.status === "error" && selected.error && (
                  <div className="error-box">{selected.error}</div>
                )}

                {selected.status === "transcribing" && (
                  <div className="hint">{t.transcribingHint}</div>
                )}

                {tab === "style" ? (
                  <StylePanel
                    t={t}
                    styleId={panelStyleId}
                    overrides={panelOverrides}
                    selectionCount={selectedPhraseCount}
                    selectionHasStyle={!!selectionStyle}
                    onStyleChange={handleStyleChange}
                    onOverridesChange={handleOverridesChange}
                    onClearSelection={() => setSelectedWordIds(new Set())}
                    onResetSegmentStyle={() => applyStyleToSelection(null)}
                    onApplyToAll={applyStyleToAll}
                    onSaveDefaults={saveStyleDefaults}
                  />
                ) : (
                  <CaptionEditor
                    t={t}
                    words={words}
                    maxWordsPerPage={resolved.maxWordsPerPage}
                    currentMs={currentMs}
                    onWordsChange={handleWordsChange}
                    onSeek={seek}
                  />
                )}

                <div className="divider" />

                {/* ── монтаж: клипы, тиша, музыка ── */}
                <div className="section-label">{t.montageSection}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => clipsInputRef.current?.click()}
                    disabled={!!uploading}
                  >
                    {t.addClips}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={deleteSilence}
                    title={t.deleteSilenceTitle}
                    disabled={selected.status === "transcribing"}
                  >
                    {t.deleteSilence}
                  </button>
                  {silenceMsg && <p className="hint">{silenceMsg}</p>}
                </div>

                <div style={{ height: 14 }} />
                <div className="section-label">{t.musicSection}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <select
                      className="select"
                      style={{ flex: 1, minWidth: 0 }}
                      value={music?.trackId ?? ""}
                      onChange={(e) => {
                        const track = musicTracks.find((m) => m.id === e.target.value);
                        setProjectMusic(track ?? null);
                      }}
                    >
                      <option value="">{t.musicNone}</option>
                      {musicTracks.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} · {formatTimestamp(m.durationMs)}
                        </option>
                      ))}
                    </select>
                    {music && (
                      <button
                        className="btn btn-sm btn-ghost"
                        title={t.musicDeleteFromLibrary}
                        onClick={() => deleteMusicFromLibrary(music.trackId)}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                  {music && (
                    <div className="control-row">
                      <span className="control-label">{t.musicVolume}</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={music.volume}
                        onChange={(e) => setMusicVolume(Number(e.target.value))}
                      />
                      <span className="control-value">
                        {Math.round(music.volume * 100)}%
                      </span>
                    </div>
                  )}
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => musicInputRef.current?.click()}
                  >
                    {t.musicUpload}
                  </button>
                </div>

                <div className="divider" />

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {selected.status === "rendering" && (
                    <div className="control-row">
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.round((selected.renderProgress ?? 0) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="control-value">
                        {Math.round((selected.renderProgress ?? 0) * 100)}%
                      </span>
                    </div>
                  )}

                  <button
                    className="btn btn-accent"
                    onClick={() => render(selected.id)}
                    disabled={
                      words.length === 0 ||
                      selected.status === "rendering" ||
                      selected.status === "transcribing"
                    }
                  >
                    {selected.status === "rendering" ? t.rendering : t.renderVideo}
                  </button>

                  {selected.status === "done" && selected.renderFile && (
                    <>
                      <a
                        className="btn"
                        style={{ justifyContent: "center", textDecoration: "none" }}
                        href={`/api/download?id=${selected.id}`}
                      >
                        {t.downloadResult}
                      </a>
                      {typeof window !== "undefined" && window.titryNative && (
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            window.titryNative?.showInFolder(selected.renderFile!)
                          }
                        >
                          {t.showInFolder}
                        </button>
                      )}
                    </>
                  )}

                  <button
                    className="btn btn-sm"
                    onClick={() => transcribe(selected.id)}
                    disabled={selected.status === "transcribing"}
                  >
                    {words.length === 0 ? t.transcribe : t.retranscribe}
                  </button>

                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--danger)" }}
                    onClick={() => removeProject(selected.id)}
                  >
                    {t.deleteProject}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="panel-body">
              <div className="section-label">{t.howItWorks}</div>
              <p className="hint" style={{ whiteSpace: "pre-line" }}>
                {t.howItWorksText}
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* ───── настройки ───── */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{t.settingsTitle}</div>

            <div>
              <div className="section-label">{t.deepgramKey}</div>
              {hasKey && maskedKey ? (
                <p className="key-badge" style={{ marginBottom: 8 }}>
                  ● {t.keySet} {maskedKey}
                </p>
              ) : (
                <p className="hint" style={{ marginBottom: 8, color: "var(--danger)" }}>
                  {t.keyMissing}
                </p>
              )}
              <input
                className="text-input"
                type="password"
                placeholder={hasKey ? t.keyReplacePlaceholder : t.keyPlaceholder}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <p className="hint" style={{ marginTop: 8 }}>
                {t.keyHintPrefix}{" "}
                <a
                  href="https://console.deepgram.com/"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  console.deepgram.com
                </a>{" "}
                {t.keyHintSuffix}
              </p>
            </div>

            <div>
              <div className="section-label">{t.outputFolder}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="text-input"
                  type="text"
                  placeholder={t.outputFolderPlaceholder}
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                />
                {typeof window !== "undefined" && window.titryNative && (
                  <button className="btn" onClick={browseFolder}>
                    {t.browse}
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="section-label">{t.renderSection}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="hint" style={{ flex: 1 }}>{t.parallelRenders}</span>
                  <select
                    className="select"
                    value={parallelRenders}
                    onChange={(e) => setParallelRenders(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="hint" style={{ flex: 1 }}>{t.encoderLabel}</span>
                  <select
                    className="select"
                    value={encoder}
                    onChange={(e) => setEncoder(e.target.value)}
                  >
                    <option value="auto">{t.encoderAuto}</option>
                    <option value="nvenc">{t.encoderNvenc}</option>
                    <option value="cpu">{t.encoderCpu}</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="hint" style={{ flex: 1 }}>{t.engineLabel}</span>
                  <select
                    className="select"
                    value={renderEngine}
                    onChange={(e) => setRenderEngine(e.target.value)}
                  >
                    <option value="native">{t.engineNative}</option>
                    <option value="chrome">{t.engineChrome}</option>
                  </select>
                </div>
                <p className="hint">{t.parallelHint}</p>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setSettingsOpen(false)}>
                {t.close}
              </button>
              <button
                className="btn btn-accent"
                onClick={saveSettings}
                disabled={savingSettings}
              >
                {savingSettings ? t.saving : t.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
