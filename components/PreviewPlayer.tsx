"use client";

import React, { useMemo } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { CaptionedVideo } from "@/remotion/CaptionedVideo";
import { clipDurationMs, type Project, type ProjectMusic, type StyleOverrides, type TimelineClip, type Word } from "@/lib/types";

const FPS = 30;

export const PreviewPlayer: React.FC<{
  project: Project;
  words: Word[];
  styleId: string;
  overrides: StyleOverrides;
  clips: TimelineClip[] | null; // null = классический проект без монтажа
  music: ProjectMusic | null;
  playerRef: React.RefObject<PlayerRef | null>;
}> = ({ project, words, styleId, overrides, clips, music, playerRef }) => {
  const { width, height, fileName } = project.video;

  const durationMs =
    clips && clips.length > 0
      ? clips.reduce((sum, c) => sum + clipDurationMs(c), 0)
      : project.video.durationMs;

  const inputProps = useMemo(
    () => ({
      videoSrc: `/api/file/uploads/${encodeURIComponent(fileName)}`,
      words,
      styleId,
      overrides,
      width,
      height,
      durationMs,
      clips:
        clips && clips.length > 0
          ? clips.map((c) => ({
              src: `/api/file/uploads/${encodeURIComponent(c.fileName)}`,
              kind: c.kind,
              inMs: c.inMs,
              outMs: c.outMs,
              zoom: c.zoom,
              panX: c.panX,
              panY: c.panY,
            }))
          : undefined,
      musicSrc: music ? `/api/file/music/${encodeURIComponent(music.fileName)}` : null,
      musicVolume: music?.volume,
    }),
    [fileName, words, styleId, overrides, width, height, durationMs, clips, music]
  );

  // вписываем видео в доступную область, сохраняя пропорции
  const aspect = width / height;
  const maxH = "calc(100vh - 200px)";

  return (
    <div
      className="player-frame"
      style={{
        aspectRatio: `${width} / ${height}`,
        height: aspect < 1 ? maxH : undefined,
        width: aspect >= 1 ? "min(100%, 960px)" : undefined,
        maxHeight: maxH,
      }}
    >
      <Player
        ref={playerRef}
        component={CaptionedVideo}
        inputProps={inputProps}
        durationInFrames={Math.max(Math.ceil((durationMs / 1000) * FPS), 1)}
        compositionWidth={width}
        compositionHeight={height}
        fps={FPS}
        controls
        style={{ width: "100%", height: "100%" }}
        acknowledgeRemotionLicense
      />
    </div>
  );
};
