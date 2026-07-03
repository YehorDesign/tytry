"use client";

import React, { useEffect, useState } from "react";
import { CAPTION_STYLES, resolveStyle } from "@/lib/styles";
import { BUILTIN_FONTS } from "@/remotion/fonts";
import type { Dict } from "@/lib/i18n";
import type { StyleOverrides } from "@/lib/types";

/** Мини-превью пресета: статичная имитация кадра с субтитром */
const StyleThumb: React.FC<{
  styleId: string;
  selected: boolean;
  label: string;
  sample: string;
  onClick: () => void;
}> = ({ styleId, selected, label, sample, onClick }) => {
  const s = resolveStyle(styleId, {});
  const wordsAll = sample.split(" ");
  const words = s.mode === "one-word" ? [wordsAll[0]] : wordsAll;
  const activeIdx = s.mode === "one-word" ? 0 : 1;

  return (
    <button className={`style-card ${selected ? "selected" : ""}`} onClick={onClick}>
      <div
        style={{
          display: "flex",
          flexDirection: s.mode === "design" ? "column" : "row",
          gap: s.mode === "design" ? 1 : 4,
          flexWrap: s.mode === "design" ? "nowrap" : "wrap",
          alignItems: "center",
          justifyContent: "center",
          padding: s.lineBackground ? "4px 8px" : 0,
          backgroundColor: s.lineBackground ?? "transparent",
          borderRadius: 5,
          maxWidth: "88%",
        }}
      >
        {words.map((w, i) => {
          const isActive = i === activeIdx || s.mode === "one-word";
          const variant =
            s.mode === "design"
              ? s.designWords?.[i % (s.designWords.length || 1)]
              : undefined;
          let color = s.colorCycle?.length
            ? s.colorCycle[i % s.colorCycle.length]
            : variant?.color ?? s.textColor;
          let bg = variant?.bg ?? "transparent";
          let opacity = 1;
          if (s.mode === "highlight-color" && isActive) color = s.highlightColor;
          if (s.mode === "highlight-box" && isActive) bg = s.highlightColor;
          if (s.mode === "karaoke" && i > activeIdx) opacity = 0.35;
          if (s.mode === "appear" && i > activeIdx) opacity = 0.12;
          const css: React.CSSProperties = {
            fontFamily: `var(--font-body)`,
            fontWeight: variant?.weight ?? 800,
            fontSize: variant ? 11 * variant.sizeMult : 13,
            fontStyle: variant?.italic ? "italic" : "normal",
            color,
            opacity,
            backgroundColor: bg,
            borderRadius: 3,
            padding: bg !== "transparent" ? "0 4px" : 0,
            textShadow:
              s.strokeRatio > 0 ? "0 1px 2px rgba(0,0,0,0.9)" : s.shadow ?? undefined,
            lineHeight: 1.15,
            textTransform:
              (variant?.caps ?? s.uppercase) ? "uppercase" : "none",
            transform: variant?.rotate
              ? `rotate(${variant.rotate}deg)`
              : isActive && s.activeScale
                ? `scale(${s.activeScale})`
                : isActive && s.boxRotate && bg !== "transparent"
                  ? `rotate(${s.boxRotate}deg)`
                  : undefined,
            display: "inline-block",
          };
          if (s.gradient) {
            css.backgroundImage = s.gradient;
            css.WebkitBackgroundClip = "text";
            css.backgroundClip = "text";
            css.color = "transparent";
            css.textShadow = undefined;
          }
          return (
            <span key={i} style={css}>
              {w}
            </span>
          );
        })}
      </div>
      <span className="style-card-name">{label}</span>
    </button>
  );
};

export const StylePanel: React.FC<{
  t: Dict;
  styleId: string;
  overrides: StyleOverrides;
  onStyleChange: (styleId: string) => void;
  onOverridesChange: (overrides: StyleOverrides) => void;
  onApplyToAll: () => Promise<void>;
  onSaveDefaults: () => Promise<void>;
}> = ({
  t,
  styleId,
  overrides,
  onStyleChange,
  onOverridesChange,
  onApplyToAll,
  onSaveDefaults,
}) => {
  const resolved = resolveStyle(styleId, overrides);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  // краткое «✓ готово» на кнопках глобальных действий
  const [appliedFlash, setAppliedFlash] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  const runGlobal = async (
    action: () => Promise<void>,
    flash: (on: boolean) => void
  ) => {
    setBusy(true);
    try {
      await action();
      flash(true);
      setTimeout(() => flash(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    fetch("/api/fonts")
      .then((r) => r.json())
      .then((d: { fonts: string[] }) => setSystemFonts(d.fonts ?? []))
      .catch(() => {});
  }, []);

  const set = (patch: StyleOverrides) => onOverridesChange({ ...overrides, ...patch });

  return (
    <div className="fade-in">
      <div className="section-label">{t.presets}</div>
      <div className="styles-grid">
        {CAPTION_STYLES.map((s) => (
          <StyleThumb
            key={s.id}
            styleId={s.id}
            selected={s.id === styleId}
            label={t.styleNames[s.id] ?? s.name}
            sample={t.sampleText}
            onClick={() => onStyleChange(s.id)}
          />
        ))}
      </div>

      <div style={{ height: 18 }} />
      <div className="section-label">{t.adjustments}</div>

      <div className="control-row">
        <span className="control-label">{t.font}</span>
        <select
          className="select"
          style={{ maxWidth: 180 }}
          value={resolved.fontFamily}
          onChange={(e) => set({ fontFamily: e.target.value })}
        >
          <optgroup label={t.builtinFonts}>
            {BUILTIN_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
          {systemFonts.length > 0 && (
            <optgroup label={t.systemFonts}>
              {systemFonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <div className="control-row">
        <span className="control-label">{t.size}</span>
        <input
          type="range"
          min={0.02}
          max={0.12}
          step={0.002}
          value={resolved.fontSizeRatio}
          onChange={(e) => set({ fontSizeRatio: Number(e.target.value) })}
        />
        <span className="control-value">
          {Math.round((resolved.fontSizeRatio / 0.05) * 100)}%
        </span>
      </div>

      <div className="control-row">
        <span className="control-label">{t.position}</span>
        <input
          type="range"
          min={0.08}
          max={0.92}
          step={0.01}
          value={resolved.positionY}
          onChange={(e) => set({ positionY: Number(e.target.value) })}
        />
        <span className="control-value">{Math.round(resolved.positionY * 100)}%</span>
      </div>

      <div className="control-row">
        <span className="control-label">{t.wordsPerPage}</span>
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={resolved.maxWordsPerPage}
          onChange={(e) => set({ maxWordsPerPage: Number(e.target.value) })}
        />
        <span className="control-value">{resolved.maxWordsPerPage}</span>
      </div>

      <div className="control-row">
        <span className="control-label">{t.textColor}</span>
        <input
          type="color"
          value={resolved.textColor}
          onChange={(e) => set({ textColor: e.target.value })}
        />
      </div>

      <div className="control-row">
        <span className="control-label">{t.accentColor}</span>
        <input
          type="color"
          value={resolved.highlightColor}
          onChange={(e) => set({ highlightColor: e.target.value })}
        />
      </div>

      <div className="control-row">
        <span className="control-label">{t.uppercase}</span>
        <button
          className={`toggle ${resolved.uppercase ? "on" : ""}`}
          onClick={() => set({ uppercase: !resolved.uppercase })}
          aria-label={t.uppercase}
        />
      </div>

      {Object.keys(overrides).length > 0 && (
        <button className="btn btn-ghost btn-sm" onClick={() => onOverridesChange({})}>
          {t.resetAdjustments}
        </button>
      )}

      <div style={{ height: 18 }} />
      <div className="section-label">{t.globalSection}</div>
      <p className="hint" style={{ marginBottom: 8 }}>
        {t.globalHint}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => runGlobal(onApplyToAll, setAppliedFlash)}
        >
          {appliedFlash ? t.applyToAllDone : t.applyToAll}
        </button>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => runGlobal(onSaveDefaults, setSavedFlash)}
        >
          {savedFlash ? t.saveDefaultsDone : t.saveDefaults}
        </button>
      </div>
    </div>
  );
};
