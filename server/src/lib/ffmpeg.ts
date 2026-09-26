import { spawn } from "node:child_process";
import type { Interval, VideoMeta } from "shared";
import { PermanentError } from "./errors";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      // No exit code means the process was killed from outside, almost always by the kernel running out of memory.
      else if (code === null) reject(new Error(`${cmd} was killed by ${signal ?? "a signal"} (usually out of memory): ${stderr.slice(-2000)}`));
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function assertFfmpegAvailable(): Promise<void> {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      await run(bin, ["-version"]);
    } catch {
      throw new Error(`FATAL: '${bin}' not found on PATH. Install ffmpeg (e.g. 'brew install ffmpeg') and restart.`);
    }
  }
}

const parseRate = (r?: string) => {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  return d ? n / d : n || 0;
};

export async function probe(file: string): Promise<VideoMeta> {
  // A file ffprobe cannot read, or one without video/audio, will not improve on retry.
  let info: any;
  try {
    info = JSON.parse((await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file])).stdout);
  } catch (err) {
    throw new PermanentError(`Not a readable video file: ${(err as Error).message.slice(0, 300)}`);
  }
  const v = info.streams.find((s: any) => s.codec_type === "video");
  const a = info.streams.find((s: any) => s.codec_type === "audio");
  if (!v) throw new PermanentError("No video stream found");
  if (!a) throw new PermanentError("No audio stream found");
  const durationSec = Number(info.format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new PermanentError("Could not read video duration");
  return {
    durationSec,
    startTimeSec: Number(info.format.start_time ?? 0) || 0,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
    width: v.width,
    height: v.height,
    videoCodec: v.codec_name,
    audioCodec: a.codec_name,
  };
}

/** Full-length mono PCM wav: sample-accurate source for chunking and silence detection. */
export async function extractWav(input: string, out: string, sampleRate: number) {
  await run("ffmpeg", ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le", out]);
}

export async function encodeMp3Chunk(wav: string, out: string, startSec: number, durSec: number, bitrate: string) {
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(startSec), "-t", String(durSec), "-i", wav, "-c:a", "libmp3lame", "-b:a", bitrate, out]);
}

export async function detectSilences(wav: string, noiseDb: number, minSec: number, totalSec: number): Promise<Interval[]> {
  const { stderr } = await run("ffmpeg", ["-v", "info", "-i", wav, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSec}`, "-f", "null", "-"]);
  const out: Interval[] = [];
  let start: number | undefined;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && start !== undefined) {
      out.push({ start, end: Number(e[1]) });
      start = undefined;
    }
  }
  // Silence running to the end of the file has no silence_end line.
  if (start !== undefined) out.push({ start, end: totalSec });
  return out;
}

export async function detectShotCuts(video: string, threshold: number, scaleWidth: number): Promise<number[]> {
  const { stderr } = await run("ffmpeg", [
    "-v", "info", "-an", "-sn", "-dn", "-i", video,
    "-vf", `scale=${scaleWidth}:-2,select='gt(scene,${threshold})',showinfo`,
    "-f", "null", "-",
  ]);
  const cuts: number[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("Parsed_showinfo")) continue;
    const m = line.match(/pts_time:\s*([\d.]+)/);
    if (m) cuts.push(Number(m[1]));
  }
  return cuts;
}
