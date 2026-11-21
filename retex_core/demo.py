"""Self-contained royalty-free synthetic 2-track demo pack for Re-Tex Core.

Generates two genuinely musical 4-stem electronic/synthwave tracks + a starter mashup project
in ~2 seconds with ZERO downloads or copyrighted audio:
  1. Midnight Drift (Demo) — 124 BPM, A minor (8A), with an intentional +2.8% live tempo drift
     and a deliberately off-beat (+95 ms) initial grid so you can watch Re-Tex Core's Viterbi
     mistake catcher detect & fix the offset, then quantize it cleanly to 0.0 ms!
  2. Neon Pulse (Demo)     — 128 BPM, C major (8B, Camelot-compatible with 8A!), dead-steady.

Run via:  python -m retex_core --demo
"""
import json
import time
from pathlib import Path

import numpy as np
from scipy.signal import butter, filtfilt

from . import audio_io, grid as G, library, project as P, quantize as Q
from .config import SHARED_SONGS, SR, STEMS


def _synth_kick(n_s, sr=SR):
    t = np.arange(n_s, dtype=np.float32) / sr
    # Pitch-dropping punchy 808/house kick (145 Hz -> 46 Hz)
    f = 46.0 + 100.0 * np.exp(-t * 38.0)
    ph = 2.0 * np.pi * np.cumsum(f) / sr
    env = np.exp(-t * 9.5) * np.minimum(1.0, t / 0.002)
    click = np.exp(-t * 220.0) * 0.35
    return (np.sin(ph) * env + click).astype(np.float32) * 0.85


def _synth_snare(n_s, sr=SR, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(n_s, dtype=np.float32) / sr
    noise = rng.standard_normal(n_s).astype(np.float32)
    b, a = butter(2, [900.0 / (sr * 0.5), 7500.0 / (sr * 0.5)], btype="band")
    hp_noise = filtfilt(b, a, noise).astype(np.float32)
    body = np.sin(2.0 * np.pi * (185.0 + 40.0 * np.exp(-t * 45.0)) * t) * np.exp(-t * 22.0)
    return (hp_noise * np.exp(-t * 16.0) * 0.55 + body * 0.45).astype(np.float32) * 0.78


def _synth_hat(n_s, sr=SR, seed=2, open_hat=False):
    rng = np.random.default_rng(seed)
    t = np.arange(n_s, dtype=np.float32) / sr
    noise = rng.standard_normal(n_s).astype(np.float32)
    b, a = butter(2, 6500.0 / (sr * 0.5), btype="high")
    hi = filtfilt(b, a, noise).astype(np.float32)
    decay = 14.0 if open_hat else 65.0
    return (hi * np.exp(-t * decay) * (0.28 if open_hat else 0.18)).astype(np.float32)


def _midi_hz(m):
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))


def _place(buf, sig, pos):
    if pos < 0 or pos >= buf.shape[1]:
        return
    m = min(len(sig), buf.shape[1] - pos)
    buf[0, pos:pos + m] += sig[:m]
    buf[1, pos:pos + m] += sig[:m]


def _make_track(sid, title, bpm_start, bpm_end, n_bars, key_info, chord_prog, bass_notes, lead_notes,
                bad_offset_ms=0.0, seed=10):
    """Synthesize a clean stereo 4-stem electronic track with exact beat timestamps (supporting tempo drift)."""
    bpb = 4
    n_beats = n_bars * bpb
    # Build beat times (linear BPM ramp from bpm_start -> bpm_end for realistic drift testing!)
    bpms = np.linspace(bpm_start, bpm_end, n_beats)
    periods = 60.0 / bpms
    true_beats = np.concatenate([[0.25], 0.25 + np.cumsum(periods)])[:n_beats]
    dur = float(true_beats[-1] + periods[-1] * 2.0)
    n_samp = int(round(dur * SR))

    drums = np.zeros((2, n_samp), np.float32)
    bass = np.zeros((2, n_samp), np.float32)
    other = np.zeros((2, n_samp), np.float32)
    vocals = np.zeros((2, n_samp), np.float32)

    kick = _synth_kick(int(0.32 * SR))
    snare = _synth_snare(int(0.24 * SR), seed=seed)
    hat_c = _synth_hat(int(0.08 * SR), seed=seed + 1, open_hat=False)
    hat_o = _synth_hat(int(0.22 * SR), seed=seed + 2, open_hat=True)

    for j in range(n_beats):
        t_b = true_beats[j]
        per = periods[j]
        s0 = int(round(t_b * SR))
        step_in_bar = j % 4
        bar = j // 4

        # 1) Drums (punchy 4-on-floor / breakbeat groove with crisp transients)
        if step_in_bar in (0, 2):
            _place(drums, kick, s0)
        if step_in_bar in (1, 3):
            _place(drums, snare, s0)
            if bpm_start >= 126:
                _place(drums, kick * 0.72, s0)
        _place(drums, hat_c, s0)
        _place(drums, hat_o if step_in_bar == 3 else hat_c, int(round((t_b + 0.5 * per) * SR)))

        # 2) Sub-808 Bassline
        bn = bass_notes[bar % len(bass_notes)]
        if step_in_bar in (0, 2) or (step_in_bar == 3 and bar % 2 == 1):
            ln = int(round(per * 0.92 * SR))
            tt = np.arange(ln, dtype=np.float32) / SR
            hz = _midi_hz(bn)
            env = np.minimum(1.0, tt / 0.008) * np.exp(-tt * 2.6)
            sub = (np.sin(2 * np.pi * hz * tt) * 0.75 + np.sin(4 * np.pi * hz * tt) * 0.22) * env * 0.52
            _place(bass, sub.astype(np.float32), s0)

        # 3) Lush stereo synth pad/chords ('other')
        if step_in_bar == 0:
            chord = chord_prog[bar % len(chord_prog)]
            bar_dur = float((true_beats[min(n_beats - 1, j + 4)] - t_b) if j + 4 < n_beats else per * 4)
            ln = max(1, int(round(bar_dur * SR)))
            tt = np.arange(ln, dtype=np.float32) / SR
            env = np.minimum(1.0, tt / 0.06) * np.minimum(1.0, (bar_dur - tt) / 0.08)
            pad_l = np.zeros(ln, np.float32)
            pad_r = np.zeros(ln, np.float32)
            for idx_n, mn in enumerate(chord):
                hz = _midi_hz(mn)
                # Slightly detuned stereo saw-ish warmth (sum of 3 harmonics)
                w_l = np.sin(2 * np.pi * (hz * 0.998) * tt) + 0.35 * np.sin(4 * np.pi * (hz * 0.998) * tt)
                w_r = np.sin(2 * np.pi * (hz * 1.002) * tt) + 0.35 * np.sin(4 * np.pi * (hz * 1.002) * tt)
                pad_l += w_l * 0.12
                pad_r += w_r * 0.12
            if s0 + ln <= n_samp:
                other[0, s0:s0 + ln] += pad_l * env
                other[1, s0:s0 + ln] += pad_r * env

        # 4) Rhythmic formant vocal-chop synth melody ('vocals')
        ln_note = lead_notes[j % len(lead_notes)]
        if ln_note is not None and bar >= 2:
            ln = int(round(per * 0.78 * SR))
            tt = np.arange(ln, dtype=np.float32) / SR
            hz = _midi_hz(ln_note)
            vib = 1.0 + 0.004 * np.sin(2 * np.pi * 5.2 * tt)
            ph = 2.0 * np.pi * np.cumsum(hz * vib) / SR
            # Vocal-like formant harmonic stack (fundamental + 2nd + 3rd + airy breath)
            raw_v = (0.55 * np.sin(ph) + 0.30 * np.sin(2 * ph) + 0.15 * np.sin(3 * ph))
            env = np.minimum(1.0, tt / 0.015) * np.exp(-tt * 3.2) * np.minimum(1.0, (ln / SR - tt) / 0.025)
            v_sig = (raw_v * env * 0.36).astype(np.float32)
            pan_l = 0.85 if (j % 2 == 0) else 0.65
            pan_r = 0.65 if (j % 2 == 0) else 0.85
            m = min(len(v_sig), n_samp - s0)
            if m > 0:
                vocals[0, s0:s0 + m] += v_sig[:m] * pan_l
                vocals[1, s0:s0 + m] += v_sig[:m] * pan_r

    stems = {"drums": drums, "bass": bass, "other": other, "vocals": vocals}
    sdir = SHARED_SONGS / sid
    (sdir / "stems").mkdir(parents=True, exist_ok=True)
    (sdir / "peaks").mkdir(parents=True, exist_ok=True)

    peak = max(float(np.abs(v).max()) for v in stems.values()) or 1.0
    scale = round(min(1.0, 0.94 / peak), 6) if peak > 0.96 else 1.0
    for name in STEMS:
        audio_io.save_wav(sdir / "stems" / f"{name}.flac", stems[name] * scale, SR, subtype="PCM_24")
        pk = audio_io.peaks_i8(stems[name], SR, 100)
        (sdir / "peaks" / f"{name}.i8").write_bytes(pk.tobytes())

    # Optionally simulate an off-beat initial beat map so the user can watch Core's mistake catcher fix it!
    reported_beats = (true_beats + bad_offset_ms / 1000.0).clip(0.0)
    info = {
        "id": sid,
        "title": title,
        "status": "ready",
        "duration": round(dur, 4),
        "bpm": round(float(60.0 / np.median(np.diff(reported_beats))), 3),
        "bpb": 4,
        "beats": [round(float(x), 5) for x in reported_beats],
        "bars": list(range(0, len(reported_beats), 4)),
        "key": key_info,
        "separation": "demo_synth",
        "stem_scale": scale,
        "has_vocals": True,
        "loudness": {"integrated": -12.0},
        "created": time.time(),
    }
    (sdir / "song.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
    return sid


def seed_demo():
    """Create the 2 royalty-free demo songs, run Core Viterbi audit + quantize on the drifting track,
    and seed a ready-to-play Demo Mashup project + Demo folder."""
    sid_a = "Midnight_Drift_Demo_124bpm"
    sid_b = "Neon_Pulse_Demo_128bpm"

    if not (SHARED_SONGS / sid_a / "song.json").exists():
        print("Synthesizing Demo Track 1: Midnight Drift (124->127.5 BPM drift, A minor 8A)...")
        _make_track(
            sid_a,
            "Midnight Drift (Demo — Drifting 124 BPM)",
            bpm_start=124.0,
            bpm_end=127.5,
            n_bars=16,
            key_info={"name": "A minor", "camelot": "8A", "tonic": 9, "mode": "minor"},
            chord_prog=[[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]],
            bass_notes=[45, 41, 43, 40],
            lead_notes=[69, None, 72, 71, 69, None, 67, 64, 65, None, 69, 67, 64, None, 62, 64],
            bad_offset_ms=95.0,  # deliberately off-beat initial detector map so Core catches & fixes it!
            seed=11,
        )

    if not (SHARED_SONGS / sid_b / "song.json").exists():
        print("Synthesizing Demo Track 2: Neon Pulse (Steady 128 BPM, C major 8B)...")
        _make_track(
            sid_b,
            "Neon Pulse (Demo — Steady 128 BPM)",
            bpm_start=128.0,
            bpm_end=128.0,
            n_bars=16,
            key_info={"name": "C major", "camelot": "8B", "tonic": 0, "mode": "major"},
            chord_prog=[[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]],
            bass_notes=[48, 45, 41, 43],
            lead_notes=[72, 76, None, 74, 72, None, 69, 71, 72, None, 74, 76, 79, None, 76, 74],
            bad_offset_ms=0.0,
            seed=22,
        )

    print("Running Core Viterbi transient audit & quantizing drifting track...")
    ga = G.get_or_build(sid_a, force=True)
    ga = Q.quantize_song(sid_a)
    gb = G.get_or_build(sid_b, force=True)
    print(f"  Midnight Drift: raw_audit={ga['audit']['note']} | quantized={ga['quantized']['audit']['median_offset_ms']}ms")
    print(f"  Neon Pulse    : raw_audit={gb['audit']['note']}")

    # Organize into a neat Demo Pack folder
    folders = library.get_folders()
    if not any(f["id"] == "f_demo_pack" for f in folders["folders"]):
        folders["folders"].insert(0, {"id": "f_demo_pack", "name": "Demo Pack", "collapsed": False})
    folders["assign"][sid_a] = "f_demo_pack"
    folders["assign"][sid_b] = "f_demo_pack"
    library.save_folders(folders)

    # Seed ready-to-play Demo Mashup project
    existing = [p for p in P.list_projects() if p["name"] == "Demo Mashup (Midnight Drift x Neon Pulse)"]
    if not existing:
        proj = P.empty("Demo Mashup (Midnight Drift x Neon Pulse)", bpm=128.0, bpb=4)
        proj["songs"][sid_a] = {"mult": 1.0, "transpose": 0.0, "quantized": True}
        proj["songs"][sid_b] = {"mult": 1.0, "transpose": 0.0, "quantized": False}
        td, tb, to, tv = proj["tracks"]
        da = float(ga["downbeat_offset"])
        db = float(gb["downbeat_offset"])
        proj["clips"].extend([
            P.clip(td["id"], sid_b, "drums", start=0.0, src=db, length=32.0, label="Neon Pulse (128)"),
            P.clip(tb["id"], sid_b, "bass", start=0.0, src=db, length=32.0, label="Neon Pulse (128)"),
            P.clip(to["id"], sid_a, "other", start=0.0, src=da, length=32.0, label="Midnight Drift (Quantized)"),
            P.clip(tv["id"], sid_a, "vocals", start=8.0, src=da + 8.0, length=24.0, label="Midnight Drift (Quantized)"),
            # Swap grooves at bar 9 (beats 32..64)
            P.clip(td["id"], sid_a, "drums", start=32.0, src=da + 32.0, length=32.0, label="Midnight Drift (Quantized)"),
            P.clip(tb["id"], sid_a, "bass", start=32.0, src=da + 32.0, length=32.0, label="Midnight Drift (Quantized)"),
            P.clip(to["id"], sid_b, "other", start=32.0, src=db + 32.0, length=32.0, label="Neon Pulse (128)"),
            P.clip(tv["id"], sid_b, "vocals", start=32.0, src=db + 32.0, length=32.0, label="Neon Pulse (128)"),
        ])
        P.save(proj)
        print(f"Seeded Demo Mashup project: {proj['id']}")


if __name__ == "__main__":
    seed_demo()
