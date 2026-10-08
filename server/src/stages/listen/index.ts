// HARD RULE, the final gate before an ad is placed: is anyone speaking within ±windowSec of the cut?
// 1. Silero VAD on the audio (local, free): clearly speech → no ad; clearly quiet with no
//    transcribed word in the window → accept. No LLM call either way.
// 2. Only when VAD is unsure: the audio LLM listens to a 6s clip, `llmVotes` times. Any answer
//    that hears words, or any failed call, = no ad.
import fs from "node:fs/promises";
import path from "node:path";
import type { Interval, ListenCheck } from "shared";
import { encodeMp3Chunk } from "../../lib/ffmpeg";
import { chatJson } from "../../lib/openrouter";
import { vadAround } from "../../lib/vad";
import {
  LISTEN_CLIP_SEC,
  LISTEN_CUT_AT_SEC,
  ListenResponse,
  listenJsonSchema,
  listenSystemPrompt,
  listenUserText,
} from "../../prompts/listen";
import { artifactPath, type StageContext } from "../context";
import { llmVerdict, speechIntervalNear, vadGate, type LlmListenAnswer } from "./rules";

/** The cut being checked: an id for the clip's log label, and the time itself. */
export interface ListenTarget {
  id: string;
  cutTime: number;
}

/** What was heard. `rejected` is set, with a reason, whenever no ad may play at this cut. */
export interface ListenOutcome {
  check?: ListenCheck;
  rejected?: string;
}

export async function listenCheck(
  ctx: StageContext,
  target: ListenTarget,
  wav: string,
  durationSec: number,
  /** Transcribed word intervals (transcript.speech): a word near the cut sends it to the LLM. */
  speech: Interval[],
): Promise<ListenOutcome> {
  const t = ctx.config.listen;
  const cut = target.cutTime;
  let vad;
  try {
    vad = await vadAround(t.vadModelPath, wav, cut, t.windowSec);
  } catch (err) {
    return { rejected: `speech check failed, cannot confirm no speech (${(err as Error).message.slice(0, 120)})` };
  }
  const speechNear = speechIntervalNear(speech, cut, t.windowSec);
  const gate = vadGate(vad, speechNear, t);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const base = { vad: { max: round(vad.max), frac: round(vad.frac) }, speechNear };

  if (gate !== "unsure") {
    const speechHeard = gate === "speech";
    const check: ListenCheck = {
      ...base,
      speech: speechHeard,
      method: "vad",
      reason: speechHeard
        ? `voice activity ${vad.max.toFixed(2)} at the cut (≥ ${t.vadSpeechMin})`
        : `no voice activity at the cut (${vad.max.toFixed(2)} < ${t.vadQuietMax}) and no transcribed word within ${t.windowSec}s`,
    };
    return { check, rejected: speechHeard ? `speech at the cut: ${check.reason}` : undefined };
  }

  const dir = artifactPath(ctx, "listen");
  await fs.mkdir(dir, { recursive: true });
  const start = Math.max(0, cut - LISTEN_CUT_AT_SEC);
  const clip = path.join(dir, `cut_${cut.toFixed(3)}.mp3`);
  await encodeMp3Chunk(wav, clip, start, Math.min(LISTEN_CLIP_SEC, durationSec - start), "96k");
  const data = (await fs.readFile(clip)).toString("base64");
  const answers = await Promise.all(
    Array.from({ length: t.llmVotes }, (_, i) =>
      chatJson({
        label: `listen ${target.id} #${i + 1}`,
        model: ctx.config.openrouter.listenModel,
        system: listenSystemPrompt,
        user: [
          { type: "text", text: listenUserText },
          { type: "input_audio", input_audio: { data, format: "mp3" } },
        ],
        schemaName: "listen_check",
        schema: listenJsonSchema,
      })
        .then((raw): LlmListenAnswer => ListenResponse.parse(raw))
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
    ),
  );
  const verdict = llmVerdict(answers);
  const check: ListenCheck = {
    ...base,
    speech: verdict.speech,
    method: "llm",
    answers: answers
      .filter((a): a is LlmListenAnswer => !(a instanceof Error))
      .map((a) => ({ speechNearMark: a.speech_near_mark, heard: a.heard_at_mark, transcript: a.transcript })),
    reason: `voice activity ${vad.max.toFixed(2)} is unclear; ${verdict.reason}`,
  };
  return { check, rejected: verdict.speech ? verdict.reason : undefined };
}
