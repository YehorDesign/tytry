"use client";

import React, { useMemo, useRef, useState } from "react";
import { formatTimestamp, groupWordsIntoPages } from "@/lib/captions";
import type { CaptionPage, Word } from "@/lib/types";

const MIN_WORD_MS = 80; // минимальная длительность слова при растяжении

type DragState = {
  kind: "move" | "left" | "right";
  pageIndex: number;
  startX: number;
  deltaMs: number;
  pages: CaptionPage[]; // снимок страниц на момент начала перетаскивания
  words: Word[]; // снимок слов
};

export const Timeline: React.FC<{
  words: Word[];
  maxWordsPerPage: number;
  durationMs: number;
  currentMs: number;
  hint: string;
  onWordsChange: (words: Word[]) => void;
  onSeek: (ms: number) => void;
}> = ({ words, maxWordsPerPage, durationMs, currentMs, hint, onWordsChange, onSeek }) => {
  const [pps, setPps] = useState(60); // пикселей на секунду
  const [drag, setDrag] = useState<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const pages = useMemo(
    () => groupWordsIntoPages(words, maxWordsPerPage),
    [words, maxWordsPerPage]
  );

  const msToPx = (ms: number) => (ms / 1000) * pps;
  const pxToMs = (px: number) => (px / pps) * 1000;
  const totalWidth = msToPx(durationMs) + 40;

  // применяем дельту перетаскивания к снимку слов
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
    };
    setDrag(initial);

    const onMove = (ev: PointerEvent) => {
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      setDrag({ ...initial });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      initial.deltaMs = pxToMs(ev.clientX - initial.startX);
      const result = applyDrag(initial);
      setDrag(null);
      if (Math.abs(initial.deltaMs) > 5) {
        onWordsChange(result);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleTrackClick = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0) * 0;
    onSeek(Math.max(0, Math.min(pxToMs(x), durationMs)));
  };

  // секундные деления
  const ticks: number[] = [];
  const tickStep = pps < 45 ? 5 : pps < 90 ? 2 : 1;
  for (let s = 0; s * 1000 <= durationMs; s += tickStep) ticks.push(s);

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <span className="hint">{hint}</span>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setPps((p) => Math.max(20, p / 1.4))}
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
        <div className="timeline-track" style={{ width: totalWidth }} onClick={handleTrackClick}>
          {/* линейка */}
          {ticks.map((s) => (
            <div key={s} className="timeline-tick" style={{ left: msToPx(s * 1000) }}>
              <span>{s}s</span>
            </div>
          ))}

          {/* блоки страниц */}
          {visiblePages.map((page, i) => {
            const isDragged = drag?.pageIndex === i;
            const active = currentMs >= page.startMs && currentMs < page.endMs;
            return (
              <div
                key={i}
                className={`timeline-block ${active ? "active" : ""} ${isDragged ? "dragging" : ""}`}
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

          {/* плейхед */}
          <div className="timeline-playhead" style={{ left: msToPx(currentMs) }} />
        </div>
      </div>
    </div>
  );
};
