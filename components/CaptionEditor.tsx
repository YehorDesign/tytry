"use client";

import React, { useMemo } from "react";
import { formatTimestamp, groupWordsIntoPages } from "@/lib/captions";
import type { Dict } from "@/lib/i18n";
import type { Word } from "@/lib/types";

export const CaptionEditor: React.FC<{
  t: Dict;
  words: Word[];
  maxWordsPerPage: number;
  currentMs: number;
  onWordsChange: (words: Word[]) => void;
  onSeek: (ms: number) => void;
}> = ({ t, words, maxWordsPerPage, currentMs, onWordsChange, onSeek }) => {
  const pages = useMemo(
    () => groupWordsIntoPages(words, maxWordsPerPage),
    [words, maxWordsPerPage]
  );

  const updateWord = (id: string, text: string) => {
    onWordsChange(words.map((w) => (w.id === id ? { ...w, text } : w)));
  };

  const deleteWord = (id: string) => {
    onWordsChange(words.filter((w) => w.id !== id));
  };

  if (words.length === 0) {
    return <p className="hint">{t.noCaptions}</p>;
  }

  return (
    <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p className="hint">{t.editorHint}</p>
      {pages.map((page, pi) => {
        const isActive = currentMs >= page.startMs && currentMs < page.endMs;
        return (
          <div key={pi} className={`caption-row ${isActive ? "active" : ""}`}>
            <div className="caption-row-head">
              <span className="caption-time" onClick={() => onSeek(page.startMs)}>
                {formatTimestamp(page.startMs)} → {formatTimestamp(page.endMs)}
              </span>
            </div>
            <div className="caption-words">
              {page.words.map((word) => (
                <input
                  key={word.id}
                  className="word-input"
                  value={word.text}
                  size={Math.max(word.text.length, 1)}
                  onChange={(e) => updateWord(word.id, e.target.value)}
                  onBlur={(e) => {
                    if (!e.target.value.trim()) deleteWord(word.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
