// Silero VAD v5 (MIT, server/models/silero_vad.onnx): per-32ms speech probability, run locally
// through the WebAssembly ONNX runtime so it works on any OS/CPU without native builds.
import { spawn } from "node:child_process";
import * as ort from "onnxruntime-web";

/** Bump when the model file or the scoring below changes (part of the match-stage cache key). */
export const VAD_VERSION = 1;

const SR = 16_000;
const FRAME = 512; // samples per model step = 32 ms
const CONTEXT = 64; // v5 expects the previous 64 samples prepended to each frame
export const VAD_FRAME_SEC = FRAME / SR;

let session: Promise<ort.InferenceSession> | undefined;
let queue: Promise<unknown> = Promise.resolve();

function load(modelPath: string) {
  ort.env.wasm.numThreads = 1;
  session ??= ort.InferenceSession.create(modelPath);
  return session;
}

/** Mono 16 kHz float samples of [fromSec, fromSec + durSec) from any audio/video file. */
function decode(file: string, fromSec: number, durSec: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-ss", String(Math.max(0, fromSec)), "-t", String(durSec), "-i", file];
    const p = spawn("ffmpeg", [...args, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg (vad decode) exited ${code}: ${err.slice(0, 300)}`));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.byteLength / 4);
      // Copy: a Float32Array view needs a 4-byte-aligned offset, which a pooled Buffer may not have.
      resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)));
    });
  });
}

/** Speech probability for each 32 ms frame of the given samples (the model keeps state across frames). */
async function probs(modelPath: string, x: Float32Array): Promise<number[]> {
  const s = await load(modelPath);
  let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);
  let ctx = new Float32Array(CONTEXT);
  const out: number[] = [];
  for (let i = 0; i + FRAME <= x.length; i += FRAME) {
    const input = new Float32Array(CONTEXT + FRAME);
    input.set(ctx);
    input.set(x.subarray(i, i + FRAME), CONTEXT);
    const r = await s.run({ input: new ort.Tensor("float32", input, [1, CONTEXT + FRAME]), state, sr });
    state = r.stateN;
    out.push((r.output.data as Float32Array)[0]);
    ctx = input.slice(FRAME);
  }
  return out;
}

export interface VadScore {
  /** Highest speech probability of any frame in the window. */
  max: number;
  /** Share of frames in the window with probability above 0.5. */
  frac: number;
}

/** Pure: max and share-above-0.5 of the frames that fall inside [winStart, winEnd) (times relative to the clip). */
export function windowScore(p: number[], winStart: number, winEnd: number): VadScore {
  const w = p.slice(Math.max(0, Math.floor(winStart / VAD_FRAME_SEC)), Math.ceil(winEnd / VAD_FRAME_SEC));
  if (!w.length) return { max: 0, frac: 0 };
  return { max: Math.max(...w), frac: w.filter((v) => v > 0.5).length / w.length };
}

/**
 * Speech score within ±halfWindowSec of `t`. The model runs from 2 s earlier so its state has
 * settled by the window. Calls are serialised: the model is tiny and one session is not re-entrant.
 */
export function vadAround(modelPath: string, audioFile: string, t: number, halfWindowSec: number): Promise<VadScore> {
  const from = Math.max(0, t - halfWindowSec - 2);
  const winStart = t - halfWindowSec - from;
  const job = queue.then(async () => {
    const x = await decode(audioFile, from, winStart + 2 * halfWindowSec);
    return windowScore(await probs(modelPath, x), winStart, winStart + 2 * halfWindowSec);
  });
  queue = job.catch(() => undefined);
  return job;
}
