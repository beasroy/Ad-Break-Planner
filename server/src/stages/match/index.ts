// Stage 6 ("What"): hard-block eligibility in code, then LLM ranks only eligible brands.
import fs from "node:fs/promises";
import path from "node:path";
import type { Brand, Candidate, IngestArtifact, MatchedCandidate, ProgrammeContext, Scene } from "shared";
import { encodeMp3Chunk } from "../../lib/ffmpeg";
import { ARTIFACTS, readKeyed, writeKeyed } from "../../lib/artifacts";
import { hashJson } from "../../lib/hash";
import { chatJson } from "../../lib/openrouter";
import { mapLimit } from "../../lib/pool";
import {
  PROGRAMME_PROMPT_VERSION,
  ProgrammeResponse,
  programmeJsonSchema,
  programmeSystemPrompt,
  programmeUserPrompt,
} from "../../prompts/programme";
import { RANK_PROMPT_VERSION, RankResponse, rankJsonSchema, rankSystemPrompt, rankUserPrompt } from "../../prompts/rank";
import {
  LISTEN_CLIP_SEC,
  LISTEN_CUT_AT_SEC,
  LISTEN_PROMPT_VERSION,
  ListenResponse,
  listenJsonSchema,
  listenSystemPrompt,
  listenUserText,
} from "../../prompts/listen";
import { artifactPath, type StageContext } from "../context";
import { decideEligibility, type EligibilityThresholds } from "./eligibility";

export type RankFn = (before: Scene, after: Scene, eligible: Brand[]) => Promise<MatchedCandidate["ranked"]>;

/** LLM ranking; unknown ids are discarded, eligible brands the model skipped get fit 0. */
export const llmRank =
  (ctx: StageContext, label: string, programme?: ProgrammeContext): RankFn =>
  async (before, after, eligible) => {
    const ids = eligible.map((b) => b.id);
    const raw = await chatJson({
      label,
      system: rankSystemPrompt,
      user: rankUserPrompt(before, after, eligible, programme),
      schemaName: "brand_ranking",
      schema: rankJsonSchema(ids),
    });
    const allowed = new Set(ids);
    const byId = new Map<string, { brandId: string; fit: number; reason: string }>();
    for (const r of RankResponse.parse(raw).rankings) {
      if (allowed.has(r.brand_id) && !byId.has(r.brand_id)) byId.set(r.brand_id, { brandId: r.brand_id, fit: r.fit, reason: r.reason });
    }
    return ids.map((id) => byId.get(id) ?? { brandId: id, fit: 0, reason: "not scored by model" });
  };

/** Core of the match stage, with the ranker injectable for tests. */
export async function matchCandidates(
  candidates: Candidate[],
  scenes: Scene[],
  brands: Brand[],
  thresholds: EligibilityThresholds & { minBrandFit: number },
  rank: (c: Candidate) => RankFn,
  concurrency: number,
): Promise<(Candidate | MatchedCandidate)[]> {
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  return mapLimit(candidates, concurrency, async (c) => {
    if (c.rejected) return c;
    const before = sceneById.get(c.sceneBeforeId)!;
    const after = sceneById.get(c.sceneAfterId)!;
    const decisions = decideEligibility(brands, before, after, thresholds);
    const eligible = brands.filter((b) => decisions.find((d) => d.brandId === b.id)?.eligible);

    const m: MatchedCandidate = { ...c, brands: decisions, ranked: [] };
    if (!eligible.length) {
      m.rejected = {
        stage: "match",
        reason: decisions[0]?.unclassified ? "scene unclassified / low confidence: no brand eligible" : "every brand blocked by negative context",
      };
      return m;
    }
    try {
      const ranked = (await rank(c)(before, after, eligible)).sort((x, y) => y.fit - x.fit);
      for (const r of ranked) {
        const d = decisions.find((x) => x.brandId === r.brandId)!;
        d.fit = r.fit;
        d.reason = r.reason;
      }
      // "When unsure, don't place" applied to relevance: an unrelated brand is not placed.
      m.ranked = ranked.filter((r) => r.fit >= thresholds.minBrandFit);
      if (!m.ranked.length) {
        m.rejected = {
          stage: "match",
          reason: `no eligible brand fits the scene (best fit ${ranked[0]?.fit.toFixed(2) ?? "n/a"} < ${thresholds.minBrandFit})`,
        };
      }
    } catch (err) {
      m.rejected = { stage: "match", reason: `brand ranking failed: ${(err as Error).message.slice(0, 200)}` };
    }
    return m;
  });
}

/**
 * Whole-episode context (one LLM call, cached) so brand ranking can use the programme's
 * theme, not just the two scenes around a break. Best effort: ranking works without it.
 */
export async function runProgramme(ctx: StageContext, scenes: Scene[]): Promise<ProgrammeContext | undefined> {
  const out = artifactPath(ctx, ARTIFACTS.programme);
  const key = hashJson({ v: PROGRAMME_PROMPT_VERSION, model: ctx.config.openrouter.reasonModel, scenes: hashJson(scenes) });
  const cached = ctx.force ? undefined : await readKeyed<ProgrammeContext>(out, key);
  if (cached) return cached;
  if (!scenes.length) return undefined;
  try {
    const raw = await chatJson({
      label: "programme",
      system: programmeSystemPrompt,
      user: programmeUserPrompt(scenes),
      schemaName: "programme",
      schema: programmeJsonSchema,
    });
    const p = ProgrammeResponse.parse(raw);
    const programme: ProgrammeContext = { summary: p.summary, genre: p.genre, recurringContexts: p.recurring_contexts.slice(0, 8) };
    await writeKeyed(out, key, programme);
    ctx.log(`programme: ${programme.genre} — ${programme.recurringContexts.join(", ")}`);
    return programme;
  } catch (err) {
    ctx.log(`programme context failed (${(err as Error).message.slice(0, 200)}); ranking without it`);
    return undefined;
  }
}

/**
 * HARD RULE, final gate: an audio LLM listens to a short clip centred on the cut and is
 * asked directly whether anyone speaks within 1s of it. "Yes", or no answer, = no ad.
 */
async function listenCheck(ctx: StageContext, m: MatchedCandidate, wav: string, durationSec: number) {
  const dir = artifactPath(ctx, "listen");
  await fs.mkdir(dir, { recursive: true });
  const start = Math.max(0, m.cutTime! - LISTEN_CUT_AT_SEC);
  const clip = path.join(dir, `cut_${m.cutTime!.toFixed(3)}.mp3`);
  await encodeMp3Chunk(wav, clip, start, Math.min(LISTEN_CLIP_SEC, durationSec - start), "96k");
  try {
    const raw = await chatJson({
      label: `listen ${m.id}`,
      model: ctx.config.openrouter.transcribeModel,
      system: listenSystemPrompt,
      user: [
        { type: "text", text: listenUserText },
        { type: "input_audio", input_audio: { data: (await fs.readFile(clip)).toString("base64"), format: "mp3" } },
      ],
      schemaName: "listen_check",
      schema: listenJsonSchema,
    });
    const r = ListenResponse.parse(raw);
    m.listenCheck = { speech: r.speech_near_mark || r.heard_at_mark === "speech", heard: r.heard_at_mark, transcript: r.transcript };
    if (m.listenCheck.speech) {
      m.rejected = { stage: "match", reason: `listening check heard speech at the cut (${r.transcript.slice(0, 120) || r.heard_at_mark})` };
    }
  } catch (err) {
    m.rejected = { stage: "match", reason: `listening check failed, cannot confirm no speech (${(err as Error).message.slice(0, 120)})` };
  }
}

export async function runMatch(ctx: StageContext, candidates: Candidate[], scenes: Scene[], ingest: IngestArtifact) {
  const out = artifactPath(ctx, ARTIFACTS.matches);
  const key = hashJson({
    v: RANK_PROMPT_VERSION,
    catalogue: ctx.catalogue.hash,
    model: ctx.config.openrouter.reasonModel,
    t: ctx.config.thresholds,
    candidates: hashJson(candidates),
    scenes: hashJson(scenes),
    programme: PROGRAMME_PROMPT_VERSION,
    listen: [LISTEN_PROMPT_VERSION, ctx.config.thresholds.listenCheckCuts, ctx.config.openrouter.transcribeModel],
  });
  const cached = ctx.force ? undefined : await readKeyed<(Candidate | MatchedCandidate)[]>(out, key);
  if (cached) return cached;

  const programme = await runProgramme(ctx, scenes);
  const matched = await matchCandidates(
    candidates,
    scenes,
    ctx.catalogue.brands,
    ctx.config.thresholds,
    (c) => llmRank(ctx, `rank ${c.id}`, programme),
    ctx.config.openrouter.concurrency,
  );
  if (ctx.config.thresholds.listenCheckCuts) {
    const toCheck = matched.filter((c): c is MatchedCandidate => !c.rejected && "ranked" in c && c.cutTime !== undefined);
    await mapLimit(toCheck, ctx.config.openrouter.concurrency, (m) => listenCheck(ctx, m, ingest.fullAudio, ingest.meta.durationSec));
    const heard = toCheck.filter((m) => m.listenCheck?.speech).length;
    ctx.log(`match: listening check on ${toCheck.length} cuts, ${heard} rejected for speech`);
  }

  await writeKeyed(out, key, matched);
  const ok = matched.filter((c) => !c.rejected).length;
  ctx.log(`match: ${ok} candidates have at least one eligible, ranked brand`);
  return matched;
}
