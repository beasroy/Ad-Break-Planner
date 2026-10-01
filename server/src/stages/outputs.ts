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
import { maybeRepo } from "../db";
import { ARTIFACTS, exists, readJson, writeFileAtomic, writeJson } from "../lib/artifacts";
import { buildVmap } from "../xml/vmap";
import { artifactPath, type StageContext } from "./context";
import { maxBrandRepeats } from "./placement";

/** Every API call recorded for this video so far, however many attempts that took. Undefined outside
 *  the running app (a CLI/script run never opens the database — see maybeRepo). */
function costSummary(jobId: string): DebugReport["costSummary"] {
  const audit = maybeRepo()?.getAudit(jobId);
  if (!audit) return undefined;
  return { totalUsd: audit.totals.costUsd, totalCalls: audit.totals.calls, totalErrors: audit.totals.errors, byStage: audit.byStage, byKind: audit.byKind };
}

/** Plain-language account of an LLM-mode run, with this run's actual settings filled in. */
function llmExplanation(ctx: StageContext, chunks: number, durationSec: number): string[] {
  const { placement: p, pacing, listen: l, scoring } = ctx.config;
  const repeatCap = maxBrandRepeats(durationSec);
  return [
    `Placement mode: LLM. The episode was split into ${chunks} chunks (the ~2 minute audio pieces used for transcription). Every chunk was called independently and in parallel — none was told what any other chunk decided. Each call read that chunk's dialogue plus ${p.contextSec}s of dialogue before and after it, with the measured silences (${p.showSilenceMinSec}s or longer) and shot cuts written between the lines, and proposed a best line-and-brand pick plus up to 2 alternatives.`,
    `For every option the model proposed, code found the exact cut time — inside a measured silence after that line (on a shot cut if one falls in it, else its middle), or, if there is none, in the first stretch of the pause with no transcribed word for at least ${ctx.config.thresholds.minSpeechFreeSec}s — and rejected it outright if none of the contexts it reported as nearby is on the brand's never-next-to list or the list that blocks every brand, and if its fit is below ${p.minBrandFit} — a strict floor: fit is the main gate on what airs at all in this mode.`,
    `Once every chunk had answered, code chose the highest total quality combination across all of them (${Math.round(scoring.combined.where * 100)}% how good the pause is, ${Math.round(scoring.combined.brandFit * 100)}% brand fit), subject to total ad time under ${Math.round(pacing.maxAdLoadPct * 100)}% of the episode and never the same brand on two ads next to each other. There is no minimum gap between ads and no target ad count: any two ads clearing the ${p.minBrandFit} fit floor can sit as close together as the content allows, and there is no preference for more ads over fewer either — a chunk with no eligible candidate is simply left empty. No ad plays in the last ${p.noAdLastSec}s of the episode, and none in the first slot either — there is no no-break zone at the start.`,
    `A brand can repeat across the episode, but it costs ${p.brandRepeatPenalty} off a candidate's score for every earlier use of that brand — a tie-break, not a ban, so a repeat still airs when nothing fresher scores close to it — and it is capped outright at ${repeatCap} airings this episode (this length gets ${repeatCap}; the cap only rises to 3 past about 75 minutes). With this catalogue's ${ctx.catalogue.brands.length} brands, some repetition across a longer episode is expected.`,
    `Last, every chosen cut was checked for speech (voice activity ${l.vadSpeechMin} or more rejects it, between ${l.vadQuietMax} and ${l.vadSpeechMin} the audio is re-checked by an LLM). A cut that fails is dropped and the schedule is redrawn without it.`,
    "Not used in this mode: scene analysis, candidate cut points, the brand ranker, breaks per hour, the first/last no-break zones, the 700ms minimum silence, and pacing.minGapSec / thresholds.minBrandFit (the rules pipeline's own, separate gap and fit floor). They belong to the older rules pipeline (PLACEMENT_MODE=rules), which is why they are left out of this file.",
    "Reading this file: `breaks` are the ads placed. `selection` has one line per chunk with the outcome and reason. `placement.chunks` has, per chunk, the exact prompt the model saw, its answer, and every option it proposed with the cut time, how the cut was found (silence / speechFree), and why it was accepted or rejected — including options that passed every content check but lost to a better schedule elsewhere, or would have repeated a brand past its cap. `settingsUsed` lists the values above. `costSummary` is every API call this video has ever made (across every attempt, including earlier retries) with what it cost, by pipeline stage and by what the call was for.",
  ];
}

function llmSettings(ctx: StageContext, durationSec: number): Record<string, unknown> {
  const { placement: p, pacing, thresholds: t, listen: l, openrouter, scoring } = ctx.config;
  return {
    placementModel: openrouter.reasonModel,
    minBrandFit: p.minBrandFit,
    noAdLastSec: p.noAdLastSec,
    maxAdLoadPct: pacing.maxAdLoadPct,
    scheduleScoreWeights: scoring.combined,
    brandRepeatPenalty: p.brandRepeatPenalty,
    maxBrandRepeatsThisEpisode: maxBrandRepeats(durationSec),
    contextSecEitherSide: p.contextSec,
    showSilenceMinSec: p.showSilenceMinSec,
    minSpeechFreeSec: t.minSpeechFreeSec,
    cutPaddingMs: t.cutPaddingMs,
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
  const { apiKey: _omitSc, ...scribe } = ctx.config.scribe;
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
    costSummary: costSummary(ctx.jobId),
  };
  const debug: DebugReport =
    placement === undefined
      ? {
          ...base,
          config: { ...ctx.config, openrouter, scribe, catalogueHash: ctx.catalogue.hash },
          scenes,
          candidates: matched,
        }
      : {
          // LLM mode: only the settings that took part, and a plain account of how the ads were placed.
          mode: "llm",
          explanation: llmExplanation(ctx, (placement as unknown[]).length, ingest.meta.durationSec),
          settingsUsed: llmSettings(ctx, ingest.meta.durationSec),
          ...base,
          config: { openrouter, scribe, contentLanguage: ctx.config.contentLanguage, catalogueHash: ctx.catalogue.hash },
          placement: { mode: "llm", chunks: placement },
        };
  await writeJson(artifactPath(ctx, ARTIFACTS.debug), debug);
  ctx.log(`outputs: vmap.xml + debug.json written (${selection.breaks.length} breaks)`);
}
