// Stage 8: vmap.xml + debug.json.
import type {
  Break,
  Candidate,
  DebugReport,
  IngestArtifact,
  MatchedCandidate,
  ProgrammeContext,
  Scene,
  SelectionLog,
  Transcript,
} from "shared";
import { ARTIFACTS, exists, readJson, writeFileAtomic, writeJson } from "../lib/artifacts";
import { buildVmap } from "../xml/vmap";
import { artifactPath, type StageContext } from "./context";

export async function runOutputs(
  ctx: StageContext,
  fileHash: string,
  ingest: IngestArtifact,
  transcript: Transcript,
  scenes: Scene[],
  matched: (Candidate | MatchedCandidate)[],
  selection: { breaks: Break[]; log: SelectionLog[] },
) {
  // Always regenerated: cheap, and depends on publicBaseUrl.
  await writeFileAtomic(artifactPath(ctx, ARTIFACTS.vmap), buildVmap(selection.breaks, ctx.config.publicBaseUrl));

  const { apiKey: _omit, ...openrouter } = ctx.config.openrouter;
  const { apiKey: _omitDg, ...deepgram } = ctx.config.deepgram;
  const programmePath = artifactPath(ctx, ARTIFACTS.programme);
  const programme = (await exists(programmePath))
    ? (await readJson<{ data: ProgrammeContext }>(programmePath)).data
    : undefined;
  const debug: DebugReport = {
    jobId: ctx.jobId,
    fileHash,
    meta: ingest.meta,
    programme,
    config: { ...ctx.config, openrouter, deepgram, catalogueHash: ctx.catalogue.hash },
    transcriptStats: {
      segments: transcript.segments.length,
      dropped: transcript.segments.filter((s) => s.dropped).length,
      rawFieldsSeen: transcript.rawFieldsSeen,
    },
    scenes,
    candidates: matched,
    selection: selection.log,
    breaks: selection.breaks,
  };
  await writeJson(artifactPath(ctx, ARTIFACTS.debug), debug);
  ctx.log(`outputs: vmap.xml + debug.json written (${selection.breaks.length} breaks)`);
}
