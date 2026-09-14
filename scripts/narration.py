"""Turn several narration takes into one voice-over aligned to the demo video.

    python scripts/narration.py transcribe take1.wav take2.m4a ...   # word timestamps -> var/demo/narration/<take>.json
    python scripts/narration.py assemble [--prefer take2] [--no-stretch]  # best take per block -> narration.wav + final MP4
    python scripts/narration.py report                                # the choices, per block

How it works. Each take is transcribed with word timestamps (faster-whisper, on the CPU). For every script block (the
rows of docs/DEMO_SCRIPT.md, from var/demo/timeline.json) and every take, the transcript is searched for the span of
words that best matches the block text (a fuzzy alignment on normalised words). Each candidate gets a score: word
accuracy first, then how well its length fits the block's slot, then a small bonus for staying on the same take as
the previous block (one voice, fewer jumps). The winning span is cut from its take, placed at the block's start time
on a silent track, stretched by at most 8 percent when it would run into the next block, loudness-normalised, and
muxed under var/demo/guardian-demo.mp4 as var/demo/guardian-demo-final.mp4.

Every take goes through the same vocal chain before any cut, so takes recorded at different distances or on
different microphones sit at one level: a high-pass at 80 Hz (rumble, desk thumps), spectral noise reduction, a
de-esser, a gentle compressor, and per-take loudness normalisation to -18 LUFS. Each candidate span also gets an
audio score: its level against the take's own median, its signal-to-noise against the take's quiet floor, and a
penalty for clipping. Room tone from the quietest second of the winning take runs under the whole track at a low
level so the gaps between blocks are not digital silence.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import subprocess
import sys
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from deck_content import SLIDES  # noqa: E402

OUT = os.path.join(ROOT, "var", "demo")
NARR = os.path.join(OUT, "narration")
VIDEO = os.path.join(OUT, "guardian-demo.mp4")
FINAL = os.path.join(OUT, "guardian-demo-final.mp4")
MAX_STRETCH = 1.08  # atempo factor limit: a take may be sped up by 8 percent to fit its slot
PAD = 0.12  # seconds kept before the first word and after the last word of a cut


def say(m: str) -> None:
    print(m, flush=True)


def ffmpeg() -> str:
    import imageio_ffmpeg  # type: ignore

    return imageio_ffmpeg.get_ffmpeg_exe()


def norm(w: str) -> str:
    w = w.lower().replace("’", "'")
    w = re.sub(r"[^a-z0-9']+", "", w)
    return NUMBERS.get(w, w)


NUMBERS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten", "12": "twelve", "13": "thirteen", "594": "594", "1200": "1200", "7143": "7143", "235": "235", "41": "41"}


# ------------------------------------------------------------------------------------------------ blocks
def blocks() -> list[dict[str, Any]]:
    tl = json.load(open(os.path.join(OUT, "timeline.json"), encoding="utf-8"))
    by_id = {s["id"]: s for s in SLIDES}
    out: list[dict[str, Any]] = []
    for seg in tl["segments"]:
        if seg["kind"] == "slide":
            s = by_id[seg["id"]]
            out.append({"id": s["id"], "start": seg["start"], "end": seg["end"], "text": s["notes"], "words": [norm(w) for w in s["notes"].split() if norm(w)]})
        else:
            out[-1]["end"] = seg["end"]
    for b in out:
        b["slot"] = b["end"] - b["start"]
    return out


# ------------------------------------------------------------------------------------------------ transcribe
def to_wav(src: str, dst: str) -> None:
    subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst], check=True)


VOCAL_CHAIN = "highpass=f=80,afftdn=nf=-28:nt=w,deesser=i=0.4,acompressor=threshold=-20dB:ratio=2.5:attack=6:release=90:makeup=2,loudnorm=I=-18:TP=-2:LRA=9"


def clean_take(src: str, dst: str) -> None:
    """The vocal chain, once per take, at 48 kHz mono: what the cuts are taken from."""
    subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", src, "-af", VOCAL_CHAIN, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", dst], check=True)


def rms_db(path: str, start: float, end: float) -> float:
    """Mean volume (dBFS) of a slice, from ffmpeg's volumedetect."""
    if end - start < 0.05:
        return -90.0
    out = subprocess.run([ffmpeg(), "-loglevel", "info", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", path, "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
    for line in out.splitlines():
        if "mean_volume" in line:
            try:
                return float(line.split("mean_volume:")[1].split("dB")[0])
            except ValueError:
                pass
    return -90.0


def peak_db(path: str, start: float, end: float) -> float:
    out = subprocess.run([ffmpeg(), "-loglevel", "info", "-ss", f"{start:.3f}", "-t", f"{max(0.05, end - start):.3f}", "-i", path, "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
    for line in out.splitlines():
        if "max_volume" in line:
            try:
                return float(line.split("max_volume:")[1].split("dB")[0])
            except ValueError:
                pass
    return -90.0


def transcribe(paths: list[str], model_size: str = "small") -> None:
    from faster_whisper import WhisperModel  # type: ignore

    os.makedirs(NARR, exist_ok=True)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    prompt = " ".join(s["notes"] for s in SLIDES)[:1000]  # vocabulary hint: product names, node ids
    for src in paths:
        name = os.path.splitext(os.path.basename(src))[0]
        wav = os.path.join(NARR, f"{name}.wav")
        to_wav(src, wav)
        clean = os.path.join(NARR, f"{name}.clean.wav")
        clean_take(src, clean)
        segments, info = model.transcribe(wav, language="en", word_timestamps=True, initial_prompt=prompt, vad_filter=True, beam_size=5)
        words: list[dict[str, Any]] = []
        for seg in segments:
            for w in seg.words or []:
                words.append({"w": w.word.strip(), "n": norm(w.word), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)})
        # The take's own reference levels: speech (median over the word spans) and the floor (the quietest gap).
        spans = [(w["s"], w["e"]) for w in words if w["e"] - w["s"] > 0.15][:400]
        levels = sorted(rms_db(clean, a, b) for a, b in spans[:: max(1, len(spans) // 40)])
        speech = levels[len(levels) // 2] if levels else -20.0
        gaps = [(words[i]["e"], words[i + 1]["s"]) for i in range(len(words) - 1) if words[i + 1]["s"] - words[i]["e"] > 0.6]
        floor_candidates = sorted((rms_db(clean, a + 0.1, b - 0.1), a + 0.1, b - 0.1) for a, b in gaps[:30]) if gaps else []
        floor = floor_candidates[0] if floor_candidates else (-60.0, 0.0, 0.0)
        json.dump({"take": name, "source": os.path.abspath(src), "wav": wav, "clean": clean, "duration": info.duration, "speech_db": speech, "floor_db": floor[0], "floor_span": [floor[1], floor[2]], "words": words}, open(os.path.join(NARR, f"{name}.json"), "w", encoding="utf-8"), indent=1)
        say(f"transcribed {name}: {len(words)} words, {info.duration:.0f} s, speech {speech:.0f} dB, floor {floor[0]:.0f} dB")


# ------------------------------------------------------------------------------------------------ align
def best_span(block_words: list[str], take_words: list[dict[str, Any]], search_from: int) -> dict[str, Any] | None:
    """The span of transcript words that best matches the block: slide a window of the block's length (±30 %) over the
    transcript, score with difflib, keep the best. Returns indices, accuracy and times."""
    tw = [w["n"] for w in take_words]
    n = len(block_words)
    if not n or not tw:
        return None
    best: dict[str, Any] | None = None
    lo, hi = max(1, int(n * 0.7)), int(n * 1.3) + 2
    for start in range(max(0, search_from - 5), len(tw)):
        if best and best["ratio"] > 0.97 and start > best["i0"] + n * 2:
            break
        for length in (n, int(n * 0.85), int(n * 1.15), lo, hi):
            j = min(len(tw), start + max(1, length))
            window = tw[start:j]
            if len(window) < max(1, n // 3):
                continue
            ratio = difflib.SequenceMatcher(None, block_words, window, autojunk=False).ratio()
            if not best or ratio > best["ratio"]:
                best = {"i0": start, "i1": j, "ratio": ratio}
    if not best:
        return None
    # trim the window to the matched words at both ends
    sm = difflib.SequenceMatcher(None, block_words, tw[best["i0"] : best["i1"]], autojunk=False)
    m = [mb for mb in sm.get_matching_blocks() if mb.size]
    if m:
        first = best["i0"] + m[0].b
        last = best["i0"] + m[-1].b + m[-1].size - 1
    else:
        first, last = best["i0"], best["i1"] - 1
    words = take_words[first : last + 1]
    matched = sum(mb.size for mb in m)
    return {"i0": first, "i1": last + 1, "ratio": round(best["ratio"], 3), "accuracy": round(matched / n, 3), "start": words[0]["s"], "end": words[-1]["e"], "spoken": " ".join(w["w"] for w in words)}


def score(cand: dict[str, Any], slot: float, same_take: bool) -> float:
    length = cand["end"] - cand["start"] + 2 * PAD
    fit = 1.0 if length <= slot else max(0.0, 1.0 - (length / slot - 1.0) / 0.25)  # over the slot by 25 % scores 0
    level = max(0.0, 1.0 - abs(cand.get("level_delta_db", 0.0)) / 9.0)  # a span 9 dB off the take's own speech level scores 0
    snr = min(1.0, max(0.0, (cand.get("snr_db", 30.0) - 10.0) / 25.0))  # 10 dB -> 0, 35 dB -> 1
    clip = 0.0 if cand.get("peak_db", -6.0) < -0.3 else 0.15
    return cand["accuracy"] * 0.6 + fit * 0.2 + level * 0.08 + snr * 0.07 + (0.05 if same_take else 0.0) - clip


def choose(prefer: str | None = None) -> list[dict[str, Any]]:
    takes = [json.load(open(os.path.join(NARR, f), encoding="utf-8")) for f in sorted(os.listdir(NARR)) if f.endswith(".json") and f != "choices.json"]
    if not takes:
        raise SystemExit("no transcripts in var/demo/narration; run `transcribe` first")
    bl = blocks()
    choices: list[dict[str, Any]] = []
    cursor = {t["take"]: 0 for t in takes}
    prev_take: str | None = None
    for b in bl:
        cands = []
        for t in takes:
            span = best_span(b["words"], t["words"], cursor[t["take"]])
            if not span:
                continue
            same = t["take"] == (prev_take or prefer)
            clean = t.get("clean") or t["wav"]
            lvl = rms_db(clean, span["start"], span["end"])
            span["level_db"] = round(lvl, 1)
            span["level_delta_db"] = round(lvl - t.get("speech_db", lvl), 1)
            span["snr_db"] = round(lvl - t.get("floor_db", -60.0), 1)
            span["peak_db"] = round(peak_db(clean, span["start"], span["end"]), 1)
            cands.append({**span, "take": t["take"], "wav": clean, "floor_span": t.get("floor_span"), "score": round(score(span, b["slot"], same), 3)})
        if not cands:
            raise SystemExit(f"block {b['id']}: no take matched")
        cands.sort(key=lambda c: -c["score"])
        win = cands[0]
        cursor[win["take"]] = win["i1"]
        prev_take = win["take"]
        choices.append({"block": b["id"], "slot_start": b["start"], "slot": round(b["slot"], 2), "take": win["take"], "wav": win["wav"], "start": win["start"], "end": win["end"], "accuracy": win["accuracy"], "score": win["score"], "level_db": win["level_db"], "snr_db": win["snr_db"], "peak_db": win["peak_db"], "floor_span": win.get("floor_span"), "spoken": win["spoken"], "alternatives": [{k: c[k] for k in ("take", "accuracy", "score", "snr_db")} for c in cands[1:]]})
    json.dump(choices, open(os.path.join(NARR, "choices.json"), "w", encoding="utf-8"), indent=1)
    return choices


# ------------------------------------------------------------------------------------------------ assemble
def assemble(prefer: str | None = None, stretch: bool = True) -> None:
    ch = choose(prefer)
    ff = ffmpeg()
    parts_dir = os.path.join(NARR, "parts")
    os.makedirs(parts_dir, exist_ok=True)
    total = json.load(open(os.path.join(OUT, "timeline.json"), encoding="utf-8"))["total_seconds"]
    inputs: list[str] = []
    filters: list[str] = []
    mixes: list[str] = []
    for i, c in enumerate(ch):
        nxt = ch[i + 1]["slot_start"] if i + 1 < len(ch) else total
        room = nxt - c["slot_start"] - 0.15
        s0 = max(0.0, c["start"] - PAD)
        e0 = c["end"] + PAD
        length = e0 - s0
        tempo = 1.0
        if length > room and stretch:
            tempo = min(MAX_STRETCH, length / room)
        part = os.path.join(parts_dir, f"{i:02d}-{c['block']}.wav")
        af = f"afade=t=in:d=0.04,afade=t=out:st={max(0, length - 0.06):.3f}:d=0.06"
        if tempo > 1.001:
            af = f"atempo={tempo:.4f}," + af
        subprocess.run([ff, "-y", "-loglevel", "error", "-ss", f"{s0:.3f}", "-t", f"{length:.3f}", "-i", c["wav"], "-af", af, "-ac", "1", "-ar", "48000", part], check=True)
        c["tempo"] = round(tempo, 3)
        c["placed_at"] = round(c["slot_start"], 2)
        c["overrun"] = round(max(0.0, length / tempo - room), 2)
        inputs += ["-i", part]
        filters.append(f"[{i}:a]adelay={int(c['slot_start'] * 1000)}|{int(c['slot_start'] * 1000)}[a{i}]")
        mixes.append(f"[a{i}]")
    # Room tone: the quietest second of the take that carries most blocks, looped under everything at -34 dB, so the
    # gaps between blocks match the recording's own air instead of digital silence.
    from collections import Counter

    main_take = Counter(c["take"] for c in ch).most_common(1)[0][0]
    main = next(c for c in ch if c["take"] == main_take)
    tone = os.path.join(parts_dir, "roomtone.wav")
    fs = main.get("floor_span") or [0.0, 0.0]
    if fs and fs[1] - fs[0] >= 0.4:
        subprocess.run([ff, "-y", "-loglevel", "error", "-ss", f"{fs[0]:.3f}", "-t", f"{min(1.0, fs[1] - fs[0]):.3f}", "-i", main["wav"], "-af", "afade=t=in:d=0.05,afade=t=out:st=0.9:d=0.1", "-ac", "1", "-ar", "48000", tone], check=True)
        inputs += ["-stream_loop", "-1", "-i", tone]
        filters.append(f"[{len(ch)}:a]atrim=0:{total:.2f},volume=-34dB[tone]")
        mixes.append("[tone]")
    n_in = len(mixes)
    graph = ";".join(filters) + ";" + "".join(mixes) + f"amix=inputs={n_in}:normalize=0:dropout_transition=0,apad=whole_dur={total:.2f},atrim=0:{total:.2f},loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    narration = os.path.join(OUT, "narration.wav")
    subprocess.run([ff, "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-map", "[out]", "-ac", "2", "-ar", "48000", narration], check=True)
    json.dump(ch, open(os.path.join(NARR, "choices.json"), "w", encoding="utf-8"), indent=1)
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", VIDEO, "-i", narration, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", FINAL], check=True)
    report(ch)
    say(f"narration: {narration}\nfinal: {FINAL}")


def report(ch: list[dict[str, Any]] | None = None) -> None:
    ch = ch or json.load(open(os.path.join(NARR, "choices.json"), encoding="utf-8"))
    say(f"{'block':15s} {'take':12s} {'acc':>5s} {'len':>6s} {'slot':>6s} {'tempo':>5s} {'over':>5s} {'level':>6s} {'snr':>5s}")
    for c in ch:
        length = c["end"] - c["start"] + 2 * PAD
        say(f"{c['block']:15s} {c['take']:12s} {c['accuracy']:5.2f} {length:6.1f} {c['slot']:6.1f} {c.get('tempo', 1.0):5.2f} {c.get('overrun', 0.0):5.1f} {c.get('level_db', 0.0):6.1f} {c.get('snr_db', 0.0):5.0f}")
    from collections import Counter

    say("takes used: " + ", ".join(f"{t} x{n}" for t, n in Counter(c["take"] for c in ch).most_common()))
    low = [c for c in ch if c["accuracy"] < 0.8]
    if low:
        say("low accuracy (check the spoken text in var/demo/narration/choices.json): " + ", ".join(c["block"] for c in low))


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        say(__doc__)
        return 0
    cmd, opts = argv[0], argv[1:]
    if cmd == "transcribe":
        files = [o for o in opts if not o.startswith("--")]
        model = opts[opts.index("--model") + 1] if "--model" in opts else "small"
        transcribe(files, model)
    elif cmd == "assemble":
        prefer = opts[opts.index("--prefer") + 1] if "--prefer" in opts else None
        assemble(prefer, stretch="--no-stretch" not in opts)
    elif cmd == "report":
        report()
    else:
        raise SystemExit(f"unknown command {cmd}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
