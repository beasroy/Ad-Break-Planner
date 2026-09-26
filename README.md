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
| Match brands | `runPlacement`: the whole placement algorithm below. |
| Write VMAP and report | Writes `vmap.xml` and `debug.json`. |

## The algorithm

1. **Episode summary.** One LLM call reads the whole dialogue and writes a short "story so far" (summary, genre, recurring contexts). It is shown to every placement call as background only. Cached in `programme.json`. If it fails, placement carries on without it.
2. **Chunks.** The episode is split into the same 120 s pieces used for transcription. Each chunk is one placement window, taken in order. A chunk is skipped, with no LLM call, if:
   - it lies in the last 90 s of the episode;
   - it is entirely within 300 s of the previous ad (a partly overlapping chunk starts later, at previous ad + 300 s);
   - it has no dialogue.
3. **One LLM call per chunk.** The model is shown the story, the full brand catalogue, the brands already shown and the previous ad's brand, then three blocks of numbered dialogue lines: the 90 s before the window (`P1…`, context only), the window's own lines (`1…`, ads only after one of these) and the 90 s after (`N1…`, context only). Measured **silences** (0.5 s or longer) and **shot cuts** are written between the lines as unnumbered markers.
4. **The answer** (strict JSON): a best `placement` (line, brand, fit 0–1, reason) or `null`, up to 2 `alternatives`, the `contexts_nearby` it saw around the cut, and `why_not_others`.
5. **Code checks each option in order** (best pick first, then alternatives). The first that passes everything is accepted, and no further option is used for that chunk. If none pass, the chunk gets no ad.

### Checks on each option

Run in this order; the first failure rejects the option.

1. The line exists in this chunk's lines.
2. **A cut time can be found** (see below).
3. **The cut is not in the last 90 s** of the episode.
4. **Not the same brand as the previous ad.** (The brand list sent to the model already leaves it out, and code checks again.)
5. **Negative contexts.** None of the `contexts_nearby` the model reported is on the chosen brand's `negativeContexts`, or on the "blocks every brand" list.
6. **Fit** is at least `0.3`.
7. **Nobody is speaking at the cut** (voice check, below).
8. **An ad of that brand fits the remaining ad time.**

If the model's call fails, the chunk stays empty.

### Where the cut goes

The model only chooses the line. Code chooses the time, in the gap between that line's end and the next line's start (or 10 s after it, for the last line):

1. **Inside a measured silence** in that gap, of any length. If a shot cut falls in it (at least 0.15 s from the edges), the cut goes on the shot cut nearest the middle; otherwise at the middle of the silence. If Deepgram hears a word within 0.15 s of that point, the silence is not used.
2. **Otherwise, in a stretch with no transcribed word for at least 1.5 s** (music may be playing): the earliest such stretch, each word widened by 0.15 s. Shot cut nearest the middle if there is one, else the middle.
3. **Otherwise the option is rejected**, with a reason such as "only 0.7s before the next line, no measured silence and no 1.5s stretch without transcribed words", or "transcribed words fill the pause".

### The speech check at the cut

The last safety gate, run on every candidate cut that passed the earlier checks:

- Silero VAD (local, free) scores the audio within 1 s either side of the cut.
- **0.9 or more: speech, rejected** (no LLM call).
- **Below 0.1 and no Deepgram word within 1 s: quiet, accepted** (no LLM call).
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
7. Never pick the previous ad's brand; prefer a brand not yet shown when two fit about equally.

**Honesty**
8. Judge only from dialogue and the measurements; do not assume anything that is not there.
9. If nothing passes every rule, place no ad.

The model must report `contexts_nearby` honestly, because code relies on it (see assumptions).

## Settings

All in [server/src/config.ts](server/src/config.ts).

| Setting | Value | Meaning |
|---|---|---|
| `placement.minGapSec` | 300 | Minimum seconds between two ad cuts. |
| `placement.noAdLastSec` | 90 | No ad in the last 90 s of the episode. |
| `pacing.maxAdLoadPct` | 0.15 | Total ad time stays under 15% of the episode. |
| `placement.contextSec` | 90 | Dialogue shown before and after each chunk. |
| `placement.showSilenceMinSec` | 0.5 | Silences shorter than this are not shown to the model. |
| `audio.chunkSec` | 120 | Chunk length. |
| `thresholds.minSpeechFreeSec` | 1.5 | Speech-free stretch needed when there is no silence. |
| `thresholds.cutPaddingMs` | 150 | Distance a cut keeps from any transcribed word. |
| `thresholds.minBrandFit` | 0.3 | Options with a lower fit are rejected. |
| `thresholds.consensusNegativeShare` | 0.5 | A context listed by more than half the brands blocks every brand. |
| `thresholds.listenCheckCuts` | true | Enables the speech check at the cut. |
| `listen.windowSec` | 1 | Seconds either side of the cut that must be free of speech. |
| `listen.vadSpeechMin` / `vadQuietMax` | 0.9 / 0.1 | VAD thresholds for "speech" and "quiet". |
| `listen.llmVotes` | 2 | Audio-LLM checks when the VAD is unsure. |
| `signals.silenceNoiseDb` / `silenceMinSec` | -35 dB / 0.3 s | What ffmpeg counts as a silence. |
| `signals.sceneThreshold` | 0.3 | What counts as a shot cut. |
| `openrouter.reasonModel` | `MODEL_REASON`, default `openai/gpt-5.6-luna` | Placement and summary model. |

There is **no cap on the number of ads** and no no-break zone at the start of the episode. `pacing.maxBreaksPerHour`, `noBreakFirstSec`, `noBreakLastSec`, `minSilenceMs` and `pacing.minGapSec` belong to the legacy pipeline and are ignored here.

## Assumptions

- **Audio measurements beat transcript timings.** Line times are estimates (many come from an LLM transcript and can be off by up to a second or more). Silences and shot cuts are measured from the audio and picture, so the model is told to trust them, and cuts are placed in them.
- **Deepgram words count as speech.** Each word is capped at 1 s from its start, because Deepgram can stretch a word's end across a following pause. Lines flagged as hallucinations by the transcript stage are left out of the dialogue.
- **Safety depends on the model reporting `contexts_nearby` honestly.** There is no separate scene analysis in this mode; the negative-context and block-all checks compare the model's own report with the brand lists. A context the model fails to report is not caught.
- **The "blocks every brand" list is computed from the catalogue** (contexts on more than half the brands' lists), so it changes when brands are added.
- **Only one ad per chunk**, and never two ads within 300 s, measured cut to cut on the content timeline (ad length is not counted).
- **The same brand may not play twice in a row.** Non-consecutive repeats are allowed; "brands already shown" is only a preference the model is asked to follow.
- **Failure means no ad.** A failed placement call, a failed voice check, a missing cut point or no creative that fits all leave the chunk empty.
- **Music is not silence.** A long gap between two lines with no silence marker is assumed to have music or background sound, so it is not treated as a quiet moment.
- **The model may return a line outside the current lines or an unknown brand.** The response schema restricts line ids, brand ids and contexts to valid values, and code checks them again.
- **Placement is deterministic except for the LLM.** The same transcript, signals, catalogue, settings and prompt reuse the cached result. Changing any of these, or the code's logic version, recomputes it.

## Outputs

- `placement.json`: the cached result: the ads placed, one selected or rejected line per chunk, and per-chunk detail.
- `placement-llm.jsonl`: every LLM request and response for the run.
- `programme.json`: the episode summary.
- `vmap.xml` and `debug.json`. In this mode `debug.json` begins with a plain-language explanation of the run and `settingsUsed`, then lists `breaks`, `selection` (one line per chunk) and `placement.chunks` (per chunk: the exact prompt, the model's answer, every option with its cut time, how the cut was found (`silence` or `speechFree`) and why it was accepted or rejected).

## Testing placement without the full pipeline

```
npm run placement -w server -- <hash-prefix> [--cached]
```

Runs only this stage on a video already in `data/`, using its cached ingest, transcript and signals. It writes to `data/<hash>/playground/` and never touches the app's own `placement.json`. Every run calls the model again (one call per chunk plus one summary call, cached in `playground/`); `--cached` re-prints the last result for free. The terminal shows each chunk with its window, the model's picks, and why each was accepted or rejected.
