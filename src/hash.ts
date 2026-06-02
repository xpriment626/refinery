import { createHash } from "node:crypto";
import fs from "node:fs";

/** Content hash of a file. Read-only: never mutates the source. */
export function sha256File(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}
