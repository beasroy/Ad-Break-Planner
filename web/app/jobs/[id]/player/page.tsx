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

  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="opacity-60">Loading…</p>;
  if (!data.results) {
    return (
      <p>
        Not processed yet. <Link className="underline" href={`/jobs/${id}`}>See progress</Link>
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold truncate">{data.job.originalName}</h1>
        <Link href={`/jobs/${id}`} className="text-sm underline shrink-0">
          Results
        </Link>
      </div>
      <Player videoUrl={data.results.videoUrl} vmapUrl={data.results.vmapUrl} />
    </div>
  );
}
