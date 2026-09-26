// Ad creatives for brands created on the brands page: uploaded clips are normalised to one mp4
// format; generated ones are an AI image with a slow zoom. Generation never blocks brand creation:
// if the image model fails, a plain colour card is used (what the sample brands ship with).
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { PermanentError } from "../lib/errors";
import { run } from "../lib/ffmpeg";
import { chatJson, generateImage } from "../lib/openrouter";
import {
  CopyResponse,
  RealNameResponse,
  copyJsonSchema,
  copySystemPrompt,
  copyUserPrompt,
  imagePrompt,
  realNameJsonSchema,
  realNameSystemPrompt,
  realNameUserPrompt,
} from "../prompts/brandCopy";

const W = 1280;
const H = 720;
const FPS = 25;
const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-ar", "44100", "-movflags", "+faststart"];

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

export async function writeCopy(b: { name: string; category: string; targetContexts: string[]; language: string }) {
  return CopyResponse.parse(
    await chatJson({ label: `ad copy ${b.name}`, system: copySystemPrompt, user: copyUserPrompt(b), schemaName: "ad_copy", schema: copyJsonSchema }),
  );
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

/** A still image as a video with a slow zoom (Ken Burns), with a quiet tone bed. */
async function imageClip(image: string, out: string, durationSec: number) {
  const frames = Math.round(durationSec * FPS);
  const zoom = `zoompan=z='min(1+0.12*on/${frames},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", image,
    "-f", "lavfi", "-t", String(durationSec), "-i", "sine=frequency=262:sample_rate=44100",
    "-filter_complex", `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},${zoom}[v];[1:a]volume=0.03[a]`,
    "-map", "[v]", "-map", "[a]", "-t", String(durationSec), ...encode, out,
  ]);
}

async function colourCard(out: string, durationSec: number, seed: string) {
  const hue = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const colour = `0x${hslToHex(hue, 0.45, 0.35)}`;
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=${colour}:s=${W}x${H}:d=${durationSec}:r=${FPS}`,
    "-f", "lavfi", "-t", String(durationSec), "-i", "sine=frequency=294:sample_rate=44100",
    "-af", "volume=0.03", "-shortest", ...encode, out,
  ]);
}

/**
 * Creates one clip per requested length from an AI image of the brand's world. Falls back to a
 * colour card (and says so) if the image cannot be generated, so creating a brand never fails on it.
 */
export async function generateCreatives(
  brand: { id: string; category: string; targetContexts: string[] },
  dir: string,
  durations: number[],
  language: string,
): Promise<{ creatives: { id: string; durationSec: number; language: string; file: string }[]; warning?: string }> {
  await fs.mkdir(dir, { recursive: true });
  let image: string | undefined;
  let warning: string | undefined;
  try {
    const img = await generateImage({ label: `ad image ${brand.id}`, prompt: imagePrompt(brand) });
    image = path.join(dir, `image.${img.ext}`);
    await fs.writeFile(image, img.bytes);
  } catch (err) {
    warning = `Image generation failed, used a plain colour card instead (${(err as Error).message.slice(0, 120)})`;
  }
  const short = brand.id.replace(/^brand_/, "").slice(0, 24);
  const creatives = [];
  for (const d of durations) {
    const id = `${short}_${d}s_${language}`;
    const file = path.join(dir, `${id}.mp4`);
    if (image) await imageClip(image, file, d);
    else await colourCard(file, d, brand.id);
    creatives.push({ id, durationSec: d, language, file });
  }
  return { creatives, warning };
}

export const brandAdsDir = (brandId: string) => path.join(path.dirname(config.cataloguePath), "ads", brandId);

function hslToHex(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `${f(0)}${f(8)}${f(4)}`;
}
