// Stage 7 ("Whether"): deterministic pacing selector over eligible, ranked candidates.
import type { Brand, Break, Candidate, Creative, MatchedCandidate, PacingConfig, ScoreWeights, SelectionLog } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { artifactPath, type StageContext } from "./context";

const isMatched = (c: Candidate | MatchedCandidate): c is MatchedCandidate =>
  !c.rejected && "ranked" in c && c.ranked.length > 0 && c.cutTime !== undefined && !!c.where;

/** Longest creative that fits the remaining ad-load budget, preferring the content language. */
export function pickCreative(brand: Brand, budgetSec: number, language: string): Creative | undefined {
  const fits = brand.creatives.filter((c) => c.durationSec <= budgetSec + 1e-9).sort((a, b) => b.durationSec - a.durationSec);
  return fits.find((c) => c.language === language) ?? fits[0];
}

/** Shortest creative (content language first): used while searching, so ad load never rules out a schedule early. */
export function shortestCreative(brand: Brand, language: string): Creative | undefined {
  const byLen = [...brand.creatives].sort((a, b) => a.durationSec - b.durationSec);
  return byLen.find((c) => c.language === language) ?? byLen[0];
}

export interface SelectInputs {
  candidates: (Candidate | MatchedCandidate)[];
  brands: Brand[];
  durationSec: number;
  pacing: PacingConfig;
  weights: ScoreWeights["combined"];
  language: string;
}

/** Bump when selection logic changes so cached selections are recomputed. */
const SELECT_VERSION = 4;

/** Safety valve for pathological inputs; real episodes explore a few thousand schedules at most. */
const MAX_SEARCH_NODES = 500_000;

/**
 * Picks the schedule with the MOST breaks, then the highest total score, subject to:
 * no-break zones, min gap between breaks, the break cap, the ad-load cap, and no
 * back-to-back same brand. Exhaustive search over time-ordered candidates (small n).
 */
export function selectBreaks(inp: SelectInputs): { breaks: Break[]; log: SelectionLog[] } {
  const { pacing: p, durationSec: dur, weights: w, language } = inp;
  const brandById = new Map(inp.brands.map((b) => [b.id, b]));
  const combined = (c: MatchedCandidate, fit: number) => c.where!.total * w.where + fit * w.brandFit;
  const maxAdSec = p.maxAdLoadPct * dur;
  // Rounded to nearest: a 25 min episode (4/h × 0.43h = 1.7) gets 2 breaks, not 1.
  const cap = Math.round((p.maxBreaksPerHour * dur) / 3600);

  const log = new Map<string, SelectionLog>();
  const reject = (id: string, reason: string) => log.set(id, { candidateId: id, outcome: "rejected", reason });

  const viable: MatchedCandidate[] = [];
  for (const c of inp.candidates.filter(isMatched)) {
    const t = c.cutTime!;
    if (t < p.noBreakFirstSec) reject(c.id, `inside first ${p.noBreakFirstSec}s`);
    else if (t > dur - p.noBreakLastSec) reject(c.id, `inside last ${p.noBreakLastSec}s`);
    else viable.push(c);
  }
  viable.sort((a, b) => a.cutTime! - b.cutTime!);

  type Sel = { c: MatchedCandidate; brandId: string; fit: number; reason: string; swappedFrom?: string };
  /** Every brand this candidate could carry after `prevBrand` within the budget, best fit first. */
  const brandOptions = (c: MatchedCandidate, prevBrand: string | undefined, budget: number) =>
    c.ranked.flatMap((r) => {
      if (r.brandId === prevBrand) return [];
      const cr = shortestCreative(brandById.get(r.brandId)!, language);
      return cr && cr.durationSec <= budget + 1e-9 ? [{ r, minSec: cr.durationSec }] : [];
    });

  let best: Sel[] = [];
  let bestScore = -1;
  let nodes = 0;
  const path: Sel[] = [];
  const dfs = (from: number, adUsed: number, score: number) => {
    if (++nodes > MAX_SEARCH_NODES) return;
    if (path.length > best.length || (path.length === best.length && score > bestScore)) {
      best = [...path];
      bestScore = score;
    }
    if (path.length >= cap) return;
    const last = path[path.length - 1];
    for (let i = from; i < viable.length; i++) {
      const c = viable[i];
      if (last && c.cutTime! - last.c.cutTime! < p.minGapSec) continue;
      // Branch on brand too: a lower-fit brand here can free the next break to keep its top brand.
      for (const pick of brandOptions(c, last?.brandId, maxAdSec - adUsed)) {
        const swappedFrom = pick.r !== c.ranked[0] ? c.ranked[0].brandId : undefined;
        path.push({ c, brandId: pick.r.brandId, fit: pick.r.fit, reason: pick.r.reason, swappedFrom });
        dfs(i + 1, adUsed + pick.minSec, score + combined(c, pick.r.fit));
        path.pop();
      }
    }
  };
  dfs(0, 0, 0);

  // Spend the remaining ad-load budget: upgrade to longer creatives, best-scoring breaks first.
  const creativeOf = new Map<Sel, Creative>(best.map((s) => [s, shortestCreative(brandById.get(s.brandId)!, language)!]));
  let used = best.reduce((t, s) => t + creativeOf.get(s)!.durationSec, 0);
  for (const s of [...best].sort((a, b) => combined(b.c, b.fit) - combined(a.c, a.fit))) {
    const cur = creativeOf.get(s)!;
    const up = pickCreative(brandById.get(s.brandId)!, maxAdSec - used + cur.durationSec, language);
    if (up && up.durationSec > cur.durationSec) {
      used += up.durationSec - cur.durationSec;
      creativeOf.set(s, up);
    }
  }

  // Explain every viable candidate that did not make the schedule.
  const sel = best;
  for (const c of viable) {
    if (sel.some((s) => s.c === c)) continue;
    const t = c.cutTime!;
    const near = sel.find((s) => Math.abs(s.c.cutTime! - t) < p.minGapSec);
    const before = [...sel].reverse().find((s) => s.c.cutTime! < t);
    const after = sel.find((s) => s.c.cutTime! > t);
    const neighbours = new Set([before?.brandId, after?.brandId]);
    if (near) reject(c.id, `within ${p.minGapSec}s of selected break ${near.c.id}`);
    else if (sel.length >= cap) reject(c.id, `break cap reached (${cap} for this duration)`);
    else if (c.ranked.every((r) => neighbours.has(r.brandId))) reject(c.id, "same brand as adjacent break and no alternative eligible brand");
    else {
      const adSec = sel.reduce((t, s) => t + (shortestCreative(brandById.get(s.brandId)!, language)?.durationSec ?? 0), 0);
      const minHere = Math.min(...c.ranked.map((r) => shortestCreative(brandById.get(r.brandId)!, language)?.durationSec ?? Infinity));
      reject(
        c.id,
        adSec + minHere > maxAdSec + 1e-9
          ? `ad load would exceed ${Math.round(p.maxAdLoadPct * 100)}%`
          : "a schedule with more breaks or a higher total score exists without it",
      );
    }
  }

  const breaks: Break[] = sel.map((s) => {
    const cr = creativeOf.get(s)!;
    return {
      candidateId: s.c.id,
      timeSec: s.c.cutTime!,
      brandId: s.brandId,
      creativeId: cr.id,
      adDurationSec: cr.durationSec,
      whereScore: s.c.where!.total,
      fit: s.fit,
      combinedScore: combined(s.c, s.fit),
      reason: s.swappedFrom
        ? `${s.reason} (took this over top brand ${brandById.get(s.swappedFrom)?.name ?? s.swappedFrom} to avoid back-to-back repeats)`
        : s.reason,
    };
  });
  for (const b of breaks) log.set(b.candidateId, { candidateId: b.candidateId, outcome: "selected", reason: b.reason });
  for (const c of inp.candidates) {
    if (!log.has(c.id) && c.rejected) log.set(c.id, { candidateId: c.id, outcome: "rejected", reason: `${c.rejected.stage}: ${c.rejected.reason}` });
  }
  return { breaks, log: inp.candidates.map((c) => log.get(c.id)!).filter(Boolean) };
}

export async function runSelect(ctx: StageContext, matched: (Candidate | MatchedCandidate)[], durationSec: number) {
  const out = artifactPath(ctx, ARTIFACTS.breaks);
  const inputs = {
    pacing: ctx.config.pacing,
    weights: ctx.config.scoring.combined,
    language: ctx.config.contentLanguage,
    durationSec,
  };
  const key = hashJson({ v: SELECT_VERSION, inputs, catalogue: ctx.catalogue.hash, matched: hashJson(matched) });
  const cached = ctx.force ? undefined : await readKeyed<ReturnType<typeof selectBreaks>>(out, key);
  if (cached) return cached;

  const result = selectBreaks({ candidates: matched, brands: ctx.catalogue.brands, ...inputs });
  await writeKeyed(out, key, result);
  ctx.log(`select: ${result.breaks.length} breaks selected`);
  return result;
}
