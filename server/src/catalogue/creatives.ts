// Ad creatives. Uploaded clips are normalised to one mp4 format. Generated ones are title cards
// rendered locally (no image API): the brand name, its category and the contexts it advertises
// into, drawn as an SVG with bundled fonts, then turned into a clip with a slow zoom.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { config } from "../config";
import { PermanentError } from "../lib/errors";
import { run } from "../lib/ffmpeg";
import { chatJson } from "../lib/openrouter";
import { mapLimit } from "../lib/pool";
import { RealNameResponse, realNameJsonSchema, realNameSystemPrompt, realNameUserPrompt } from "../prompts/brandName";
import type { RawBrandData } from "./loader";

const W = 1280;
const H = 720;
const FPS = 25;
const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-ar", "44100", "-movflags", "+faststart"];

/** Bundled (SIL OFL) so cards render the same on any machine. */
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");
const FONTS = fsSync.existsSync(FONT_DIR)
  ? fsSync.readdirSync(FONT_DIR).filter((f) => f.endsWith(".ttf")).map((f) => path.join(FONT_DIR, f))
  : [];

/** Refuses names that look like real companies (auto-disqualifier). A failed check refuses too. */
export async function assertSyntheticName(name: string, category: string): Promise<void> {
  let r;
  try {
    r = RealNameResponse.parse(
      await chatJson({
        label: `brand name check ${name}`,
        system: realNameSystemPrompt,
        user: realNameUserPrompt(name, category),
        schemaName: "real_name_check",
        schema: realNameJsonSchema,
      }),
    );
  } catch (err) {
    throw new Error(`Could not check the brand name, try again (${(err as Error).message.slice(0, 120)})`);
  }
  if (r.is_real_brand) {
    throw new PermanentError(`"${name}" looks like a real brand (${r.matches || "a known company"}). Use a synthetic name.`);
  }
}

async function probeVideo(file: string): Promise<{ durationSec: number; hasAudio: boolean }> {
  let info: any;
  try {
    info = JSON.parse((await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file])).stdout);
  } catch {
    throw new PermanentError("The uploaded ad is not a readable video file");
  }
  if (!info.streams?.some((s: any) => s.codec_type === "video")) throw new PermanentError("The uploaded ad has no video stream");
  const durationSec = Number(info.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec < 3 || durationSec > 120) {
    throw new PermanentError(`Ad length must be 3–120 seconds (got ${Number.isFinite(durationSec) ? durationSec.toFixed(1) : "unknown"})`);
  }
  return { durationSec, hasAudio: info.streams.some((s: any) => s.codec_type === "audio") };
}

/** Re-encodes an uploaded ad to 1280x720 H.264/AAC mp4 (letterboxed; silent track added if none). Returns its length. */
export async function normaliseUpload(input: string, out: string): Promise<number> {
  const { durationSec, hasAudio } = await probeVideo(input);
  const scale = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const audio = hasAudio ? [] : ["-f", "lavfi", "-t", String(durationSec), "-i", "anullsrc=r=44100:cl=stereo"];
  const map = hasAudio ? ["-map", "0:v:0", "-map", "0:a:0"] : ["-map", "0:v:0", "-map", "1:a:0"];
  await run("ffmpeg", ["-y", "-v", "error", "-i", input, ...audio, ...map, "-vf", scale, "-t", String(durationSec), ...encode, out]);
  return Math.round(durationSec * 10) / 10;
}

// ---- Title cards

export interface CardBrand {
  id: string;
  name: string;
  category: string;
  targetContexts: string[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Deterministic brand colour from its id, so each brand's cards look consistent. */
const brandHue = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);

/**
 * The SVG renderer (resvg) cannot shape Bengali correctly: it drops conjuncts and spaces (checked
 * with both Noto Sans Bengali and Kohinoor Bangla). Cards therefore carry Latin text only; strings
 * in another script are left off rather than drawn broken.
 */
const isLatin = (s: string) => !/[^\u0000-\u024F\u2000-\u206F]/.test(s);
const FONT = "Noto Sans";

/** Rough text width for layout (Noto Sans averages ~0.56em per character). */
const textWidth = (s: string, size: number) => [...s].length * size * 0.56;

/** Pure: the title card as SVG: brand name, category, and the contexts it advertises into. */
export function titleCardSvg(b: CardBrand): string {
  const hue = brandHue(b.id);
  const category = isLatin(b.category) ? b.category : "";
  const name = isLatin(b.name.trim()) ? b.name.trim() : category || "Advertisement";
  const nameSize = Math.max(56, Math.min(112, Math.floor(1080 / Math.max(1, [...name].length * 0.56))));
  const font = FONT;

  // Context chips, wrapped over at most two rows.
  const chips: string[] = [];
  let x = 96;
  let y = 470;
  let rows = 1;
  for (const c of b.targetContexts.filter(isLatin).slice(0, 10)) {
    const w = textWidth(c, 26) + 40;
    if (x + w > W - 96) {
      if (++rows > 2) break;
      x = 96;
      y += 64;
    }
    chips.push(
      `<rect x="${x}" y="${y}" width="${w}" height="46" rx="23" fill="white" fill-opacity="0.12" stroke="white" stroke-opacity="0.25"/>` +
        `<text x="${x + w / 2}" y="${y + 31}" font-family="${font}" font-size="26" fill="white" text-anchor="middle">${esc(c)}</text>`,
    );
    x += w + 14;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},55%,30%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,12%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.7">
      <stop offset="0" stop-color="hsl(${hue},80%,60%)" stop-opacity="0.45"/>
      <stop offset="1" stop-color="hsl(${hue},80%,60%)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <circle cx="${W - 150}" cy="${H - 120}" r="260" fill="white" fill-opacity="0.04"/>
  <text x="96" y="120" font-family="${font}" font-size="22" font-weight="700" letter-spacing="6" fill="white" fill-opacity="0.6">ADVERTISEMENT</text>
  <text x="96" y="330" font-family="${font}" font-size="${nameSize}" font-weight="700" fill="white">${esc(name)}</text>
  <rect x="96" y="362" width="96" height="6" rx="3" fill="hsl(${hue},85%,65%)"/>
  <text x="96" y="420" font-family="${font}" font-size="30" letter-spacing="4" fill="white" fill-opacity="0.85">${esc(category.toUpperCase())}</text>
  ${chips.join("\n  ")}
</svg>`;
}

/** Renders the title card to a PNG file. */
export async function renderTitleCard(b: CardBrand, out: string) {
  const png = new Resvg(titleCardSvg(b), {
    font: { fontFiles: FONTS, loadSystemFonts: FONTS.length === 0, defaultFontFamily: "Noto Sans" },
  })
    .render()
    .asPng();
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, png);
  return out;
}

/** A still image as a video with a slow zoom (Ken Burns), with a quiet tone bed. */
export async function imageClip(image: string, out: string, durationSec: number) {
  const frames = Math.round(durationSec * FPS);
  const zoom = `zoompan=z='min(1+0.06*on/${frames},1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", image,
    "-f", "lavfi", "-t", String(durationSec), "-i", "sine=frequency=262:sample_rate=44100",
    "-filter_complex", `[0:v]scale=${W * 2}:${H * 2},${zoom}[v];[1:a]volume=0.03[a]`,
    "-map", "[v]", "-map", "[a]", "-t", String(durationSec), ...encode, out,
  ]);
}

/** Title-card clips for a new brand, one per requested length. */
export async function titleCardCreatives(
  brand: CardBrand,
  dir: string,
  durations: number[],
  language: string,
): Promise<{ id: string; durationSec: number; language: string; file: string }[]> {
  const card = await renderTitleCard(brand, path.join(dir, "card.png"));
  const short = brand.id.replace(/^brand_/, "").slice(0, 24);
  const out = [];
  for (const d of durations) {
    const id = `${short}_${d}s_${language}`;
    const file = path.join(dir, `${id}.mp4`);
    await imageClip(card, file, d);
    out.push({ id, durationSec: d, language, file });
  }
  return out;
}

const cardBrand = (b: RawBrandData): CardBrand => ({
  id: b.brand_id,
  name: b.display_name,
  category: b.category ?? "",
  targetContexts: b.target_contexts ?? [],
});

/**
 * Makes title-card clips for creatives whose files are missing (or all of them with `force`),
 * at the paths the catalogue expects. Returns how many clips were made.
 */
export async function ensureCreativeFiles(brands: RawBrandData[], catalogueDir: string, opts: { force?: boolean } = {}) {
  let made = 0;
  await mapLimit(brands, 2, async (b) => {
    const todo = b.creatives
      .map((c) => ({ c, file: path.resolve(catalogueDir, c.url) }))
      .filter(({ file }) => opts.force || !fsSync.existsSync(file));
    if (!todo.length) return;
    const card = await renderTitleCard(cardBrand(b), path.join(path.dirname(todo[0].file), "card.png"));
    for (const { c, file } of todo) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Write next to the target, then swap, so a player streaming the old file never reads half a new one.
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp.mp4`);
      await imageClip(card, tmp, c.duration_sec);
      await fs.rename(tmp, file);
      made++;
    }
  });
  return made;
}

export const brandAdsDir = (brandId: string) => path.join(path.dirname(config.cataloguePath), "ads", brandId);
