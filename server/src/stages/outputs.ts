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

/** Plain-language account of an LLM-mode run, with this run's actual settings filled in. */
function llmExplanation(ctx: StageContext, chunks: number): string[] {
  const { placement: p, pacing, thresholds: t, listen: l } = ctx.config;
  return [
    `Placement mode: LLM. The episode was split into ${chunks} chunks (the ~2 minute audio pieces used for transcription). For each chunk, one LLM call read that chunk's dialogue plus ${p.contextSec}s of dialogue before and after it, with the measured silences (${p.showSilenceMinSec}s or longer) and shot cuts written between the lines, and chose one line after which an ad plays and the brand.`,
    `Code then decides the exact cut time: inside a measured silence after that line (on a shot cut if one falls in it, else its middle), or, if there is none, in the first stretch of the pause with no transcribed word for at least ${t.minSpeechFreeSec}s.`,
    `Checks on every pick, in order: not the same brand as the previous ad; none of the contexts the model reported as nearby is on the brand's never-next-to list or on the list that blocks every brand; fit of at least ${t.minBrandFit}; a cut point exists; nobody speaks at the cut (voice activity ${l.vadSpeechMin} or more rejects it, between ${l.vadQuietMax} and ${l.vadSpeechMin} the audio is re-checked by an LLM); an ad of that brand fits the remaining ad time. If a pick fails, the model's alternatives are tried in order; if none pass, the chunk gets no ad.`,
    `Pacing: an ad is placed at least ${p.minGapSec}s after the previous one, and total ad time stays under ${Math.round(pacing.maxAdLoadPct * 100)}% of the episode. There is no cap on the number of ads and no no-break zones at the start or end.`,
    "Not used in this mode: scene analysis, candidate cut points, the brand ranker, breaks per hour, the no-break zones, the 700ms minimum silence and pacing.minGapSec. They belong to the older rules pipeline (PLACEMENT_MODE=rules), which is why they are left out of this file.",
    "Reading this file: `breaks` are the ads placed. `selection` has one line per chunk with the outcome and reason. `placement.chunks` has, per chunk, the exact prompt the model saw, its answer, and every option it proposed with the cut time, how the cut was found (silence / speechFree), and why it was accepted or rejected. `settingsUsed` lists the values above.",
  ];
}

function llmSettings(ctx: StageContext): Record<string, unknown> {
  const { placement: p, pacing, thresholds: t, listen: l, openrouter } = ctx.config;
  return {
    placementModel: openrouter.reasonModel,
    minGapBetweenAdsSec: p.minGapSec,
    maxAdLoadPct: pacing.maxAdLoadPct,
    contextSecEitherSide: p.contextSec,
    showSilenceMinSec: p.showSilenceMinSec,
    minSpeechFreeSec: t.minSpeechFreeSec,
    cutPaddingMs: t.cutPaddingMs,
    minBrandFit: t.minBrandFit,
    consensusNegativeShare: t.consensusNegativeShare,
    listenCheckCuts: t.listenCheckCuts,
    listen: { windowSec: l.windowSec, vadSpeechMin: l.vadSpeechMin, vadQuietMax: l.vadQuietMax, llmVotes: l.llmVotes },
  };
}

export async function runOutputs(
  ctx: StageContext,
  fileHash: string,
  ingest: IngestArtifact,
  transcript: Transcript,
  scenes: Scene[],
  matched: (Candidate | MatchedCandidate)[],
  selection: { breaks: Break[]; log: SelectionLog[] },
  /** LLM placement mode: per-slot prompts, answers and checks. */
  placement?: unknown,
) {
  // Always regenerated: cheap, and depends on publicBaseUrl.
  await writeFileAtomic(artifactPath(ctx, ARTIFACTS.vmap), buildVmap(selection.breaks, ctx.config.publicBaseUrl));

  const { apiKey: _omit, ...openrouter } = ctx.config.openrouter;
  const { apiKey: _omitDg, ...deepgram } = ctx.config.deepgram;
  const programmePath = artifactPath(ctx, ARTIFACTS.programme);
  const programme = (await exists(programmePath))
    ? (await readJson<{ data: ProgrammeContext }>(programmePath)).data
    : undefined;
  const base = {
    jobId: ctx.jobId,
    fileHash,
    meta: ingest.meta,
    programme,
    transcriptStats: {
      segments: transcript.segments.length,
      dropped: transcript.segments.filter((s) => s.dropped).length,
      rawFieldsSeen: transcript.rawFieldsSeen,
    },
    selection: selection.log,
    breaks: selection.breaks,
  };
  const debug: DebugReport =
    placement === undefined
      ? {
          ...base,
          config: { ...ctx.config, openrouter, deepgram, catalogueHash: ctx.catalogue.hash },
          scenes,
          candidates: matched,
        }
      : {
          // LLM mode: only the settings that took part, and a plain account of how the ads were placed.
          mode: "llm",
          explanation: llmExplanation(ctx, (placement as unknown[]).length),
          settingsUsed: llmSettings(ctx),
          ...base,
          config: { openrouter, deepgram, contentLanguage: ctx.config.contentLanguage, catalogueHash: ctx.catalogue.hash },
          placement: { mode: "llm", chunks: placement },
        };
  await writeJson(artifactPath(ctx, ARTIFACTS.debug), debug);
  ctx.log(`outputs: vmap.xml + debug.json written (${selection.breaks.length} breaks)`);
}
