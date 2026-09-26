// Typed client for the server API. Endpoint shapes are PROVISIONAL (see shared/src/api.ts)
// until API_SPEC.md exists.
import type { CreateJobResponse, GetJobResponse, ListJobsResponse } from "shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const listJobs = () => getJson<ListJobsResponse>("/api/jobs");
export const getJob = (id: string) => getJson<GetJobResponse>(`/api/jobs/${encodeURIComponent(id)}`);

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `delete failed: HTTP ${res.status}`);
  }
}

/** Multipart upload with progress (fetch has no upload progress, so XHR). */
export function uploadVideo(file: File, onProgress: (fraction: number) => void): Promise<CreateJobResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/jobs`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as CreateJobResponse);
        else reject(new Error(body?.error ?? `upload failed: HTTP ${xhr.status}`));
      } catch {
        reject(new Error(`upload failed: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload failed: network error (is the server running?)"));
    const form = new FormData();
    form.append("video", file);
    xhr.send(form);
  });
}

export const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
