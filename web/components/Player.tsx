"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "@/lib/api";
import { loadAdSchedule, type VastAd, type VmapBreak } from "@/lib/vmap";

type ScheduledBreak = VmapBreak & { ad: VastAd };

/** Seconds of playback before a break that "Jump" lands on. */
const JUMP_LEAD_SEC = 5;
const EMPTY_VTT = "data:text/vtt;charset=utf-8,WEBVTT";

export function Player({ videoUrl, vmapUrl }: Readonly<{ videoUrl: string; vmapUrl: string }>) {
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

  // Fires a break when playback crosses its cut. Seeks never count: `seeking` moves lastTimeRef
  // to the new position first, so a jump over a break skips it (as in any ad-enabled player).
  const checkBreak = useCallback(() => {
    const content = contentRef.current;
    if (!content || inAdRef.current || content.seeking) return;
    const t = content.currentTime;
    const prev = lastTimeRef.current;
    lastTimeRef.current = t;
    setTime(t);
    if (!content.paused && t > prev) {
      const due = schedule.find((b) => !playedRef.current.has(b.breakId) && prev < b.timeSec && b.timeSec <= t);
      if (due) startAd(due); // rewinds to the exact cut if detection ran a little late
    }
  }, [schedule, startAd]);

  // Frame-accurate while the tab is visible. Browsers stop animation frames in background tabs,
  // so the video's own timeupdate events (below) keep breaks firing there too.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      checkBreak();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [checkBreak]);

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
      <div className="relative aspect-video overflow-hidden rounded-3xl border border-border bg-black shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
        <video
          ref={contentRef}
          src={videoUrl}
          controls={!activeAd}
          className="w-full h-full"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={checkBreak}
          onSeeking={(e) => (lastTimeRef.current = e.currentTarget.currentTime)}
          onSeeked={(e) => (lastTimeRef.current = e.currentTarget.currentTime)}
          onPlay={(e) => {
            // The episode stays held at the cut while an ad runs (media keys, browser media controls).
            if (inAdRef.current) e.currentTarget.pause();
          }}
        >
          <track kind="captions" src={EMPTY_VTT} label="Captions" />
        </video>
        {activeAd && (
          <div className="absolute inset-0 bg-black">
            <video
              ref={adRef}
              src={activeAd.ad.mediaUrl}
              className="w-full h-full"
              onTimeUpdate={(e) => setAdRemaining(Math.max(0, e.currentTarget.duration - e.currentTarget.currentTime))}
              onEnded={endAd}
              onError={endAd}
            >
              <track kind="captions" src={EMPTY_VTT} label="Captions" />
            </video>
            <div className="absolute top-3 left-3 rounded-full border border-accent/30 bg-accent/85 px-3 py-1 text-xs text-white">
              Ad · {activeAd.ad.title} · {Math.ceil(adRemaining || activeAd.ad.durationSec)}s
            </div>
            <div className="absolute top-3 right-3 rounded-full border border-white/10 bg-black/70 px-3 py-1 text-xs text-white">
              resumes at {fmtTime(activeAd.timeSec)}
            </div>
            {(activeAd.ad.headline || activeAd.ad.tagline) && (
              <div className="pointer-events-none absolute inset-y-0 left-0 flex w-1/2 flex-col justify-end bg-linear-to-r from-black/75 via-black/40 to-transparent p-6 sm:p-10">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-strong">{activeAd.ad.title}</p>
                {activeAd.ad.headline && (
                  <p className="mt-2 text-2xl font-semibold leading-tight text-white sm:text-4xl">{activeAd.ad.headline}</p>
                )}
                {activeAd.ad.tagline && <p className="mt-2 text-sm text-white/80 sm:text-base">{activeAd.ad.tagline}</p>}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-surface/90 p-4">
        <Timeline duration={duration} time={time} breaks={schedule} played={played} onSeek={seek} onJump={jumpTo} />
      </div>

      {error && <p className="text-sm text-accent-strong">{error}</p>}

      <section className="space-y-3 rounded-2xl border border-border bg-surface/90 p-4">
        <h2 className="font-semibold text-sm">
          Breaks from VMAP <span className="font-normal text-muted">({schedule.length})</span>
        </h2>
        <ul className="flex flex-wrap gap-2">
          {schedule.map((b) => (
            <li key={b.breakId}>
              <button
                onClick={() => jumpTo(b)}
                className="rounded-xl border border-border bg-surface-elevated px-3 py-2 text-sm transition hover:border-accent/40 hover:bg-accent/10"
              >
                <span className="font-mono">{fmtTime(b.timeSec)}</span> · {b.ad.title} · {Math.round(b.ad.durationSec)}s
                {played.includes(b.breakId) && <span className="ml-2 text-emerald-400">✓</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">Jump starts playback {JUMP_LEAD_SEC}s before the break.</p>
      </section>
    </div>
  );
}

function Timeline(props: Readonly<{
  duration: number;
  time: number;
  breaks: ScheduledBreak[];
  played: string[];
  onSeek: (t: number) => void;
  onJump: (b: ScheduledBreak) => void;
}>) {
  const { duration, time, breaks, played, onSeek, onJump } = props;
  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : "0%");
  const seekFromClientX = (clientX: number, element: HTMLElement) => {
    const r = element.getBoundingClientRect();
    onSeek(((clientX - r.left) / r.width) * duration);
  };
  const currentPct = pct(time);

  return (
    <div className="space-y-2">
      <div className="relative h-5">
        <button
          type="button"
          aria-label="Seek through video timeline"
          className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 cursor-pointer rounded-full bg-white/10 ring-1 ring-white/8"
          onClick={(e) => seekFromClientX(e.clientX, e.currentTarget)}
        />
        <div
          className="pointer-events-none absolute left-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-linear-to-r from-accent to-accent-strong shadow-[0_0_16px_rgba(215,25,32,0.45)]"
          style={{ width: currentPct }}
        />
        <div
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent-strong shadow-[0_0_20px_rgba(255,51,65,0.55)]"
          style={{ left: currentPct }}
        />
        {breaks.map((b) => (
          <button
            key={b.breakId}
            title={`${fmtTime(b.timeSec)} · ${b.ad.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onJump(b);
            }}
            className={`absolute top-1/2 z-10 h-5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${played.includes(b.breakId) ? "bg-emerald-400" : "bg-amber-300"}`}
            style={{ left: pct(b.timeSec) }}
          />
        ))}
      </div>
      <div className="flex justify-between text-xs font-mono text-white/70">
        <span>{fmtTime(time)}</span>
        <span>{fmtTime(duration)}</span>
      </div>
    </div>
  );
}
