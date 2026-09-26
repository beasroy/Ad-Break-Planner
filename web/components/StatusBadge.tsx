import type { Job, StageState } from "shared";

const styles: Record<string, string> = {
  done: "border border-emerald-500/20 bg-emerald-500/15 text-emerald-300",
  cached: "border border-emerald-500/20 bg-emerald-500/15 text-emerald-300",
  running: "border border-amber-500/20 bg-amber-500/15 text-amber-200",
  retrying: "border border-orange-500/20 bg-orange-500/15 text-orange-300",
  queued: "border border-border bg-surface-elevated text-muted",
  pending: "border border-border bg-surface-elevated text-muted opacity-70",
  error: "border border-accent/30 bg-accent/15 text-accent-strong",
};

export function StatusBadge({ status }: Readonly<{ status: Job["status"] | StageState }>) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? ""}`}>{status}</span>;
}
