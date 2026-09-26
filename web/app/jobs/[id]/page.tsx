"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { STAGES, type GetJobResponse, type StageName } from "shared";
import { fmtTime, getJob } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";

const STAGE_LABELS: Record<StageName, string> = {
  ingest: "Extract audio",
  transcribe: "Transcribe dialogue",
  signals: "Detect silences & shot cuts",
  scenes: "Understand scenes",
  candidates: "Find safe cut points",
  match: "Match brands",
  select: "Apply pacing rules",
  outputs: "Write VMAP & report",
};

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<GetJobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await getJob(id);
        if (stop) return;
        setData(r);
        setError(null);
        if (r.job.status === "done" || r.job.status === "error") return;
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
      if (!stop) timer = setTimeout(poll, 2000);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (error && !data) return <p className="text-accent-strong">{error}</p>;
  if (!data) return <p className="text-muted">Loading...</p>;
  const { job, results } = data;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-accent-strong">Processing</p>
          <h1 className="text-2xl font-semibold tracking-tight">{job.originalName}</h1>
          <p className="font-mono text-xs text-muted">job {job.id}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
          {results && (
            <Link
              href={`/jobs/${job.id}/player`}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-strong"
            >
              Open player
            </Link>
          )}
        </div>
      </div>

      <section className="rounded-2xl border border-border bg-surface/90 p-5 shadow-[0_18px_42px_rgba(0,0,0,0.3)]">
        <h2 className="mb-3 font-semibold">Pipeline</h2>
        <ol className="space-y-2">
          {STAGES.map((s, i) => {
            const st = job.stages[s];
            const secs =
              st.startedAt && st.finishedAt ? ((Date.parse(st.finishedAt) - Date.parse(st.startedAt)) / 1000).toFixed(1) : null;
            return (
              <li key={s} className="flex items-center gap-3 rounded-xl border border-border bg-surface-elevated/60 px-3 py-3 text-sm">
                <span className="w-5 font-mono text-right text-muted">{i + 1}</span>
                <span className="flex-1">{STAGE_LABELS[s]}</span>
                {secs && <span className="font-mono text-xs text-muted">{secs}s</span>}
                <StatusBadge status={st.state} />
              </li>
            );
          })}
        </ol>
        {job.error && <p className="mt-3 wrap-break-word text-sm text-accent-strong">{job.error}</p>}
      </section>

      {results && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">
              Ad breaks <span className="font-normal text-muted">({results.breaks.length} in {fmtTime(results.durationSec)})</span>
            </h2>
            <div className="flex gap-3 text-sm">
              <a className="text-accent-strong hover:text-white" href={results.vmapUrl} target="_blank">
                vmap.xml
              </a>
              <a className="text-accent-strong hover:text-white" href={results.breaksUrl} target="_blank">
                breaks.json
              </a>
              <a className="text-accent-strong hover:text-white" href={results.debugUrl} target="_blank">
                debug.json
              </a>
            </div>
          </div>
          {results.breaks.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border bg-surface/70 px-4 py-8 text-sm text-muted">
              No break was safe to place. Every candidate was rejected by the hard rules; see debug.json for the reasons.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border bg-surface/90">
              <table className="w-full text-sm">
                <thead className="bg-surface-elevated text-left text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Brand</th>
                    <th className="px-3 py-2 font-medium">Ad</th>
                    <th className="px-3 py-2 font-medium">Where</th>
                    <th className="px-3 py-2 font-medium">Fit</th>
                    <th className="px-3 py-2 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {results.breaks.map((b) => (
                    <tr key={b.candidateId} className="align-top transition hover:bg-surface-elevated/60">
                      <td className="px-3 py-2 font-mono whitespace-nowrap">{fmtTime(b.timeSec)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{b.brandName}</td>
                      <td className="px-3 py-2 font-mono">{b.adDurationSec}s</td>
                      <td className="px-3 py-2 font-mono">{b.whereScore.toFixed(2)}</td>
                      <td className="px-3 py-2 font-mono">{b.fit.toFixed(2)}</td>
                      <td className="px-3 py-2 text-muted">{b.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
