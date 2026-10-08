%% Ad Break Planner: what happens after a video is uploaded.
%% Blue = code/ffmpeg only, green = ElevenLabs Scribe v2,
%% purple = GPT-5.6 Luna (text only), red = hard safety gate, grey = files out.
flowchart TD
    UP["Upload<br/>POST /api/jobs (video file)<br/>SHA-256 hash → data/{hash}/source.mp4<br/>job id = first 16 chars of hash<br/>cached stages reused on re-upload"]

    ING["1 · Ingest (ffmpeg)<br/>duration, resolution<br/>full.wav 16 kHz mono<br/>2-min mp3 chunks, 32 kbps"]

    DG["2 · Transcribe: ElevenLabs Scribe v2, every chunk in parallel<br/>SENT: chunk mp3 only<br/>language=ben, word timestamps,<br/>tag_audio_events, diarize<br/>RETURNS: Bengali words with exact<br/>start/end, plus [music]/[crying] tags"]

    SIG["3 · Signals (ffmpeg, parallel with 2)<br/>silencedetect: -35 dB, ≥ 0.3s<br/>scene detect: threshold 0.3 → shot cuts"]

    MERGE["Merge transcript (code)<br/>text: Scribe words grouped into utterances on a 0.5s pause<br/>speech walls: every word capped at 2s, plus audio-event spans<br/>drop lines &gt; 60% inside silence<br/>record chunk seams + coverage"]

    subgraph P["4 · Placement"]
        ST["Story so far: GPT-5.6 Luna, 1 call, cached<br/>SENT: the whole dialogue as '[mm:ss] text'<br/>RETURNS JSON: summary, genre,<br/>up to 8 recurring_contexts<br/>background only; placement runs without it"]
        ASK["Ask: GPT-5.6 Luna, 1 call per chunk with dialogue,<br/>all in parallel, none told what another decided<br/>SENT: story, every brand (fits_scenes_about /<br/>never_next_to), this chunk's numbered lines plus<br/>90s either side as context, with measured silences<br/>(≥ 0.5s) and shot cuts written in between them<br/>RETURNS JSON: best placement (line_id, brand_id,<br/>fit 0–1, reason) or null, up to 2 alternatives,<br/>contexts_nearby, why_not_others"]
        CUT["Find the cut (code)<br/>in the gap after the chosen line:<br/>A · inside a measured silence, any length,<br/>on a shot cut in it if there is one, else its middle<br/>B · else first stretch with no transcribed word<br/>for ≥ 1.5s (music may play), 150ms pad<br/>C · else the option is rejected"]
        CHK["Content checks (code)<br/>line is one of this chunk's lines<br/>cut not in the last 90s of the episode<br/>no reported context on the brand's never_next_to<br/>none on the &gt; 50%-of-brands 'blocks all' list<br/>fit ≥ 0.7"]
        SCH["Schedule (code)<br/>best total quality across every chunk's options,<br/>≤ 1 per chunk, 60% pause + 40% fit,<br/>−0.15 per earlier use of the same brand<br/>never the same brand on two adjacent ads<br/>≤ 2 airings per brand (3 past ~75 min)<br/>ad load ≤ 15%; no minimum gap, no target count<br/>longest creative that fits, Bengali preferred"]
        LC["Speech check at the cut (hard gate), per scheduled cut<br/>Silero VAD (local, free) on ±1s:<br/>≥ 0.9 = speech → no ad · &lt; 0.1 and nothing<br/>transcribed nearby = quiet → accept<br/>in between: audio LLM (MODEL_LISTEN) ×2 on a 6s mp3,<br/>cut at 3.0s, 'anyone speaking within 1s of the mark?'<br/>speech or failed call → no ad"]
    end

    OUT["5 · Outputs<br/>vmap.xml → one break per cut → VAST URL<br/>VAST per break → creative media URL<br/>debug.json: explanation, settings used, every chunk's<br/>prompt and answer, every option with its outcome<br/>(API keys stripped)"]

    PLAY["Web player<br/>reads VMAP, pauses at each cut,<br/>plays the ad, resumes exactly at the cut"]

    DROP(["No ad from this option"])

    UP --> ING
    ING --> DG
    ING --> SIG
    DG --> MERGE
    SIG --> MERGE
    MERGE --> ST
    MERGE --> ASK
    ST -. background .-> ASK
    SIG -. silences + shot cuts .-> ASK
    ASK -->|a line + brand| CUT
    ASK -->|no ad in this chunk| DROP
    CUT -->|cut found| CHK
    CUT -->|no safe pause| DROP
    CHK -->|passes| SCH
    CHK -->|blocked / fit too low| DROP
    SCH -->|chosen| LC
    SCH -->|lost to a better schedule| DROP
    LC -->|no speech| OUT
    LC -->|speech or no answer| RE["Drop the cut and<br/>reschedule without it<br/>(≤ 20 rounds)"]
    RE --> SCH
    OUT --> PLAY

    classDef code fill:#e8f0fe,stroke:#4a6fa5,color:#111
    classDef scribe fill:#e3f6e8,stroke:#2e8b57,color:#111
    classDef luna fill:#f1e8fb,stroke:#7b4bb7,color:#111
    classDef gate fill:#fde8e8,stroke:#c0392b,color:#111
    classDef out fill:#eeeeee,stroke:#666,color:#111

    class UP,ING,SIG,MERGE,CUT,CHK,SCH,RE code
    class DG scribe
    class LC gate
    class ST,ASK luna
    class OUT,PLAY,DROP out
