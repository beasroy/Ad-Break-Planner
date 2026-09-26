import crypto from "node:crypto";
import { createReadStream } from "node:fs";

export function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    createReadStream(p)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export const hashJson = (v: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
