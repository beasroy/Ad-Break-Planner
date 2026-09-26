// Stage 3: ffmpeg-only signals. Silence windows from the wav, shot cuts from the video.
import type { IngestArtifact, Signals } from "shared";
import { ARTIFACTS, exists, readJson, writeJson } from "../lib/artifacts";
import { detectShotCuts, detectSilences } from "../lib/ffmpeg";
import { artifactPath, type StageContext } from "./context";

export async function runSignals(ctx: StageContext, ingest: IngestArtifact): Promise<Signals> {
  const out = artifactPath(ctx, ARTIFACTS.signals);
  if (!ctx.force && (await exists(out))) return readJson(out);

  const s = ctx.config.signals;
  const [silences, shotCuts] = await Promise.all([
    detectSilences(ingest.fullAudio, s.silenceNoiseDb, s.silenceMinSec, ingest.meta.durationSec),
    detectShotCuts(ctx.videoPath, s.sceneThreshold, s.sceneScaleWidth),
  ]);

  const signals: Signals = { silences, shotCuts };
  await writeJson(out, signals);
  const silentSec = silences.reduce((t, i) => t + (i.end - i.start), 0);
  ctx.log(`signals: ${silences.length} silences (${silentSec.toFixed(0)}s total), ${shotCuts.length} shot cuts`);
  return signals;
}
