// Generates a placeholder clip (colour card + tone per brand) for every
// catalogue creative whose file is missing. Stand-ins until real creatives are dropped in.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config";
import { loadCatalogue } from "../src/catalogue/loader";
import { exists } from "../src/lib/artifacts";
import { run } from "../src/lib/ffmpeg";

const catalogue = await loadCatalogue(config.cataloguePath);
const colours = ["0x8e44ad", "0x16a085", "0xc0392b", "0x2980b9", "0xd35400", "0x27ae60", "0x2c3e50", "0xb7950b"];

for (const [i, brand] of catalogue.brands.entries()) {
  for (const creative of brand.creatives) {
    const out = creative.file;
    if (await exists(out)) {
      console.log(`exists  ${path.relative(process.cwd(), out)}`);
      continue;
    }
    await fs.mkdir(path.dirname(out), { recursive: true });
    const d = creative.durationSec;
    // Plain colour card + tone per brand (Homebrew ffmpeg ships without drawtext);
    // the brand name reaches the player through the VAST AdTitle.
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=${colours[i % colours.length]}:s=1280x720:d=${d}:r=25`,
      "-f", "lavfi", "-i", `sine=frequency=${330 + i * 40}:duration=${d}`,
      "-af", "volume=0.05",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      out,
    ]);
    console.log(`created ${path.relative(process.cwd(), out)} (${d}s)`);
  }
}
