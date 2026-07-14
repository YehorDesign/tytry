// Конфиг — обычный JS, не TS: next.config.ts в упакованном приложении
// требует модуль typescript в рантайме (Next пытается доустановить его
// через npm — на машинах дизайнеров это падает с ENOENT).
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "@napi-rs/canvas",
    "esbuild",
    "ffmpeg-static",
    "@ffprobe-installer/ffprobe",
  ],
};

export default nextConfig;
