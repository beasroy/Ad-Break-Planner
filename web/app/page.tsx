"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Job } from "shared";
import { deleteJob, listJobs, uploadVideo } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { PlayIcon, SpinnerIcon, TrashIcon } from "@/components/Icons";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    listJobs()
      .then((r) => setJobs(r.jobs))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function onDelete(job: Job) {
    if (!confirm(`Delete "${job.originalName}"? This removes the video and all its results.`)) return;
    setError(null);
    setDeletingId(job.id);
    try {
      await deleteJob(job.id);
      setJobs((js) => js.filter((j) => j.id !== job.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  async function onUpload() {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const { job } = await uploadVideo(file, setProgress);
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-6 rounded-3xl border border-border bg-surface/95 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_64px_rgba(0,0,0,0.45)]">
        <div className="space-y-3">
          <span className="inline-flex rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-accent-strong">
            Bengali streaming inspired
          </span>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Upload an episode</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            The pipeline finds safe, natural ad breaks, applies pacing rules, and matches brands from the catalogue.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted">
          <span className="rounded-full border border-border bg-surface-elevated px-3 py-1">Scene-aware cuts</span>
          <span className="rounded-full border border-border bg-surface-elevated px-3 py-1">Brand matching</span>
          <span className="rounded-full border border-border bg-surface-elevated px-3 py-1">VMAP output</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={progress !== null}
            className="w-full max-w-lg rounded-xl border border-border bg-surface-elevated px-3 py-3 text-sm text-foreground outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:font-medium file:text-white md:w-auto"
          />
          <button
            onClick={onUpload}
            disabled={!file || progress !== null}
            className="rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(215,25,32,0.3)] transition hover:bg-accent-strong disabled:opacity-40"
          >
            Upload & process
          </button>
        </div>
        {progress !== null && (
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-surface-elevated">
              <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="text-xs text-muted">Uploading... {Math.round(progress * 100)}%</p>
          </div>
        )}
        {error && <p className="text-sm text-accent-strong">{error}</p>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Processed videos</h2>
          <span className="text-xs uppercase tracking-[0.24em] text-muted">{jobs.length} jobs</span>
        </div>
        {jobs.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface/70 px-4 py-8 text-center text-sm text-muted">
            None yet.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/90">
            {jobs.map((j) => (
              <li
                key={j.id}
                aria-busy={deletingId === j.id}
                className={`flex items-center justify-between gap-3 px-4 py-4 transition hover:bg-surface-elevated/80 ${deletingId === j.id ? "pointer-events-none" : ""}`}
              >
                <Link
                  href={`/jobs/${j.id}`}
                  className={`truncate font-medium hover:text-accent-strong ${deletingId === j.id ? "text-muted line-through" : ""}`}
                >
                  {j.originalName}
                </Link>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusBadge status={j.status} />
                  {j.status === "done" && (
                    <Link
                      href={`/jobs/${j.id}/player`}
                      aria-label={`Play ${j.originalName}`}
                      title="Play"
                      className="rounded-full bg-accent p-2 text-white transition hover:bg-accent-strong"
                    >
                      <PlayIcon />
                    </Link>
                  )}
                  <button
                    onClick={() => onDelete(j)}
                    disabled={j.status === "running" || deletingId !== null}
                    aria-label={deletingId === j.id ? `Deleting ${j.originalName}` : `Delete ${j.originalName}`}
                    title={j.status === "running" ? "Wait for processing to finish" : deletingId === j.id ? "Deleting..." : "Delete video and results"}
                    className={`rounded-full p-2 text-muted transition hover:bg-accent/10 hover:text-accent-strong disabled:hover:bg-transparent disabled:hover:text-muted ${deletingId === j.id ? "" : "disabled:opacity-40"}`}
                  >
                    {deletingId === j.id ? <SpinnerIcon className="h-4 w-4 text-accent-strong" /> : <TrashIcon />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
