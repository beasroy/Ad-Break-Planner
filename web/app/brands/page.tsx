"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, Clapperboard, FileJson, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { BrandSummary, ImportProgress } from "shared";
import { createBrand, deleteBrand, importCatalogue, listBrands, rerunAllJobs } from "@/lib/api";

const DURATIONS = [15, 20, 30];
type Tab = "import" | "add";

export default function BrandsPage() {
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [tab, setTab] = useState<Tab>("import");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  const load = () =>
    listBrands()
      .then((r) => setBrands(r.brands))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const requeuedNote = (n: number) =>
    n ? `${n} processed video${n === 1 ? "" : "s"} re-queued against the new catalogue.` : "No processed videos to re-run.";

  /** Runs a catalogue action with the shared busy/error/notice handling. */
  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  function onImport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    if (data.get("mode") === "replace" && !confirm("Replace the whole catalogue with this file? Brands not in it are removed.")) return;
    act("import", async () => {
      const r = await importCatalogue(data, setProgress);
      form.reset();
      const parts = [
        r.added.length && `${r.added.length} added`,
        r.updated.length && `${r.updated.length} updated`,
        r.removed.length && `${r.removed.length} removed`,
        r.generatedCreatives && `${r.generatedCreatives} missing ad${r.generatedCreatives === 1 ? "" : "s"} created`,
      ].filter(Boolean);
      return `Imported: ${parts.join(", ") || "no changes"}. ${requeuedNote(r.requeuedJobs.length)}`;
    });
  }

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    data.set("generate", data.get("generate") ? "true" : "false");
    data.set("durations", data.getAll("duration").join(","));
    data.delete("duration");
    act("create", async () => {
      const r = await createBrand(data);
      form.reset();
      return `Created ${r.brand?.name}. ${requeuedNote(r.requeuedJobs.length)}`;
    });
  }

  function onDelete(b: BrandSummary) {
    if (!confirm(`Delete ${b.name} and its ads? Every processed video will be re-run without it.`)) return;
    act(b.id, async () => `Deleted ${b.name}. ${requeuedNote((await deleteBrand(b.id)).requeuedJobs.length)}`);
  }

  const input =
    "w-full rounded-xl border border-border bg-surface-elevated px-3 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted/60 focus:border-accent/60";
  const panel = "rounded-2xl border border-border bg-surface-elevated/50 p-4 text-sm";
  const primary =
    "inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(215,25,32,0.3)] transition hover:bg-accent-strong disabled:opacity-40";
  const fileInput =
    "w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:font-medium file:text-white";

  const tabs: { id: Tab; label: string; icon: typeof FileJson }[] = [
    { id: "import", label: "Import JSON", icon: FileJson },
    { id: "add", label: "Add a brand", icon: Plus },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.24em] text-accent-strong">Catalogue</p>
          <h1 className="text-3xl font-semibold tracking-tight">Brands</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            Every video is matched against these brands at runtime. Any change re-runs all processed videos, so no break is ever
            chosen with an outdated catalogue.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => act("rerun", async () => requeuedNote((await rerunAllJobs()).requeuedJobs.length))}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface-elevated px-4 py-2.5 text-sm font-medium transition hover:border-accent/40 disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${busy === "rerun" ? "animate-spin" : ""}`} />
            Re-run all videos
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent-strong">{error}</p>}
      {notice && <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>}

      <section className="overflow-hidden rounded-3xl border border-border bg-surface/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_64px_rgba(0,0,0,0.45)]">
        <div role="tablist" aria-label="Change the catalogue" className="flex gap-1 border-b border-border px-4 pt-4">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`-mb-px inline-flex items-center gap-2 rounded-t-xl border px-4 py-2.5 text-sm font-medium transition ${
                tab === id
                  ? "border-border border-b-transparent bg-surface text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              <Icon className={`h-4 w-4 ${tab === id ? "text-accent-strong" : ""}`} />
              {label}
            </button>
          ))}
        </div>

        {tab === "import" ? (
          <form role="tabpanel" onSubmit={onImport} className="space-y-4 p-6">
            <p className="text-sm text-muted">
              Upload a catalogue in the brands.json format: an array of brands, or {"{ \"brands\": [...] }"}. It is validated before
              anything is saved, and new brand names are checked to be synthetic. Any ad file the JSON points to that does not exist
              gets a title-card ad.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <label className={`space-y-2 ${panel}`}>
                <span className="font-medium">Catalogue file</span>
                <input type="file" name="catalogue" accept="application/json,.json" required className={fileInput} />
              </label>
              <fieldset className={`space-y-2 ${panel}`}>
                <legend className="sr-only">Import mode</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="mode" value="merge" defaultChecked className="accent-accent" />
                  Add or update these brands
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="mode" value="replace" className="accent-accent" />
                  Replace the whole catalogue
                </label>
              </fieldset>
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={busy !== null} className={primary}>
                {busy === "import" && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {busy === "import" ? "Importing…" : "Import"}
              </button>
              {busy === "import" && !progress && <span className="text-xs text-muted">Starting the import…</span>}
            </div>
            {busy === "import" && progress && <ImportProgressPanel progress={progress} />}
          </form>
        ) : (
          <form role="tabpanel" onSubmit={onCreate} className="space-y-5 p-6">
            <p className="text-xs text-muted">Synthetic names only; names that look like real companies are refused.</p>
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
              <div className={`space-y-2 ${panel}`}>
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" name="generate" defaultChecked className="accent-accent" />
                  <Clapperboard className="h-4 w-4 text-accent-strong" />
                  Create title-card ads
                </label>
                <p className="text-xs text-muted">The brand name, category and target contexts on the video.</p>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  {DURATIONS.map((d) => (
                    <label key={d} className="flex items-center gap-1.5 font-mono text-xs">
                      <input type="checkbox" name="duration" value={d} defaultChecked={d !== 20} className="accent-accent" />
                      {d}s
                    </label>
                  ))}
                  <select name="language" defaultValue="bn" aria-label="Ad language" className="ml-auto rounded-lg border border-border bg-surface px-2 py-1 text-xs">
                    <option value="bn">Bengali audience</option>
                    <option value="en">English audience</option>
                  </select>
                </div>
              </div>
              <label className={`space-y-2 ${panel}`}>
                <span className="font-medium">Or upload ad videos (up to 3)</span>
                <input type="file" name="creatives" accept="video/*" multiple className={fileInput} />
                <p className="text-xs text-muted">3–120 s each; converted to 1280×720 mp4. Length is read from the file.</p>
              </label>
            </div>

            <div className="flex items-center gap-3">
              <button type="submit" disabled={busy !== null} className={primary}>
                {busy === "create" && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {busy === "create" ? "Creating…" : "Create brand"}
              </button>
              {busy === "create" && <span className="text-xs text-muted">Checking the name and creating the ads.</span>}
            </div>
          </form>
        )}
      </section>

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

/** Live progress of a catalogue import: a bar, and each brand as it becomes ready. */
function ImportProgressPanel({ progress: p }: { progress: ImportProgress }) {
  const pct = p.total ? Math.round((p.ready.length / p.total) * 100) : 100;
  const headline =
    p.phase === "checking"
      ? "Checking brand names…"
      : p.phase === "saving"
        ? "Saving the catalogue…"
        : `${p.ready.length} of ${p.total} brand${p.total === 1 ? "" : "s"} ready`;
  return (
    <div aria-live="polite" className="space-y-3 rounded-2xl border border-border bg-surface-elevated/50 p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{headline}</span>
        <span className="text-xs text-muted">{p.phase === "checking" ? "" : `${pct}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${p.phase === "checking" ? 0 : pct}%` }} />
      </div>
      <ul className="space-y-1 text-xs">
        {p.ready.map((name) => (
          <li key={name} className="flex items-center gap-2 text-emerald-300">
            <Check className="h-3.5 w-3.5" />
            {name} ready
          </li>
        ))}
        {p.working && (
          <li className="flex items-center gap-2 text-muted">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {p.working}: creating ads…
          </li>
        )}
      </ul>
      <p className="text-xs text-muted">Nothing is saved until every brand is ready.</p>
    </div>
  );
}
