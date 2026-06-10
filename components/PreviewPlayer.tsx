"use client";

import React, { useMemo } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { CaptionedVideo } from "@/remotion/CaptionedVideo";
import type { Project, StyleOverrides, Word } from "@/lib/types";

const FPS = 30;

export const PreviewPlayer: React.FC<{
  project: Project;
  words: Word[];
  styleId: string;
  overrides: StyleOverrides;
  playerRef: React.RefObject<PlayerRef | null>;
}> = ({ project, words, styleId, overrides, playerRef }) => {
  const { width, height, durationMs, fileName } = project.video;

  const inputProps = useMemo(
    () => ({
      videoSrc: `/api/file/uploads/${encodeURIComponent(fileName)}`,
      words,
      styleId,
      overrides,
      width,
      height,
      durationMs,
    }),
    [fileName, words, styleId, overrides, width, height, durationMs]
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
