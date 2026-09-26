"use client";

import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { BrandSummary } from "shared";
import { createBrand, deleteBrand, listBrands, rerunAllJobs } from "@/lib/api";

const DURATIONS = [15, 20, 30];

export default function BrandsPage() {
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "rerun" | string | null>(null);

  const load = () =>
    listBrands()
      .then((r) => setBrands(r.brands))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const requeuedNote = (n: number) =>
    n ? `${n} processed video${n === 1 ? "" : "s"} re-queued against the new catalogue.` : "No processed videos to re-run.";

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    data.set("generate", data.get("generate") ? "true" : "false");
    data.set("durations", data.getAll("duration").join(","));
    data.delete("duration");
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const r = await createBrand(data);
      form.reset();
      setNotice([`Created ${r.brand?.name}.`, requeuedNote(r.requeuedJobs.length), r.warning].filter(Boolean).join(" "));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(b: BrandSummary) {
    if (!confirm(`Delete ${b.name} and its ads? Every processed video will be re-run without it.`)) return;
    setBusy(b.id);
    setError(null);
    setNotice(null);
    try {
      const r = await deleteBrand(b.id);
      setNotice(`Deleted ${b.name}. ${requeuedNote(r.requeuedJobs.length)}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onRerun() {
    setBusy("rerun");
    setError(null);
    try {
      setNotice(requeuedNote((await rerunAllJobs()).requeuedJobs.length));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const input =
    "w-full rounded-xl border border-border bg-surface-elevated px-3 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted/60 focus:border-accent/60";

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.24em] text-accent-strong">Catalogue</p>
          <h1 className="text-3xl font-semibold tracking-tight">Brands</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            Every video is matched against these brands at runtime. Adding or deleting a brand re-runs all processed videos, so
            no break is ever chosen with an outdated catalogue.
          </p>
        </div>
        <button
          onClick={onRerun}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface-elevated px-4 py-2.5 text-sm font-medium transition hover:border-accent/40 disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${busy === "rerun" ? "animate-spin" : ""}`} />
          Re-run all videos
        </button>
      </div>

      {error && <p className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent-strong">{error}</p>}
      {notice && <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

      <form
        onSubmit={onCreate}
        className="space-y-5 rounded-3xl border border-border bg-surface/95 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_64px_rgba(0,0,0,0.45)]"
      >
        <div>
          <h2 className="text-lg font-semibold">Add a brand</h2>
          <p className="text-xs text-muted">Synthetic names only; names that look like real companies are refused.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="text-muted">Name</span>
            <input name="name" required minLength={2} maxLength={60} placeholder="Synth Ninth Paints" className={input} />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted">Category</span>
            <input name="category" placeholder="home/paint/renovation" className={input} />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted">Target contexts: scenes the brand fits (comma separated)</span>
            <textarea name="targetContexts" required rows={2} placeholder="painting walls, new house, renovation" className={input} />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted">Negative contexts: never place next to (comma separated)</span>
            <textarea name="negativeContexts" rows={2} placeholder="flood, fire, grief" className={input} />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-2xl border border-border bg-surface-elevated/50 p-4 text-sm">
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" name="generate" defaultChecked className="accent-[var(--accent)]" />
              <Sparkles className="h-4 w-4 text-accent-strong" />
              Generate ads with AI
            </label>
            <p className="text-xs text-muted">An image of the brand&apos;s world plus a headline and tagline shown over it.</p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {DURATIONS.map((d) => (
                <label key={d} className="flex items-center gap-1.5 font-mono text-xs">
                  <input type="checkbox" name="duration" value={d} defaultChecked={d !== 20} className="accent-[var(--accent)]" />
                  {d}s
                </label>
              ))}
              <select name="language" defaultValue="bn" className="ml-auto rounded-lg border border-border bg-surface px-2 py-1 text-xs">
                <option value="bn">Bengali copy</option>
                <option value="en">English copy</option>
              </select>
            </div>
          </div>
          <label className="space-y-2 rounded-2xl border border-border bg-surface-elevated/50 p-4 text-sm">
            <span className="font-medium">Or upload ad videos (up to 3)</span>
            <input
              type="file"
              name="creatives"
              accept="video/*"
              multiple
              className="w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:font-medium file:text-white"
            />
            <p className="text-xs text-muted">3–120 s each; converted to 1280×720 mp4. Length is read from the file.</p>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(215,25,32,0.3)] transition hover:bg-accent-strong disabled:opacity-40"
          >
            {busy === "create" && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {busy === "create" ? "Creating…" : "Create brand"}
          </button>
          {busy === "create" && <span className="text-xs text-muted">Checking the name, generating the ad and copy: up to a minute.</span>}
        </div>
      </form>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">In the catalogue</h2>
          <span className="text-xs uppercase tracking-[0.24em] text-muted">{brands.length} brands</span>
        </div>
        <ul className="grid gap-4 md:grid-cols-2">
          {brands.map((b) => (
            <li key={b.id} className="space-y-3 rounded-2xl border border-border bg-surface/90 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{b.name}</h3>
                  <p className="truncate font-mono text-xs text-muted">
                    {b.id} · {b.category || "no category"}
                  </p>
                </div>
                <button
                  onClick={() => onDelete(b)}
                  disabled={busy !== null}
                  aria-label={`Delete ${b.name}`}
                  title="Delete brand and its ads"
                  className="rounded-full p-2 text-muted transition hover:bg-accent/10 hover:text-accent-strong disabled:opacity-40"
                >
                  {busy === b.id ? <LoaderCircle className="h-4 w-4 animate-spin text-accent-strong" /> : <Trash2 className="h-4 w-4" />}
                </button>
              </div>
              {(b.headline || b.tagline) && (
                <div className="rounded-xl border border-border bg-surface-elevated/60 px-3 py-2">
                  {b.headline && <p className="text-sm font-semibold">{b.headline}</p>}
                  {b.tagline && <p className="text-xs text-muted">{b.tagline}</p>}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {b.targetContexts.map((c) => (
                  <span key={c} className="rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-muted">
                    {c}
                  </span>
                ))}
              </div>
              {b.negativeContexts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {b.negativeContexts.map((c) => (
                    <span key={c} className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent-strong">
                      ✕ {c}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2 overflow-x-auto pt-1">
                {b.creatives.map((c) => (
                  <figure key={c.id} className="w-36 shrink-0 space-y-1">
                    <video src={c.url} preload="metadata" controls muted className="aspect-video w-full rounded-lg border border-border bg-black">
                      <track kind="captions" src="data:text/vtt;charset=utf-8,WEBVTT" label="Captions" />
                    </video>
                    <figcaption className="font-mono text-[11px] text-muted">
                      {c.durationSec}s · {c.language}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
