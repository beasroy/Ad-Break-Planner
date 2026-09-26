// Stage 1: probe the video, extract mono audio, split into short mp3 chunks (config.audio.chunkSec) with offsets.
import fs from "node:fs/promises";
import path from "node:path";
import type { AudioChunk, IngestArtifact } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { encodeMp3Chunk, extractWav, probe } from "../lib/ffmpeg";
import { artifactPath, type StageContext } from "./context";

export async function runIngest(ctx: StageContext): Promise<IngestArtifact> {
  const out = artifactPath(ctx, ARTIFACTS.ingest);
  const key = hashJson(ctx.config.audio);
  const cached = ctx.force ? undefined : await readKeyed<IngestArtifact>(out, key);
  if (cached) return cached;

  const meta = await probe(ctx.videoPath);
  if (Math.abs(meta.startTimeSec) > 0.05) {
    ctx.log(`note: container start_time is ${meta.startTimeSec}s; all times are relative to media start`);
  }

  const audioDir = artifactPath(ctx, "audio");
  await fs.rm(audioDir, { recursive: true, force: true });
  await fs.mkdir(audioDir, { recursive: true });
  const fullAudio = path.join(audioDir, "full.wav");
  await extractWav(ctx.videoPath, fullAudio, ctx.config.audio.sampleRate);

  const { chunkSec, bitrate } = ctx.config.audio;
  const chunks: AudioChunk[] = [];
  for (let i = 0, offset = 0; offset < meta.durationSec; i++, offset += chunkSec) {
    const durationSec = Math.min(chunkSec, meta.durationSec - offset);
    if (durationSec < 0.5) break;
    const file = path.join(audioDir, `chunk_${String(i).padStart(3, "0")}.mp3`);
    await encodeMp3Chunk(fullAudio, file, offset, durationSec, bitrate);
    chunks.push({ index: i, file, offsetSec: offset, durationSec });
  }

  const artifact: IngestArtifact = { meta, fullAudio, chunks };
  await writeKeyed(out, key, artifact);
  ctx.log(`ingest: ${meta.durationSec.toFixed(1)}s, ${meta.width}x${meta.height} ${meta.videoCodec}, ${chunks.length} chunks`);
  return artifact;
}
