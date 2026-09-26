import { describe, expect, it } from "vitest";
import { createRepo, openDb } from "../src/db/repo";
import { PermanentError } from "../src/lib/errors";
import { classifyError, createQueue, retryDelaySec, type QueueConfig, type RunFn } from "../src/jobs/queue";
import { StageError } from "../src/jobs/runner";

const HASH = "a".repeat(64);
const ID = HASH.slice(0, 16);
const Q: QueueConfig = {
  concurrency: 1,
  pollMs: 10_000,
  maxAttempts: 3,
  backoffBaseSec: 30,
  backoffMaxSec: 600,
  heartbeatSec: 10,
  staleAfterSec: 60,
  attemptTimeoutSec: 3600,
};

/** In-memory database with a clock the test moves by hand. */
function setup() {
  let t = Date.parse("2026-09-26T10:00:00Z");
  const clock = () => new Date(t);
  const db = openDb(":memory:");
  const repo = createRepo(db, clock);
  return { db, repo, advance: (sec: number) => (t += sec * 1000) };
}

const upload = (repo: ReturnType<typeof createRepo>, maxAttempts = 3) =>
  repo.enqueueUpload({ fileHash: HASH, originalName: "ep1.mp4", sizeBytes: 10, mimeType: "video/mp4", maxAttempts, requester: { ip: "1.2.3.4" } });

const types = (repo: ReturnType<typeof createRepo>) => repo.getAudit(ID)!.events.map((e) => e.type);

describe("retryDelaySec", () => {
  it("grows ×4 per attempt and is capped", () => {
    expect([1, 2, 3, 4].map((n) => retryDelaySec(n, Q))).toEqual([30, 120, 480, 600]);
  });
});

describe("classifyError", () => {
  it("keeps the stage and marks permanent errors as not retryable", () => {
    expect(classifyError(new StageError("ingest", new PermanentError("No audio stream found")))).toEqual({
      message: "PermanentError: No audio stream found",
      stage: "ingest",
      retryable: false,
    });
    expect(classifyError(new StageError("scenes", new Error("OpenRouter HTTP 503")))).toMatchObject({ stage: "scenes", retryable: true });
  });
});

describe("repo: uploads", () => {
  it("creates a queued job with an audit trail that records who uploaded", () => {
    const { repo } = setup();
    expect(upload(repo).outcome).toBe("created");
    const job = repo.getJob(ID)!;
    expect(job).toMatchObject({ status: "queued", attempts: 0, maxAttempts: 3, sizeBytes: 10 });
    const ev = repo.getAudit(ID)!.events;
    expect(ev.map((e) => e.type)).toEqual(["job.created", "job.queued"]);
    expect(ev[0]).toMatchObject({ actor: "api", ip: "1.2.3.4" });
  });

  it("does not queue a second run while one is active", () => {
    const { repo } = setup();
    upload(repo);
    expect(upload(repo).outcome).toBe("already-active");
    expect(types(repo)).toContain("upload.duplicate");
  });

  it("re-uploading a deleted video restores it; the old audit trail is kept", () => {
    const { repo } = setup();
    upload(repo);
    expect(repo.markDeleted(ID).fileHash).toBe(HASH);
    expect(repo.getJob(ID)).toBeUndefined();
    expect(repo.listJobs()).toEqual([]);
    expect(upload(repo).outcome).toBe("restored");
    expect(repo.getJob(ID)!.status).toBe("queued");
    expect(types(repo)).toEqual(["job.created", "job.queued", "job.deleted", "job.restored"]);
  });

  it("refuses to delete a running job", () => {
    const { repo } = setup();
    upload(repo);
    repo.claimNext("w1");
    expect(repo.markDeleted(ID).error).toBe("running");
  });
});

describe("repo: audit trail is append-only", () => {
  it("rejects updates and deletes at the database level", () => {
    const { db, repo } = setup();
    upload(repo);
    expect(() => db.exec("UPDATE audit_events SET type = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_events")).toThrow(/append-only/);
  });
});

describe("repo: claiming", () => {
  it("claims a due job once and opens an attempt", () => {
    const { repo } = setup();
    upload(repo);
    expect(repo.claimNext("w1")).toEqual({ id: ID, fileHash: HASH, attempt: 1 });
    expect(repo.claimNext("w2")).toBeUndefined();
    expect(repo.getJob(ID)).toMatchObject({ status: "running", attempts: 1 });
    expect(repo.getAudit(ID)!.attempts).toMatchObject([{ attempt: 1, workerId: "w1", status: "running" }]);
  });

  it("a scheduled retry is not claimed before it is due", () => {
    const { repo, advance } = setup();
    upload(repo);
    repo.claimNext("w1");
    expect(repo.fail(ID, "w1", 1, { error: "boom", stage: "scenes", retryable: true, retryDelaySec: 30 })).toBe("retrying");
    expect(repo.claimNext("w1")).toBeUndefined();
    advance(31);
    expect(repo.claimNext("w1")?.attempt).toBe(2);
  });
});

describe("repo: failures", () => {
  it("fails for good after max attempts", () => {
    const { repo, advance } = setup();
    upload(repo, 2);
    for (const attempt of [1, 2]) {
      repo.claimNext("w1");
      const outcome = repo.fail(ID, "w1", attempt, { error: "503", stage: "scenes", retryable: true, retryDelaySec: 30 });
      expect(outcome).toBe(attempt === 1 ? "retrying" : "error");
      advance(31);
    }
    expect(repo.getJob(ID)).toMatchObject({ status: "error", attempts: 2, error: "503" });
    const a = repo.getAudit(ID)!;
    expect(a.attempts.map((x) => x.status)).toEqual(["failed", "failed"]);
    expect(a.events.at(-1)).toMatchObject({ type: "job.failed", detail: { reason: "no attempts left" } });
  });

  it("does not retry a permanent error", () => {
    const { repo } = setup();
    upload(repo);
    repo.claimNext("w1");
    expect(repo.fail(ID, "w1", 1, { error: "No audio stream", stage: "ingest", retryable: false, retryDelaySec: 30 })).toBe("error");
    expect(repo.getJob(ID)!.attempts).toBe(1);
  });

  it("manual retry grants a fresh budget and keeps attempt numbers increasing", () => {
    const { repo } = setup();
    upload(repo, 1);
    repo.claimNext("w1");
    repo.fail(ID, "w1", 1, { error: "503", retryable: true, retryDelaySec: 30 });
    expect(repo.retry(ID, 3).job).toMatchObject({ status: "queued", attempts: 1, maxAttempts: 4 });
    expect(repo.claimNext("w1")?.attempt).toBe(2);
    expect(repo.retry(ID, 3).error).toMatch(/only failed jobs/);
  });

  it("ignores a result from a worker that no longer holds the job", () => {
    const { repo, advance } = setup();
    upload(repo);
    repo.claimNext("w1");
    advance(120);
    repo.recoverStale(60, () => 5);
    expect(repo.succeed(ID, "w1", 1, { breakCount: 2 })).toBe(false);
    expect(repo.getJob(ID)!.status).toBe("retrying");
  });
});

describe("repo: crash recovery", () => {
  it("reschedules a running job whose heartbeat went silent", () => {
    const { repo, advance } = setup();
    upload(repo);
    repo.claimNext("w1");
    advance(30);
    repo.heartbeat(ID, "w1");
    advance(45);
    expect(repo.recoverStale(60, () => 5)).toEqual([]);
    advance(30);
    expect(repo.recoverStale(60, () => 5)).toEqual([ID]);
    expect(repo.getJob(ID)!.status).toBe("retrying");
    expect(repo.getAudit(ID)!.attempts[0].status).toBe("interrupted");
    expect(types(repo)).toContain("attempt.interrupted");
  });

  it("a worker shutting down hands its jobs back at once", () => {
    const { repo } = setup();
    upload(repo);
    repo.claimNext("w1");
    expect(repo.recoverStale(60, () => 5, "w1")).toEqual([ID]);
  });
});

describe("repo: model calls", () => {
  it("sums calls, errors and cost per model", () => {
    const { repo } = setup();
    upload(repo);
    const base = { jobId: ID, attempt: 1, stage: "scenes", provider: "openrouter" as const, model: "m", startedAt: "t", latencyMs: 100 };
    repo.recordModelCall({ ...base, ok: true, costUsd: 0.01 });
    repo.recordModelCall({ ...base, ok: false, httpStatus: 503 });
    const a = repo.getAudit(ID)!;
    expect(a.usage).toEqual([{ provider: "openrouter", model: "m", calls: 2, errors: 1, totalLatencyMs: 200, costUsd: 0.01, audioSec: 0 }]);
    expect(a.totals).toEqual({ calls: 2, errors: 1, costUsd: 0.01 });
  });
});

describe("queue", () => {
  it("retries a failed attempt and succeeds, recording stages", async () => {
    const { repo, advance } = setup();
    upload(repo);
    let calls = 0;
    const run: RunFn = async (_job, hooks) => {
      calls++;
      hooks.onStage("ingest", { state: "running", startedAt: "2026-09-26T10:00:00.000Z" });
      if (calls === 1) throw new StageError("ingest", new Error("OpenRouter HTTP 503"));
      hooks.onStage("ingest", { state: "done", startedAt: "2026-09-26T10:00:00.000Z", finishedAt: "2026-09-26T10:00:02.000Z" });
      return { durationSec: 1500, breakCount: 2 };
    };
    const q = createQueue({ repo, run, config: Q, workerId: "w1" });
    q.start();
    await q.tick();
    await q.idle();
    expect(repo.getJob(ID)).toMatchObject({ status: "retrying", attempts: 1, error: "OpenRouter HTTP 503" });

    advance(31);
    await q.tick();
    await q.idle();
    q.stop();
    expect(repo.getJob(ID)).toMatchObject({ status: "done", attempts: 2, breakCount: 2, durationSec: 1500 });
    expect(repo.getJob(ID)!.stages.ingest.state).toBe("done");
    expect(types(repo)).toEqual([
      "job.created",
      "job.queued",
      "attempt.started",
      "attempt.failed",
      "job.retry_scheduled",
      "attempt.started",
      "attempt.succeeded",
    ]);
  });

  it("fails a permanent error without retrying", async () => {
    const { repo } = setup();
    upload(repo);
    const run: RunFn = async () => {
      throw new StageError("ingest", new PermanentError("Not a readable video file"));
    };
    const q = createQueue({ repo, run, config: Q, workerId: "w1" });
    q.start();
    await q.tick();
    await q.idle();
    q.stop();
    expect(repo.getJob(ID)).toMatchObject({ status: "error", attempts: 1 });
    expect(repo.getAudit(ID)!.attempts[0]).toMatchObject({ errorStage: "ingest", retryable: false });
  });

  it("runs no more jobs at once than the concurrency limit", async () => {
    const { repo } = setup();
    for (const h of ["b", "c", "d"]) {
      repo.enqueueUpload({ fileHash: h.repeat(64), originalName: `${h}.mp4`, maxAttempts: 3 });
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run: RunFn = async () => {
      await gate;
      return { durationSec: 1, breakCount: 0 };
    };
    const q = createQueue({ repo, run, config: { ...Q, concurrency: 2 }, workerId: "w1" });
    q.start();
    await q.tick();
    expect(q.activeCount()).toBe(2);
    release();
    await q.idle();
    q.stop();
  });
});

describe("repo: change notifications (live updates)", () => {
  it("reports the job after each visible change, but not heartbeats or duplicate uploads", () => {
    const seen: string[][] = [];
    const repo = createRepo(openDb(":memory:"), () => new Date("2026-09-26T10:00:00Z"), (ids) => seen.push(ids));
    upload(repo);
    upload(repo); // already active: nothing changed
    repo.claimNext("w1");
    repo.heartbeat(ID, "w1");
    repo.setStage(ID, 1, "ingest", { state: "running" });
    repo.succeed(ID, "w1", 1, { breakCount: 1 });
    repo.markDeleted(ID);
    expect(seen).toEqual([[ID], [ID], [ID], [ID], [ID]]);
  });
});
