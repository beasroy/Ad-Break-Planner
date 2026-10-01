# Hoichoi Ad Break Planner

This project analyzes long-form video and suggests safe, context-aware mid-roll ad breaks for Bengali content. It
combines transcript, audio and scene signals with a brand catalogue so ads land at natural pauses instead of cutting
through important dialogue or emotional moments.

This README explains how the current LLM-driven placement pipeline works.

## LLM ad placement

How the ad-break planner decides where mid-roll ads go when `placement.mode` is `"llm"` (the default; the older
pipeline is not covered here).

The idea: **the model makes the judgement call, code makes every decision that can be measured or must be safe.**
The model reads dialogue and picks a line and a brand. Code picks the exact cut time and rejects anything that breaks a rule.
When in doubt, no ad is placed: a missing ad is better than a bad one.

Code: [server/src/stages/placement.ts](server/src/stages/placement.ts) · prompt: [server/src/prompts/placement.ts](server/src/prompts/placement.ts) · settings: [server/src/config.ts](server/src/config.ts)

## What runs in this mode

| Pipeline step | LLM mode |
|---|---|
| Extract audio, transcribe dialogue, detect silences and shot cuts | Run as normal. Their output is the input to placement. |
| Understand scenes, find cut points, apply pacing rules | **Not run** (shown as instantly done). Their work is done inside placement. |
| Match brands | `runPlacement`: gathers every chunk's candidates, schedules the best combination, verifies it — the whole algorithm below. |
| Write VMAP and report | Writes `vmap.xml` and `debug.json`. |

## The algorithm

Placement runs in three phases: gather every chunk's candidates (in parallel, each chunk judged on its own), schedule the best combination of them, then verify the schedule's cuts for speech, redrawing it if one fails.

1. **Episode summary.** One LLM call reads the whole dialogue and writes a short "story so far" (summary, genre, recurring contexts). It is shown to every placement call as background only. Cached in `programme.json`. If it fails, placement carries on without it.
2. **Chunks.** The episode is split into the same 120 s pieces used for transcription. Each chunk is one placement window. A chunk with no dialogue in it is skipped, with no LLM call. Every other chunk is called, whatever it's near — chunks never skip each other for being close together, and there is no minimum gap enforced anywhere later either.
3. **One LLM call per chunk, all in parallel.** No chunk is told what any other chunk decided — not the previous ad's brand, not which brands have already been used — because at call time that isn't decided yet either. Each call is shown the story, the full brand catalogue, then three blocks of numbered dialogue lines: the 90 s before the window (`P1…`, context only), the window's own lines (`1…`, ads only after one of these) and the 90 s after (`N1…`, context only). Measured **silences** (0.5 s or longer) and **shot cuts** are written between the lines as unnumbered markers.
4. **The answer** (strict JSON): a best `placement` (line, brand, fit 0–1, reason) or `null`, up to 2 `alternatives` (asked to be different brands, so code has real choices later), the `contexts_nearby` it saw around the cut, and `why_not_others`.
5. **Code checks every option on its own merits** (see below) — content only, nothing that depends on other chunks. Every option that passes becomes a schedulable candidate; a chunk can contribute more than one (its pick and any alternative that also passes).
6. **Scheduling.** Once every chunk has answered, code picks the combination of at most one candidate per chunk with the highest total quality score, subject to the ad-load budget and never the same brand on two ads next to each other (see "Scheduling" below). There is no minimum gap between ads and no target ad count — the fit floor is the only thing gating what plays.
7. **Verification.** Every scheduled cut is checked for speech (see below). A cut that fails is dropped and the schedule is redrawn without it, which can let a different chunk's candidate take that slot instead.

### Checks on each option (phase 1: content only)

Run in this order; the first failure rejects the option. None of these depend on any other chunk.

1. The line exists in this chunk's lines.
2. **A cut time can be found** (see below).
3. **The cut is not in the last 90 s** of the episode.
4. **Negative contexts.** None of the `contexts_nearby` the model reported is on the chosen brand's `negativeContexts`, or on the "blocks every brand" list.
5. **Fit** is at least `0.7` — a strict gate: this is the main thing deciding what airs at all in this mode.

An option that passes becomes a candidate for scheduling. If the model's call fails, the chunk contributes no candidates.

### Scheduling (phase 2: across every chunk's candidates)

Picks the combination of candidates — at most one per chunk — with the highest total quality score, where a candidate's score is `0.6 × how good the pause is + 0.4 × fit` (the pause score saturates at a 3 s gap), minus `0.15` for every earlier use of that candidate's brand elsewhere in the episode. Subject to:

- **Never the same brand on two chosen ads next to each other** — including across a chunk that contributed nothing, since "next to each other" means the previous and next *chosen* ad, not the previous and next chunk. This is a hard rule, not affected by the penalty below.
- **A brand cannot air more than its repeat cap** (2 for an episode up to about 75 minutes, 3 beyond that) — a hard rule too, once the cap is reached that brand's remaining candidates are simply unavailable.
- **Total ad time under 15% of the episode.**

There is **no minimum gap between ads** and **no target ad count**: two candidates can sit as close together as the content allows, and there is no preference for more ads over fewer, or fewer over more — the `0.7` fit floor (see above) is what decides which ads exist to choose from in the first place, not the scheduler. A chunk with no eligible candidate, or one that loses purely on quality to the brand-adjacency or budget rules above, is simply left with no ad.

The `0.15` repeat penalty is a tie-break, not a ban: a second use of a brand only loses to a fresher one when the fresher one is genuinely close in quality; a repeat that clearly fits better than any unused brand nearby still airs. With this catalogue's small brand count, some repetition across a longer episode is expected and accepted — the penalty and the cap exist to bound it, not eliminate it.

Exhaustive search over chunks in time order (small n; the same technique, and the same safety valve, as the rules pipeline's `selectBreaks`).

### Verification (phase 3: nobody speaking at the cut)

Every scheduled cut is checked for speech (see below). A cut that fails is removed from its chunk's candidates and scheduling runs again without it — bounded to 20 rounds, and each candidate is only ever checked once, so the added cost stays close to one check per ad actually placed, not per candidate considered.

### Where the cut goes

The model only chooses the line. Code chooses the time, in the gap between that line's end and the next line's start (or 10 s after it, for the last line):

1. **Inside a measured silence** in that gap, of any length. If a shot cut falls in it (at least 0.15 s from the edges), the cut goes on the shot cut nearest the middle; otherwise at the middle of the silence. If a transcribed word or audio event falls within 0.15 s of that point, the silence is not used.
2. **Otherwise, in a stretch with no transcribed word for at least 1.5 s** (music may be playing): the earliest such stretch, each word widened by 0.15 s. Shot cut nearest the middle if there is one, else the middle.
3. **Otherwise the option is rejected**, with a reason such as "only 0.7s before the next line, no measured silence and no 1.5s stretch without transcribed words", or "transcribed words fill the pause".

### The speech check at the cut

The last safety gate, run on every candidate cut that passed the earlier checks:

- Silero VAD (local, free) scores the audio within 1 s either side of the cut.
- **0.9 or more: speech, rejected** (no LLM call).
- **Below 0.1 and nothing transcribed within 1 s: quiet, accepted** (no LLM call).
- **In between:** an audio LLM listens to a short clip around the cut, 2 times. Any answer that says "speech" and gives the words it heard rejects the cut. If any call fails, the cut is rejected.
- If the VAD itself fails, the cut is rejected.

### Which ad plays

For the accepted brand, the **longest creative that still fits the remaining ad time** is used, preferring one in the content language (`bn`). If none fits, the option is rejected.

## Rules the model is given (the prompt)

**Placement**
1. An ad plays after a line, at a point backed by a measured silence (or, if there is none nearby, the quietest, most conversation-ending point).
2. That line must be the last line of a finished conversation: never mid-conversation, between a question and its answer, or after a line that calls someone over ("come here", "listen", "wait").
3. Never interrupt suspense, an argument, a threat, a revelation or a cliffhanger, even a verbal one.

**Suitability**
4. The brand must fit what the viewer just watched or is about to watch (its `fits_scenes_about`). Fitting only the episode's general theme does not count.
5. Never pick a brand when the scenes around the line involve anything on its `never_next_to` list.
6. If the scenes around the line involve any "blocks every brand" context, place no ad.
7. The model is never told the previous or next chunk's brand — it can't know, since every chunk is judged on its own — so it doesn't try to avoid repeats itself. Instead it's asked to make its alternatives different brands from its main pick, so code has real choices to avoid a repeat when scheduling.

**Honesty**
8. Judge only from dialogue and the measurements; do not assume anything that is not there.
9. If nothing passes every rule, place no ad.

The model must report `contexts_nearby` honestly, because code relies on it (see assumptions).

## Settings

All in [server/src/config.ts](server/src/config.ts).

| Setting | Value | Meaning |
|---|---|---|
| `placement.minBrandFit` | 0.7 | The fit floor for this mode (see "the rules mode uses a different fit floor" below) — a strict quality gate, not a tie-break. |
| `placement.noAdLastSec` | 90 | No ad in the last 90 s of the episode. |
| `pacing.maxAdLoadPct` | 0.15 | Total ad time stays under 15% of the episode. |
| `scoring.combined` | `{ where: 0.6, brandFit: 0.4 }` | How a candidate's schedule score is weighed: pause quality vs brand fit. |
| `placement.brandRepeatPenalty` | 0.15 | Subtracted from the score for every earlier use of a candidate's brand in the episode. |
| `maxBrandRepeats(durationSec)` | 2 (3 past ~75 min) | Hard cap on how many times one brand may air in an episode; not a config value, a function of the episode's length (`placement.ts`). |
| `placement.contextSec` | 90 | Dialogue shown before and after each chunk. |
| `placement.showSilenceMinSec` | 0.5 | Silences shorter than this are not shown to the model. |
| `audio.chunkSec` | 120 | Chunk length. |
| `thresholds.minSpeechFreeSec` | 1.5 | Speech-free stretch needed when there is no silence. |
| `thresholds.cutPaddingMs` | 150 | Distance a cut keeps from any transcribed word. |
| `thresholds.consensusNegativeShare` | 0.5 | A context listed by more than half the brands blocks every brand. |
| `thresholds.listenCheckCuts` | true | Enables the speech check at the cut. |
| `listen.windowSec` | 1 | Seconds either side of the cut that must be free of speech. |
| `listen.vadSpeechMin` / `vadQuietMax` | 0.9 / 0.1 | VAD thresholds for "speech" and "quiet". |
| `listen.llmVotes` | 2 | Audio-LLM checks when the VAD is unsure. |
| `signals.silenceNoiseDb` / `silenceMinSec` | -35 dB / 0.3 s | What ffmpeg counts as a silence. |
| `signals.sceneThreshold` | 0.3 | What counts as a shot cut. |
| `openrouter.reasonModel` | `MODEL_REASON`, default `openai/gpt-5.6-luna` | Placement and summary model. |
| `openrouter.listenModel` | `MODEL_LISTEN`, default `google/gemini-3.8-flash` | Audio model for the listen check at a cut. |
| `scribe.maxWordSec` | 2.0 | Each word caps at this from its start, bounding a rare over-long span. |
| `scribe.uttSplitSec` | 0.5 | Pause that splits Scribe's words into separate lines. |
| `scribe.audioEventsAreSpeech` | true | `[music]`/`[crying]` spans block cuts like words do. |

There is **no minimum gap between ads**, **no target ad count**, **no cap on the number of ads**, and no no-break zone at the start of the episode. `pacing.maxBreaksPerHour`, `noBreakFirstSec`, `noBreakLastSec`, `minSilenceMs` and `pacing.minGapSec` belong to the legacy pipeline and are ignored here — as is `thresholds.minBrandFit` (0.3): the rules mode uses that one, LLM mode uses its own, much stricter `placement.minBrandFit` (0.7) instead.

## Assumptions

- **Every chunk is judged only on its own merits, and every chunk is called.** Since chunks run in parallel with no fixed order between them, none can be told what an earlier or later one decided — so nothing is skipped upfront for being "too close" to another chunk's ad. This costs one LLM call per chunk with dialogue, every run, not just the ones that end up used; the trade-off is that a schedule can compare every chunk's quality before deciding, instead of locking in whichever came first.
- **The fit floor, not spacing, is what limits how many ads there are.** There is no minimum gap between ads and no target ad count in this mode — two good candidates can sit as close together as the content allows, and a thin episode with few high-fit moments simply gets few ads, with no floor pushing a weaker candidate in to compensate. The strictness lives entirely in the `0.7` fit floor: raise it and fewer, better-fitting ads air; lower it and more do.
- **A brand may repeat, but is nudged and then capped, not banned outright.** With only a handful of brands in the catalogue, refusing all repetition would leave good ad moments empty. Instead a repeat costs a small score penalty (a tie-break: a fresher brand close in quality wins, but a repeat that is clearly the better fit still airs), and a hard cap stops one brand from dominating a long episode regardless of how well it scores throughout. Every repeat still obeys the same-brand-adjacent ban, the negative-context checks and every other rule.
- **Audio measurements beat transcript timings.** Line times are estimates (many come from an LLM transcript and can be off by up to a second or more). Silences and shot cuts are measured from the audio and picture, so the model is told to trust them, and cuts are placed in them.
- **Transcribed words count as speech, and so do audio events.** ElevenLabs Scribe is the only transcriber: it returns word-level timings (capped at 2 s from each word's start, which bounds a rare over-long span) and tags for sound it can name but has no words for — `[music]`, `[crying]`, `[screaming]`. Those tagged spans are speech walls too, because a cut inside a song or someone crying is as wrong as one mid-sentence. Lines flagged as hallucinations by the transcript stage are left out of the dialogue.
- **One transcriber means one point of failure.** If Scribe fails on a chunk the stage fails rather than carrying on, because a hole in the transcript would look exactly like quiet and invite a cut there. Measured against the previous Deepgram+Gemini pair on five full episodes, Scribe's word timings drift ~0.1 s (Gemini: 0.8–1.4 s), it puts 3–5× fewer words inside measured silence, and it misses 5.3× less speech than Deepgram did — but it does miss some, mostly singing and wailing, which is why audio events are walls and the VAD gate below is independent of the transcript.
- **Safety depends on the model reporting `contexts_nearby` honestly.** There is no separate scene analysis in this mode; the negative-context and block-all checks compare the model's own report with the brand lists. A context the model fails to report is not caught.
- **The "blocks every brand" list is computed from the catalogue** (contexts on more than half the brands' lists), so it changes when brands are added.
- **Only one ad per chunk** — but there is no minimum spacing between two chunks' ads; adjacent chunks can each get one.
- **The same brand may not play on two ads next to each other in the final schedule** — a hard rule enforced by the scheduler, not a preference. "Next to each other" means the previous and next *scheduled* ad; a chunk that contributed nothing in between doesn't break the adjacency. A brand can still repeat further apart, subject to the penalty and cap above.
- **Failure means no ad.** A failed placement call, a failed voice check, a missing cut point or no creative that fits all leave that candidate out of the schedule.
- **Music is not silence.** A long gap between two lines with no silence marker is assumed to have music or background sound, so it is not treated as a quiet moment.
- **The model may return a line outside the current lines or an unknown brand.** The response schema restricts line ids, brand ids and contexts to valid values, and code checks them again.
- **Placement is deterministic except for the LLM.** The same transcript, signals, catalogue, settings and prompt reuse the cached result. Changing any of these, or the code's logic version, recomputes it.

## Outputs

- `placement.json`: the cached result: the ads placed, one selected or rejected line per chunk, and per-chunk detail.
- `placement-llm.jsonl`: every LLM request and response for the run.
- `programme.json`: the episode summary.
- `vmap.xml` and `debug.json`. In this mode `debug.json` begins with a plain-language explanation of the run and `settingsUsed`, then lists `breaks`, `selection` (one line per chunk) and `placement.chunks` (per chunk: the exact prompt, the model's answer, every option with its cut time, how the cut was found (`silence` or `speechFree`) and why it was accepted or rejected — including an option that passed every content check but lost to a better schedule elsewhere). It also carries `costSummary`: every API call this video has made across every attempt (so a failed retry's cost isn't lost), with the total, and a breakdown both by pipeline stage and by what the call was for (e.g. every "placement chunk" call counted as one row, whatever chunk number). Present only when running through the app itself — a `npm run stage`/playground run never opens the database, so it's left out there. The same numbers, live-updating while a job runs, are on its page in the web app, under "API cost".

## Testing placement without the full pipeline

```
npm run placement -w server -- <hash-prefix> [--cached]
```

Runs only this stage on a video already in `data/`, using its cached ingest, transcript and signals. It writes to `data/<hash>/playground/` and never touches the app's own `placement.json`. Every run calls the model again: one call for every chunk with dialogue (not only the ones an earlier version would have skipped for being close together), run in parallel, plus one summary call, cached in `playground/`. `--cached` re-prints the last result for free. The terminal shows each chunk with its window, the model's picks, and why each was accepted or rejected.
