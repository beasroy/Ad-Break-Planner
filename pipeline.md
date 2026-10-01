%% Ad Break Planner: what happens after a video is uploaded.
%% Blue = code/ffmpeg only, green = ElevenLabs Scribe v2,
%% purple = GPT-5.6 Luna (text only), red = hard safety gate, grey = files out.
flowchart TD
    UP["Upload<br/>POST /api/jobs (video file)<br/>SHA-256 hash → data/{hash}/source.mp4<br/>job id = first 16 chars of hash<br/>cached stages reused on re-upload"]

    ING["1 · Ingest (ffmpeg)<br/>duration, resolution<br/>full.wav 16 kHz mono<br/>2-min mp3 chunks, 32 kbps"]

    subgraph T["2 · Transcribe: both models on every chunk, in parallel"]
        DG["ElevenLabs Scribe v2<br/>SENT: chunk mp3 only<br/>language=ben, word timestamps,<br/>tag_audio_events, diarize<br/>RETURNS: Bengali words with exact<br/>start/end, plus [music]/[crying] tags"]
    end

    SIG["3 · Signals (ffmpeg, parallel with 2)<br/>silencedetect: -35 dB, ≥ 0.3s<br/>scene detect: threshold 0.3 → shot cuts"]

    MERGE["Merge transcript (code)<br/>text: Scribe words grouped into utterances on a 0.5s pause<br/>speech walls: every word capped at 2s, plus audio-event spans<br/>drop lines &gt; 60% inside silence<br/>record chunk seams + coverage"]

    SC["4 · Scenes: GPT-5.6 Luna<br/>SENT: transcript in 6-min windows, 1-min overlap,<br/>lines as '[segment_id] start–end text'<br/>+ negative-context list from catalogue<br/>RETURNS JSON per scene: first/last segment id,<br/>summary, activity, mood, closure, tension,<br/>confidence, negative_contexts[context, confidence]<br/>code derives all timestamps from segment ids"]

    CAND["5 · Candidates (code)<br/>each scene boundary, search ±3s for a safe cut:<br/>A · silence ≥ 700ms, 150ms pad, no transcribed word<br/>B · speech-free ≥ 1.5s: nothing transcribed and no audio event,<br/>inside coverage, away from seams (score ×0.7)<br/>cut on a shot cut if possible, else midpoint<br/>score: gap .3, shot cut .2, closure .3, calm .2"]

    RL["Re-listen: ElevenLabs Scribe v2<br/>SENT: clip of just the cut window ±0.5s<br/>RETURNS: any words or sounds heard<br/>move cut away from them, or drop candidate"]

    subgraph M["6 · Match"]
        PR["Programme context: GPT-5.6 Luna, 1 call<br/>SENT: every scene as '[mm:ss] activity — summary'<br/>RETURNS JSON: summary, genre,<br/>up to 8 recurring_contexts"]
        EL["Eligibility (code)<br/>scene confidence &lt; 0.6 → no brand<br/>negative tag ≥ 0.3 in brand's own list → blocked<br/>context listed by &gt; 50% of brands → blocks all"]
        RK["Rank: GPT-5.6 Luna, 1 call per candidate<br/>SENT JSON: programme context,<br/>scene before + after (summary, activity, mood),<br/>eligible brands (id, category, target contexts)<br/>RETURNS JSON: rankings[brand_id, fit 0–1, reason]<br/>fit &lt; 0.3 → dropped"]
        LC["Listening check: audio LLM (MODEL_LISTEN), 1 call per matched cut<br/>SENT: 6s mp3, cut at 3.0s + question<br/>'anyone speaking within 1s of the mark?'<br/>RETURNS JSON: speech_near_mark, heard_at_mark,<br/>transcript<br/>speech or failed call → no ad"]
    end

    SEL["7 · Select (code)<br/>no break in first 180s / last 120s<br/>≤ 4 breaks/hour (rounded), ≥ 480s apart, ad load ≤ 15%<br/>exhaustive search: most breaks, then best score<br/>(60% placement, 40% brand fit)<br/>longest creative that fits, Bengali preferred"]

    OUT["8 · Outputs<br/>vmap.xml → one break per cut → VAST URL<br/>VAST per break → creative media URL<br/>debug.json: every candidate, reason, score,<br/>model answer (API keys stripped)"]

    PLAY["Web player<br/>reads VMAP, pauses at each cut,<br/>plays the ad, resumes exactly at the cut"]

    DROP(["No break at this boundary"])

    UP --> ING
    ING --> DG
    ING --> SIG
    DG --> MERGE
    SIG --> MERGE
    MERGE --> SC
    SC --> CAND
    SIG -. silences + shot cuts .-> CAND
    CAND -->|safe cut found| RL
    CAND -->|no safe cut| DROP
    RL -->|still safe| EL
    RL -->|speech in window| DROP
    SC --> PR
    PR --> RK
    EL -->|at least one brand eligible| RK
    EL -->|all blocked / unsure scene| DROP
    RK -->|a brand with fit ≥ 0.3| LC
    RK -->|no brand fits| DROP
    LC -->|no speech| SEL
    LC -->|speech or no answer| DROP
    SEL --> OUT
    OUT --> PLAY

    classDef code fill:#e8f0fe,stroke:#4a6fa5,color:#111
    classDef scribe fill:#e3f6e8,stroke:#2e8b57,color:#111
    classDef luna fill:#f1e8fb,stroke:#7b4bb7,color:#111
    classDef gate fill:#fde8e8,stroke:#c0392b,color:#111
    classDef out fill:#eeeeee,stroke:#666,color:#111

    class UP,ING,SIG,MERGE,CAND,EL,SEL code
    class DG,RL scribe
    class LC gate
    class SC,PR,RK luna
    class OUT,PLAY,DROP out
