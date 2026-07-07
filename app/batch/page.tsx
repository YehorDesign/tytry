"use client";

// Батч-режим: ZIP-архивы → монтаж + субтитры + музыка + ендкард по пресету.
// Отдельная страница, чтобы не перегружать основной редактор.
import React, { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { StylePanel } from "@/components/StylePanel";
import { STRINGS, getLocale, type Locale } from "@/lib/i18n";
import type { MusicTrack, StyleOverrides } from "@/lib/types";
import type { BatchItemStatus, BatchPreset, Endcard } from "@/lib/batch/types";

// живое превью субтитров (Remotion Player) — только в браузере
const PresetPreview = dynamic(
  () => import("@/components/PresetPreview").then((m) => m.PresetPreview),
  { ssr: false }
);

type PresentedItem = {
  id: string;
  name: string;
  status: BatchItemStatus;
  live: boolean;
  progress: number;
  error?: string;
  outputFile?: string;
  cleanFile?: string;
  projectId?: string;
  clipCount?: number;
  durationMs?: number;
};

type PresentedBatch = {
  id: string;
  name: string;
  createdAt: string;
  preset: BatchPreset;
  outputDir: string;
  cleanDir?: string;
  paused: boolean;
  items: PresentedItem[];
};

type BatchSummary = {
  id: string;
  name: string;
  createdAt: string;
  presetName: string;
  outputDir: string;
  paused: boolean;
  total: number;
  done: number;
  error: number;
  active: number;
  queued: number;
};

export default function BatchPage() {
  const [locale] = useState<Locale>(() =>
    typeof window === "undefined" ? "uk" : getLocale()
  );
  const t = STRINGS[locale];

  const [presets, setPresets] = useState<BatchPreset[]>([]);
  const [endcards, setEndcards] = useState<Endcard[]>([]);
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [batch, setBatch] = useState<PresentedBatch | null>(null);

  // форма создания
  const [newName, setNewName] = useState("");
  const [newPresetId, setNewPresetId] = useState("");
  const [newOutputDir, setNewOutputDir] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // загрузка архивов (refs — источник истины, state — только для отрисовки)
  const uploadStats = useRef({ done: 0, total: 0 });
  const [upload, setUpload] = useState({ done: 0, total: 0 });
  const zipInputRef = useRef<HTMLInputElement>(null);

  // пресет-редактор
  const [presetOpen, setPresetOpen] = useState(false);
  const [editPreset, setEditPreset] = useState<Partial<BatchPreset> | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const endcardInputRef = useRef<HTMLInputElement>(null);

  // предпросмотр
  const [preview, setPreview] = useState<{ itemId: string; kind: "final" | "clean" } | null>(null);

  const refreshLibraries = useCallback(async () => {
    try {
      const [p, e, m, b] = await Promise.all([
        fetch("/api/presets").then((r) => r.json()),
        fetch("/api/endcards").then((r) => r.json()),
        fetch("/api/music").then((r) => r.json()),
        fetch("/api/batch").then((r) => r.json()),
      ]);
      setPresets(p.presets ?? []);
      setEndcards(e.endcards ?? []);
      setMusicTracks(m.tracks ?? []);
      setBatches(b.batches ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshLibraries();
  }, [refreshLibraries]);

  // поллинг открытого батча
  const batchIdRef = useRef<string | null>(null);
  batchIdRef.current = batch?.id ?? null;
  useEffect(() => {
    if (!batch?.id) return;
    const interval = setInterval(async () => {
      const id = batchIdRef.current;
      if (!id) return;
      try {
        const res = await fetch(`/api/batch/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.batch && batchIdRef.current === id) setBatch(data.batch);
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [batch?.id]);

  const openBatch = async (id: string) => {
    const res = await fetch(`/api/batch/${id}`);
    const data = await res.json();
    if (data.batch) setBatch(data.batch);
  };

  const createBatch = async (folderPath?: string) => {
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          presetId: newPresetId,
          outputDir: newOutputDir,
          folderPath,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.error ?? "Error");
        return;
      }
      setBatch(data.batch);
      refreshLibraries();
    } finally {
      setCreating(false);
    }
  };

  const createFromFolder = async () => {
    const folder = await window.titryNative?.pickFolder();
    if (folder) await createBatch(folder);
  };

  const batchAction = async (action: string, itemId?: string) => {
    if (!batch) return;
    const res = await fetch(`/api/batch/${batch.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, itemId }),
    });
    const data = await res.json();
    if (data.batch) setBatch(data.batch);
  };

  const deleteBatch = async () => {
    if (!batch) return;
    if (!confirm(t.batchConfirmDelete)) return;
    await fetch(`/api/batch/${batch.id}`, { method: "DELETE" });
    setBatch(null);
    refreshLibraries();
  };

  // архивы льём по одному: файлы большие, а так виден прогресс и обработка
  // стартует с первого же архива
  const uploadZips = async (files: File[]) => {
    if (!batch || files.length === 0) return;
    const zips = files.filter((f) => f.name.toLowerCase().endsWith(".zip"));
    uploadStats.current.total += zips.length;
    setUpload({ ...uploadStats.current });
    for (const file of zips) {
      const form = new FormData();
      form.append("files", file);
      try {
        const res = await fetch(`/api/batch/${batch.id}/upload`, {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (data.batch && batchIdRef.current === batch.id) setBatch(data.batch);
      } catch {
        // элемент просто не добавится; продолжаем остальные
      }
      uploadStats.current.done++;
      if (uploadStats.current.done >= uploadStats.current.total) {
        uploadStats.current = { done: 0, total: 0 };
      }
      setUpload({ ...uploadStats.current });
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (batch) uploadZips(Array.from(e.dataTransfer.files));
  };

  const browseOutput = async () => {
    const picked = await window.titryNative?.pickFolder();
    if (picked) setNewOutputDir(picked);
  };

  // ── пресеты ──

  const openPresetEditor = (preset?: BatchPreset) => {
    setEditPreset(
      preset ?? {
        name: "",
        language: "auto",
        captions: true,
        trimSilence: false,
        styleId: "hormozi",
        overrides: { fontFamily: "Gilroy" },
        disclaimer: null,
        musicTrackId: null,
        musicVolume: 0.3,
        endcardId: null,
        endcardDurationMs: 3000,
        cleanCopy: true,
        maxSizeMb: 30,
      }
    );
    setPresetOpen(true);
  };

  const savePreset = async () => {
    if (!editPreset?.name?.trim()) return;
    setSavingPreset(true);
    try {
      const res = await fetch("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editPreset),
      });
      const data = await res.json();
      if (res.ok) {
        setPresets(data.presets ?? []);
        if (!newPresetId && data.preset) setNewPresetId(data.preset.id);
        setPresetOpen(false);
      }
    } finally {
      setSavingPreset(false);
    }
  };

  const removePreset = async (id: string) => {
    if (!confirm(t.presetDeleteConfirm)) return;
    const res = await fetch(`/api/presets?id=${id}`, { method: "DELETE" });
    const data = await res.json();
    setPresets(data.presets ?? []);
  };

  const uploadEndcard = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/endcards", { method: "POST", body: form });
    const data = await res.json();
    if (res.ok) {
      setEndcards(data.endcards ?? []);
      setEditPreset((p) => (p ? { ...p, endcardId: data.endcard.id } : p));
    }
  };

  // ── рендер ──

  const statusLabel: Record<BatchItemStatus, string> = {
    queued: t.batchStatusQueued,
    extract: t.batchStatusExtract,
    montage: t.batchStatusMontage,
    transcribe: t.batchStatusTranscribe,
    render: t.batchStatusRender,
    compress: t.batchStatusCompress,
    done: t.batchStatusDone,
    error: t.batchStatusError,
  };

  const doneCount = batch?.items.filter((i) => i.status === "done").length ?? 0;
  const errorCount = batch?.items.filter((i) => i.status === "error").length ?? 0;
  const previewItem = preview ? batch?.items.find((i) => i.id === preview.itemId) : null;

  return (
    <div
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* шапка */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 20px",
          borderBottom: "1px solid var(--border, #333)",
        }}
      >
        <a href="/" className="btn btn-ghost">
          {t.batchBack}
        </a>
        <h1 style={{ fontSize: 18, margin: 0, flex: 1 }}>{t.batchTitle}</h1>
        <button className="btn" onClick={() => openPresetEditor()}>
          {t.presetNew}
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* список батчей */}
        <aside
          style={{
            width: 260,
            borderRight: "1px solid var(--border, #333)",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflowY: "auto",
          }}
        >
          <button
            className={`btn ${batch ? "" : "btn-accent"}`}
            onClick={() => setBatch(null)}
          >
            {t.batchNewBatch}
          </button>
          <div className="section-label">{t.batchOpenExisting}</div>
          {batches.map((b) => (
            <button
              key={b.id}
              className={`btn ${batch?.id === b.id ? "btn-accent" : ""}`}
              style={{ textAlign: "left", display: "block" }}
              onClick={() => openBatch(b.id)}
            >
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                {b.name}
              </div>
              <div className="hint">
                {t.batchProgress(b.done, b.total)}
                {b.error > 0 && ` · ${t.batchErrors(b.error)}`}
                {b.paused && " · ⏸"}
              </div>
            </button>
          ))}
        </aside>

        {/* основная область */}
        <main style={{ flex: 1, padding: 20, overflowY: "auto" }}>
          {!batch ? (
            // ── создание батча ──
            <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div className="section-label">{t.batchName}</div>
                <input
                  className="text-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={new Date().toISOString().slice(0, 10)}
                />
              </div>
              <div>
                <div className="section-label">{t.batchPreset}</div>
                {presets.length === 0 ? (
                  <p className="hint">{t.batchNoPresets}</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {presets.map((p) => (
                      <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <label
                          style={{ flex: 1, display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}
                        >
                          <input
                            type="radio"
                            name="preset"
                            checked={newPresetId === p.id}
                            onChange={() => setNewPresetId(p.id)}
                          />
                          {p.name}
                        </label>
                        <button className="btn btn-sm" onClick={() => openPresetEditor(p)}>
                          {t.presetEdit}
                        </button>
                        <button className="btn btn-sm" onClick={() => removePreset(p.id)}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="section-label">{t.batchOutputFolder}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="text-input"
                    value={newOutputDir}
                    onChange={(e) => setNewOutputDir(e.target.value)}
                    placeholder="C:\Videos\ready"
                  />
                  {typeof window !== "undefined" && window.titryNative && (
                    <button className="btn" onClick={browseOutput}>
                      {t.browse}
                    </button>
                  )}
                </div>
              </div>
              {createError && <p className="hint" style={{ color: "#ff6b6b" }}>{createError}</p>}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-accent"
                  disabled={creating || !newPresetId || !newOutputDir.trim()}
                  onClick={() => createBatch()}
                >
                  {creating ? t.batchCreating : t.batchCreate}
                </button>
                {typeof window !== "undefined" && window.titryNative && (
                  <button
                    className="btn"
                    disabled={creating || !newPresetId || !newOutputDir.trim()}
                    onClick={createFromFolder}
                  >
                    {t.batchPickZipFolder}
                  </button>
                )}
              </div>
            </div>
          ) : (
            // ── батч ──
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 17, flex: 1 }}>{batch.name}</h2>
                <span className="hint">
                  {t.batchProgress(doneCount, batch.items.length)}
                  {errorCount > 0 && ` · ${t.batchErrors(errorCount)}`}
                </span>
                {batch.paused ? (
                  <button className="btn" onClick={() => batchAction("resume")}>
                    {t.batchResume}
                  </button>
                ) : (
                  <button className="btn" onClick={() => batchAction("pause")}>
                    {t.batchPause}
                  </button>
                )}
                {errorCount > 0 && (
                  <button className="btn" onClick={() => batchAction("retry-failed")}>
                    {t.batchRetryFailed}
                  </button>
                )}
                <button className="btn" onClick={() => zipInputRef.current?.click()}>
                  {t.batchAddZips}
                </button>
                <button className="btn btn-ghost" onClick={deleteBatch}>
                  🗑
                </button>
              </div>
              <p className="hint">
                {batch.outputDir} · {batch.preset.name}
              </p>
              {batch.paused && <p className="hint">{t.batchPausedNote}</p>}
              {upload.total > 0 && (
                <p className="hint">{t.batchUploadingZips(upload.done, upload.total)}</p>
              )}
              <p className="hint">{t.batchDropHint}</p>

              <input
                ref={zipInputRef}
                type="file"
                accept=".zip"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  uploadZips(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />

              {batch.items.length === 0 && <p className="hint">{t.batchEmpty}</p>}

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {batch.items.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.04)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.name}
                      </div>
                      {item.error && (
                        <div className="hint" style={{ color: "#ff6b6b", whiteSpace: "normal" }}>
                          {item.error}
                        </div>
                      )}
                    </div>
                    {item.clipCount != null && (
                      <span className="hint">{t.batchClips(item.clipCount)}</span>
                    )}
                    {item.status === "render" && (
                      <div className="progress-track" style={{ width: 90 }}>
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.round(item.progress * 100)}%` }}
                        />
                      </div>
                    )}
                    <span
                      className="hint"
                      style={{
                        minWidth: 110,
                        textAlign: "right",
                        color:
                          item.status === "done"
                            ? "#6bd18b"
                            : item.status === "error"
                              ? "#ff6b6b"
                              : undefined,
                      }}
                    >
                      {statusLabel[item.status]}
                      {item.status === "render" && ` ${Math.round(item.progress * 100)}%`}
                    </span>
                    {item.status === "error" && (
                      <button className="btn btn-sm" onClick={() => batchAction("retry", item.id)}>
                        {t.batchRetry}
                      </button>
                    )}
                    {item.outputFile && (
                      <button
                        className="btn btn-sm"
                        onClick={() => setPreview({ itemId: item.id, kind: "final" })}
                      >
                        ▶ {t.batchPreview}
                      </button>
                    )}
                    {item.projectId && item.status === "done" && (
                      <a
                        className="btn btn-sm"
                        style={{ textDecoration: "none" }}
                        href={`/?project=${item.projectId}`}
                        title={t.iterSection}
                      >
                        🎬 {t.batchOpenTimeline}
                      </a>
                    )}
                    {item.cleanFile && (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setPreview({ itemId: item.id, kind: "clean" })}
                        title={t.batchPreviewClean}
                      >
                        ▶ clean
                      </button>
                    )}
                    {item.outputFile &&
                      typeof window !== "undefined" &&
                      window.titryNative && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => window.titryNative?.showInFolder(item.outputFile!)}
                          title={batch.outputDir}
                        >
                          📂
                        </button>
                      )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* предпросмотр */}
      {preview && previewItem && batch && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div
            className="modal"
            style={{ maxWidth: 420, padding: 12 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              {previewItem.name}
              {preview.kind === "clean" && ` · ${t.batchPreviewClean}`}
            </div>
            <video
              key={`${preview.itemId}-${preview.kind}`}
              src={`/api/batch/${batch.id}/file?item=${preview.itemId}&kind=${preview.kind}`}
              controls
              autoPlay
              style={{ width: "100%", maxHeight: "70vh", borderRadius: 8 }}
            />
          </div>
        </div>
      )}

      {/* редактор пресета */}
      {presetOpen && editPreset && (
        <div className="modal-overlay" onClick={() => setPresetOpen(false)}>
          <div
            className="modal"
            style={{ maxWidth: 980, width: "min(94vw, 980px)", maxHeight: "92vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">{t.presetManage}</div>
            <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
            {/* живое превью: как будут выглядеть субтитры и дисклеймер */}
            {editPreset.captions !== false && (
              <div style={{ width: 280, flexShrink: 0, position: "sticky", top: 4 }}>
                <PresetPreview
                  styleId={editPreset.styleId ?? "hormozi"}
                  overrides={editPreset.overrides ?? {}}
                  disclaimer={editPreset.disclaimer ?? null}
                  sampleWords={t.presetPreviewWords}
                  hint={t.presetPreviewHint}
                  onPositionYChange={(y) =>
                    setEditPreset((p) =>
                      p ? { ...p, overrides: { ...(p.overrides ?? {}), positionY: y } } : p
                    )
                  }
                />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div className="section-label">{t.presetName}</div>
                <input
                  className="text-input"
                  value={editPreset.name ?? ""}
                  onChange={(e) => setEditPreset({ ...editPreset, name: e.target.value })}
                />
              </div>

              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={editPreset.captions ?? true}
                  onChange={(e) => setEditPreset({ ...editPreset, captions: e.target.checked })}
                />
                {t.presetCaptions}
              </label>

              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={editPreset.trimSilence ?? false}
                  onChange={(e) =>
                    setEditPreset({ ...editPreset, trimSilence: e.target.checked })
                  }
                />
                <span className="hint" style={{ whiteSpace: "normal" }}>
                  {t.presetTrimSilence}
                </span>
              </label>

              {editPreset.captions !== false && (
                <>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="hint" style={{ flex: 1 }}>{t.presetLanguage}</span>
                    <select
                      className="select"
                      value={editPreset.language ?? "auto"}
                      onChange={(e) => setEditPreset({ ...editPreset, language: e.target.value })}
                    >
                      <option value="auto">{t.langAuto}</option>
                      <option value="uk">{t.langUk}</option>
                      <option value="ru">Русский</option>
                      <option value="en">{t.langEn}</option>
                    </select>
                  </div>
                  <div className="section-label">{t.presetStyleSection}</div>
                  <StylePanel
                    t={t}
                    styleId={editPreset.styleId ?? "hormozi"}
                    overrides={editPreset.overrides ?? {}}
                    onStyleChange={(styleId) => setEditPreset({ ...editPreset, styleId })}
                    onOverridesChange={(overrides: StyleOverrides) =>
                      setEditPreset({ ...editPreset, overrides })
                    }
                  />
                </>
              )}

              <div>
                <div className="section-label">{t.presetDisclaimer}</div>
                <input
                  className="text-input"
                  value={editPreset.disclaimer?.text ?? ""}
                  onChange={(e) =>
                    setEditPreset({
                      ...editPreset,
                      disclaimer: e.target.value.trim()
                        ? {
                            text: e.target.value,
                            sizeRatio: editPreset.disclaimer?.sizeRatio ?? 0.02,
                            positionY: editPreset.disclaimer?.positionY ?? 0.04,
                          }
                        : null,
                    })
                  }
                />
                <p className="hint">{t.presetDisclaimerHint}</p>
                {editPreset.disclaimer?.text?.trim() && (
                  <>
                    <div className="control-row">
                      <span className="control-label">{t.size}</span>
                      <input
                        type="range"
                        min={0.01}
                        max={0.05}
                        step={0.001}
                        value={editPreset.disclaimer.sizeRatio}
                        onChange={(e) =>
                          setEditPreset({
                            ...editPreset,
                            disclaimer: {
                              ...editPreset.disclaimer!,
                              sizeRatio: Number(e.target.value),
                            },
                          })
                        }
                      />
                      <span className="control-value">
                        {Math.round((editPreset.disclaimer.sizeRatio / 0.018) * 100)}%
                      </span>
                    </div>
                    <div className="control-row">
                      <span className="control-label">{t.position}</span>
                      <input
                        type="range"
                        min={0.03}
                        max={0.97}
                        step={0.01}
                        value={editPreset.disclaimer.positionY}
                        onChange={(e) =>
                          setEditPreset({
                            ...editPreset,
                            disclaimer: {
                              ...editPreset.disclaimer!,
                              positionY: Number(e.target.value),
                            },
                          })
                        }
                      />
                      <span className="control-value">
                        {Math.round(editPreset.disclaimer.positionY * 100)}%
                      </span>
                    </div>
                  </>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="hint" style={{ flex: 1 }}>{t.presetMusic}</span>
                <select
                  className="select"
                  value={editPreset.musicTrackId ?? ""}
                  onChange={(e) =>
                    setEditPreset({ ...editPreset, musicTrackId: e.target.value || null })
                  }
                >
                  <option value="">{t.presetMusicNone}</option>
                  {musicTracks.map((tr) => (
                    <option key={tr.id} value={tr.id}>
                      {tr.name}
                    </option>
                  ))}
                </select>
              </div>
              {editPreset.musicTrackId && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="hint" style={{ flex: 1 }}>{t.presetMusicVolume}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={editPreset.musicVolume ?? 0.3}
                    onChange={(e) =>
                      setEditPreset({ ...editPreset, musicVolume: Number(e.target.value) })
                    }
                  />
                  <span className="hint" style={{ width: 36 }}>
                    {Math.round((editPreset.musicVolume ?? 0.3) * 100)}%
                  </span>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="hint" style={{ flex: 1 }}>{t.presetEndcard}</span>
                <select
                  className="select"
                  value={editPreset.endcardId ?? ""}
                  onChange={(e) =>
                    setEditPreset({ ...editPreset, endcardId: e.target.value || null })
                  }
                >
                  <option value="">{t.presetEndcardNone}</option>
                  {endcards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.kind})
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-sm" onClick={() => endcardInputRef.current?.click()}>
                {t.presetEndcardUpload}
              </button>
              <input
                ref={endcardInputRef}
                type="file"
                accept="video/*,image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadEndcard(f);
                  e.target.value = "";
                }}
              />
              {editPreset.endcardId &&
                endcards.find((c) => c.id === editPreset.endcardId)?.kind === "image" && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="hint" style={{ flex: 1 }}>{t.presetEndcardSeconds}</span>
                    <input
                      className="text-input"
                      type="number"
                      min={1}
                      max={30}
                      style={{ width: 70 }}
                      value={(editPreset.endcardDurationMs ?? 3000) / 1000}
                      onChange={(e) =>
                        setEditPreset({
                          ...editPreset,
                          endcardDurationMs: (Number(e.target.value) || 3) * 1000,
                        })
                      }
                    />
                  </div>
                )}

              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={editPreset.cleanCopy ?? true}
                  onChange={(e) => setEditPreset({ ...editPreset, cleanCopy: e.target.checked })}
                />
                <span className="hint" style={{ whiteSpace: "normal" }}>{t.presetCleanCopy}</span>
              </label>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="hint" style={{ flex: 1 }}>{t.presetSizeLimit}</span>
                <input
                  className="text-input"
                  type="number"
                  min={0}
                  max={2000}
                  style={{ width: 80 }}
                  value={editPreset.maxSizeMb ?? 30}
                  onChange={(e) =>
                    setEditPreset({ ...editPreset, maxSizeMb: Number(e.target.value) || 0 })
                  }
                />
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setPresetOpen(false)}>
                  {t.close}
                </button>
                <button
                  className="btn btn-accent"
                  disabled={savingPreset || !editPreset.name?.trim()}
                  onClick={savePreset}
                >
                  {savingPreset ? t.saving : t.presetSave}
                </button>
              </div>
            </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
