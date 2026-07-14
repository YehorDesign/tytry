"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatTimestamp, groupWordsIntoPages } from "@/lib/captions";
import type { Dict } from "@/lib/i18n";
import { OVERLAY_MIN_MS } from "@/lib/overlays";
import { clipDurationMs, clipSpeed, type CaptionPage, type ProjectMusic, type TextOverlay, type TimelineClip, type Word } from "@/lib/types";

const MIN_WORD_MS = 80; // минимальная длительность слова при растяжении
const MIN_CLIP_MS = 200; // минимальная длительность клипа при триме
const MAX_IMAGE_MS = 120000; // картинку можно растянуть максимум до 2 минут
const MAX_FREEZE_MS = 120000; // «продление кадра»: до 2 минут статичного хвоста

type DragState = {
  kind: "move" | "left" | "right";
  pageIndex: number;
  startX: number;
  deltaMs: number;
  pages: CaptionPage[]; // снимок страниц на момент начала перетаскивания
  words: Word[]; // снимок слов
  moved: boolean;
};

type ClipDragState = {
  kind: "cmove" | "cleft" | "cright";
  clipIndex: number;
  startX: number;
  deltaMs: number;
  clips: TimelineClip[]; // снимок
  moved: boolean;
};

type OverlayDragState = {
  kind: "omove" | "oleft" | "oright";
  index: number;
  startX: number;
  deltaMs: number;
  overlays: TextOverlay[]; // снимок
  moved: boolean;
};

export const Timeline: React.FC<{
  t: Dict;
  words: Word[];
  maxWordsPerPage: number;
  durationMs: number;
  currentMs: number;
  selectedWordIds: Set<string>;
  clips: TimelineClip[] | null; // null — классический проект, трек клипов скрыт
  music: ProjectMusic | null;
  /** длительность трека из библиотеки — для блока музыки и повторов лупа */
  musicDurationMs?: number | null;
  onMusicOffsetChange?: (offsetMs: number) => void;
  selectedClipId: string | null;
  overlays: TextOverlay[] | null;
  selectedOverlayId: string | null;
  /** режим «итерация»: ЛКМ = дубль в хук, ПКМ = перенос в хук (по порядку) */
  hookMode?: boolean;
  hookSelection?: { id: string; move?: boolean }[];
  onHookToggle?: (clipId: string, move: boolean) => void;
  onWordsChange: (words: Word[]) => void;
  onSelectionChange: (ids: Set<string>) => void;
  onDeleteSelected: () => void;
  onClipsChange: (clips: TimelineClip[]) => void;
  onClipSelect: (id: string | null) => void;
  onOverlaysChange: (overlays: TextOverlay[]) => void;
  onOverlaySelect: (id: string | null) => void;
  onSeek: (ms: number) => void;
}> = ({
  t,
  words,
  maxWordsPerPage,
  durationMs,
  currentMs,
  selectedWordIds,
  clips,
  music,
  musicDurationMs,
  onMusicOffsetChange,
  selectedClipId,
  overlays,
  selectedOverlayId,
  hookMode,
  hookSelection,
  onHookToggle,
  onWordsChange,
  onSelectionChange,
  onDeleteSelected,
  onClipsChange,
  onClipSelect,
  onOverlaysChange,
  onOverlaySelect,
  onSeek,
}) => {
  const [pps, setPps] = useState(60); // пикселей на секунду
  const [drag, setDrag] = useState<DragState | null>(null);
  const [clipDrag, setClipDrag] = useState<ClipDragState | null>(null);
  const [overlayDrag, setOverlayDrag] = useState<OverlayDragState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const anchorPageRef = useRef<number | null>(null); // якорь для shift+клика

  const pages = useMemo(
    () => groupWordsIntoPages(words, maxWordsPerPage),
    [words, maxWordsPerPage]
  );

  const msToPx = (ms: number) => (ms / 1000) * pps;
  const pxToMs = (px: number) => (px / pps) * 1000;
  const totalWidth = msToPx(durationMs) + 40;

  // ── ctrl+колесо = зум ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setPps((p) => Math.min(240, Math.max(10, p * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const fitToWidth = () => {
    const w = scrollRef.current?.clientWidth ?? 800;
    setPps(Math.min(240, Math.max(10, ((w - 48) / Math.max(durationMs, 1000)) * 1000)));
  };

  // ── перетаскивание страниц субтитров (как раньше) + выделение кликом ──
  const applyDrag = (d: DragState): Word[] => {
    const page = d.pages[d.pageIndex];
    if (!page) return d.words;
    const ids = new Set(page.words.map((w) => w.id));
    const first = page.words[0];
    const last = page.words[page.words.length - 1];

    if (d.kind === "move") {
      const minDelta = -first.startMs;
      const maxDelta = durationMs - last.endMs;
      const delta = Math.min(Math.max(d.deltaMs, minDelta), maxDelta);
      return d.words.map((w) =>
        ids.has(w.id) ? { ...w, startMs: w.startMs + delta, endMs: w.endMs + delta } : w
      );
    }
    if (d.kind === "left") {
      const delta = Math.min(
        Math.max(d.deltaMs, -first.startMs),
        first.endMs - first.startMs - MIN_WORD_MS
      );
      return d.words.map((w) =>
        w.id === first.id ? { ...w, startMs: w.startMs + delta } : w
      );
    }
    // right: тянем конец последнего слова (продление субтитра)
    const delta = Math.min(
      Math.max(d.deltaMs, -(last.endMs - last.startMs - MIN_WORD_MS)),
      durationMs - last.endMs
    );
    return d.words.map((w) =>
      w.id === last.id ? { ...w, endMs: w.endMs + delta } : w
    );
  };

  const draggedWords = drag ? applyDrag(drag) : words;
  const visiblePages = drag
    ? groupWordsIntoPages(draggedWords, maxWordsPerPage)
    : pages;

  const selectPage = (pageIndex: number, ev: PointerEvent) => {
    const page = pages[pageIndex];
    if (!page) return;
    const ids = page.words.map((w) => w.id);
    const next = new Set(selectedWordIds);
    if (ev.shiftKey && anchorPageRef.current !== null) {
      // диапазон от якоря до кликнутой страницы (добавляется к выбранному)
      const [a, b] = [anchorPageRef.current, pageIndex].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) {
        for (const w of pages[i]?.words ?? []) next.add(w.id);
      }
    } else if (ev.ctrlKey || ev.metaKey) {
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      anchorPageRef.current = pageIndex;
    } else {
      const onlyThis =
        ids.every((id) => next.has(id)) && next.size === ids.length;
      next.clear();
      if (!onlyThis) for (const id of ids) next.add(id);
      anchorPageRef.current = pageIndex;
    }
    onSelectionChange(next);
  };

  const startDrag = (
    e: React.PointerEvent,
    kind: DragState["kind"],
    pageIndex: number
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const initial: DragState = {
      kind,
      pageIndex,
      startX: e.clientX,
      deltaMs: 0,
      pages,
      words,
      moved: false,
    };
    setDrag(initial);

    const onMove = (ev: PointerEvent) => {
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      if (Math.abs(ev.clientX - initial.startX) > 4) initial.moved = true;
      setDrag({ ...initial });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      const result = applyDrag(initial);
      setDrag(null);
      if (initial.moved && Math.abs(initial.deltaMs) > 5) {
        onWordsChange(result);
      } else if (kind === "move") {
        // не тащили — это клик: выделение
        selectPage(pageIndex, ev);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── клипы: старты по порядку массива ──
  const clipStarts = useMemo(() => {
    if (!clips) return [];
    const starts: number[] = [];
    let acc = 0;
    for (const c of clips) {
      starts.push(acc);
      acc += clipDurationMs(c);
    }
    return starts;
  }, [clips]);

  const applyClipDrag = (d: ClipDragState): TimelineClip[] => {
    const clip = d.clips[d.clipIndex];
    if (!clip) return d.clips;
    // курсор двигается по таймлайну, а трим — по исходнику: пересчёт через скорость
    const srcDelta = d.deltaMs * clipSpeed(clip);
    if (d.kind === "cleft") {
      const inMs = Math.min(
        Math.max(clip.inMs + srcDelta, 0),
        clip.outMs - MIN_CLIP_MS
      );
      return d.clips.map((c, i) => (i === d.clipIndex ? { ...c, inMs } : c));
    }
    if (d.kind === "cright") {
      // видео можно тянуть дальше конца исходника — хвост зависает на последнем кадре
      const maxOut =
        clip.kind === "image"
          ? clip.inMs + MAX_IMAGE_MS
          : clip.sourceDurationMs + MAX_FREEZE_MS;
      const outMs = Math.min(
        Math.max(clip.outMs + srcDelta, clip.inMs + MIN_CLIP_MS),
        maxOut
      );
      return d.clips.map((c, i) => (i === d.clipIndex ? { ...c, outMs } : c));
    }
    return d.clips; // cmove: порядок меняется на дропе
  };

  /** Новый индекс клипа при перетаскивании: по центру блока в новой позиции */
  const clipDropIndex = (d: ClipDragState): number => {
    const dur = clipDurationMs(d.clips[d.clipIndex]);
    const start = clipStarts[d.clipIndex] + d.deltaMs;
    const center = start + dur / 2;
    let acc = 0;
    for (let i = 0; i < d.clips.length; i++) {
      if (i === d.clipIndex) continue;
      const cd = clipDurationMs(d.clips[i]);
      if (center < acc + cd / 2) {
        return i > d.clipIndex ? i - 1 : i;
      }
      acc += cd;
    }
    return d.clips.length - 1;
  };

  const startClipDrag = (
    e: React.PointerEvent,
    kind: ClipDragState["kind"],
    clipIndex: number
  ) => {
    if (!clips) return;
    e.preventDefault();
    e.stopPropagation();
    // ПКМ в режиме итерации: перенос клипа в хук (без перетаскивания)
    if (e.button === 2) {
      if (hookMode && onHookToggle) {
        const id = clips[clipIndex]?.id;
        if (id) {
          onHookToggle(id, true);
          onSeek(clipStarts[clipIndex] ?? 0);
        }
      }
      return;
    }
    if (e.button !== 0) return;
    const initial: ClipDragState = {
      kind,
      clipIndex,
      startX: e.clientX,
      deltaMs: 0,
      clips,
      moved: false,
    };
    setClipDrag(initial);

    const onMove = (ev: PointerEvent) => {
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      if (Math.abs(ev.clientX - initial.startX) > 4) initial.moved = true;
      setClipDrag({ ...initial });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      setClipDrag(null);
      if (!initial.moved) {
        const id = initial.clips[clipIndex]?.id ?? null;
        // режим итерации: ЛКМ добавляет дубль в хук / убирает клип из хука
        if (hookMode && id && onHookToggle) {
          onHookToggle(id, false);
          onSeek(clipStarts[clipIndex] ?? 0);
          return;
        }
        // клик: выбрать клип (для панели «Кадр») и перемотать к его началу
        onClipSelect(id === selectedClipId ? null : id);
        onSeek(clipStarts[clipIndex] ?? 0);
        return;
      }
      if (hookMode) return; // в режиме итерации клипы не двигаем
      if (kind === "cmove") {
        const to = clipDropIndex(initial);
        if (to !== clipIndex) {
          const next = [...initial.clips];
          const [moved] = next.splice(clipIndex, 1);
          next.splice(to, 0, moved);
          onClipsChange(next);
        }
      } else {
        const next = applyClipDrag(initial);
        if (next !== initial.clips) onClipsChange(next);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const removeClip = (index: number) => {
    if (!clips || clips.length <= 1) return;
    if (!confirm(t.confirmRemoveClip)) return;
    onClipsChange(clips.filter((_, i) => i !== index));
  };

  const visibleClips = clipDrag ? applyClipDrag(clipDrag) : clips;

  // ── текст-плашки: свой трек, двигаем/тримим как клипы ──
  const applyOverlayDrag = (d: OverlayDragState): TextOverlay[] => {
    const o = d.overlays[d.index];
    if (!o) return d.overlays;
    if (d.kind === "omove") {
      const dur = o.endMs - o.startMs;
      const start = Math.min(
        Math.max(o.startMs + d.deltaMs, 0),
        Math.max(durationMs - dur, 0)
      );
      return d.overlays.map((x, i) =>
        i === d.index ? { ...x, startMs: start, endMs: start + dur } : x
      );
    }
    if (d.kind === "oleft") {
      const start = Math.min(
        Math.max(o.startMs + d.deltaMs, 0),
        o.endMs - OVERLAY_MIN_MS
      );
      return d.overlays.map((x, i) => (i === d.index ? { ...x, startMs: start } : x));
    }
    const end = Math.min(
      Math.max(o.endMs + d.deltaMs, o.startMs + OVERLAY_MIN_MS),
      durationMs
    );
    return d.overlays.map((x, i) => (i === d.index ? { ...x, endMs: end } : x));
  };

  const startOverlayDrag = (
    e: React.PointerEvent,
    kind: OverlayDragState["kind"],
    index: number
  ) => {
    if (!overlays) return;
    e.preventDefault();
    e.stopPropagation();
    const initial: OverlayDragState = {
      kind,
      index,
      startX: e.clientX,
      deltaMs: 0,
      overlays,
      moved: false,
    };
    setOverlayDrag(initial);

    const onMove = (ev: PointerEvent) => {
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      if (Math.abs(ev.clientX - initial.startX) > 4) initial.moved = true;
      setOverlayDrag({ ...initial });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      setOverlayDrag(null);
      if (!initial.moved) {
        // клик: выбрать плашку и перемотать к её началу
        const o = initial.overlays[index];
        onOverlaySelect(o && o.id !== selectedOverlayId ? o.id : null);
        if (o) onSeek(o.startMs);
        return;
      }
      const next = applyOverlayDrag(initial);
      if (next !== initial.overlays) onOverlaysChange(next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const visibleOverlays = overlayDrag ? applyOverlayDrag(overlayDrag) : overlays;

  // ── музыка: сдвиг трека перетаскиванием ──
  const [musicDrag, setMusicDrag] = useState<{ startX: number; deltaMs: number } | null>(
    null
  );
  const musicOffset = (music?.offsetMs ?? 0) + (musicDrag?.deltaMs ?? 0);

  const startMusicDrag = (e: React.PointerEvent) => {
    if (!music || !onMusicOffsetChange) return;
    e.preventDefault();
    e.stopPropagation();
    const initial = { startX: e.clientX, deltaMs: 0 };
    setMusicDrag(initial);
    const trackDur = musicDurationMs ?? durationMs;
    const clampOffset = (off: number) =>
      Math.min(Math.max(off, -(trackDur - 500)), Math.max(durationMs - 500, 0));

    const onMove = (ev: PointerEvent) => {
      initial.deltaMs =
        clampOffset((music.offsetMs ?? 0) + pxToMs(ev.clientX - initial.startX)) -
        (music.offsetMs ?? 0);
      setMusicDrag({ ...initial });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMusicDrag(null);
      if (Math.abs(initial.deltaMs) > 5) {
        onMusicOffsetChange(Math.round((music.offsetMs ?? 0) + initial.deltaMs));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleTrackClick = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    onSeek(Math.max(0, Math.min(pxToMs(x), durationMs)));
    if (selectedWordIds.size > 0) onSelectionChange(new Set());
    if (selectedClipId) onClipSelect(null);
    if (selectedOverlayId) onOverlaySelect(null);
  };

  // секундные деления
  const ticks: number[] = [];
  const tickStep = pps < 20 ? 10 : pps < 45 ? 5 : pps < 90 ? 2 : 1;
  for (let s = 0; s * 1000 <= durationMs; s += tickStep) ticks.push(s);

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const p of pages) {
      if (p.words.some((w) => selectedWordIds.has(w.id))) n++;
    }
    return n;
  }, [pages, selectedWordIds]);

  // геометрия дорожек: линейка → клипы (если есть) → субтитры → плашки → музыка
  const hasClipsLane = !!(visibleClips && visibleClips.length > 0);
  const hasOverlaysLane = !!(visibleOverlays && visibleOverlays.length > 0);
  const clipsTop = 16;
  const capTop = hasClipsLane ? 52 : 18;
  const capH = 36;
  const ovTop = capTop + capH + 4;
  const ovH = 22;
  const musicTop = hasOverlaysLane ? ovTop + ovH + 4 : capTop + capH + 4;
  const trackH = music
    ? musicTop + 26
    : hasOverlaysLane
      ? ovTop + ovH + 10
      : capTop + capH + 10;

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <span className="hint">{t.timelineHint}</span>
        <div style={{ flex: 1 }} />
        {selectedCount > 0 && (
          <button
            className="btn btn-sm"
            style={{ color: "var(--danger)" }}
            onClick={onDeleteSelected}
          >
            {t.deleteSelected(selectedCount)}
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={fitToWidth} title={t.fitTimeline}>
          ⤢
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setPps((p) => Math.max(10, p / 1.4))}
          title="Zoom out"
        >
          −
        </button>
        <span className="control-value" style={{ width: "auto" }}>
          {Math.round(pps)}px/s
        </span>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setPps((p) => Math.min(240, p * 1.4))}
          title="Zoom in"
        >
          +
        </button>
      </div>
      <div className="timeline-scroll" ref={scrollRef}>
        <div
          className="timeline-track"
          style={{ width: totalWidth, height: trackH }}
          onClick={handleTrackClick}
        >
          {/* линейка */}
          {ticks.map((s) => (
            <div key={s} className="timeline-tick" style={{ left: msToPx(s * 1000) }}>
              <span>{s}s</span>
            </div>
          ))}

          {/* ── трек клипов (только в монтаже) ── */}
          {hasClipsLane && visibleClips && (
            <div className="timeline-lane clips-lane" style={{ top: clipsTop, height: 30 }}>
              {visibleClips.map((clip, i) => {
                const isDragged = clipDrag?.clipIndex === i;
                const start =
                  clipDrag && clipDrag.kind === "cmove" && isDragged
                    ? clipStarts[i] + clipDrag.deltaMs
                    : (() => {
                        // при триме пересчитываем старты по видимым клипам
                        let acc = 0;
                        for (let k = 0; k < i; k++) acc += clipDurationMs(visibleClips[k]);
                        return acc;
                      })();
                const hookIdx = hookMode
                  ? (hookSelection ?? []).findIndex((h) => h.id === clip.id)
                  : -1;
                const hookMove = hookIdx >= 0 && !!hookSelection?.[hookIdx]?.move;
                return (
                  <div
                    key={clip.id}
                    className={`clip-block ${isDragged ? "dragging" : ""} ${clip.kind === "image" ? "image" : ""} ${clip.id === selectedClipId ? "selected" : ""} ${hookMode ? "hookable" : ""} ${hookIdx >= 0 ? "hooked" : ""} ${hookMove ? "hook-move" : ""}`}
                    style={{
                      left: msToPx(start),
                      width: Math.max(msToPx(clipDurationMs(clip)), 16),
                    }}
                    onPointerDown={(e) => startClipDrag(e, "cmove", i)}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => {
                      if (hookMode) e.preventDefault();
                    }}
                    title={`${clip.originalName} · ${formatTimestamp(clipDurationMs(clip))}`}
                  >
                    {hookIdx >= 0 && (
                      <span className={`hook-badge ${hookMove ? "move" : ""}`}>
                        {hookMove ? `${hookIdx + 1}↰` : hookIdx + 1}
                      </span>
                    )}
                    <div
                      className="timeline-handle left"
                      onPointerDown={(e) => startClipDrag(e, "cleft", i)}
                    />
                    {/* «продлённый» хвост — статичный последний кадр */}
                    {clip.kind === "video" && clip.outMs > clip.sourceDurationMs && (
                      <div
                        className="clip-freeze"
                        style={{
                          width: msToPx(
                            (clip.outMs - clip.sourceDurationMs) / clipSpeed(clip)
                          ),
                        }}
                      />
                    )}
                    <span className="clip-block-text">
                      {clip.kind === "image" ? "🖼 " : ""}
                      {clipSpeed(clip) !== 1 && (
                        <span className="clip-speed-badge">
                          ×{clipSpeed(clip).toFixed(2).replace(/\.?0+$/, "")}{" "}
                        </span>
                      )}
                      {clip.originalName}
                    </span>
                    {clips && clips.length > 1 && (
                      <button
                        className="clip-delete"
                        title={t.clipRemove}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeClip(i);
                        }}
                      >
                        ✕
                      </button>
                    )}
                    <div
                      className="timeline-handle right"
                      onPointerDown={(e) => startClipDrag(e, "cright", i)}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* ── блоки страниц субтитров ── */}
          <div className="timeline-lane captions-lane" style={{ top: capTop, height: capH }}>
            {visiblePages.map((page, i) => {
              const isDragged = drag?.pageIndex === i;
              const active = currentMs >= page.startMs && currentMs < page.endMs;
              const selected = page.words.some((w) => selectedWordIds.has(w.id));
              return (
                <div
                  key={i}
                  className={`timeline-block ${active ? "active" : ""} ${isDragged ? "dragging" : ""} ${selected ? "selected" : ""} ${page.style ? "styled" : ""}`}
                  style={{
                    left: msToPx(page.startMs),
                    width: Math.max(msToPx(page.endMs - page.startMs), 14),
                  }}
                  onPointerDown={(e) => startDrag(e, "move", i)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={() => onSeek(page.startMs)}
                  title={`${formatTimestamp(page.startMs)} → ${formatTimestamp(page.endMs)}`}
                >
                  <div
                    className="timeline-handle left"
                    onPointerDown={(e) => startDrag(e, "left", i)}
                  />
                  <span className="timeline-block-text">
                    {page.words.map((w) => w.text).join(" ")}
                  </span>
                  <div
                    className="timeline-handle right"
                    onPointerDown={(e) => startDrag(e, "right", i)}
                  />
                </div>
              );
            })}
          </div>

          {/* ── трек текст-плашек ── */}
          {hasOverlaysLane && visibleOverlays && (
            <div className="timeline-lane overlays-lane" style={{ top: ovTop, height: ovH }}>
              {visibleOverlays.map((o, i) => {
                const isDragged = overlayDrag?.index === i;
                const active = currentMs >= o.startMs && currentMs < o.endMs;
                return (
                  <div
                    key={o.id}
                    className={`overlay-block ${isDragged ? "dragging" : ""} ${active ? "active" : ""} ${o.id === selectedOverlayId ? "selected" : ""}`}
                    style={{
                      left: msToPx(o.startMs),
                      width: Math.max(msToPx(o.endMs - o.startMs), 14),
                    }}
                    onPointerDown={(e) => startOverlayDrag(e, "omove", i)}
                    onClick={(e) => e.stopPropagation()}
                    title={`${formatTimestamp(o.startMs)} → ${formatTimestamp(o.endMs)}`}
                  >
                    <div
                      className="timeline-handle left"
                      onPointerDown={(e) => startOverlayDrag(e, "oleft", i)}
                    />
                    <span className="clip-block-text">💬 {o.text}</span>
                    <div
                      className="timeline-handle right"
                      onPointerDown={(e) => startOverlayDrag(e, "oright", i)}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* ── полоса музыки: тянется влево/вправо (сдвиг трека) ── */}
          {music && (
            <div className="timeline-lane music-lane" style={{ top: musicTop, height: 20 }}>
              {(() => {
                const trackDur = Math.max(musicDurationMs ?? durationMs, 1000);
                // трек играет один раз, без повторов
                return (
                  <>
                    <div
                      className={`music-block ${musicDrag ? "dragging" : ""}`}
                      style={{ left: msToPx(musicOffset), width: Math.max(msToPx(trackDur), 24) }}
                      onPointerDown={startMusicDrag}
                      onClick={(e) => e.stopPropagation()}
                      title={`${music.name} — ${t.musicDragTitle}`}
                    >
                      <span className="clip-block-text">
                        🎵 {music.name} · {Math.round(music.volume * 100)}%
                        {Math.round(musicOffset) !== 0 &&
                          ` · ${musicOffset > 0 ? "+" : ""}${(musicOffset / 1000).toFixed(1)}s`}
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* плейхед */}
          <div className="timeline-playhead" style={{ left: msToPx(currentMs) }} />
        </div>
      </div>
    </div>
  );
};
