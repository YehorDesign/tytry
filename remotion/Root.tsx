import React from "react";
import { Composition } from "remotion";
import { CaptionedVideo } from "./CaptionedVideo";
import type { CaptionInputProps } from "../lib/types";

export const FPS = 30;

const defaultProps: CaptionInputProps = {
  videoSrc: "",
  words: [],
  styleId: "classic",
  overrides: {},
  width: 1080,
  height: 1920,
  durationMs: 5000,
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CaptionedVideo"
      component={CaptionedVideo}
      durationInFrames={150}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(Math.ceil((props.durationMs / 1000) * FPS), 1),
        width: props.width,
        height: props.height,
        fps: FPS,
        props,
      })}
    />
  );
};
