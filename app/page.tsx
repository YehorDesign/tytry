"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PlayerRef } from "@remotion/player";
import { CaptionEditor } from "@/components/CaptionEditor";
import { PanelCard } from "@/components/PanelCard";
import { StylePanel } from "@/components/StylePanel";
import { Timeline } from "@/components/Timeline";
import { formatTimestamp, groupWordsIntoPages } from "@/lib/captions";
import { STRINGS, getLocale, setLocale, type Locale } from "@/lib/i18n";
import type { BatchPreset } from "@/lib/batch/types";
import { buildIterationProject } from "@/lib/iterations";
import { getClips, projectDurationMs, remapWordsToClips } from "@/lib/montage";
import {
  OVERLAY_MAX_SIZE_RATIO,
  OVERLAY_MIN_SIZE_RATIO,
  newOverlayId,
} from "@/lib/overlays";
import {
  computeClipTrims,
  shiftWordsByTrims,
  totalTrimMs,
  trimmedClipCount,
} from "@/lib/silence";
import { resolveStyle } from "@/lib/styles";
import {
  clipDurationMs,
  clipSpeed,
  totalClipsDurationMs,
  type Disclaimer,
  type MusicTrack,
  type Project,
  type ProjectMusic,
  type StyleOverrides,
  type HookClip,
  type TextOverlay,
  type TimelineClip,
  type Word,
  type WordStyle,
} from "@/lib/types";

const PreviewPlayer = dynamic(
  () => import("@/components/PreviewPlayer").then((m) => m.PreviewPlayer),
  { ssr: false }
);

const FPS = 30;

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
  const [maxSizeMb, setMaxSizeMb] = useState(0); // 0 = без лимита
  const [savingSettings, setSavingSettings] = useState(false);

  // локальное (редактируемое) состояние выбранного проекта
  const [projectName, setProjectName] = useState("");
  const [words, setWords] = useState<Word[]>([]);
  const [styleId, setStyleId] = useState("hormozi");
  const [overrides, setOverrides] = useState<StyleOverrides>({});
  const [clips, setClips] = useState<TimelineClip[] | null>(null);
  const [music, setMusic] = useState<ProjectMusic | null>(null);
  const [disclaimer, setDisclaimer] = useState<Disclaimer | null>(null);
  const [overlays, setOverlays] = useState<TextOverlay[] | null>(null);
  // выбранная текст-плашка (панель + рамка на превью)
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  // глобальные правки «по умолчанию» — подставляются при смене пресета и для новых видео
  const [defaultOverrides, setDefaultOverrides] = useState<StyleOverrides>({
    fontFamily: "Gilroy",
  });

  // выделение фраз на таймлайне (по id слов)
  const [selectedWordIds, setSelectedWordIds] = useState<Set<string>>(new Set());
  // выбранный клип (панель «Кадр»: зум/позиция)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // мультивыбор проектов в списке
  const [railSelectMode, setRailSelectMode] = useState(false);
  const [railSelected, setRailSelected] = useState<Set<string>>(new Set());

  // режим «итерация»: ЛКМ = дубль клипа в хук, ПКМ = перенос (по порядку выбора)
  const [hookMode, setHookMode] = useState(false);
  const [hookSelection, setHookSelection] = useState<HookClip[]>([]);
  const [iterPreviewId, setIterPreviewId] = useState<string | null>(null);
  /** итерация, выбранная в ленте слева — показывается в сцене вместо проекта */
  const [railIterId, setRailIterId] = useState<string | null>(null);

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
  /** итерация из ленты: показываем её видео в сцене вместо проекта */
  // превью итерации доступно в ЛЮБОМ статусе (черновик — до рендера)
  const railIter =
    (railIterId ? selected?.iterations?.find((i) => i.id === railIterId) : null) ?? null;

  // проект-вариант итерации для живого превью: хук + текущее состояние редактора
  const railIterProject = useMemo(() => {
    if (!railIter || !selected) return null;
    try {
      return buildIterationProject(
        {
          ...selected,
          words,
          clips: clips ?? undefined,
          music,
          overlays: overlays ?? undefined,
          disclaimer,
          styleId,
          overrides,
        },
        railIter
      );
    } catch {
      return null; // клипы хука удалены из проекта — превью невозможно
    }
  }, [railIter, selected, words, clips, music, overlays, disclaimer, styleId, overrides]);

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
  // Ответ сравнивается с прошлым: без изменений — НЕ трогаем состояние,
  // иначе каждые 2с перерисовывалось всё дерево (плеер, таймлайн, панель) —
  // клики по пресетам/музыке попадали в эти перерисовки и подлагивали.
  const lastProjectsJson = useRef("");
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const text = await res.text();
      if (text === lastProjectsJson.current) return;
      lastProjectsJson.current = text;
      const data = JSON.parse(text) as { projects: Project[] };
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

  // ── батч-пресеты: быстрые настройки (стиль+дисклеймер+музыка+ендкард) ──
  const [projPresets, setProjPresets] = useState<BatchPreset[]>([]);
  const [applyPresetId, setApplyPresetId] = useState("");
  const [applyingPreset, setApplyingPreset] = useState(false);
  useEffect(() => {
    fetch("/api/presets")
      .then((r) => r.json())
      .then((d) => setProjPresets(d.presets ?? []))
      .catch(() => {});
  }, []);

  // ── пресеты вариаций: схема итераций по номерам сцен ──
  type IterPreset = {
    id: string;
    name: string;
    createdAt: string;
    iterations: { clips: { scene: number; move?: boolean }[] }[];
  };
  const [iterPresets, setIterPresets] = useState<IterPreset[]>([]);
  /** контекстное меню карточки проекта (ПКМ в ленте) */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; projectId: string } | null>(
    null
  );
  /** режим ввода имени внутри меню (prompt() в Electron не работает) */
  const [ctxNaming, setCtxNaming] = useState<{
    kind: "iter" | "montage" | "folder";
    name: string;
  } | null>(null);
  const closeCtxMenu = () => {
    setCtxMenu(null);
    setCtxNaming(null);
  };

  // ── папки в ленте + архив ──
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      return new Set(JSON.parse(localStorage.getItem("tytry-folders-collapsed") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [archiveOpen, setArchiveOpen] = useState(false);
  const toggleFolder = (name: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem("tytry-folders-collapsed", JSON.stringify([...next]));
      return next;
    });
  };

  const patchProjects = async (
    targets: Project[],
    patch: { folder?: string | null; archived?: boolean }
  ) => {
    for (const p of targets) {
      await fetch(`/api/projects/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    }
    await refresh();
  };

  /** меню папки (ПКМ по заголовку): переименовать / расформировать */
  const [folderMenu, setFolderMenu] = useState<{
    x: number;
    y: number;
    name: string;
    renaming: string | null;
  } | null>(null);

  const renameFolder = async (oldName: string, newName: string) => {
    const clean = newName.trim().slice(0, 40);
    if (!clean || clean === oldName) return;
    await patchProjects(
      projects.filter((p) => p.folder === oldName),
      { folder: clean }
    );
    // состояние «свёрнута» переезжает вместе с папкой
    setCollapsedFolders((prev) => {
      if (!prev.has(oldName)) return prev;
      const next = new Set(prev);
      next.delete(oldName);
      next.add(clean);
      localStorage.setItem("tytry-folders-collapsed", JSON.stringify([...next]));
      return next;
    });
  };
  const refreshIterPresets = useCallback(async () => {
    try {
      const d = await (await fetch("/api/iter-presets")).json();
      setIterPresets(d.presets ?? []);
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    refreshIterPresets();
  }, [refreshIterPresets]);

  // ── пресеты монтажа: порядок/удаление сцен + границы относительно озвучки ──
  type MontagePreset = {
    id: string;
    name: string;
    createdAt: string;
    /** число слов озвучки оригинала — для точной пословной привязки */
    voWords?: number;
    scenes: {
      num: number;
      endFrac?: number;
      /** позиция конца сцены на «ломаной слов» (точнее, чем endFrac) */
      endWord?: number;
      inFrac?: number;
      zoom?: number;
      panX?: number;
      panY?: number;
      speed?: number;
    }[];
  };
  const [montagePresets, setMontagePresets] = useState<MontagePreset[]>([]);
  const refreshMontagePresets = useCallback(async () => {
    try {
      const d = await (await fetch("/api/montage-presets")).json();
      setMontagePresets(d.presets ?? []);
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    refreshMontagePresets();
  }, [refreshMontagePresets]);

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
        maxSizeMb?: number;
        defaultOverrides?: StyleOverrides;
      };
      setHasKey(data.hasDeepgramKey);
      setMaskedKey(data.maskedKey);
      setOutputDir(data.outputDir);
      setParallelRenders(data.parallelRenders ?? 3);
      setEncoder(data.encoder ?? "auto");
      setRenderEngine(data.renderEngine ?? "native");
      setMaxSizeMb(data.maxSizeMb ?? 0);
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
        maxSizeMb,
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
    setDisclaimer(project.disclaimer ?? null);
    setOverlays(project.overlays && project.overlays.length > 0 ? project.overlays : null);
    setSelectedWordIds(new Set());
    setSelectedClipId(null);
    setSelectedOverlayId(null);
    setSilenceMsg(null);
    setHookMode(false);
    setHookSelection([]);
    setIterPreviewId(null);
    setRailIterId(null);
    setCurrentMs(0);
    // история undo — своя у каждого проекта
    undoStack.current = [];
    redoStack.current = [];
    lastPushAt.current = 0;
  }, []);

  // ── открытие проекта по ссылке (кнопка «Таймлайн» на батч-странице) ──
  const pendingUrlProject = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (pendingUrlProject.current === undefined) {
      pendingUrlProject.current = new URLSearchParams(window.location.search).get(
        "project"
      );
    }
    const wanted = pendingUrlProject.current;
    if (!wanted) return;
    const project = projects.find((p) => p.id === wanted);
    if (project) {
      pendingUrlProject.current = null;
      selectProject(project);
      window.history.replaceState(null, "", "/");
    }
  }, [projects, selectProject]);

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

  // ── undo/redo таймлайна (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y), как в монтажках ──
  // Снимки состояния {words, clips, music, overlays} ПЕРЕД каждой правкой.
  // historyNow — всегда свежее состояние (обходит устаревшие замыкания useCallback).
  const historyNow = useRef({ words, clips, music, overlays });
  historyNow.current = { words, clips, music, overlays };
  const undoStack = useRef<(typeof historyNow.current)[]>([]);
  const redoStack = useRef<(typeof historyNow.current)[]>([]);
  const lastPushAt = useRef(0);

  /** Зови ПЕРЕД мутацией. Быстрые серии правок (набор текста, слайдеры)
   *  склеиваются в один шаг undo (окно 800мс). */
  const pushHistory = useCallback(() => {
    const now = Date.now();
    if (now - lastPushAt.current < 800 && undoStack.current.length > 0) {
      lastPushAt.current = now;
      return;
    }
    lastPushAt.current = now;
    undoStack.current.push({ ...historyNow.current });
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
  }, []);

  const restoreSnapshot = useCallback(
    (snap: typeof historyNow.current) => {
      setWords(snap.words);
      setClips(snap.clips);
      setMusic(snap.music);
      setOverlays(snap.overlays);
      setSelectedWordIds(new Set());
      setSelectedClipId(null);
      setSelectedOverlayId(null);
      scheduleSave({
        words: snap.words,
        clips: snap.clips,
        music: snap.music,
        overlays: snap.overlays ?? [],
      });
    },
    [scheduleSave]
  );

  const undoTimeline = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current.push({ ...historyNow.current });
    lastPushAt.current = 0; // правка после undo — уже новый шаг
    restoreSnapshot(snap);
  }, [restoreSnapshot]);

  const redoTimeline = useCallback(() => {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current.push({ ...historyNow.current });
    lastPushAt.current = 0;
    restoreSnapshot(snap);
  }, [restoreSnapshot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      const el = e.target as HTMLElement;
      // в полях ввода работает нативный undo браузера
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      )
        return;
      e.preventDefault();
      if (k === "y" || (k === "z" && e.shiftKey)) redoTimeline();
      else undoTimeline();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoTimeline, redoTimeline]);

  const handleWordsChange = (next: Word[]) => {
    pushHistory();
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
    pushHistory();
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
      pushHistory();
      setWords((prev) => {
        const next = prev.filter((w) => !sel.has(w.id));
        scheduleSave({ words: next });
        return next;
      });
      return new Set();
    });
  }, [scheduleSave, pushHistory]);

  // ── текст-плашки (TikTok) ──
  const handleOverlaysChange = useCallback(
    (next: TextOverlay[]) => {
      pushHistory();
      setOverlays(next.length > 0 ? next : null);
      scheduleSave({ overlays: next });
    },
    [scheduleSave, pushHistory]
  );

  const addOverlay = () => {
    if (!selected) return;
    const total = timelineDurationMs || 3000;
    const start = Math.min(Math.max(Math.round(currentMs), 0), Math.max(total - 500, 0));
    const end = Math.max(Math.min(start + 2500, total), start + 500);
    const ov: TextOverlay = {
      id: newOverlayId(),
      text: t.overlayDefaultText,
      startMs: start,
      endMs: end,
      y: 0.4,
      sizeRatio: 0.042,
    };
    handleOverlaysChange([...(overlays ?? []), ov]);
    setSelectedOverlayId(ov.id);
    seek(start);
  };

  const selectedOverlay = overlays?.find((o) => o.id === selectedOverlayId) ?? null;

  const updateSelectedOverlay = (patch: Partial<TextOverlay>) => {
    if (!overlays || !selectedOverlayId) return;
    handleOverlaysChange(
      overlays.map((o) => (o.id === selectedOverlayId ? { ...o, ...patch } : o))
    );
  };

  const deleteOverlay = useCallback(
    (id: string) => {
      pushHistory();
      setOverlays((prev) => {
        const next = (prev ?? []).filter((o) => o.id !== id);
        scheduleSave({ overlays: next });
        return next.length > 0 ? next : null;
      });
      setSelectedOverlayId((cur) => (cur === id ? null : cur));
    },
    [scheduleSave, pushHistory]
  );

  // Delete/Backspace удаляет выделенную плашку или выделенные фразы
  // (если фокус не в поле ввода)
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
      if (selectedOverlayId) {
        deleteOverlay(selectedOverlayId);
        return;
      }
      deleteSelectedPhrases();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelectedPhrases, selectedOverlayId, deleteOverlay]);

  // ── клипы монтажа: субтитры едут вместе с клипами ──
  // (кроме слов из музыки — они привязаны к треку, а не к клипам)
  const handleClipsChange = (next: TimelineClip[]) => {
    pushHistory();
    const base = clips ?? (selected ? getClips(selected) : null);
    const speech = words.filter((w) => !w.fromMusic);
    if (base && speech.length > 0) {
      const remapped = remapWordsToClips(speech, base, next);
      if (remapped !== speech) {
        const nextWords = [...remapped, ...words.filter((w) => w.fromMusic)].sort(
          (a, b) => a.startMs - b.startMs
        );
        setWords(nextWords);
        setClips(next);
        scheduleSave({ clips: next, words: nextWords });
        return;
      }
    }
    setClips(next);
    scheduleSave({ clips: next });
  };

  // ── «Кадр»: зум/позиция выбранного клипа ──
  // у классического проекта клип один — берём его без выбора на таймлайне
  const frameClips = clips ?? (selected ? getClips(selected) : null);
  const frameClip = frameClips
    ? clips
      ? frameClips.find((c) => c.id === selectedClipId) ??
        (frameClips.length === 1 ? frameClips[0] : null)
      : frameClips[0]
    : null;

  const updateFrame = (
    patch: Partial<Pick<TimelineClip, "zoom" | "panX" | "panY" | "speed">>
  ) => {
    if (!frameClips || !frameClip) return;
    const next = frameClips.map((c) =>
      c.id === frameClip.id ? { ...c, ...patch } : c
    );
    handleClipsChange(next);
  };

  // ── пресеты вариаций: сохранить схему / применить к видео (или пачке) ──
  const saveIterPreset = async (p: Project, name: string) => {
    const iters = p.iterations ?? [];
    if (iters.length === 0) return;
    const clipsArr = p.clips && p.clips.length > 0 ? p.clips : getClips(p);
    // итерации → номера сцен (1-based) + тип (move = вырезание)
    const iterations = iters
      .map((it) => {
        const hooks: { id: string; move?: boolean }[] =
          it.hookClips ?? (it.clipIds ?? []).map((cid) => ({ id: cid }));
        return {
          clips: hooks
            .map((h) => ({
              scene: clipsArr.findIndex((c) => c.id === h.id) + 1,
              ...(h.move ? { move: true } : {}),
            }))
            .filter((c) => c.scene >= 1),
        };
      })
      .filter((it) => it.clips.length > 0);
    if (iterations.length === 0) {
      alert(t.iterPresetNothing);
      return;
    }
    await fetch("/api/iter-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, iterations }),
    }).catch(() => {});
    await refreshIterPresets();
  };

  const applyIterPreset = async (
    targets: Project[],
    preset: { iterations: { clips: { scene: number; move?: boolean }[] }[] }
  ) => {
    let created = 0;
    let skipped = 0;
    for (const p of targets) {
      const clipsArr = p.clips && p.clips.length > 0 ? p.clips : getClips(p);
      for (const it of preset.iterations) {
        // сцены по номеру: лишние (за пределами таймлайна) отбрасываются
        const clipsSel = it.clips
          .map((c) => ({ id: clipsArr[c.scene - 1]?.id ?? "", ...(c.move ? { move: true } : {}) }))
          .filter((c) => c.id);
        if (clipsSel.length === 0) {
          skipped++;
          continue;
        }
        try {
          const res = await fetch(`/api/projects/${p.id}/iterate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clips: clipsSel,
              musicOffsetMs: p.music?.offsetMs ?? 0,
              // черновики: рендер — кнопкой «Рендер ітерацій» или «Рендер усіх»
              render: false,
            }),
          });
          if (res.ok) created++;
          else skipped++;
        } catch {
          skipped++;
        }
      }
    }
    await refresh();
    alert(t.iterPresetApplied(created, targets.length, skipped));
  };

  // ── пресеты монтажа ──
  /** номер сцены из имени исходника («03_intro.mp4» → 3); ендкарды не сцены */
  const sceneNum = (c: TimelineClip): number | null => {
    if (c.id.startsWith("endcard-")) return null;
    const m = c.originalName.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  };

  /** озвучка проекта: речь из клипов, а если её нет — текст музыки */
  const voAnchor = (ws: Word[]) => {
    const speech = ws.filter((w) => !w.fromMusic);
    const anchor = speech.length > 0 ? speech : ws;
    if (anchor.length === 0) return null;
    return {
      words: anchor,
      start: Math.min(...anchor.map((w) => w.startMs)),
      end: Math.max(...anchor.map((w) => w.endMs)),
    };
  };

  // «ломаная слов»: монотонные ключевые точки старт/конец каждого слова.
  // Позиция на ломаной переносится между озвучками с РАЗНЫМИ таймингами,
  // но одинаковыми словами — граница сцены попадает в то же слово/паузу.
  const wordLandmarks = (ws: Word[]): number[] => {
    const pts: number[] = [];
    let prev = -Infinity;
    for (const w of [...ws].sort((a, b) => a.startMs - b.startMs)) {
      for (const v of [w.startMs, w.endMs]) {
        const t = Math.max(v, prev);
        pts.push(t);
        prev = t;
      }
    }
    return pts;
  };
  const timeToWordPos = (pts: number[], T: number): number | null => {
    if (pts.length < 2 || T < pts[0] || T > pts[pts.length - 1]) return null;
    for (let i = 0; i < pts.length - 1; i++) {
      if (T <= pts[i + 1]) {
        const seg = pts[i + 1] - pts[i];
        return Math.round((i + (seg > 0 ? (T - pts[i]) / seg : 0)) * 10000) / 10000;
      }
    }
    return pts.length - 1;
  };
  const wordPosToTime = (pts: number[], pos: number): number => {
    const i = Math.max(Math.min(Math.floor(pos), pts.length - 2), 0);
    const frac = Math.min(Math.max(pos - i, 0), 1);
    return Math.round(pts[i] + frac * (pts[i + 1] - pts[i]));
  };

  const saveMontagePreset = async (p: Project, name: string) => {
    const clipsArr = p.clips && p.clips.length > 0 ? p.clips : getClips(p);
    const vo = voAnchor(p.words ?? []);
    const span = vo ? Math.max(vo.end - vo.start, 1) : 0;
    const pts = vo ? wordLandmarks(vo.words) : [];
    let acc = 0;
    const scenes: MontagePreset["scenes"] = [];
    for (const c of clipsArr) {
      acc += clipDurationMs(c);
      const n = sceneNum(c);
      if (n === null) continue;
      const endWord = vo ? timeToWordPos(pts, acc) : null;
      scenes.push({
        num: n,
        ...(vo ? { endFrac: Math.round(((acc - vo.start) / span) * 10000) / 10000 } : {}),
        ...(endWord !== null ? { endWord } : {}),
        ...(c.inMs > 0 && c.sourceDurationMs > 0
          ? { inFrac: Math.round((c.inMs / c.sourceDurationMs) * 10000) / 10000 }
          : {}),
        ...((c.zoom ?? 1) !== 1 ? { zoom: c.zoom } : {}),
        ...((c.panX ?? 0) !== 0 ? { panX: c.panX } : {}),
        ...((c.panY ?? 0) !== 0 ? { panY: c.panY } : {}),
        ...(clipSpeed(c) !== 1 ? { speed: clipSpeed(c) } : {}),
      });
    }
    if (scenes.length === 0) {
      alert(t.mpNothing);
      return;
    }
    await fetch("/api/montage-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, scenes, voWords: vo ? vo.words.length : undefined }),
    }).catch(() => {});
    await refreshMontagePresets();
  };

  const applyMontagePreset = async (targets: Project[], preset: MontagePreset) => {
    let applied = 0;
    let skippedProjects = 0;
    let skippedScenes = 0;
    for (const p of targets) {
      const clipsArr = p.clips && p.clips.length > 0 ? [...p.clips] : getClips(p);
      const byNum = new Map<number, TimelineClip>();
      for (const c of clipsArr) {
        const n = sceneNum(c);
        if (n !== null && !byNum.has(n)) byNum.set(n, c);
      }
      // безномерные клипы (ендкард и т.п.) остаются хвостом как есть
      const tail = clipsArr.filter((c) => sceneNum(c) === null);
      const scenes = preset.scenes.filter((s) => byNum.has(s.num));
      skippedScenes += preset.scenes.length - scenes.length;
      if (scenes.length === 0) {
        skippedProjects++;
        continue;
      }
      const wordsArr = p.words ?? [];
      const speech = wordsArr.filter((w) => !w.fromMusic);
      const musicWords = wordsArr.filter((w) => w.fromMusic);
      // подгонка длительностей по озвучке: только когда озвучка — трек
      // (слова стоят на месте); речь в клипах едет вместе с ними — там
      // применяем только структуру
      const fit =
        speech.length === 0 &&
        musicWords.length > 0 &&
        scenes.every((s) => typeof s.endFrac === "number");
      let newClips: TimelineClip[];
      let newWords = wordsArr;
      if (fit) {
        const vo = voAnchor(musicWords)!;
        const span = Math.max(vo.end - vo.start, 1000);
        // пословная привязка — когда слов столько же, сколько в оригинале
        // (тот же текст, другие тайминги); иначе — пропорция от длительности
        const pts =
          preset.voWords && preset.voWords === vo.words.length
            ? wordLandmarks(vo.words)
            : null;
        let prevEnd = 0;
        newClips = scenes.map((s) => {
          const c = byNum.get(s.num)!;
          // конец сцены — то же слово озвучки (или та же доля); мин. 200мс
          const byWord =
            pts && typeof s.endWord === "number" ? wordPosToTime(pts, s.endWord) : null;
          const targetEnd = Math.max(
            byWord ?? Math.round(vo.start + s.endFrac! * span),
            prevEnd + 200
          );
          const durMs = targetEnd - prevEnd;
          prevEnd = targetEnd;
          const inMs = s.inFrac ? Math.round(s.inFrac * c.sourceDurationMs) : 0;
          let speed = s.speed ?? 1;
          let outMs: number;
          if (c.kind !== "video") {
            // картинка статична — просто длительность
            outMs = Math.min(inMs + durMs, inMs + 120000);
          } else {
            const available = Math.max(c.sourceDurationMs - inMs, 100);
            const needSrc = durMs * speed;
            if (needSrc <= available) {
              // исходника хватает: тримим под нужную длину
              outMs = Math.round(inMs + needSrc);
            } else {
              // исходник короче нужного: не морозим кадр, а ЗАМЕДЛЯЕМ сцену
              speed = Math.max(Math.round((available / durMs) * 10000) / 10000, 0.25);
              // при клампе 0.25 (нужно >4x замедление) остаток доморозится
              outMs = Math.round(inMs + durMs * speed);
            }
          }
          return {
            ...c,
            inMs,
            outMs,
            zoom: s.zoom,
            panX: s.panX,
            panY: s.panY,
            speed: speed !== 1 ? speed : undefined,
          };
        });
        newClips = [...newClips, ...tail];
        // слова из музыки привязаны к треку — не трогаем
      } else {
        newClips = [
          ...scenes.map((s) => {
            const c = byNum.get(s.num)!;
            return { ...c, zoom: s.zoom, panX: s.panX, panY: s.panY, speed: s.speed };
          }),
          ...tail,
        ];
        // речь едет вместе со сценами; слова удалённых сцен пропадают
        const remapped = remapWordsToClips(speech, clipsArr, newClips);
        newWords = [...remapped, ...musicWords].sort((a, b) => a.startMs - b.startMs);
      }
      try {
        const res = await fetch(`/api/projects/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clips: newClips, words: newWords }),
        });
        if (!res.ok) {
          skippedProjects++;
          continue;
        }
        if (p.id === selectedIdRef.current) {
          pushHistory(); // откат Ctrl+Z для открытого проекта
          setClips(newClips);
          setWords(newWords);
          setSelectedClipId(null);
          setSelectedWordIds(new Set());
        }
        applied++;
      } catch {
        skippedProjects++;
      }
    }
    await refresh();
    alert(t.mpApplied(applied, skippedProjects, skippedScenes));
  };

  // применить батч-пресет к открытому проекту (сервер копирует ендкард в uploads)
  const applyProjectPreset = async () => {
    const id = selectedIdRef.current;
    if (!id || !applyPresetId || applyingPreset) return;
    setApplyingPreset(true);
    try {
      const res = await fetch(`/api/projects/${id}/apply-preset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: applyPresetId }),
      });
      const data = (await res.json()) as { project?: Project; error?: string };
      if (res.ok && data.project) {
        pushHistory(); // клипы/музыку можно откатить Ctrl+Z
        const p = data.project;
        setStyleId(p.styleId);
        setOverrides(p.overrides ?? {});
        setDisclaimer(p.disclaimer ?? null);
        setMusic(p.music ?? null);
        setClips(p.clips && p.clips.length > 0 ? p.clips : null);
        await refresh();
      } else if (data.error) {
        alert(data.error);
      }
    } finally {
      setApplyingPreset(false);
    }
  };

  // ── дисклеймер ──
  const updateDisclaimer = (patch: Partial<Disclaimer>) => {
    const next: Disclaimer = {
      text: "",
      sizeRatio: 0.018,
      positionY: 0.96,
      ...disclaimer,
      ...patch,
    };
    const value = next.text.trim() ? next : null;
    setDisclaimer(next.text ? next : null); // пустой текст = дисклеймера нет
    scheduleSave({ disclaimer: value });
  };

  // ── музыка ──
  const setProjectMusic = (track: MusicTrack | null) => {
    pushHistory();
    const sameTrack = track && music?.trackId === track.id;
    const next: ProjectMusic | null = track
      ? {
          trackId: track.id,
          fileName: track.fileName,
          name: track.name,
          volume: music?.volume ?? 0.25,
          offsetMs: sameTrack ? music?.offsetMs ?? 0 : 0,
        }
      : null;
    setMusic(next);
    // трек убрали/сменили — его субтитры больше не соответствуют звуку
    if (!sameTrack && words.some((w) => w.fromMusic)) {
      const nextWords = words.filter((w) => !w.fromMusic);
      setWords(nextWords);
      scheduleSave({ music: next, words: nextWords });
      return;
    }
    scheduleSave({ music: next });
  };

  // сдвиг трека: слова из музыки едут вместе с ним
  const setMusicOffset = (offsetMs: number) => {
    if (!music) return;
    pushHistory();
    const delta = offsetMs - (music.offsetMs ?? 0);
    const next = { ...music, offsetMs };
    setMusic(next);
    if (delta !== 0 && words.some((w) => w.fromMusic)) {
      const nextWords = words.map((w) =>
        w.fromMusic
          ? { ...w, startMs: w.startMs + delta, endMs: w.endMs + delta }
          : w
      );
      setWords(nextWords);
      scheduleSave({ music: next, words: nextWords });
      return;
    }
    scheduleSave({ music: next });
  };

  // ── субтитры из музыки (Deepgram по треку, слова якорятся к музыке) ──
  const [musicTranscribing, setMusicTranscribing] = useState(false);
  const transcribeMusic = async () => {
    const id = selectedIdRef.current;
    if (!id || !music || musicTranscribing) return;
    setMusicTranscribing(true);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, language, source: "music" }),
      });
      const data = (await res.json()) as { project?: Project; error?: string };
      if (data.project?.words) {
        pushHistory();
        setWords(data.project.words);
      }
      await refresh();
    } catch {
      // ошибка видна через статус проекта
    } finally {
      setMusicTranscribing(false);
    }
  };

  const setMusicVolume = (volume: number) => {
    if (!music) return;
    pushHistory();
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

  // ── «прибрати тишу»: тримы по краям КАЖДОГО клипа по таймингам слов ──
  // слова из музыки не считаются речью и остаются на месте (якорь — трек)
  const deleteSilence = () => {
    if (!selected) return;
    const speech = words.filter((w) => !w.fromMusic);
    if (speech.length === 0) {
      setSilenceMsg(t.silenceNeedWords);
      return;
    }
    const base = clips ?? getClips(selected);
    const durations = base.map(clipDurationMs);
    const trims = computeClipTrims(durations, speech);
    const total = totalTrimMs(trims);
    if (total < 1) {
      setSilenceMsg(t.silenceNothing);
      return;
    }
    // тримы посчитаны во времени таймлайна, а inMs/outMs — по исходнику:
    // у ускоренных/замедленных клипов пересчитываем через скорость
    const next = base.map((c, i) => ({
      ...c,
      inMs: c.inMs + trims[i].lead * clipSpeed(c),
      outMs: c.outMs - trims[i].tail * clipSpeed(c),
    }));
    // сдвигаем субтитры, чтобы остались на своих словах
    const shifted = new Map(
      shiftWordsByTrims(speech, durations, trims).map((w) => [w.id, w])
    );
    const nextWords = words.map((w) => (w.fromMusic ? w : shifted.get(w.id) ?? w));

    pushHistory();
    setClips(next);
    setWords(nextWords);
    setSelectedWordIds(new Set());
    scheduleSave({ clips: next, words: nextWords });
    setSilenceMsg(t.silenceTrimmed(total, trimmedClipCount(trims)));
  };

  // ── итерации: хук из выбранных клипов в начало ──
  // повторный клик (любой кнопкой) убирает клип из хука
  const toggleHookClip = (clipId: string, move: boolean) => {
    setHookSelection((prev) =>
      prev.some((h) => h.id === clipId)
        ? prev.filter((h) => h.id !== clipId)
        : [...prev, { id: clipId, move }]
    );
  };

  const startHookMode = () => {
    // классический проект: показываем дорожку клипов (один клип = весь ролик),
    // чтобы было что тыкать — как это делает панель «Кадр» при первой правке
    if (!clips && selected) {
      const base = getClips(selected);
      setClips(base);
      scheduleSave({ clips: base });
    }
    // если в сцене открыта итерация — возвращаем таймлайн, иначе клипы
    // для хука выбирать не по чему
    setRailIterId(null);
    setHookMode(true);
    setHookSelection([]);
    setSelectedClipId(null);
  };

  const cancelHookMode = () => {
    setHookMode(false);
    setHookSelection([]);
  };

  // добавляет итерацию ЧЕРНОВИКОМ — рендер запускается отдельной кнопкой,
  // чтобы можно было набрать несколько вариантов и прорендерить разом
  const renderIteration = async () => {
    const id = selectedIdRef.current;
    if (!id || hookSelection.length === 0) return;
    setHookMode(false);
    const hookClips = hookSelection;
    setHookSelection([]);
    await fetch(`/api/projects/${id}/iterate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // сдвиг музыки снимается на момент создания: у каждой итерации свой
      body: JSON.stringify({
        clips: hookClips,
        musicOffsetMs: music?.offsetMs ?? 0,
        render: false,
      }),
    }).catch(() => {});
    await refresh();
  };

  /** запускает рендер итерации-черновика (или всех черновиков сразу) */
  const renderDraftIteration = async (iterationId: string) => {
    const id = selectedIdRef.current;
    if (!id) return;
    await fetch(`/api/projects/${id}/iterate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ renderIterationId: iterationId }),
    }).catch(() => {});
  };

  const renderAllDrafts = async () => {
    const drafts = (selected?.iterations ?? []).filter((i) => i.status === "draft");
    for (const it of drafts) await renderDraftIteration(it.id);
    await refresh();
  };

  const deleteIteration = async (iterationId: string) => {
    const id = selectedIdRef.current;
    if (!id) return;
    if (!confirm(t.iterDeleteConfirm)) return;
    await fetch(`/api/projects/${id}/iterate`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ iterationId }),
    }).catch(() => {});
    await refresh();
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
        /\.(mp4|mov|webm|mkv|avi|m4v|zip)$/i.test(f.name)
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
        /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp|zip)$/i.test(f.name)
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
        /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp|zip)$/i.test(f.name)
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

  // «Рендер всех»: спрашиваем корневую папку, туда — все видео и их итерации,
  // сгруппированные по подпапкам с именем проекта
  const renderAll = async () => {
    const ready = projects.filter(
      (p) =>
        (p.status === "ready" || p.status === "done") && p.words?.length && !p.archived
    );
    if (ready.length === 0) return;
    let outputRoot: string | undefined;
    if (typeof window !== "undefined" && window.titryNative) {
      const picked = await window.titryNative.pickFolder();
      if (!picked) return; // отмена диалога = ничего не рендерим
      outputRoot = picked;
    }
    for (const p of ready) {
      await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, outputRoot, withIterations: true }),
      }).catch(() => {});
    }
    await refresh();
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
    (p) => (p.status === "ready" || p.status === "done") && p.words?.length && !p.archived
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
        <a className="btn" href="/batch" title={t.batchTitle}>
          {t.batchMode}
        </a>
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
          accept="video/*,.mp4,.mov,.webm,.mkv,.zip"
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
          accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp,.zip"
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
          accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp,.zip"
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
            {(() => {
              const visible = projects.filter((p) => !p.archived);
              const archivedList = projects.filter((p) => p.archived);
              const folderNames = [
                ...new Set(
                  visible.map((p) => p.folder).filter((f): f is string => !!f)
                ),
              ].sort((a, b) => a.localeCompare(b));
              const card = (p: Project) => (
              <React.Fragment key={p.id}>
              <div
                className={`project-card ${p.id === selectedId && !railIterId ? "selected" : ""} ${p.id === selectedId && railIterId ? "iter-open" : ""} ${railSelectMode && railSelected.has(p.id) ? "checked" : ""}`}
                onClick={() => {
                  if (railSelectMode) toggleRailSelected(p.id);
                  else {
                    selectProject(p);
                    setRailIterId(null);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxNaming(null);
                  setCtxMenu({
                    x: Math.min(e.clientX, window.innerWidth - 300),
                    y: e.clientY,
                    projectId: p.id,
                  });
                }}
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
              {/* итерации — мини-подгруппа под основным видео */}
              {!railSelectMode && (p.iterations ?? []).length > 0 && (
                <div className="iter-sub">
                  {(p.iterations ?? []).map((it) => (
                    <div
                      key={it.id}
                      className={`iter-sub-row ${it.status} ${
                        p.id === selectedId && railIterId === it.id ? "active" : ""
                      }`}
                      title={it.status === "error" ? it.error : undefined}
                      onClick={() => {
                        if (p.id !== selectedId) selectProject(p);
                        // просмотр итерации скрывает таймлайн — выходим из
                        // режима выбора клипов, чтобы он не «залипал»
                        setHookMode(false);
                        setHookSelection([]);
                        setRailIterId(it.id);
                      }}
                    >
                      <span className="iter-sub-branch">↳</span>
                      <span className="iter-sub-name">it{it.num}</span>
                      {it.status === "draft" && (
                        <span className="iter-sub-meta">{t.iterDraft}</span>
                      )}
                      {(it.status === "queued" || it.status === "rendering") && (
                        <span className="iter-sub-meta">
                          {it.status === "queued"
                            ? t.batchStatusQueued
                            : `${Math.round(it.progress * 100)}%`}
                        </span>
                      )}
                      {it.status === "error" && (
                        <span className="iter-sub-meta" style={{ color: "var(--danger)" }}>
                          {t.batchStatusError}
                        </span>
                      )}
                      {it.status === "done" && <span className="iter-sub-meta">▶</span>}
                    </div>
                  ))}
                </div>
              )}
              </React.Fragment>
              );
              return (
                <>
                  {/* папки-группы */}
                  {folderNames.map((f) => {
                    const items = visible.filter((p) => p.folder === f);
                    const closed = collapsedFolders.has(f);
                    return (
                      <div key={f}>
                        <button
                          className="rail-folder"
                          onClick={() => toggleFolder(f)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setFolderMenu({
                              x: Math.min(e.clientX, window.innerWidth - 260),
                              y: Math.min(e.clientY, window.innerHeight - 160),
                              name: f,
                              renaming: null,
                            });
                          }}
                        >
                          <span className="rail-folder-name">
                            {closed ? "▸" : "▾"} 📁 {f}
                          </span>
                          <span className="rail-folder-count">{items.length}</span>
                        </button>
                        {!closed && items.map(card)}
                      </div>
                    );
                  })}
                  {/* вне папок */}
                  {visible.filter((p) => !p.folder).map(card)}
                  {/* архив */}
                  {archivedList.length > 0 && (
                    <div>
                      <button
                        className="rail-folder archive"
                        onClick={() => setArchiveOpen((o) => !o)}
                      >
                        <span className="rail-folder-name">
                          {archiveOpen ? "▾" : "▸"} 📦 {t.railArchive}
                        </span>
                        <span className="rail-folder-count">{archivedList.length}</span>
                      </button>
                      {archiveOpen && archivedList.map(card)}
                    </div>
                  )}
                  {projects.length === 0 && (
                    <p className="hint" style={{ padding: "8px 6px" }}>
                      {t.railEmpty}
                    </p>
                  )}
                </>
              );
            })()}
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
                → 📁 {renderFileNamePreview}\{renderFileNamePreview}.mp4
              </span>
            </div>
          )}
          <div className="stage-canvas">
            {selected && railIter && railIterProject ? (
              <div className="iter-stage">
                <div className="iter-stage-head">
                  <span className="iter-stage-name">
                    {selected.name}_it{railIter.num}
                    {railIter.status !== "done" ? ` · ${t.iterDraft}` : ""}
                  </span>
                  {typeof window !== "undefined" && window.titryNative && railIter.file && (
                    <button
                      className="btn btn-sm btn-ghost"
                      title={railIter.file}
                      onClick={() => window.titryNative?.showInFolder(railIter.file!)}
                    >
                      📂
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => setRailIterId(null)}
                  >
                    ✕
                  </button>
                </div>
                {/* живое превью варианта — тот же плеер, что и у оригинала */}
                <PreviewPlayer
                  key={railIter.id}
                  project={railIterProject}
                  words={railIterProject.words ?? []}
                  styleId={styleId}
                  overrides={overrides}
                  clips={railIterProject.clips ?? null}
                  music={railIterProject.music ?? null}
                  disclaimer={railIterProject.disclaimer ?? null}
                  overlays={railIterProject.overlays ?? null}
                  selectedOverlayId={null}
                  currentMs={currentMs}
                  onOverlaysChange={() => {}}
                  onOverlaySelect={() => {}}
                  playerRef={playerRef}
                />
              </div>
            ) : selected ? (
              <PreviewPlayer
                project={selected}
                words={words}
                styleId={styleId}
                overrides={overrides}
                clips={clips}
                music={music}
                disclaimer={disclaimer}
                overlays={overlays}
                selectedOverlayId={selectedOverlayId}
                currentMs={currentMs}
                onOverlaysChange={handleOverlaysChange}
                onOverlaySelect={setSelectedOverlayId}
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

          {/* таймлайн варианта итерации: только просмотр и перемотка */}
          {selected && railIter && railIterProject && (
            <Timeline
              t={t}
              words={railIterProject.words ?? []}
              maxWordsPerPage={resolved.maxWordsPerPage}
              durationMs={railIterProject.video.durationMs}
              currentMs={currentMs}
              selectedWordIds={new Set<string>()}
              clips={railIterProject.clips ?? null}
              music={railIterProject.music ?? null}
              musicDurationMs={
                railIterProject.music
                  ? musicTracks.find((m) => m.id === railIterProject.music!.trackId)
                      ?.durationMs ?? null
                  : null
              }
              onMusicOffsetChange={() => {}}
              selectedClipId={null}
              overlays={railIterProject.overlays ?? null}
              selectedOverlayId={null}
              hookMode={false}
              hookSelection={[]}
              onHookToggle={() => {}}
              onWordsChange={() => {}}
              onSelectionChange={() => {}}
              onDeleteSelected={() => {}}
              onClipsChange={() => {}}
              onClipSelect={() => {}}
              onOverlaysChange={() => {}}
              onOverlaySelect={() => {}}
              onSeek={seek}
            />
          )}

          {/* таймлайн (скрыт, пока в сцене открыта итерация из ленты) */}
          {selected &&
            !railIter &&
            (pages.length > 0 ||
              (clips && clips.length > 0) ||
              (overlays && overlays.length > 0)) && (
            <Timeline
              t={t}
              words={words}
              maxWordsPerPage={resolved.maxWordsPerPage}
              durationMs={timelineDurationMs}
              currentMs={currentMs}
              selectedWordIds={selectedWordIds}
              clips={clips}
              music={music}
              musicDurationMs={
                music
                  ? musicTracks.find((m) => m.id === music.trackId)?.durationMs ?? null
                  : null
              }
              onMusicOffsetChange={setMusicOffset}
              selectedClipId={selectedClipId}
              overlays={overlays}
              selectedOverlayId={selectedOverlayId}
              hookMode={hookMode}
              hookSelection={hookSelection}
              onHookToggle={toggleHookClip}
              onWordsChange={handleWordsChange}
              onSelectionChange={setSelectedWordIds}
              onDeleteSelected={deleteSelectedPhrases}
              onClipsChange={handleClipsChange}
              onClipSelect={setSelectedClipId}
              onOverlaysChange={handleOverlaysChange}
              onOverlaySelect={setSelectedOverlayId}
              onSeek={seek}
            />
          )}
        </main>

        {/* ───── правая панель ───── */}
        <aside className="panel">
          {selected ? (
              <div className="panel-body">
                {selected.status === "error" && selected.error && (
                  <div className="error-box">{selected.error}</div>
                )}

                {selected.status === "transcribing" && (
                  <div className="hint">{t.transcribingHint}</div>
                )}

                {/* ── ПРЕСЕТ: быстрые настройки из батч-пресетов ── */}
                {projPresets.length > 0 && (
                  <PanelCard id="preset" icon="🎛" title={t.projPresetSection} tone="captions">
                    <div style={{ display: "flex", gap: 6 }}>
                      <select
                        className="select"
                        style={{ flex: 1, minWidth: 0 }}
                        value={applyPresetId}
                        onChange={(e) => setApplyPresetId(e.target.value)}
                      >
                        <option value="">{t.projPresetChoose}</option>
                        {projPresets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-sm btn-accent"
                        disabled={!applyPresetId || applyingPreset}
                        onClick={applyProjectPreset}
                      >
                        {applyingPreset ? "…" : t.projPresetApply}
                      </button>
                    </div>
                    <p className="hint" style={{ marginTop: 6 }}>
                      {t.projPresetHint}
                    </p>
                  </PanelCard>
                )}

                {/* ── СУБТИТРЫ: стиль + текст ── */}
                <PanelCard id="captions" icon="💬" title={t.groupCaptions} tone="captions">
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
                </PanelCard>

                {/* ── МОНТАЖ: клипы + тиша ── */}
                <PanelCard
                  id="montage"
                  icon="🎬"
                  title={t.groupMontage}
                  tone="montage"
                  badge={clips && clips.length > 1 ? t.clipsCount(clips.length) : null}
                >
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
                </PanelCard>

                {/* ── ИТЕРАЦИИ: хук из выбранных клипов (любой проект) ── */}
                {selected.status !== "transcribing" && (
                  <PanelCard
                    id="iter"
                    icon="⚡"
                    title={t.iterSection}
                    tone="iter"
                    badge={
                      (selected.iterations ?? []).length > 0
                        ? `×${(selected.iterations ?? []).length}`
                        : null
                    }
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {!hookMode ? (
                        <button className="btn btn-sm" onClick={startHookMode}>
                          {t.iterAdd}
                        </button>
                      ) : (
                        <>
                          <p className="hint">{t.iterHint}</p>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              className="btn btn-sm btn-accent"
                              style={{ flex: 1 }}
                              disabled={hookSelection.length === 0}
                              onClick={renderIteration}
                            >
                              {t.iterRender(hookSelection.length)}
                            </button>
                            <button className="btn btn-sm btn-ghost" onClick={cancelHookMode}>
                              {t.iterCancel}
                            </button>
                          </div>
                        </>
                      )}
                      {(selected.iterations ?? []).length === 0 && !hookMode && (
                        <p className="hint">{t.iterEmpty}</p>
                      )}
                      {(selected.iterations ?? []).some((i) => i.status === "draft") &&
                        !hookMode && (
                          <button className="btn btn-sm btn-accent" onClick={renderAllDrafts}>
                            {t.iterRenderDrafts(
                              (selected.iterations ?? []).filter(
                                (i) => i.status === "draft"
                              ).length
                            )}
                          </button>
                        )}
                      {(selected.iterations ?? []).map((it) => (
                        <div key={it.id} className="iter-row">
                          <span className="iter-name">it{it.num}</span>
                          {it.status === "draft" && (
                            <>
                              <span className="hint" style={{ flex: 1 }}>
                                {t.iterDraft}
                              </span>
                              <button
                                className="btn btn-sm btn-ghost"
                                title={t.iterRenderOne}
                                onClick={async () => {
                                  await renderDraftIteration(it.id);
                                  await refresh();
                                }}
                              >
                                🎬
                              </button>
                            </>
                          )}
                          {(it.status === "queued" || it.status === "rendering") && (
                            <>
                              <div className="progress-track" style={{ flex: 1 }}>
                                <div
                                  className="progress-fill"
                                  style={{ width: `${Math.round(it.progress * 100)}%` }}
                                />
                              </div>
                              <span className="hint">
                                {it.status === "queued"
                                  ? t.batchStatusQueued
                                  : `${Math.round(it.progress * 100)}%`}
                              </span>
                            </>
                          )}
                          {it.status === "error" && (
                            <span
                              className="hint"
                              style={{ flex: 1, color: "var(--danger)" }}
                              title={it.error}
                            >
                              {t.batchStatusError}
                            </span>
                          )}
                          {it.status === "done" && (
                            <>
                              <span className="hint" style={{ flex: 1 }}>
                                {t.batchStatusDone}
                              </span>
                              <button
                                className="btn btn-sm btn-ghost"
                                onClick={() => setIterPreviewId(it.id)}
                              >
                                ▶
                              </button>
                              {typeof window !== "undefined" &&
                                window.titryNative &&
                                it.file && (
                                  <button
                                    className="btn btn-sm btn-ghost"
                                    title={it.file}
                                    onClick={() =>
                                      window.titryNative?.showInFolder(it.file!)
                                    }
                                  >
                                    📂
                                  </button>
                                )}
                            </>
                          )}
                          <button
                            className="btn btn-sm btn-ghost"
                            style={{ color: "var(--danger)" }}
                            onClick={() => deleteIteration(it.id)}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </PanelCard>
                )}

                {/* ── КАДР: зум/позиция выбранного клипа ── */}
                <PanelCard id="frame" icon="🔍" title={t.frameSection} tone="montage">
                {frameClip ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {clips && clips.length > 1 && (
                      <p className="hint" style={{ marginBottom: 4 }}>
                        🎞 {frameClip.originalName}
                      </p>
                    )}
                    <div className="control-row">
                      <span className="control-label">{t.frameZoom}</span>
                      <input
                        type="range"
                        min={0.5}
                        max={3}
                        step={0.05}
                        value={frameClip.zoom ?? 1}
                        onChange={(e) => updateFrame({ zoom: Number(e.target.value) })}
                      />
                      <span className="control-value">
                        {Math.round((frameClip.zoom ?? 1) * 100)}%
                      </span>
                    </div>
                    <div className="control-row">
                      <span className="control-label">{t.framePosX}</span>
                      <input
                        type="range"
                        min={-0.5}
                        max={0.5}
                        step={0.01}
                        value={frameClip.panX ?? 0}
                        onChange={(e) => updateFrame({ panX: Number(e.target.value) })}
                      />
                      <span className="control-value">
                        {Math.round((frameClip.panX ?? 0) * 100)}%
                      </span>
                    </div>
                    <div className="control-row">
                      <span className="control-label">{t.framePosY}</span>
                      <input
                        type="range"
                        min={-0.5}
                        max={0.5}
                        step={0.01}
                        value={frameClip.panY ?? 0}
                        onChange={(e) => updateFrame({ panY: Number(e.target.value) })}
                      />
                      <span className="control-value">
                        {Math.round((frameClip.panY ?? 0) * 100)}%
                      </span>
                    </div>
                    {frameClip.kind !== "image" && (
                      <div className="control-row">
                        <span className="control-label">{t.clipSpeed}</span>
                        <input
                          type="range"
                          min={0.25}
                          max={4}
                          step={0.05}
                          value={frameClip.speed ?? 1}
                          onChange={(e) =>
                            updateFrame({ speed: Number(e.target.value) })
                          }
                        />
                        <span className="control-value">
                          ×{(frameClip.speed ?? 1).toFixed(2).replace(/\.?0+$/, "")}
                        </span>
                      </div>
                    )}
                    {((frameClip.zoom ?? 1) !== 1 ||
                      (frameClip.panX ?? 0) !== 0 ||
                      (frameClip.panY ?? 0) !== 0 ||
                      (frameClip.speed ?? 1) !== 1) && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          updateFrame({ zoom: 1, panX: 0, panY: 0, speed: 1 })
                        }
                      >
                        {t.frameReset}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="hint">{t.frameSelectHint}</p>
                )}
                </PanelCard>

                {/* ── ТЕКСТ ПОВЕРХ ВИДЕО: дисклеймер + плашки ── */}
                <PanelCard
                  id="overlay"
                  icon="📝"
                  title={t.groupOverlays}
                  tone="overlay"
                  badge={
                    (overlays?.length ?? 0) + (disclaimer?.text?.trim() ? 1 : 0) > 0
                      ? `×${(overlays?.length ?? 0) + (disclaimer?.text?.trim() ? 1 : 0)}`
                      : null
                  }
                >
                <div className="section-label">{t.disclaimerSection}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <textarea
                    className="text-input"
                    style={{ resize: "vertical", minHeight: 40, fontSize: 12 }}
                    rows={2}
                    placeholder={t.disclaimerPlaceholder}
                    value={disclaimer?.text ?? ""}
                    onChange={(e) => updateDisclaimer({ text: e.target.value })}
                  />
                  {disclaimer?.text?.trim() && (
                    <>
                      <div className="control-row">
                        <span className="control-label">{t.size}</span>
                        <input
                          type="range"
                          min={0.01}
                          max={0.05}
                          step={0.001}
                          value={disclaimer.sizeRatio}
                          onChange={(e) =>
                            updateDisclaimer({ sizeRatio: Number(e.target.value) })
                          }
                        />
                        <span className="control-value">
                          {Math.round((disclaimer.sizeRatio / 0.018) * 100)}%
                        </span>
                      </div>
                      <div className="control-row">
                        <span className="control-label">{t.position}</span>
                        <input
                          type="range"
                          min={0.03}
                          max={0.97}
                          step={0.01}
                          value={disclaimer.positionY}
                          onChange={(e) =>
                            updateDisclaimer({ positionY: Number(e.target.value) })
                          }
                        />
                        <span className="control-value">
                          {Math.round(disclaimer.positionY * 100)}%
                        </span>
                      </div>
                    </>
                  )}
                </div>

                <div style={{ height: 14 }} />
                <div className="section-label">{t.overlaySection}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button className="btn btn-sm" onClick={addOverlay}>
                    {t.overlayAdd}
                  </button>
                  {selectedOverlay ? (
                    <>
                      <textarea
                        className="text-input"
                        style={{ resize: "vertical", minHeight: 40, fontSize: 12 }}
                        rows={2}
                        value={selectedOverlay.text}
                        onChange={(e) => updateSelectedOverlay({ text: e.target.value })}
                      />
                      <div className="control-row">
                        <span className="control-label">{t.size}</span>
                        <input
                          type="range"
                          min={OVERLAY_MIN_SIZE_RATIO}
                          max={OVERLAY_MAX_SIZE_RATIO}
                          step={0.001}
                          value={selectedOverlay.sizeRatio}
                          onChange={(e) =>
                            updateSelectedOverlay({ sizeRatio: Number(e.target.value) })
                          }
                        />
                        <span className="control-value">
                          {Math.round((selectedOverlay.sizeRatio / 0.042) * 100)}%
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: "var(--danger)" }}
                        onClick={() => deleteOverlay(selectedOverlay.id)}
                      >
                        {t.overlayDelete}
                      </button>
                    </>
                  ) : (
                    <p className="hint">{t.overlayHint}</p>
                  )}
                </div>
                </PanelCard>

                {/* ── МУЗЫКА ── */}
                <PanelCard
                  id="music"
                  icon="🎵"
                  title={t.musicSection}
                  tone="music"
                  badge={music ? music.name : null}
                >
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
                  {music && (
                    <div className="control-row">
                      <span className="control-label">{t.musicOffset}</span>
                      <span className="hint" style={{ flex: 1 }}>
                        {((music.offsetMs ?? 0) / 1000).toFixed(1)}s
                      </span>
                      {(music.offsetMs ?? 0) !== 0 && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setMusicOffset(0)}
                        >
                          ↺ 0s
                        </button>
                      )}
                    </div>
                  )}
                  {music && <p className="hint">{t.musicOffsetHint}</p>}
                  {music && (
                    <button
                      className="btn btn-sm"
                      onClick={transcribeMusic}
                      disabled={musicTranscribing || selected.status === "transcribing"}
                    >
                      {musicTranscribing ? t.musicTranscribing : t.musicTranscribe}
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => musicInputRef.current?.click()}
                  >
                    {t.musicUpload}
                  </button>
                </div>
                </PanelCard>

                {/* ── действия: всегда прилипают к низу панели ── */}
                <div className="panel-actions">
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

      {/* ───── контекстное меню проекта: пресеты вариаций ───── */}
      {ctxMenu &&
        (() => {
          const p = projects.find((x) => x.id === ctxMenu.projectId);
          if (!p) return null;
          // в режиме выбора ПКМ по отмеченному видео действует на всю пачку
          const targets =
            railSelectMode && railSelected.has(p.id) && railSelected.size > 0
              ? projects.filter((x) => railSelected.has(x.id))
              : [p];
          // у нижнего края экрана меню раскрывается вверх, чтобы не резалось
          const openUp = ctxMenu.y > window.innerHeight * 0.55;
          const commitNaming = async () => {
            if (!ctxNaming?.name.trim()) return;
            const naming = ctxNaming;
            closeCtxMenu();
            if (naming.kind === "iter") await saveIterPreset(p, naming.name.trim());
            else if (naming.kind === "montage")
              await saveMontagePreset(p, naming.name.trim());
            else await patchProjects(targets, { folder: naming.name.trim().slice(0, 40) });
          };
          const existingFolders = [
            ...new Set(projects.map((x) => x.folder).filter((f): f is string => !!f)),
          ].sort((a, b) => a.localeCompare(b));
          const allArchived = targets.every((x) => x.archived);
          return (
            <div
              className="ctx-overlay"
              onClick={closeCtxMenu}
              onContextMenu={(e) => {
                e.preventDefault();
                closeCtxMenu();
              }}
            >
              <div
                className="ctx-menu"
                style={{
                  left: ctxMenu.x,
                  ...(openUp
                    ? {
                        bottom: Math.max(window.innerHeight - ctxMenu.y, 8),
                        maxHeight: Math.max(ctxMenu.y - 16, 200),
                      }
                    : {
                        top: ctxMenu.y,
                        maxHeight: Math.max(window.innerHeight - ctxMenu.y - 16, 200),
                      }),
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ctx-title">
                  {targets.length > 1 ? t.iterPresetTargets(targets.length) : p.name}
                </div>
                {ctxNaming && (
                  <div className="ctx-row" style={{ padding: "2px 4px" }}>
                    <input
                      className="text-input"
                      style={{ flex: 1, padding: "6px 8px", fontSize: 12 }}
                      autoFocus
                      value={ctxNaming.name}
                      placeholder={
                        ctxNaming.kind === "iter"
                          ? t.iterPresetNamePrompt
                          : ctxNaming.kind === "montage"
                            ? t.mpNamePrompt
                            : t.folderNamePrompt
                      }
                      onChange={(e) =>
                        setCtxNaming({ ...ctxNaming, name: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitNaming();
                        if (e.key === "Escape") setCtxNaming(null);
                      }}
                    />
                    <button
                      className="btn btn-sm btn-accent"
                      disabled={!ctxNaming.name.trim()}
                      onClick={() => void commitNaming()}
                    >
                      OK
                    </button>
                  </div>
                )}
                {/* ── папки и архив ── */}
                {!ctxNaming && (
                  <>
                    {existingFolders.map((f) => (
                      <button
                        key={f}
                        className="ctx-item"
                        onClick={async () => {
                          closeCtxMenu();
                          await patchProjects(targets, { folder: f });
                        }}
                      >
                        📁 {t.folderMoveTo} «{f}»
                      </button>
                    ))}
                    <button
                      className="ctx-item"
                      onClick={() => setCtxNaming({ kind: "folder", name: "" })}
                    >
                      ➕ {t.folderNew}
                    </button>
                    {targets.some((x) => x.folder) && (
                      <button
                        className="ctx-item"
                        onClick={async () => {
                          closeCtxMenu();
                          await patchProjects(targets, { folder: null });
                        }}
                      >
                        ✂️ {t.folderRemove}
                      </button>
                    )}
                    <button
                      className="ctx-item"
                      onClick={async () => {
                        closeCtxMenu();
                        await patchProjects(targets, { archived: !allArchived });
                      }}
                    >
                      {allArchived ? `↩️ ${t.archiveRemove}` : `📦 ${t.archiveAdd}`}
                    </button>
                  </>
                )}
                {(p.iterations?.length ?? 0) > 0 && targets.length === 1 && !ctxNaming && (
                  <button
                    className="ctx-item"
                    onClick={() => setCtxNaming({ kind: "iter", name: p.name })}
                  >
                    💾 {t.iterPresetSave} ({p.iterations!.length})
                  </button>
                )}
                <div className="ctx-label">{t.iterPresetFrom}</div>
                {iterPresets.length === 0 && (
                  <div className="ctx-empty">{t.iterPresetEmpty}</div>
                )}
                {iterPresets.map((pr) => (
                  <div key={pr.id} className="ctx-row">
                    <button
                      className="ctx-item"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        closeCtxMenu();
                        await applyIterPreset(targets, pr);
                      }}
                    >
                      ⚡ {pr.name}
                      <span className="ctx-meta">
                        ×{pr.iterations.length}
                        {targets.length > 1 ? ` → ${targets.length}` : ""}
                      </span>
                    </button>
                    <button
                      className="ctx-x"
                      title={t.iterPresetDelete}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(t.iterPresetDeleteConfirm)) return;
                        await fetch(`/api/iter-presets?id=${pr.id}`, { method: "DELETE" });
                        await refreshIterPresets();
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {targets.length === 1 && !ctxNaming && (
                  <button
                    className="ctx-item"
                    onClick={() => setCtxNaming({ kind: "montage", name: p.name })}
                  >
                    💾 {t.mpSave}
                  </button>
                )}
                <div className="ctx-label">{t.mpFrom}</div>
                {montagePresets.length === 0 && (
                  <div className="ctx-empty">{t.mpEmpty}</div>
                )}
                {montagePresets.map((pr) => (
                  <div key={pr.id} className="ctx-row">
                    <button
                      className="ctx-item"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        closeCtxMenu();
                        await applyMontagePreset(targets, pr);
                      }}
                    >
                      🎬 {pr.name}
                      <span className="ctx-meta">
                        {t.mpScenes(pr.scenes.length)}
                        {targets.length > 1 ? ` → ${targets.length}` : ""}
                      </span>
                    </button>
                    <button
                      className="ctx-x"
                      title={t.iterPresetDelete}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(t.mpDeleteConfirm)) return;
                        await fetch(`/api/montage-presets?id=${pr.id}`, {
                          method: "DELETE",
                        });
                        await refreshMontagePresets();
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

      {/* ───── меню папки: переименовать / расформировать ───── */}
      {folderMenu && (
        <div
          className="ctx-overlay"
          onClick={() => setFolderMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setFolderMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: folderMenu.x, top: folderMenu.y, width: 250 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">📁 {folderMenu.name}</div>
            {folderMenu.renaming !== null ? (
              <div className="ctx-row" style={{ padding: "2px 4px" }}>
                <input
                  className="text-input"
                  style={{ flex: 1, padding: "6px 8px", fontSize: 12 }}
                  autoFocus
                  value={folderMenu.renaming}
                  placeholder={t.folderNamePrompt}
                  onChange={(e) =>
                    setFolderMenu({ ...folderMenu, renaming: e.target.value })
                  }
                  onKeyDown={async (e) => {
                    if (e.key === "Escape") setFolderMenu({ ...folderMenu, renaming: null });
                    if (e.key === "Enter" && folderMenu.renaming?.trim()) {
                      const m = folderMenu;
                      setFolderMenu(null);
                      await renameFolder(m.name, m.renaming!);
                    }
                  }}
                />
                <button
                  className="btn btn-sm btn-accent"
                  disabled={!folderMenu.renaming?.trim()}
                  onClick={async () => {
                    const m = folderMenu;
                    setFolderMenu(null);
                    await renameFolder(m.name, m.renaming!);
                  }}
                >
                  OK
                </button>
              </div>
            ) : (
              <>
                <button
                  className="ctx-item"
                  onClick={() =>
                    setFolderMenu({ ...folderMenu, renaming: folderMenu.name })
                  }
                >
                  ✏️ {t.folderRename}
                </button>
                <button
                  className="ctx-item"
                  onClick={async () => {
                    const name = folderMenu.name;
                    setFolderMenu(null);
                    await patchProjects(
                      projects.filter((p) => p.folder === name),
                      { folder: null }
                    );
                  }}
                >
                  ✂️ {t.folderUngroup}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ───── предпросмотр итерации ───── */}
      {iterPreviewId && selected && (
        <div className="modal-overlay" onClick={() => setIterPreviewId(null)}>
          <div
            className="modal"
            style={{ maxWidth: 420, padding: 12 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              {selected.name}_it
              {selected.iterations?.find((i) => i.id === iterPreviewId)?.num}
            </div>
            <video
              key={iterPreviewId}
              src={`/api/projects/${selected.id}/iterate?file=${iterPreviewId}`}
              controls
              autoPlay
              style={{ width: "100%", maxHeight: "70vh", borderRadius: 8 }}
            />
          </div>
        </div>
      )}

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
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <label
                    className="hint"
                    style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={maxSizeMb > 0}
                      onChange={(e) => setMaxSizeMb(e.target.checked ? 30 : 0)}
                    />
                    {t.sizeLimitLabel}
                  </label>
                  {maxSizeMb > 0 && (
                    <>
                      <input
                        className="text-input"
                        type="number"
                        min={5}
                        max={2000}
                        value={maxSizeMb}
                        onChange={(e) => setMaxSizeMb(Number(e.target.value) || 0)}
                        style={{ width: 80 }}
                      />
                      <span className="hint">{t.sizeLimitMb}</span>
                    </>
                  )}
                </div>
                {maxSizeMb > 0 && <p className="hint">{t.sizeLimitHint}</p>}
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
