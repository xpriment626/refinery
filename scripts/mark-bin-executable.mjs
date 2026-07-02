import fs from "node:fs";
import path from "node:path";

const binPath = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
fs.chmodSync(binPath, 0o755);
