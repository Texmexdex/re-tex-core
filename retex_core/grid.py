"""Transient-verified beat grid engine and phase/drift mistake catcher.

Design guarantees (fixing the exact bugs found in Re-Tex):
  1. Uses ZERO-PHASE full-band drum onsets: sub/kick (30-160 Hz) + snare/clap (250-3500 Hz).
     Never blinds itself to <150 Hz electronic kicks.
  2. Always verifies beat phase at k = 1 (the actual beat), NEVER letting k = 4 (16ths) or
     k = 3 (triplets) lock 1/4 or 1/3 of a beat early while reporting low subdivision RMS.
  3. Produces ONE single source of truth per song stored in F:\\retex_core\\data\\grids\\<sid>.json.
  4. Audits both the raw Re-Tex grid AND the fixed grid against real drum hits, returning honest
     per-section millisecond offsets so green in the UI ALWAYS means real audio hits are on beat.
"""
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.signal import butter, filtfilt

from . import library
from .config import GRIDS, SR

ENV_FPS = 500.0            # 2 ms frame resolution for onset envelopes
ACTIVE_SHARE = 0.22        # window mean onset >= 22% of song's active median -> drums active
OFFBEAT_WARN_MS = 22.0     # > 22 ms off real drum hits triggers phase-fix / warning
DRIFT_WARN_MS = 16.0       # > 16 ms cumulative drift from a straight line -> recommends Quantize


# ------------------------------------------------------------------ full-band zero-phase drum onsets

def onset_curves(sid, audio_mono=None, sr=SR):
    """Return (body, kick, snare, fps, source) at ENV_FPS with ZERO filter phase delay."""
    source = "drums"
    if audio_mono is None:
        try:
            y = library.load_raw_stem(sid, "drums", mono=True)[0]
        except FileNotFoundError:
            y = np.zeros(SR, np.float32)
        if float(np.sqrt(np.mean(y ** 2))) < 1e-4:
            # Drumless / acapella fallback: use full mix of available stems
            parts = []
            for st in ("bass", "other", "vocals"):
                try:
                    parts.append(library.load_raw_stem(sid, st, mono=True)[0])
                except FileNotFoundError:
                    pass
            if parts:
                n = min(len(p) for p in parts)
                y = sum(p[:n] for p in parts)
                source = "mix"
    else:
        y = np.asarray(audio_mono, np.float32)

    hop = max(1, int(round(sr / ENV_FPS)))
    fps = sr / hop
    n_fr = len(y) // hop
    if n_fr < 16:
        z = np.zeros(max(16, n_fr), np.float32)
        return z, z, z, fps, source

    nyq = sr * 0.5
    # Zero-phase Butterworth filters (filtfilt -> 0.0 ms group delay!)
    b_k, a_k = butter(2, [30.0 / nyq, 160.0 / nyq], btype="band")
    b_s, a_s = butter(2, [250.0 / nyq, 3500.0 / nyq], btype="band")
    k_sig = filtfilt(b_k, a_k, y).astype(np.float32)
    s_sig = filtfilt(b_s, a_s, y).astype(np.float32)

    k_rms = np.sqrt(np.mean(k_sig[:n_fr * hop].reshape(n_fr, hop) ** 2, axis=1))
    s_rms = np.sqrt(np.mean(s_sig[:n_fr * hop].reshape(n_fr, hop) ** 2, axis=1))

    # Half-wave rectified first difference on compressed amplitude (sharp attack peaks!)
    k_on = np.maximum(0.0, np.diff(np.log1p(25.0 * k_rms), prepend=0.0)).astype(np.float32)
    s_on = np.maximum(0.0, np.diff(np.log1p(25.0 * s_rms), prepend=0.0)).astype(np.float32)

    kp = float(np.percentile(k_on, 99.5)) or 1.0
    sp = float(np.percentile(s_on, 99.5)) or 1.0
    k_n = k_on / kp
    s_n = s_on / sp
    body = (k_n + 0.85 * s_n).astype(np.float32)
    return body, k_n.astype(np.float32), s_n.astype(np.float32), fps, source


# ------------------------------------------------------------------ k=1 beat-hit phase audit

_DELTAS = np.linspace(-0.5, 0.5, 201)     # 0.005 beat step (~2-3 ms resolution)
_LOCAL_MASK = np.abs(_DELTAS) <= 0.10     # +-10% of a beat around 0 (captures detector bias & drift without syncopated fills)


def _window_phase_profile(times, body, fps):
    """Compute the full k=1 onset clarity curve across delta in [-0.5, +0.5] beats.

    Returns (clarity_curve, scores, per, med_score).
    """
    t = np.asarray(times, float)
    if len(t) < 4:
        return np.ones(len(_DELTAS), np.float64), np.zeros(len(_DELTAS), np.float64), 0.5, 1.0
    per = float(np.median(np.diff(t)))
    if per <= 0.1 or per >= 2.5:
        return np.ones(len(_DELTAS), np.float64), np.zeros(len(_DELTAS), np.float64), 0.5, 1.0
    n = len(body)
    # Mild 6 ms triangle smoothing around exact hit time so +-4 ms micro-groove sums cleanly
    ker = np.array([0.25, 0.5, 1.0, 0.5, 0.25], np.float32)
    sm = np.convolve(body, ker / ker.sum(), mode="same")

    scores = np.empty(len(_DELTAS), np.float64)
    for idx_d, d in enumerate(_DELTAS):
        fr = np.round((t + d * per) * fps).astype(np.int64)
        ok = (fr >= 0) & (fr < n)
        scores[idx_d] = float(sm[fr[ok]].mean()) if ok.any() else 0.0

    med_score = float(np.median(scores)) + 1e-9
    clarity_curve = scores / med_score
    return clarity_curve, scores, per, med_score


def _window_phase_offset(times, body, fps):
    """Measure honest k=1 beat phase offset (seconds) of `times` against `body` onset peaks.

    Distinguishes genuine off-beat misalignment (where no clear drum peak sits near 0 and the
    dominant hit lives far off-beat) from syncopated fills/breakdowns (where real drum hits
    already land near delta=0 even if an off-beat snare/crash is slightly louder).

    Positive offset means real drum hits occur AFTER `times` (i.e. `times` are early).
    Returns (offset_s, peak_score, zero_score, clarity).
    """
    clarity_curve, scores, per, med_score = _window_phase_profile(times, body, fps)
    zero_score = float(scores[100])
    glob_i = int(np.argmax(scores))
    glob_score = float(scores[glob_i])
    glob_cl = float(clarity_curve[glob_i])

    # Check best drum hit peak near the beat (+-10% of a beat)
    local_indices = np.where(_LOCAL_MASK)[0]
    loc_rel = int(np.argmax(scores[local_indices]))
    loc_i = int(local_indices[loc_rel])
    loc_score = float(scores[loc_i])
    loc_cl = float(clarity_curve[loc_i])

    # If a genuine drum hit already sits near the beat AND the global off-beat peak is
    # not overwhelmingly stronger (< 2.1x), OR if delta=0 already carries nearly peak energy
    # (continuous 16th-note drum rolls / dense metal fills), it is syncopation, NOT off-beat!
    if (loc_cl >= 1.35 and (glob_score / max(loc_score, 1e-9)) < 2.1) or (glob_score / max(zero_score, 1e-9) < 1.35):
        return float(_DELTAS[loc_i] * per), loc_score, zero_score, loc_cl
    return float(_DELTAS[glob_i] * per), glob_score, zero_score, glob_cl


def _viterbi_phase_track(curves, win_centers, p_med):
    """Find the globally smooth beat-phase offset trajectory (seconds) across active windows.

    Prevents isolated syncopated fills/breakdowns from yanking the grid +-1/4 or +-1/2 beat,
    while freely tracking true drift (e.g. Reyin) or true constant phase errors (e.g. user_marks).
    """
    W, D = curves.shape
    if W == 0:
        return np.zeros(0, np.float64)
    # Mild spike cap + tiny zero-anchor preference to break ties cleanly on equal beat/upbeat hits
    prior = 0.22 * np.exp(-(_DELTAS / 0.065) ** 2)
    emit = np.minimum(curves, 10.0) + prior[None, :]
    if W == 1:
        return np.array([_DELTAS[int(np.argmax(emit[0]))] * p_med], np.float64)

    # Precompute circular shortest signed distance matrix between every pair of delta states
    diff = (_DELTAS[None, :] - _DELTAS[:, None] + 0.5) % 1.0 - 0.5   # shape (D, D): from i to j
    diff_sq = diff * diff

    dp = np.empty((W, D), np.float64)
    back = np.zeros((W, D), np.int32)
    dp[0] = emit[0]
    for w in range(1, W):
        # Allow slightly more freedom across long drumless gaps, tighter continuity on consecutive windows
        gap_beats = max(4.0, float(win_centers[w] - win_centers[w - 1]))
        lam = 220.0 / (gap_beats / 4.0) ** 0.75
        trans = dp[w - 1][:, None] - lam * diff_sq
        idx = np.argmax(trans, axis=0)
        back[w] = idx
        dp[w] = emit[w] + trans[idx, np.arange(D)]

    path = np.empty(W, np.int32)
    path[W - 1] = int(np.argmax(dp[W - 1]))
    for w in range(W - 2, -1, -1):
        path[w] = back[w + 1, path[w + 1]]

    # Unwrap along the exact DP step deltas (never suffers abrupt +-0.5 wrap flips!)
    deltas_unwrapped = np.empty(W, np.float64)
    deltas_unwrapped[0] = _DELTAS[path[0]]
    for w in range(1, W):
        step_d = (_DELTAS[path[w]] - _DELTAS[path[w - 1]] + 0.5) % 1.0 - 0.5
        deltas_unwrapped[w] = deltas_unwrapped[w - 1] + step_d
    # Re-center median into [-0.5, +0.5]
    med_d = float(np.median(deltas_unwrapped))
    deltas_unwrapped -= round(med_d)
    return deltas_unwrapped * p_med


def audit_beats(beats, body, fps, win_beats=16, step_beats=8):
    """Audit a beat list against actual drum onsets across the song.

    Returns dict with per-window measurements, median/max absolute offset in ms,
    active beat mask, drift stats, and honest status ('ok' | 'warn' | 'off_beat').
    """
    b = np.asarray(beats, float)
    n = len(b)
    if n < 8:
        return dict(status="warn", median_offset_ms=0.0, max_offset_ms=0.0,
                    signed_median_ms=0.0, active_windows=0, bad_windows=0,
                    drift_pct=0.0, max_straight_err_ms=0.0, needs_quantize=False, sections=[])

    # Determine usual active drum energy across the song
    win_e = []
    for i in range(0, max(1, n - win_beats + 1), step_beats):
        seg = b[i:i + win_beats]
        f0, f1 = int(max(0, seg[0] * fps)), int(min(len(body), seg[-1] * fps))
        win_e.append(float(body[f0:f1].mean()) if f1 > f0 else 0.0)
    win_e = np.asarray(win_e, float)
    nz = win_e[win_e > 0.25 * (win_e.max() if len(win_e) else 0.0)]
    usual = float(np.median(nz)) if len(nz) else 0.0

    sections = []
    offs_ms = []
    for idx_w, i in enumerate(range(0, max(1, n - win_beats + 1), step_beats)):
        seg = b[i:min(n, i + win_beats)]
        if len(seg) < 8:
            continue
        active = bool(win_e[idx_w] >= ACTIVE_SHARE * usual and usual > 1e-4)
        per = float(np.median(np.diff(seg)))
        bpm_loc = 60.0 / per if per > 0 else 0.0
        if not active:
            sections.append(dict(i0=int(i), i1=int(i + len(seg)), t0=round(float(seg[0]), 2),
                                 t1=round(float(seg[-1]), 2), bpm=round(bpm_loc, 2),
                                 active=False, offset_ms=0.0, clarity=0.0, ratio=1.0))
            continue
        off_s, pk, z0, clarity = _window_phase_offset(seg, body, fps)
        off_ms = off_s * 1000.0
        ratio = pk / max(z0, 1e-6)
        offs_ms.append(off_ms)
        sections.append(dict(i0=int(i), i1=int(i + len(seg)), t0=round(float(seg[0]), 2),
                             t1=round(float(seg[-1]), 2), bpm=round(bpm_loc, 2),
                             active=True, offset_ms=round(off_ms, 1),
                             clarity=round(clarity, 2), ratio=round(ratio, 2)))

    # Measure how far the beat list itself drifts from a single straight constant-BPM grid
    j = np.arange(n, dtype=float)
    per_med = float(np.median(np.diff(b)))
    # Fit straight line weighted to active beats
    slope, intercept = np.polyfit(j, b, 1)
    straight_err_ms = np.abs(b - (intercept + slope * j)) * 1000.0
    max_straight_err_ms = float(np.percentile(straight_err_ms, 95))
    bpms_active = [s["bpm"] for s in sections if s["active"] and s["bpm"] > 0]
    drift_pct = (max(bpms_active) - min(bpms_active)) / max(1e-6, float(np.median(bpms_active))) * 100.0 if len(bpms_active) >= 2 else 0.0

    abs_offs = [abs(x) for x in offs_ms]
    med_abs = float(np.median(abs_offs)) if abs_offs else 0.0
    max_abs = float(np.max(abs_offs)) if abs_offs else 0.0
    signed_med = float(np.median(offs_ms)) if offs_ms else 0.0
    bad_wins = sum(1 for s in sections if s["active"] and abs(s["offset_ms"]) > OFFBEAT_WARN_MS and s["clarity"] >= 1.8)
    bad_thresh = max(2, int(round(0.10 * max(1, len(offs_ms)))))

    status = "ok"
    if med_abs > OFFBEAT_WARN_MS or bad_wins >= bad_thresh:
        status = "off_beat"
    elif bad_wins > 0 or max_abs > 18.0:
        status = "warn"

    needs_quantize = bool(max_straight_err_ms > DRIFT_WARN_MS or drift_pct > 0.35)
    return dict(
        status=status,
        median_offset_ms=round(med_abs, 1),
        max_offset_ms=round(max_abs, 1),
        signed_median_ms=round(signed_med, 1),
        active_windows=len(offs_ms),
        bad_windows=bad_wins,
        drift_pct=round(drift_pct, 2),
        max_straight_err_ms=round(max_straight_err_ms, 1),
        needs_quantize=needs_quantize,
        sections=sections,
    )


# ------------------------------------------------------------------ transient-locked auto-fix

def _recount_slips(beats):
    """Fix 2x / 0.5x detector tempo switches, missed-beat gaps, and isolated glitch sub-beats using local tempo."""
    b = np.asarray(beats, float)
    if len(b) < 12:
        return b
    for _ in range(2):
        iv = np.diff(b)
        p_glob = float(np.median(iv))
        if p_glob <= 0.05 or len(b) < 12:
            return b
        # Local tempo estimate around every beat (+-8 beats) so real section tempo shifts stay intact
        loc_p = np.empty(len(b), float)
        for k in range(len(b)):
            lo = max(0, k - 8)
            hi = min(len(iv), k + 8)
            loc_p[k] = float(np.median(iv[lo:hi])) if hi > lo else p_glob
        out = [float(b[0])]
        i = 1
        while i < len(b):
            d = float(b[i]) - out[-1]
            # If Beat This! temporarily doubled into a 2x burst (loc_p < 0.62 * p_glob), anchor to p_glob!
            p_loc = float(loc_p[i])
            if p_loc < 0.62 * p_glob:
                p_loc = p_glob
            p_loc = max(0.18, p_loc)
            # Split beat or isolated glitch sub-beat (<0.62x local period, e.g. 244-352 BPM stray/double beat)
            if d < 0.62 * p_loc:
                if i + 1 < len(b):
                    d2 = float(b[i + 1]) - float(b[i])
                    if 0.72 * p_loc <= (d + d2) <= 1.38 * p_loc:
                        # Two sub-beats summing to ~1 real beat -> merge into the real beat
                        out.append(float(b[i + 1]))
                        i += 2
                        continue
                if d < 0.60 * p_loc:
                    # Isolated stray glitch beat -> drop it!
                    i += 1
                    continue
            # Missed beats / half-time gap (>= 1.58x local period): subdivide evenly
            if d >= 1.58 * p_loc:
                n_sub = max(2, int(round(d / p_loc)))
                prev = out[-1]
                for k in range(1, n_sub):
                    out.append(prev + d * k / n_sub)
                out.append(float(b[i]))
                i += 1
                continue
            out.append(float(b[i]))
            i += 1
        b = np.asarray(out, float)
    return b


def _pick_downbeat_offset(beats, kick, snare, fps, bpb, ref_bars_t=None):
    """Choose which beat index mod `bpb` is Beat 1 (downbeat)."""
    b = np.asarray(beats, float)
    n = len(b)
    if n < bpb * 2:
        return 0
    r = max(1, int(round(0.018 * fps)))
    kick_scores = np.zeros(bpb, float)
    for ph in range(bpb):
        idx = np.round(b[ph::bpb] * fps).astype(np.int64)
        vals = [float(kick[max(0, i - r):min(len(kick), i + r + 1)].max()) for i in idx if 0 <= i < len(kick)]
        kick_scores[ph] = float(np.mean(vals)) if vals else 0.0

    # If Beat This! gave bar times, check which phase matches them best
    if ref_bars_t is not None and len(ref_bars_t) >= 2:
        votes = np.zeros(bpb, int)
        for bt in ref_bars_t:
            k = int(np.argmin(np.abs(b - bt)))
            if abs(b[k] - bt) < 0.25 * float(np.median(np.diff(b))):
                votes[k % bpb] += 1
        ref_ph = int(np.argmax(votes))
        # Prefer Beat This! musical phrasing if its kick strength is at least 75% of the strongest kick phase
        if votes[ref_ph] >= 2 and kick_scores[ref_ph] >= 0.75 * float(kick_scores.max()):
            return ref_ph

    return int(np.argmax(kick_scores))


def build_verified_grid(sid):
    """Build a single-source-of-truth transient-verified beat grid for `sid` (never mutates shared song.json)."""
    info = library.read_raw(sid)
    if not info:
        raise FileNotFoundError(f"Song {sid} not found in shared library")

    dur = float(info.get("duration") or 0.0)
    bpb = int(info.get("bpb") or 4)
    raw_beats_all = np.asarray(info.get("beats") or [], float)
    # Keep beats within song duration
    raw_beats = raw_beats_all[(raw_beats_all >= -0.05) & (raw_beats_all <= dur + 0.05)]
    if len(raw_beats) < 8:
        bpm_fb = float(info.get("bpm") or 120.0)
        p = 60.0 / bpm_fb
        raw_beats = np.arange(0.0, max(dur, p * 8), p)

    body, kick, snare, fps, env_src = onset_curves(sid)

    # 1) Audit both raw Beat This! and any existing Re-Tex user_marks (diagnostic honesty!)
    raw_audit = audit_beats(raw_beats, body, fps)
    um_audit = None
    um = info.get("user_marks")
    if um and um.get("t") and len(um["t"]) >= 8:
        um_audit = audit_beats(um["t"], body, fps)

    # 2) Seed from clean monotonic raw_beats (re-counting any half/double-time slips)
    seed = _recount_slips(raw_beats)
    n = len(seed)
    p_med = float(np.median(np.diff(seed)))

    # 3) Measure k=1 drum-hit phase curves in overlapping active windows (16 beats, step 4)
    #    and solve a continuity-constrained Viterbi path so syncopated fills never yank the grid!
    win = 16
    step = 4
    win_centers = []
    win_curves = []

    # Determine active drum threshold
    all_e = []
    for i in range(0, max(1, n - win + 1), step):
        seg = seed[i:i + win]
        f0, f1 = int(max(0, seg[0] * fps)), int(min(len(body), seg[-1] * fps))
        all_e.append(float(body[f0:f1].mean()) if f1 > f0 else 0.0)
    all_e = np.asarray(all_e, float)
    nz = all_e[all_e > 0.25 * (all_e.max() if len(all_e) else 0.0)]
    usual = float(np.median(nz)) if len(nz) else 0.0

    for idx_w, i in enumerate(range(0, max(1, n - win + 1), step)):
        seg = seed[i:min(n, i + win)]
        if len(seg) < 8:
            continue
        if all_e[idx_w] < ACTIVE_SHARE * usual or usual <= 1e-4:
            continue
        c_curve, _, _, _ = _window_phase_profile(seg, body, fps)
        if float(c_curve.max()) >= 1.5:
            win_centers.append(i + 0.5 * (len(seg) - 1))
            win_curves.append(c_curve)

    fixed = seed.copy()
    action = "verified"

    if len(win_centers) >= 2:
        wc = np.asarray(win_centers, float)
        wo = _viterbi_phase_track(np.asarray(win_curves, np.float64), wc, p_med)

        # Apply smooth per-beat offset curve (compact 7-beat Hanning preserves tight groove changes)
        j_all = np.arange(n, dtype=float)
        off_curve = np.interp(j_all, wc, wo)
        ker_len = min(7, max(3, (n // 16) | 1))
        ker = np.hanning(ker_len + 2)[1:-1]
        off_smooth = np.convolve(np.pad(off_curve, ker_len // 2, mode="edge"), ker / ker.sum(), mode="valid")[:n]
        cand_follow = seed + off_smooth

        # Enforce strict monotonic spacing (never abort the whole song due to one tight beat)
        min_gap = 0.35 * p_med
        for k in range(1, len(cand_follow)):
            if cand_follow[k] < cand_follow[k - 1] + min_gap:
                cand_follow[k] = cand_follow[k - 1] + min_gap

        if len(cand_follow) >= 8:
            # Also test a pure steady straight line fitted robustly to the active beat anchors
            active_mask = np.zeros(n, bool)
            for c_idx in wc:
                lo = max(0, int(c_idx - win // 2))
                hi = min(n, int(c_idx + win // 2))
                active_mask[lo:hi] = True
            act_j = j_all[active_mask]
            act_t = cand_follow[active_mask]
            slope, intercept = np.polyfit(act_j, act_t, 1)
            # One IRLS pass to ignore any lone outlier stretch in the straight-line fit
            res_s = np.abs(act_t - (intercept + slope * act_j))
            inliers = res_s <= max(0.018, float(np.percentile(res_s, 75)) * 1.8)
            if inliers.sum() >= 8:
                slope, intercept = np.polyfit(act_j[inliers], act_t[inliers], 1)
            cand_straight = intercept + slope * j_all
            straight_dev = float(np.percentile(np.abs(act_t - cand_straight[active_mask]) * 1000.0, 85))

            aud_follow = audit_beats(cand_follow, body, fps)
            aud_straight = audit_beats(cand_straight, body, fps)

            # Pick pure straight line if 85% of active beats sit within 14 ms of it AND median hit error stays clean
            if straight_dev <= 14.0 and aud_straight["median_offset_ms"] <= max(10.0, aud_follow["median_offset_ms"] + 4.0):
                fixed = cand_straight
                action = "steady_locked"
            else:
                # Re-even out any inactive (drumless) interior stretches between active anchors
                fixed = _even_inactive_gaps(cand_follow, active_mask)
                # Gentle +-5 ms transient lock (never introduces beat-to-beat speed whiplash)
                fixed = _gentle_hit_snap(fixed, active_mask, body, fps, max_shift_s=0.005)
                action = "drift_tracked"
    elif len(win_centers) == 1:
        off_s = float(_DELTAS[int(np.argmax(win_curves[0]))] * p_med)
        fixed = seed + off_s
        action = "phase_shifted"

    # Trim / extend cleanly to cover [0, dur]
    p_start = float(np.median(np.diff(fixed[:min(len(fixed), 16)])))
    p_end = float(np.median(np.diff(fixed[max(0, len(fixed) - 16):])))
    while fixed[0] - p_start >= 0.0:
        fixed = np.r_[fixed[0] - p_start, fixed]
    while len(fixed) > 2 and fixed[0] < 0.0:
        fixed = fixed[1:]
    while fixed[-1] + p_end <= dur + 0.05:
        fixed = np.r_[fixed, fixed[-1] + p_end]

    # Pick musical downbeat phase
    ref_bars_idx = [int(x) for x in (info.get("bars") or []) if 0 <= int(x) < len(raw_beats_all)]
    ref_bars_t = [float(raw_beats_all[k]) for k in ref_bars_idx] if ref_bars_idx else None
    down_off = _pick_downbeat_offset(fixed, kick, snare, fps, bpb, ref_bars_t=ref_bars_t)
    bars = list(range(down_off, len(fixed), bpb))

    # Post-fix honest audit!
    post_audit = audit_beats(fixed, body, fps)
    bpm = round(60.0 / float(np.median(np.diff(fixed))), 4)

    # Human-readable note summarizing any mistake caught!
    notes = []
    if um_audit and um_audit["median_offset_ms"] > OFFBEAT_WARN_MS:
        notes.append(f"Caught Re-Tex user_marks off-beat by {um_audit['signed_median_ms']:+.0f} ms (max {um_audit['max_offset_ms']:.0f} ms)")
    if raw_audit["max_offset_ms"] > OFFBEAT_WARN_MS:
        notes.append(f"Caught Beat This! drift/offset up to {raw_audit['max_offset_ms']:.0f} ms")
    if post_audit["needs_quantize"]:
        notes.append(f"Song drifts {post_audit['drift_pct']:.1f}% ({post_audit['max_straight_err_ms']:.0f} ms) — click Quantize to lock onto steady grid")
    if not notes:
        notes.append(f"Hits verified clean ({post_audit['median_offset_ms']:.1f} ms median)")

    grid = {
        "sid": sid,
        "title": info.get("title") or sid,
        "bpm": bpm,
        "bpb": bpb,
        "downbeat_offset": int(down_off),
        "beats": [round(float(x), 5) for x in fixed],
        "bars": bars,
        "duration": round(dur, 4),
        "mode": action,
        "onset_source": env_src,
        "updated": time.time(),
        "audit": {
            **post_audit,
            "raw_median_offset_ms": raw_audit["median_offset_ms"],
            "raw_max_offset_ms": raw_audit["max_offset_ms"],
            "retex_user_marks_offset_ms": um_audit["signed_median_ms"] if um_audit else None,
            "note": "; ".join(notes),
        },
        "quantized": None,
    }
    grid["sig"] = grid_sig(grid)
    save_grid(sid, grid)
    return grid


def _even_inactive_gaps(beats, active_mask):
    """Interpolate drumless intros/breaks/outros linearly between their active boundary beats."""
    b = beats.copy()
    n = len(b)
    i = 0
    while i < n:
        if active_mask[i]:
            i += 1
            continue
        j = i
        while j < n and not active_mask[j]:
            j += 1
        if i > 0 and j < n:
            # Interior break: evenly space beats between b[i-1] and b[j]
            b[i:j] = np.linspace(b[i - 1], b[j], j - i + 2)[1:-1]
        elif i == 0 and j < n:
            # Intro: carry back at the first active section's tempo
            per = float(np.median(np.diff(b[j:min(n, j + 16)]))) if j + 2 < n else float(np.median(np.diff(b)))
            b[0:j] = b[j] - np.arange(j, 0, -1) * per
        elif j == n and i > 0:
            # Outro: carry forward at the last active section's tempo
            per = float(np.median(np.diff(b[max(0, i - 16):i]))) if i >= 2 else float(np.median(np.diff(b)))
            b[i:n] = b[i - 1] + np.arange(1, n - i + 1) * per
        i = j
    return b


def _gentle_hit_snap(beats, active_mask, body, fps, max_shift_s=0.012):
    """Nudge active beats up to +-12 ms onto unambiguous transient peaks without breaking monotonicity."""
    b = beats.copy()
    w = max(1, int(round(max_shift_s * fps)))
    ctx_w = w * 6
    n = len(body)
    for k in range(1, len(b) - 1):
        if not active_mask[k]:
            continue
        i = int(round(b[k] * fps))
        lo, hi = max(0, i - w), min(n, i + w + 1)
        if hi - lo < 3:
            continue
        seg = body[lo:hi]
        p = int(np.argmax(seg))
        ctx = body[max(0, i - ctx_w):min(n, i + ctx_w + 1)]
        if seg[p] > 2.0 * (float(np.median(ctx)) + 1e-6) and p not in (0, len(seg) - 1):
            cand = (lo + p) / fps
            if b[k - 1] + 0.15 < cand < b[k + 1] - 0.15:
                b[k] = cand
    return b


# ------------------------------------------------------------------ persistence & user adjustments

def grid_sig(grid):
    b = grid.get("beats") or []
    h = hashlib.sha1()
    h.update(f"{len(b)}:{grid.get('bpb', 4)}:{grid.get('downbeat_offset', 0)}:".encode())
    for x in b:
        h.update(f"{int(round(x * 1000))},".encode())
    return h.hexdigest()[:12]


def grid_path(sid):
    return GRIDS / f"{sid}.json"


def load_grid(sid):
    p = grid_path(sid)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return None


def save_grid(sid, grid):
    grid["sig"] = grid_sig(grid)
    grid["updated"] = time.time()
    p = grid_path(sid)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(grid, indent=1), encoding="utf-8")
    tmp.replace(p)
    return grid


def get_or_build(sid, force=False):
    if not force:
        g = load_grid(sid)
        if g and g.get("beats"):
            return g
    return build_verified_grid(sid)


def update_grid(sid, *, downbeat_shift=0, nudge_ms=0.0, factor=1.0, bpb=None, custom_beats=None):
    """Apply clean user grid edits (shift bar 1, nudge phase in ms, half/double tempo, or tapped beats),
    then immediately re-audit against real drum hits so the UI stays 100% honest!"""
    g = get_or_build(sid)
    beats = np.asarray(custom_beats if custom_beats is not None else g["beats"], float)
    dur = float(g.get("duration") or beats[-1])
    new_bpb = int(bpb if bpb is not None else g.get("bpb", 4))

    if abs(nudge_ms) > 1e-6:
        beats = beats + (float(nudge_ms) / 1000.0)
        beats = beats[beats >= 0.0]

    if abs(factor - 2.0) < 1e-6:
        # Double-time: insert midpoints between beats
        mids = 0.5 * (beats[:-1] + beats[1:])
        out = np.empty(len(beats) * 2 - 1, float)
        out[0::2] = beats
        out[1::2] = mids
        beats = out
    elif abs(factor - 0.5) < 1e-6 and len(beats) >= 8:
        # Half-time: keep every second beat anchored on downbeat
        off = int(g.get("downbeat_offset", 0)) % 2
        beats = beats[off::2]

    down_off = (int(g.get("downbeat_offset", 0)) + int(downbeat_shift)) % new_bpb
    bars = list(range(down_off, len(beats), new_bpb))
    bpm = round(60.0 / float(np.median(np.diff(beats))), 4) if len(beats) >= 2 else g["bpm"]

    body, _, _, fps, env_src = onset_curves(sid)
    aud = audit_beats(beats, body, fps)
    aud["note"] = f"User adjusted ({aud['median_offset_ms']:.1f} ms median vs drum hits)"

    g["beats"] = [round(float(x), 5) for x in beats]
    g["bars"] = bars
    g["bpb"] = new_bpb
    g["downbeat_offset"] = down_off
    g["bpm"] = bpm
    g["mode"] = "user"
    g["audit"] = aud
    # If beats changed, mark previous quantization stale (keep files untouched on disk; new sig won't match)
    new_sig = grid_sig(g)
    if g.get("quantized") and g["quantized"].get("sig") != new_sig:
        g["quantized"] = None
    return save_grid(sid, g)
