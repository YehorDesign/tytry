// Собирает Remotion-бандл заранее, чтобы упакованному приложению
// не нужен был webpack во время работы.
import { bundle } from "@remotion/bundler";
import path from "node:path";
import fs from "node:fs";

const root = process.cwd();
const outDir = path.join(root, "remotion-bundle");

fs.rmSync(outDir, { recursive: true, force: true });

const result = await bundle({
  entryPoint: path.join(root, "remotion", "index.ts"),
  outDir,
  onProgress: (p) => {
    if (p % 20 === 0) console.log(`bundling: ${p}%`);
  },
});

console.log(`Remotion bundle ready: ${result}`);
