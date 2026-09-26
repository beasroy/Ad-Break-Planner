"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Job } from "shared";
import { listJobs, uploadVideo } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    listJobs()
      .then((r) => setJobs(r.jobs))
      .catch((e: Error) => setError(e.message));
  }, []);

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
      <section className="rounded-xl border border-black/10 dark:border-white/10 p-6 space-y-4">
        <h1 className="text-xl font-semibold">Upload an episode</h1>
        <p className="text-sm opacity-70">
          The pipeline finds safe, natural ad breaks, applies pacing rules, and matches brands from the catalogue.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={progress !== null}
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-black/5 dark:file:bg-white/10 file:px-3 file:py-1.5"
          />
          <button
            onClick={onUpload}
            disabled={!file || progress !== null}
            className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-medium disabled:opacity-40"
          >
            Upload & process
          </button>
        </div>
        {progress !== null && (
          <div className="space-y-1">
            <div className="h-2 rounded bg-black/10 dark:bg-white/10 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="text-xs opacity-60">Uploading… {Math.round(progress * 100)}%</p>
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Processed videos</h2>
        {jobs.length === 0 ? (
          <p className="text-sm opacity-60">None yet.</p>
        ) : (
          <ul className="divide-y divide-black/10 dark:divide-white/10 rounded-xl border border-black/10 dark:border-white/10">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <Link href={`/jobs/${j.id}`} className="font-medium hover:underline truncate">
                  {j.originalName}
                </Link>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusBadge status={j.status} />
                  {j.status === "done" && (
                    <Link href={`/jobs/${j.id}/player`} className="text-sm underline">
                      Play
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
