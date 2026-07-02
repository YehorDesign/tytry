import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "@napi-rs/canvas",
    "esbuild",
    "ffmpeg-static",
    "ffprobe-static",
  ],
};

export default nextConfig;
