// Transcribe playground: try ElevenLabs Scribe on real chunks from the videos already in data/, and
// measure it against the two transcribers the pipeline uses today — without touching the pipeline.
//
//   npm run transcribe-playground -w server                 # 3 chunks per video (cheap first look)
//   npm run transcribe-playground -w server -- --chunks 5   # more chunks per video
//   npm run transcribe-playground -w server -- --all        # every chunk of every video
//   npm run transcribe-playground -w server -- --video mandaar --chunks 4
//
// Needs ELEVENLABS_API_KEY in the repo's .env. Every Scribe response is cached under
// data/<hash>/playground/scribe/, so a re-run costs nothing; delete that folder to re-pay.
//
// WHAT IT ANSWERS, per video, into data/<hash>/playground/scribe.json:
//  1. Does Scribe return word-level timestamps at all? (cutAfterLine, freeIntervals and the listen
//     gate all need per-word start/end — without them Scribe cannot replace Deepgram.)
//  2. Does it drift? Onsets are compared against Deepgram's, with Gemini measured the same way as a
//     control: we already know Gemini drifts by seconds, so if the metric doesn't show that, the
//     metric is wrong. A transcriber that agrees with Deepgram scores near 0.
//  3. Does it agree with real silence? ffmpeg's silencedetect (signals.json) is the ground truth the
//     pipeline actually cuts on. Two ways to be wrong, and they are not equally bad:
//       - words placed inside measured silence  -> timing is off; blocks cuts that were fine
//       - "quiet" gaps that overlap real speech -> DANGEROUS; this is how an ad lands on dialogue
//  4. What else it reports: audio-event tags (music/laughter), inter-word spacing spans, speakers,
//     and the language it detected.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config";

const API = "https://api.elevenlabs.io/v1/speech-to-text";
/** Scribe v2 in the pricing page is $0.22/hour of audio. Override if the model id differs. */
const MODEL = process.env.SCRIBE_MODEL ?? "scribe_v2";
/** ISO-639-3 for Bengali. Set SCRIBE_LANGUAGE="" to let Scribe auto-detect instead. */
const LANGUAGE = process.env.SCRIBE_LANGUAGE ?? "ben";
const USD_PER_HOUR = Number(process.env.SCRIBE_USD_PER_HOUR ?? 0.22);

/** A measured silence must be at least this long to count as one the pipeline would cut in. */
const REAL_SILENCE_SEC = 0.7;
/** A transcriber-derived gap this long is one the pipeline would treat as a safe, speech-free spot. */
const CLAIMED_QUIET_SEC = 1.5;

interface Span {
  start: number;
  end: number;
  text?: string;
}

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type?: string;
  speaker_id?: string;
}

interface ScribeResponse {
  text?: string;
  language_code?: string;
  language_probability?: number;
  words?: ScribeWord[];
}

// ---- args
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const chunkLimit = flag("all") ? Infinity : Number(value("chunks") ?? 3);
const videoFilter = value("video");

// ---- small helpers
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, "utf8")) as T;
/** Artifacts written by the pipeline are wrapped as { inputsKey, data }; caches are not. */
const unwrap = <T>(v: any): T => (v && typeof v === "object" && "inputsKey" in v ? v.data : v) as T;
const exists = (p: string) =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);
const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const percentile = (xs: number[], p: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] : 0;
const overlap = (a: Span, b: Span) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Merge overlapping/touching spans, so coverage sums never double-count. */
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** The quiet stretches between spans, within [from, to] — the same shape cutAfterLine looks for. */
function gapsBetween(spans: Span[], from: number, to: number, minSec: number): Span[] {
  const merged = merge(spans);
  const out: Span[] = [];
  let t = from;
  for (const s of merged) {
    if (s.start - t >= minSec) out.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (to - t >= minSec) out.push({ start: t, end: to });
  return out;
}

// ---- the Scribe call
async function scribeChunk(file: string): Promise<ScribeResponse> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set (add it to the repo's .env)");
  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(file)], { type: "audio/mpeg" }), path.basename(file));
  form.append("model_id", MODEL);
  if (LANGUAGE) form.append("language_code", LANGUAGE);
  // Word-level timing is the whole point; audio events tell us whether it flags music over dialogue.
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "true");
  form.append("diarize", "true");

  const res = await fetch(API, { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(180_000) });
  const body = await res.text();
  if (!res.ok) {
    // The body says exactly what ElevenLabs objected to — usually a bad model_id or language code.
    throw new Error(
      `Scribe HTTP ${res.status} for ${path.basename(file)}: ${body.slice(0, 500)}\n` +
        `  model_id="${MODEL}" language_code="${LANGUAGE || "(auto)"}"\n` +
        `  If the model id is wrong, re-run with SCRIBE_MODEL=scribe_v1 (or whatever the dashboard lists).\n` +
        `  If the language code is wrong, try SCRIBE_LANGUAGE=bn, or SCRIBE_LANGUAGE= to auto-detect.`,
    );
  }
  return JSON.parse(body) as ScribeResponse;
}

/** Cached per chunk: a re-run of this script never pays for the same audio twice. */
async function scribeCached(dir: string, file: string): Promise<{ raw: ScribeResponse; cached: boolean }> {
  const out = path.join(dir, `${path.basename(file, path.extname(file))}.json`);
  if (await exists(out)) return { raw: await readJson<ScribeResponse>(out), cached: true };
  const raw = await scribeChunk(file);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(out, JSON.stringify(raw, null, 2));
  return { raw, cached: false };
}

// ---- pulling speech out of each source, all in absolute video time
/**
 * Only actual speech. Scribe's words[] also carries "spacing" (the gaps between words) and
 * "audio_event" entries like "(music)" — counting either as speech would both invent drift and,
 * worse, mark music as someone talking. `type` is treated as a word only when it says so (or is
 * missing), so an event type we haven't seen before is excluded rather than silently counted.
 */
const SPEECH_TYPES = new Set(["word", undefined]);
const scribeWords = (raw: ScribeResponse, offset: number): Span[] =>
  (raw.words ?? [])
    .filter((w) => SPEECH_TYPES.has(w.type) && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({ start: w.start! + offset, end: w.end! + offset, text: w.text }));

/** The non-speech things Scribe flagged, with when — music over dialogue is the interesting one. */
const scribeEvents = (raw: ScribeResponse, offset: number): Span[] =>
  (raw.words ?? [])
    .filter((w) => w.type === "audio_event" && typeof w.start === "number")
    .map((w) => ({ start: w.start! + offset, end: (w.end ?? w.start!) + offset, text: w.text }));

const deepgramWords = (raw: any, offset: number): Span[] =>
  (raw?.results?.utterances ?? []).flatMap((u: any) =>
    (u.words ?? []).map((w: any) => ({ start: w.start + offset, end: w.end + offset, text: w.punctuated_word ?? w.word })),
  );

const deepgramUtterances = (raw: any, offset: number): Span[] =>
  (raw?.results?.utterances ?? []).map((u: any) => ({ start: u.start + offset, end: u.end + offset, text: u.transcript }));

const geminiUtterances = (raw: any, offset: number): Span[] =>
  (raw?.utterances ?? []).map((u: any) => ({ start: u.start + offset, end: u.end + offset, text: u.text }));

/** Group words into utterances the way the Deepgram config does (a pause this long splits them). */
function toUtterances(words: Span[], splitSec: number): Span[] {
  const out: Span[] = [];
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && w.start - last.end < splitSec) {
      last.end = Math.max(last.end, w.end);
      last.text = `${last.text ?? ""}${last.text ? " " : ""}${w.text ?? ""}`;
    } else out.push({ ...w });
  }
  return out;
}

// ---- the metrics
/**
 * How far each onset sits from the nearest onset in the reference. Two transcribers of the same audio
 * should land within a few hundred ms; seconds means drift. Gemini is run through this too, as a
 * control with a known answer.
 */
function onsetDrift(spans: Span[], reference: Span[]) {
  if (!spans.length || !reference.length) return { medianSec: 0, p90Sec: 0, worstSec: 0, compared: 0 };
  const refs = reference.map((r) => r.start).sort((a, b) => a - b);
  const deltas = spans.map((s) => Math.min(...refs.map((r) => Math.abs(r - s.start))));
  return {
    medianSec: round(median(deltas)),
    p90Sec: round(percentile(deltas, 90)),
    worstSec: round(Math.max(...deltas)),
    compared: deltas.length,
  };
}

/** Words this transcriber puts inside a stretch ffmpeg measured as silent — timing is off if any do. */
function wordsInsideSilence(words: Span[], silences: Span[]) {
  const real = silences.filter((s) => s.end - s.start >= REAL_SILENCE_SEC);
  const inside = words.filter((w) => real.some((s) => overlap(w, s) > (w.end - w.start) / 2));
  return { words: inside.length, ofTotal: words.length, pct: words.length ? round((inside.length / words.length) * 100, 1) : 0 };
}

/**
 * The dangerous direction: stretches this transcriber shows as quiet (long enough that the pipeline
 * would happily cut there) that are NOT backed by measured silence and overlap the reference
 * transcriber's speech. Every second counted here is a second where an ad could land on dialogue.
 */
function falseQuiet(words: Span[], silences: Span[], referenceSpeech: Span[], from: number, to: number) {
  const claimed = gapsBetween(words, from, to, CLAIMED_QUIET_SEC);
  const refSpeech = merge(referenceSpeech);
  let unbackedSec = 0;
  let overSpeechSec = 0;
  for (const gap of claimed) {
    const silent = silences.reduce((t, s) => t + overlap(gap, s), 0);
    unbackedSec += Math.max(0, gap.end - gap.start - silent);
    overSpeechSec += refSpeech.reduce((t, s) => t + overlap(gap, s), 0);
  }
  return { gaps: claimed.length, unbackedSec: round(unbackedSec, 1), overReferenceSpeechSec: round(overSpeechSec, 1) };
}

// ---- per video
async function runVideo(hash: string) {
  const dir = path.join(config.dataDir, hash);
  const ingest = unwrap<any>(await readJson(path.join(dir, "ingest.json")));
  const signals = unwrap<any>(await readJson(path.join(dir, "signals.json")));
  const job = await readJson<any>(path.join(dir, "job.json")).catch(() => ({ originalName: hash.slice(0, 8) }));
  const silences: Span[] = signals.silences ?? [];

  const transcribeDir = path.join(dir, "transcribe");
  const providers = await fs.readdir(transcribeDir).catch(() => [] as string[]);
  const dgDir = providers.find((d) => d.startsWith("deepgram-"));
  const llmDir = providers.find((d) => d.startsWith("llm-"));

  const chunks = (ingest.chunks ?? []).slice(0, chunkLimit === Infinity ? undefined : chunkLimit);
  const scribeDir = path.join(dir, "playground", "scribe");

  const perChunk: any[] = [];
  let paidSec = 0;
  const all = { scribe: [] as Span[], deepgram: [] as Span[], gemini: [] as Span[] };
  const allUtt = { scribe: [] as Span[], deepgram: [] as Span[], gemini: [] as Span[] };
  const capabilities = {
    wordTimestamps: false,
    words: 0,
    spacingSpans: 0,
    audioEvents: [] as string[],
    speakers: [] as string[],
    detectedLanguage: undefined as string | undefined,
    languageProbability: undefined as number | undefined,
  };

  for (const chunk of chunks) {
    const file = chunk.file as string;
    if (!(await exists(file))) {
      console.log(`  chunk ${chunk.index}: audio missing, skipped`);
      continue;
    }
    const { raw, cached } = await scribeCached(scribeDir, file);
    if (!cached) paidSec += chunk.durationSec ?? 0;

    const offset = chunk.offsetSec ?? 0;
    const sWords = scribeWords(raw, offset);
    const sEvents = scribeEvents(raw, offset);
    capabilities.wordTimestamps ||= sWords.length > 0;
    capabilities.words += sWords.length;
    capabilities.spacingSpans += (raw.words ?? []).filter((w) => w.type === "spacing").length;
    for (const e of sEvents) if (e.text && !capabilities.audioEvents.includes(e.text)) capabilities.audioEvents.push(e.text);
    for (const w of raw.words ?? []) if (w.speaker_id && !capabilities.speakers.includes(w.speaker_id)) capabilities.speakers.push(w.speaker_id);
    capabilities.detectedLanguage ??= raw.language_code;
    capabilities.languageProbability ??= raw.language_probability;

    const dgRaw = dgDir ? await readJson<any>(path.join(transcribeDir, dgDir, `chunk_${String(chunk.index).padStart(3, "0")}.json`)).catch(() => null) : null;
    const llmRaw = llmDir ? await readJson<any>(path.join(transcribeDir, llmDir, `chunk_${String(chunk.index).padStart(3, "0")}.json`)).catch(() => null) : null;
    const dWords = dgRaw ? deepgramWords(dgRaw, offset) : [];
    const dUtt = dgRaw ? deepgramUtterances(dgRaw, offset) : [];
    const gUtt = llmRaw ? geminiUtterances(llmRaw, offset) : [];

    all.scribe.push(...sWords);
    all.deepgram.push(...dWords);
    all.gemini.push(...gUtt);
    allUtt.scribe.push(...toUtterances(sWords, config.scribe.uttSplitSec));
    allUtt.deepgram.push(...dUtt);
    allUtt.gemini.push(...gUtt);

    perChunk.push({
      index: chunk.index,
      offsetSec: offset,
      durationSec: chunk.durationSec,
      fromCache: cached,
      scribe: { words: sWords.length, text: (raw.text ?? "").trim(), audioEvents: sEvents.map((e) => ({ t: e.text, s: round(e.start), e: round(e.end) })) },
      deepgram: { words: dWords.length, text: dUtt.map((u) => u.text).join(" ") },
      gemini: { utterances: gUtt.length, text: gUtt.map((u) => u.text).join(" ") },
      scribeWords: sWords.map((w) => ({ t: w.text, s: round(w.start), e: round(w.end) })),
    });
    process.stdout.write(cached ? "." : "+");
  }
  process.stdout.write("\n");

  const from = chunks[0]?.offsetSec ?? 0;
  const to = (chunks.at(-1)?.offsetSec ?? 0) + (chunks.at(-1)?.durationSec ?? 0);
  const comparison = {
    window: [from, to],
    onsetDriftVsDeepgram: {
      scribe: onsetDrift(allUtt.scribe, allUtt.deepgram),
      gemini: onsetDrift(allUtt.gemini, allUtt.deepgram), // control: known to drift
    },
    wordsInsideMeasuredSilence: {
      scribe: wordsInsideSilence(all.scribe, silences),
      deepgram: wordsInsideSilence(all.deepgram, silences),
    },
    claimedQuietNotBackedBySilence: {
      scribe: falseQuiet(all.scribe, silences, all.deepgram, from, to),
      deepgram: falseQuiet(all.deepgram, silences, all.scribe, from, to),
    },
  };

  const result = {
    video: job.originalName,
    hash,
    scribeModel: MODEL,
    languageRequested: LANGUAGE || "(auto)",
    chunksTested: perChunk.length,
    audioSecSent: paidSec,
    costUsdThisRun: round((paidSec / 3600) * USD_PER_HOUR, 4),
    capabilities,
    comparison,
    chunks: perChunk,
  };
  await fs.mkdir(path.join(dir, "playground"), { recursive: true });
  await fs.writeFile(path.join(dir, "playground", "scribe.json"), JSON.stringify(result, null, 2));
  return result;
}

// ---- main
const entries = await fs.readdir(config.dataDir, { withFileTypes: true });
const videos = entries
  .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.includes("."))
  .map((e) => e.name)
  .filter((h) => !videoFilter || h.startsWith(videoFilter));

const named = await Promise.all(
  videos.map(async (h) => ({ hash: h, name: (await readJson<any>(path.join(config.dataDir, h, "job.json")).catch(() => ({})))?.originalName ?? "" })),
);
const chosen = videoFilter ? named.filter((v) => v.hash.startsWith(videoFilter) || v.name.includes(videoFilter)) : named;

if (!chosen.length) {
  console.error(`no videos matched${videoFilter ? ` "${videoFilter}"` : ""} in ${config.dataDir}`);
  process.exit(1);
}

console.log(`Scribe: model "${MODEL}", language "${LANGUAGE || "(auto)"}", priced at $${USD_PER_HOUR}/hour`);
console.log(`${chosen.length} video(s), up to ${chunkLimit === Infinity ? "every" : chunkLimit} chunk(s) each. Cached chunks cost nothing ('.' cached, '+' paid).\n`);

const results = [];
for (const v of chosen) {
  console.log(`${v.name || v.hash.slice(0, 8)}`);
  try {
    results.push(await runVideo(v.hash));
  } catch (err) {
    console.error(`  failed: ${(err as Error).message}\n`);
  }
}

if (!results.length) process.exit(1);

// ---- summary
const f = (n: number, w: number) => String(n).padStart(w);
console.log("\n==================== CAN SCRIBE REPLACE THEM? ====================\n");
console.log("Word-level timestamps are the hard requirement: cutAfterLine, freeIntervals and the");
console.log("listen gate all need per-word start/end times.\n");
for (const r of results) {
  const c = r.capabilities;
  console.log(
    `${(r.video ?? r.hash).padEnd(22)} words:${f(c.words, 5)}  wordTimestamps:${c.wordTimestamps ? "YES" : "NO "}  ` +
      `spacing:${f(c.spacingSpans, 5)}  speakers:${f(c.speakers.length, 2)}  lang:${c.detectedLanguage ?? "?"}` +
      `${c.languageProbability ? ` (${round(c.languageProbability, 2)})` : ""}`,
  );
  if (c.audioEvents.length) console.log(`${"".padEnd(22)} audio events seen: ${c.audioEvents.join(", ")}`);
}

console.log("\n---- Drift: utterance onsets vs Deepgram (Gemini is the control — it is known to drift) ----\n");
console.log(`${"video".padEnd(22)} ${"scribe median".padEnd(14)} ${"scribe p90".padEnd(11)} ${"scribe worst".padEnd(13)} | gemini median  gemini p90`);
for (const r of results) {
  const s = r.comparison.onsetDriftVsDeepgram.scribe;
  const g = r.comparison.onsetDriftVsDeepgram.gemini;
  console.log(
    `${(r.video ?? r.hash).padEnd(22)} ${`${s.medianSec}s`.padEnd(14)} ${`${s.p90Sec}s`.padEnd(11)} ${`${s.worstSec}s`.padEnd(13)} | ` +
      `${`${g.medianSec}s`.padEnd(14)} ${g.p90Sec}s`,
  );
}

console.log("\n---- Agreement with ffmpeg's measured silence (signals.json is what the pipeline cuts on) ----\n");
console.log("words inside real silence = timing off, blocks good cuts.");
console.log("quiet-over-speech = DANGEROUS: the transcriber says quiet where the other hears talking.\n");
console.log(`${"video".padEnd(22)} ${"scribe in-silence".padEnd(18)} ${"dg in-silence".padEnd(15)} ${"scribe quiet-over-speech".padEnd(25)} dg quiet-over-speech`);
for (const r of results) {
  const w = r.comparison.wordsInsideMeasuredSilence;
  const q = r.comparison.claimedQuietNotBackedBySilence;
  console.log(
    `${(r.video ?? r.hash).padEnd(22)} ${`${w.scribe.pct}% (${w.scribe.words})`.padEnd(18)} ${`${w.deepgram.pct}% (${w.deepgram.words})`.padEnd(15)} ` +
      `${`${q.scribe.overReferenceSpeechSec}s`.padEnd(25)} ${q.deepgram.overReferenceSpeechSec}s`,
  );
}

const paid = results.reduce((t, r) => t + r.audioSecSent, 0);
console.log(`\nPaid for ${round(paid / 60, 1)} min of audio this run ≈ $${round((paid / 3600) * USD_PER_HOUR, 4)}.`);
console.log(`Per-video JSON (text side by side, every Scribe word with its timing): data/<hash>/playground/scribe.json`);
console.log(`Raw Scribe responses cached at: data/<hash>/playground/scribe/ — delete to re-transcribe.`);
