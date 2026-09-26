"use client";

import { useEffect, useState } from "react";
import type { JobAuditResponse } from "shared";
import { getJobAudit } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";

const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`);
const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Attempts, model usage and cost, and the append-only event trail for one job. */
export function JobAudit({ jobId, refreshKey }: Readonly<{ jobId: string; refreshKey: string }>) {
  const [audit, setAudit] = useState<JobAuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJobAudit(jobId)
      .then((a) => {
        setAudit(a);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [jobId, refreshKey]);

  if (error) return <p className="text-sm text-accent-strong">{error}</p>;
  if (!audit) return null;

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-surface/90 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Audit</h2>
        <div className="flex gap-4 font-mono text-xs text-muted">
          <span>{audit.totals.calls} model calls</span>
          <span className={audit.totals.errors ? "text-accent-strong" : ""}>{audit.totals.errors} errors</span>
          <span className="text-foreground">{fmtCost(audit.totals.costUsd)}</span>
        </div>
      </div>

      {audit.usage.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-left text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Calls</th>
                <th className="px-3 py-2 font-medium">Errors</th>
                <th className="px-3 py-2 font-medium">Avg latency</th>
                <th className="px-3 py-2 font-medium">Audio</th>
                <th className="px-3 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono text-xs">
              {audit.usage.map((u) => (
                <tr key={`${u.provider}/${u.model}`}>
                  <td className="px-3 py-2 font-sans text-sm">
                    {u.model} <span className="text-muted">· {u.provider}</span>
                  </td>
                  <td className="px-3 py-2">{u.calls}</td>
                  <td className={`px-3 py-2 ${u.errors ? "text-accent-strong" : ""}`}>{u.errors}</td>
                  <td className="px-3 py-2">{fmtSec(u.totalLatencyMs / Math.max(1, u.calls))}</td>
                  <td className="px-3 py-2">{u.audioSec ? `${Math.round(u.audioSec / 60)} min` : "—"}</td>
                  <td className="px-3 py-2">{u.provider === "deepgram" ? "not reported" : fmtCost(u.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {audit.attempts.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted">Attempts</h3>
          <ul className="space-y-2">
            {audit.attempts.map((a) => (
              <li key={a.attempt} className="rounded-xl border border-border bg-surface-elevated/60 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono">#{a.attempt}</span>
                  <StatusBadge status={attemptBadge(a.status)} />
                  <span className="font-mono text-xs text-muted">
                    {fmtClock(a.startedAt)}
                    {a.finishedAt && ` → ${fmtClock(a.finishedAt)} (${fmtSec(Date.parse(a.finishedAt) - Date.parse(a.startedAt))})`}
                  </span>
                  <span className="ml-auto font-mono text-xs text-muted">{a.workerId}</span>
                </div>
                {a.error && (
                  <p className="mt-1 wrap-break-word text-xs text-accent-strong">
                    {a.errorStage && <span className="font-mono">[{a.errorStage}] </span>}
                    {a.error}
                    {a.retryable === false && <span className="text-muted"> · not retryable</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-muted hover:text-foreground">
          Event log ({audit.events.length})
        </summary>
        <ol className="mt-2 space-y-1 font-mono text-xs">
          {audit.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-border py-1.5">
              <span className="text-muted">{fmtClock(e.at)}</span>
              <span className="text-foreground">{e.type}</span>
              <span className="text-muted">
                {e.actor}
                {e.attempt !== undefined && ` · attempt ${e.attempt}`}
                {e.ip && ` · ${e.ip}`}
              </span>
              {e.detail && <span className="w-full wrap-break-word text-muted">{JSON.stringify(e.detail)}</span>}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

const attemptBadge = (s: JobAuditResponse["attempts"][number]["status"]) =>
  s === "succeeded" ? "done" : s === "failed" || s === "interrupted" ? "error" : "running";
