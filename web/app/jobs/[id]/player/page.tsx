"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { GetJobResponse } from "shared";
import { getJob } from "@/lib/api";
import { Player } from "@/components/Player";

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<GetJobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJob(id)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="text-accent-strong">{error}</p>;
  if (!data) return <p className="text-muted">Loading...</p>;
  if (!data.results) {
    return (
      <p className="text-muted">
        Not processed yet.{" "}
        <Link className="font-medium text-accent-strong hover:text-white" href={`/jobs/${id}`}>
          See progress
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-accent-strong">Preview</p>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{data.job.originalName}</h1>
        </div>
        <Link href={`/jobs/${id}`} className="shrink-0 text-sm font-medium text-accent-strong hover:text-white">
          Results
        </Link>
      </div>
      <Player videoUrl={data.results.videoUrl} vmapUrl={data.results.vmapUrl} />
    </div>
  );
}
