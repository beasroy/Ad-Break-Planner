import type { Job, StageState } from "shared";

const styles: Record<string, string> = {
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  cached: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  running: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  queued: "bg-black/5 dark:bg-white/10",
  pending: "bg-black/5 dark:bg-white/10 opacity-60",
  error: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function StatusBadge({ status }: { status: Job["status"] | StageState }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? ""}`}>{status}</span>;
}
