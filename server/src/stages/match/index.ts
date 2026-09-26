// Stage 6 ("What"): hard-block eligibility in code, then LLM ranks only eligible brands.
import type { Brand, Candidate, MatchedCandidate, Scene } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../../lib/artifacts";
import { hashJson } from "../../lib/hash";
import { chatJson } from "../../lib/openrouter";
import { mapLimit } from "../../lib/pool";
import { RANK_PROMPT_VERSION, RankResponse, rankJsonSchema, rankSystemPrompt, rankUserPrompt } from "../../prompts/rank";
import { artifactPath, type StageContext } from "../context";
import { decideEligibility } from "./eligibility";

export type RankFn = (before: Scene, after: Scene, eligible: Brand[]) => Promise<MatchedCandidate["ranked"]>;

/** LLM ranking; unknown ids are discarded, eligible brands the model skipped get fit 0. */
export const llmRank =
  (ctx: StageContext, label: string): RankFn =>
  async (before, after, eligible) => {
    const ids = eligible.map((b) => b.id);
    const raw = await chatJson({
      label,
      system: rankSystemPrompt,
      user: rankUserPrompt(before, after, eligible),
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
  thresholds: Parameters<typeof decideEligibility>[3],
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
      const ranked = await rank(c)(before, after, eligible);
      m.ranked = ranked.sort((x, y) => y.fit - x.fit);
      for (const r of m.ranked) {
        const d = decisions.find((x) => x.brandId === r.brandId)!;
        d.fit = r.fit;
        d.reason = r.reason;
      }
    } catch (err) {
      m.rejected = { stage: "match", reason: `brand ranking failed: ${(err as Error).message.slice(0, 200)}` };
    }
    return m;
  });
}

export async function runMatch(ctx: StageContext, candidates: Candidate[], scenes: Scene[]) {
  const out = artifactPath(ctx, ARTIFACTS.matches);
  const key = hashJson({
    v: RANK_PROMPT_VERSION,
    catalogue: ctx.catalogue.hash,
    model: ctx.config.openrouter.reasonModel,
    t: ctx.config.thresholds,
    candidates: hashJson(candidates),
    scenes: hashJson(scenes),
  });
  const cached = ctx.force ? undefined : await readKeyed<(Candidate | MatchedCandidate)[]>(out, key);
  if (cached) return cached;

  const matched = await matchCandidates(
    candidates,
    scenes,
    ctx.catalogue.brands,
    ctx.config.thresholds,
    (c) => llmRank(ctx, `rank ${c.id}`),
    ctx.config.openrouter.concurrency,
  );
  await writeKeyed(out, key, matched);
  const ok = matched.filter((c) => !c.rejected).length;
  ctx.log(`match: ${ok} candidates have at least one eligible, ranked brand`);
  return matched;
}
