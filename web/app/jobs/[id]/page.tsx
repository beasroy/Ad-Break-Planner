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

  if (error && !data) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="opacity-60">Loading…</p>;
  const { job, results } = data;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{job.originalName}</h1>
          <p className="text-xs opacity-60 font-mono">job {job.id}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
          {results && (
            <Link href={`/jobs/${job.id}/player`} className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-medium">
              Open player
            </Link>
          )}
        </div>
      </div>

      <section className="rounded-xl border border-black/10 dark:border-white/10 p-4">
        <h2 className="font-semibold mb-3">Pipeline</h2>
        <ol className="space-y-2">
          {STAGES.map((s, i) => {
            const st = job.stages[s];
            const secs =
              st.startedAt && st.finishedAt ? ((Date.parse(st.finishedAt) - Date.parse(st.startedAt)) / 1000).toFixed(1) : null;
            return (
              <li key={s} className="flex items-center gap-3 text-sm">
                <span className="w-5 text-right opacity-50 font-mono">{i + 1}</span>
                <span className="flex-1">{STAGE_LABELS[s]}</span>
                {secs && <span className="opacity-50 font-mono text-xs">{secs}s</span>}
                <StatusBadge status={st.state} />
              </li>
            );
          })}
        </ol>
        {job.error && <p className="mt-3 text-sm text-red-600 break-words">{job.error}</p>}
      </section>

      {results && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">
              Ad breaks <span className="opacity-60 font-normal">({results.breaks.length} in {fmtTime(results.durationSec)})</span>
            </h2>
            <div className="flex gap-3 text-sm">
              <a className="underline" href={results.vmapUrl} target="_blank">
                vmap.xml
              </a>
              <a className="underline" href={results.breaksUrl} target="_blank">
                breaks.json
              </a>
              <a className="underline" href={results.debugUrl} target="_blank">
                debug.json
              </a>
            </div>
          </div>
          {results.breaks.length === 0 ? (
            <p className="text-sm opacity-70">
              No break was safe to place. Every candidate was rejected by the hard rules; see debug.json for the reasons.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
              <table className="w-full text-sm">
                <thead className="text-left opacity-60">
                  <tr>
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Brand</th>
                    <th className="px-3 py-2 font-medium">Ad</th>
                    <th className="px-3 py-2 font-medium">Where</th>
                    <th className="px-3 py-2 font-medium">Fit</th>
                    <th className="px-3 py-2 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10 dark:divide-white/10">
                  {results.breaks.map((b) => (
                    <tr key={b.candidateId} className="align-top">
                      <td className="px-3 py-2 font-mono whitespace-nowrap">{fmtTime(b.timeSec)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{b.brandName}</td>
                      <td className="px-3 py-2 font-mono">{b.adDurationSec}s</td>
                      <td className="px-3 py-2 font-mono">{b.whereScore.toFixed(2)}</td>
                      <td className="px-3 py-2 font-mono">{b.fit.toFixed(2)}</td>
                      <td className="px-3 py-2 opacity-80">{b.reason}</td>
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
