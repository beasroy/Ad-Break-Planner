"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "@/lib/api";
import { loadAdSchedule, type VastAd, type VmapBreak } from "@/lib/vmap";

type ScheduledBreak = VmapBreak & { ad: VastAd };

/** Seconds of playback before a break that "Jump" lands on. */
const JUMP_LEAD_SEC = 5;
/** A time jump larger than this between frames is a seek, not playback: skipped breaks don't fire. */
const MAX_PLAYBACK_STEP_SEC = 1.5;

export function Player({ videoUrl, vmapUrl }: { videoUrl: string; vmapUrl: string }) {
  const contentRef = useRef<HTMLVideoElement>(null);
  const adRef = useRef<HTMLVideoElement>(null);
  const lastTimeRef = useRef(0);
  const playedRef = useRef(new Set<string>());
  const inAdRef = useRef(false);

  const [schedule, setSchedule] = useState<ScheduledBreak[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [activeAd, setActiveAd] = useState<ScheduledBreak | null>(null);
  const [adRemaining, setAdRemaining] = useState(0);
  const [played, setPlayed] = useState<string[]>([]);

  useEffect(() => {
    loadAdSchedule(vmapUrl)
      .then(setSchedule)
      .catch((e: Error) => setError(`Could not load VMAP/VAST: ${e.message}`));
  }, [vmapUrl]);

  const startAd = useCallback((b: ScheduledBreak) => {
    const content = contentRef.current!;
    inAdRef.current = true;
    content.pause();
    content.currentTime = b.timeSec; // resume exactly at the cut point
    setActiveAd(b);
  }, []);

  // Frame-accurate break detection while the episode plays.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const content = contentRef.current;
      if (content && !inAdRef.current) {
        const t = content.currentTime;
        const prev = lastTimeRef.current;
        lastTimeRef.current = t;
        setTime(t);
        if (!content.paused && t > prev && t - prev < MAX_PLAYBACK_STEP_SEC) {
          const due = schedule.find((b) => !playedRef.current.has(b.breakId) && prev < b.timeSec && b.timeSec <= t);
          if (due) startAd(due);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [schedule, startAd]);

  // Play the ad once its element mounts.
  useEffect(() => {
    if (activeAd) adRef.current?.play().catch(() => {});
  }, [activeAd]);

  const endAd = () => {
    if (!activeAd) return;
    playedRef.current.add(activeAd.breakId);
    setPlayed([...playedRef.current]);
    const content = contentRef.current!;
    content.currentTime = activeAd.timeSec;
    lastTimeRef.current = activeAd.timeSec;
    inAdRef.current = false;
    setActiveAd(null);
    content.play().catch(() => {});
  };

  const seek = (t: number) => {
    const content = contentRef.current;
    if (!content || inAdRef.current) return;
    content.currentTime = Math.max(0, t);
    lastTimeRef.current = content.currentTime;
  };

  const jumpTo = (b: ScheduledBreak) => {
    playedRef.current.delete(b.breakId);
    setPlayed([...playedRef.current]);
    seek(b.timeSec - JUMP_LEAD_SEC);
    contentRef.current?.play().catch(() => {});
  };

  return (
    <div className="space-y-4">
      <div className="relative rounded-xl overflow-hidden bg-black aspect-video">
        <video
          ref={contentRef}
          src={videoUrl}
          controls={!activeAd}
          className="w-full h-full"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onSeeked={(e) => (lastTimeRef.current = e.currentTarget.currentTime)}
        />
        {activeAd && (
          <div className="absolute inset-0 bg-black">
            <video
              ref={adRef}
              src={activeAd.ad.mediaUrl}
              className="w-full h-full"
              onTimeUpdate={(e) => setAdRemaining(Math.max(0, e.currentTarget.duration - e.currentTarget.currentTime))}
              onEnded={endAd}
              onError={endAd}
            />
            <div className="absolute top-3 left-3 rounded bg-black/70 text-white text-xs px-2 py-1">
              Ad · {activeAd.ad.title} · {Math.ceil(adRemaining || activeAd.ad.durationSec)}s
            </div>
            <div className="absolute top-3 right-3 rounded bg-black/70 text-white text-xs px-2 py-1">
              resumes at {fmtTime(activeAd.timeSec)}
            </div>
          </div>
        )}
      </div>

      <Timeline duration={duration} time={time} breaks={schedule} played={played} onSeek={seek} onJump={jumpTo} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2">
        <h2 className="font-semibold text-sm">
          Breaks from VMAP <span className="opacity-60 font-normal">({schedule.length})</span>
        </h2>
        <ul className="flex flex-wrap gap-2">
          {schedule.map((b) => (
            <li key={b.breakId}>
              <button
                onClick={() => jumpTo(b)}
                className="rounded-md border border-black/10 dark:border-white/10 px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
              >
                <span className="font-mono">{fmtTime(b.timeSec)}</span> · {b.ad.title} · {Math.round(b.ad.durationSec)}s
                {played.includes(b.breakId) && <span className="ml-2 text-emerald-600">✓</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="text-xs opacity-60">Jump starts playback {JUMP_LEAD_SEC}s before the break.</p>
      </section>
    </div>
  );
}

function Timeline(props: {
  duration: number;
  time: number;
  breaks: ScheduledBreak[];
  played: string[];
  onSeek: (t: number) => void;
  onJump: (b: ScheduledBreak) => void;
}) {
  const { duration, time, breaks, played, onSeek, onJump } = props;
  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : "0%");
  return (
    <div className="space-y-1">
      <div
        className="relative h-3 rounded bg-black/10 dark:bg-white/10 cursor-pointer"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        <div className="absolute inset-y-0 left-0 rounded bg-black/30 dark:bg-white/30" style={{ width: pct(time) }} />
        {breaks.map((b) => (
          <button
            key={b.breakId}
            title={`${fmtTime(b.timeSec)} · ${b.ad.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onJump(b);
            }}
            className={`absolute -top-1 h-5 w-1.5 -translate-x-1/2 rounded ${played.includes(b.breakId) ? "bg-emerald-500" : "bg-amber-500"}`}
            style={{ left: pct(b.timeSec) }}
          />
        ))}
      </div>
      <div className="flex justify-between text-xs font-mono opacity-60">
        <span>{fmtTime(time)}</span>
        <span>{fmtTime(duration)}</span>
      </div>
    </div>
  );
}
