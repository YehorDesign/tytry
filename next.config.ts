import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "esbuild",
    "ffmpeg-static",
    "ffprobe-static",
  ],
};

export default nextConfig;
