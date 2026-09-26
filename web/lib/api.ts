// Typed client for the server API. Endpoint shapes are PROVISIONAL (see shared/src/api.ts)
// until API_SPEC.md exists.
import type {
  BrandChangeResponse,
  CreateJobResponse,
  GetJobResponse,
  ImportCatalogueResponse,
  Job,
  JobStreamEvent,
  ListBrandsResponse,
  ListJobsResponse,
} from "shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const listJobs = () => getJson<ListJobsResponse>("/api/jobs");
export const getJob = (id: string) => getJson<GetJobResponse>(`/api/jobs/${encodeURIComponent(id)}`);

/**
 * Live job updates over Server-Sent Events. The browser reconnects by itself after a drop, and
 * every (re)connect starts with a fresh snapshot, so the caller's state is always complete.
 * Returns a function that closes the stream.
 */
export function subscribeJobs(
  opts: { jobId?: string },
  on: {
    snapshot: (jobs: Job[]) => void;
    job: (job: Job) => void;
    deleted: (id: string) => void;
    connection?: (connected: boolean) => void;
  },
): () => void {
  const qs = opts.jobId ? `?jobId=${encodeURIComponent(opts.jobId)}` : "";
  const es = new EventSource(`${API_URL}/api/events${qs}`);
  const parse = (e: MessageEvent) => JSON.parse(e.data) as JobStreamEvent;
  es.addEventListener("snapshot", (e) => {
    const ev = parse(e as MessageEvent);
    if (ev.type === "snapshot") on.snapshot(ev.jobs);
    on.connection?.(true);
  });
  es.addEventListener("job", (e) => {
    const ev = parse(e as MessageEvent);
    if (ev.type === "job") on.job(ev.job);
  });
  es.addEventListener("deleted", (e) => {
    const ev = parse(e as MessageEvent);
    if (ev.type === "deleted") on.deleted(ev.id);
  });
  es.onerror = () => on.connection?.(false);
  return () => es.close();
}

export async function retryJob(id: string): Promise<CreateJobResponse> {
  const res = await fetch(`${API_URL}/api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `retry failed: HTTP ${res.status}`);
  return body as CreateJobResponse;
}

export const listBrands = () => getJson<ListBrandsResponse>("/api/brands");

async function sendJson<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${path}: HTTP ${res.status}`);
  return body as T;
}

/** Creates a brand (multipart: fields + optional ad videos). Takes up to a minute when generating creatives. */
export const createBrand = (form: FormData) => sendJson<BrandChangeResponse>("/api/brands", { method: "POST", body: form });

/** Imports a brands.json-format file (multipart: catalogue, mode, missingAds). */
export const importCatalogue = (form: FormData) =>
  sendJson<ImportCatalogueResponse>("/api/brands/import", { method: "POST", body: form });

export const deleteBrand = (id: string) =>
  sendJson<BrandChangeResponse>(`/api/brands/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Re-processes every video against the current catalogue (cached stages are reused). */
export const rerunAllJobs = () => sendJson<{ requeuedJobs: string[] }>("/api/jobs/rerun-all", { method: "POST" });

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
