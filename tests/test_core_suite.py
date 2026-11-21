"""End-to-end backend & audio verification suite for Re-Tex Core."""
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from retex_core import audio_io, grid as G, library, mixer, player, project as P, quantize as Q, warp
from retex_core.config import QUANTIZED, SR

REYIN = "Reyin_Not_Myself_Now_Visualizer_fcb5bb"
DARCI = "Darci_Code_Red_Skeler_Vision_Official_978974"
DEVILISH = "Everything_is_Right_ft_Devilish_Trio_7bdaaf"

SCRATCH_DIR = Path(r"C:\Users\he_te\.gemini\antigravity\brain\a1c82f3d-fdf7-4f99-9054-0e3a41f83d62\scratch")


def main():
    print("=== 1. Verify Library Bridge ===")
    songs = library.list_songs()
    print(f"Shared library songs ready: {len(songs)}")
    assert len(songs) > 100, "Expected shared library to expose >100 ready songs"

    print("\n=== 2. Verify Grid & Quantize on Reyin ===")
    g_reyin = G.get_or_build(REYIN, force=False)
    print(f"Reyin raw grid: bpm={g_reyin['bpm']} mode={g_reyin['mode']} downbeat_offset={g_reyin['downbeat_offset']}")
    print(f"Reyin raw audit: {g_reyin['audit']['note']}")
    assert g_reyin["audit"]["retex_user_marks_offset_ms"] is not None
    assert abs(g_reyin["audit"]["retex_user_marks_offset_ms"]) > 80.0, "Should catch Re-Tex user_marks ~106ms error!"
    assert g_reyin["audit"]["needs_quantize"] is True, "Reyin drifts and should flag needs_quantize=True"

    # Clean up any stale pre-fix Q_* dirs for Reyin whose sig doesn't match current grid sig
    q_parent = QUANTIZED / REYIN
    if q_parent.exists():
        for d in q_parent.iterdir():
            if d.is_dir() and g_reyin["sig"] not in d.name:
                print(f"Removing stale pre-fix quantized dir: {d.name}")
                shutil.rmtree(d, ignore_errors=True)

    if not (g_reyin.get("quantized") and g_reyin["quantized"].get("sig") == g_reyin["sig"]):
        g_reyin = Q.quantize_song(REYIN, progress=lambda f, m="": print(f"  [{int(f*100):3d}%] {m}") if m else None)
    else:
        print(f"Reusing verified quantized Reyin: {g_reyin['quantized']['rev']}")
    q = g_reyin["quantized"]
    qa = q["audit"]
    print(f"Reyin QUANTIZED audit: status={qa['status']} med={qa['median_offset_ms']}ms max={qa['max_offset_ms']}ms drift={qa['drift_pct']}% bad={qa['bad_windows']}")
    assert qa["status"] == "ok", f"Expected quantized status=ok, got {qa}"
    assert qa["median_offset_ms"] <= 5.0
    assert qa["max_offset_ms"] <= 16.0
    assert qa["bad_windows"] == 0

    # Create a 16-second ear-verification clip (Reyin quantized drums + steady metronome click, Verse 1 -> Chorus 1)
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    drums_q = Q.load_quantized_stem(REYIN, q["rev"], "drums")
    t0, per, n_b = float(q["t0"]), float(q["period"]), int(q["n_beats"])
    doff = int(g_reyin["downbeat_offset"])
    bpb = int(g_reyin["bpb"])
    # Pick 16s starting around 28s (active Verse/Chorus drums)
    s_a, s_b = int(28 * SR), int(44 * SR)
    seg = drums_q[:, s_a:s_b].copy()
    for j in range(n_b):
        s = int(round((t0 + j * per) * SR)) - s_a
        if 0 <= s < seg.shape[1]:
            is_bar = ((j - doff) % bpb == 0) and (j >= doff)
            ck = player.CLICKS[1] if is_bar else player.CLICKS[0]
            m = min(len(ck), seg.shape[1] - s)
            seg[:, s:s + m] += ck[:m] * 0.42
    peak = float(np.max(np.abs(seg))) or 1.0
    seg = seg * min(1.0, 0.9 / peak)
    wav_ck = SCRATCH_DIR / "reyin_quantized_click_check.wav"
    mp3_ck = SCRATCH_DIR / "reyin_quantized_click_check.mp3"
    audio_io.save_wav(wav_ck, seg)
    audio_io.save_mp3(wav_ck, mp3_ck, bitrate="192k")
    wav_ck.unlink(missing_ok=True)
    print(f"Wrote ear-check click file: {mp3_ck}")

    print("\n=== 3. Verify Darci & Devilish Trio Grids ===")
    g_darci = G.get_or_build(DARCI, force=False)
    g_dev = G.get_or_build(DEVILISH, force=False)
    print(f"Darci: bpm={g_darci['bpm']} status={g_darci['audit']['status']} med={g_darci['audit']['median_offset_ms']}ms")
    print(f"Devilish: bpm={g_dev['bpm']} status={g_dev['audit']['status']} med={g_dev['audit']['median_offset_ms']}ms")
    assert g_darci["audit"]["status"] == "ok"
    assert g_dev["audit"]["status"] == "ok"

    print("\n=== 4. Test Editing Operations (Split, Duplicate After, Per-Stem/Clip Pitch) ===")
    proj = P.empty("Unit Test Mashup", bpm=138.0, bpb=4)
    proj["songs"][REYIN] = {"mult": 1.0, "transpose": 0.0, "quantized": True}
    t_drums, t_bass, t_other, t_voc = proj["tracks"]
    t_bass["pitch"] = -2.0   # Per-stem lane pitch shift!
    t_voc["pitch"] = 1.0     # Per-stem lane pitch shift!

    c1 = P.clip(t_drums["id"], REYIN, "drums", start=0.0, src=float(g_reyin["downbeat_offset"] + 64), length=16.0)
    c2 = P.clip(t_voc["id"], REYIN, "vocals", start=0.0, src=float(g_reyin["downbeat_offset"] + 64), length=16.0, pitch=1.0)
    proj["clips"].extend([c1, c2])

    # Check total pitch calculation
    assert P.clip_semis(proj, c1, t_drums) == 0.0
    assert P.clip_semis(proj, c2, t_voc) == 2.0  # lane +1 + clip +1 = +2 st!

    # Test Split at beat 8.0
    res_split = P.split_clip(proj, c1["id"], 8.0)
    assert res_split is not None
    left, right = res_split
    assert abs(left["len"] - 8.0) < 1e-5
    assert abs(right["start"] - 8.0) < 1e-5
    assert abs(right["len"] - 8.0) < 1e-5
    assert abs(right["src"] - (c1["src"] + 8.0)) < 1e-5
    print(f"Split OK: left(start={left['start']}, len={left['len']}, src={left['src']}) | right(start={right['start']}, len={right['len']}, src={right['src']})")

    # Test Duplicate After on [right, c2] (span 0..16 -> duplicated at +16)
    duped = P.duplicate_after(proj, [right["id"], c2["id"]])
    assert len(duped) == 2
    assert abs(duped[0]["start"] - 24.0) < 1e-5
    assert abs(duped[1]["start"] - 16.0) < 1e-5
    print(f"Duplicate After OK: created {len(duped)} clips at starts {[d['start'] for d in duped]}")

    # Test offline bounce with per-stem pitch + split + duplicate
    out_wav = SCRATCH_DIR / "unit_bounce_test.wav"
    res = mixer.bounce(proj, out_wav, target_lufs=-12.0)
    print(f"Bounce OK: {res}")
    assert out_wav.exists() and res["duration_s"] > 10.0
    assert -14.0 <= res["lufs"] <= -10.0, f"Expected ~-12 LUFS, got {res['lufs']}"
    assert res["peak_db"] <= -0.5, f"Expected brickwall <= -0.5 dBFS, got {res['peak_db']}"
    out_wav.unlink(missing_ok=True)

    print("\n=== 5. Seed Clean Starter Project for User ===")
    existing = [p for p in P.list_projects() if p["name"] == "Reyin x Darci (Core Verified Starter)"]
    if not existing:
        sp = P.empty("Reyin x Darci (Core Verified Starter)", bpm=138.0, bpb=4)
        sp["songs"][REYIN] = {"mult": 1.0, "transpose": 0.0, "quantized": True}
        sp["songs"][DARCI] = {"mult": 2.0, "transpose": 0.0, "quantized": False}
        sp["songs"][DEVILISH] = {"mult": 2.0, "transpose": 0.0, "quantized": False}

        td, tb, to, tv = sp["tracks"]
        td["name"] = "Drums"
        tb["name"] = "Bass"
        to["name"] = "Synths / Other"
        tv["name"] = "Vocals"
        t_v2 = P.track("Rap / Vocals 2", "vocals")
        sp["tracks"].append(t_v2)

        r0 = float(g_reyin["downbeat_offset"])
        d0 = float(g_darci["downbeat_offset"])
        v0 = float(g_dev["downbeat_offset"])

        # Bars 1-9 (beats 0..32): Reyin intro vocals + synths + Darci drums/bass drop-in at Bar 5
        sp["clips"].extend([
            P.clip(to["id"], REYIN, "other", start=0.0, src=r0 + 32.0, length=64.0, label="Reyin - Not Myself Now"),
            P.clip(tv["id"], REYIN, "vocals", start=0.0, src=r0 + 32.0, length=64.0, label="Reyin - Not Myself Now"),
            P.clip(td["id"], REYIN, "drums", start=0.0, src=r0 + 32.0, length=32.0, label="Reyin - Not Myself Now"),
            P.clip(tb["id"], REYIN, "bass", start=0.0, src=r0 + 32.0, length=32.0, label="Reyin - Not Myself Now"),
            # Bars 9-17 (beats 32..64): Swap in Darci Skeler Vision drums & bass (half-time 2x mult = 135->138 BPM)
            P.clip(td["id"], DARCI, "drums", start=32.0, src=d0 + 32.0, length=32.0, label="Darci - Code Red (Skeler)"),
            P.clip(tb["id"], DARCI, "bass", start=32.0, src=d0 + 32.0, length=32.0, label="Darci - Code Red (Skeler)"),
            # Bars 17-25 (beats 64..96): Devilish Trio vocals over Darci instrumental
            P.clip(td["id"], DARCI, "drums", start=64.0, src=d0 + 48.0, length=32.0, label="Darci - Code Red (Skeler)"),
            P.clip(tb["id"], DARCI, "bass", start=64.0, src=d0 + 48.0, length=32.0, label="Darci - Code Red (Skeler)"),
            P.clip(to["id"], DARCI, "other", start=64.0, src=d0 + 48.0, length=32.0, label="Darci - Code Red (Skeler)"),
            P.clip(t_v2["id"], DEVILISH, "vocals", start=64.0, src=v0 + 32.0, length=32.0, label="Devilish Trio - Everything is Right"),
        ])
        P.save(sp)
        print(f"Saved starter project: {sp['id']} ({sp['name']})")
        # Pre-warm its warps so live playback is instantaneous!
        reqs = P.render_requests(sp)
        print(f"Pre-warming {len(reqs)} stem warps for starter project...")
        warp.render_many_blocking(reqs, progress=lambda f, m="": print(f"  [{int(f*100):3d}%] {m}"))
    else:
        print(f"Starter project already exists: {existing[0]['id']}")

    print("\nALL BACKEND & AUDIO TESTS PASSED!")


if __name__ == "__main__":
    main()
