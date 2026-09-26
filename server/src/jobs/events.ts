// In-process fan-out of job changes to live-update (SSE) subscribers.
import { EventEmitter } from "node:events";
import type { JobStreamEvent } from "shared";

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open browser tab

export const publishJobEvent = (e: Exclude<JobStreamEvent, { type: "snapshot" }>) => bus.emit("job", e);

export function subscribeJobEvents(fn: (e: Exclude<JobStreamEvent, { type: "snapshot" }>) => void): () => void {
  bus.on("job", fn);
  return () => bus.off("job", fn);
}
