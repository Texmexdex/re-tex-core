"""Block-based real-time and offline arrangement mixer for Re-Tex Core.

Exact same DSP drives live playback and offline export (what you hear = what you get).
Supports per-lane Gain, Pan, Pitch (via warp), HPF, LPF, Vocal Pocket EQ, Sidechain Ducking,
seamless adjacent clip joins, instant varispeed preview while R3 warps render, and 2-pass
LUFS-normalized brickwall-limited WAV/MP3 export.
"""
import contextlib
import numpy as np
import numba
import pedalboard as pb

from . import audio_io, grid as G, library, project as P, quantize as Q, warp
from .config import SR

MICRO_FADE = int(0.003 * SR)
_WIN = (np.i0(8.0 * np.sqrt(np.clip(1 - np.linspace(0, 1, 4097) ** 2, 0, 1))) / np.i0(8.0)).astype(np.float64)


@numba.njit(cache=True, fastmath=True)
def _vari(x, p0, step, m, cutoff, win):
    ch, n = x.shape
    H = int(np.ceil(16.0 / cutoff))
    nw = win.shape[0] - 1
    out = np.zeros((ch, m), np.float32)
    for i in range(m):
        p = p0 + i * step
        i0 = int(np.floor(p))
        for j in range(i0 - H + 1, i0 + H + 1):
            if j < 0 or j >= n:
                continue
            t = j - p
            a = abs(t) / H
            if a >= 1.0:
                continue
            u = t * cutoff
            s = 1.0 if abs(u) < 1e-9 else np.sin(np.pi * u) / (np.pi * u)
            k = cutoff * s * win[int(a * nw)]
            for c in range(ch):
                out[c, i] += x[c, j] * k
    return out


def varispeed_read(buf, pos0, step, m):
    cutoff = min(1.0, 1.0 / max(1e-4, step)) * 0.95
    H = int(np.ceil(16.0 / cutoff)) + 2
    lo = int(np.floor(pos0)) - H
    hi = int(np.ceil(pos0 + m * step)) + H
    la, lb = max(0, lo), min(buf.shape[1], hi)
    if lb <= la:
        return np.zeros((buf.shape[0], m), np.float32)
    seg = np.ascontiguousarray(buf[:, la:lb], dtype=np.float32)
    return _vari(seg, pos0 - la, step, m, cutoff, _WIN)


class _TrackFX:
    def __init__(self):
        self.sig = None
        self.board = None
        self.duck_env = 0.0

    def configure(self, t):
        sig = (round(float(t.get("hpf", 0) or 0)), round(float(t.get("lpf", 0) or 0)), round(float(t.get("pocket", 0) or 0), 1))
        if sig == self.sig:
            return
        self.sig = sig
        fx = []
        if sig[0] > 20:
            fx.append(pb.HighpassFilter(cutoff_frequency_hz=float(sig[0])))
        if 200 < sig[1] < 20000:
            fx.append(pb.LowpassFilter(cutoff_frequency_hz=float(sig[1])))
        if sig[2] > 0.05:
            fx.append(pb.PeakFilter(cutoff_frequency_hz=2800.0, gain_db=-float(sig[2]), q=0.7))
        self.board = pb.Pedalboard(fx) if fx else None

    def process(self, x, reset=False):
        return x if self.board is None else self.board.process(x, SR, reset=reset)


class Mixer:
    def __init__(self):
        self.proj = None
        self.tracks = []
        self.track_index = {}
        self.clips = []
        self.fx = {}
        self.master = None
        self.master_sig = None
        self.master_gain = 1.0
        self.end_sample = 0
        self.missing = set()
        self._reset_next = True

    def load(self, proj, allow_preview=True, swap_lock=None):
        bpm = float(proj.get("bpm") or 120.0)
        T = (60.0 / bpm) * SR
        tracks = proj.get("tracks") or []
        solo = any(t.get("solo") for t in tracks)
        tinfo = []
        tmap = {}
        for t in tracks:
            tmap[t["id"]] = t
            audible = not t.get("mute") and (t.get("solo") or not solo)
            pan = float(np.clip(t.get("pan", 0.0), -1.0, 1.0))
            g = 10.0 ** (float(t.get("gain_db", 0.0)) / 20.0) if audible else 0.0
            lr = np.array([np.cos((pan + 1.0) * np.pi / 4.0), np.sin((pan + 1.0) * np.pi / 4.0)], dtype=np.float32) * np.sqrt(2.0)
            tinfo.append(dict(id=t["id"], gain=g, lr=lr, duck=float(t.get("duck", 0.0) or 0.0),
                              role=t.get("role", "any"), cfg=t))
            self.fx.setdefault(t["id"], _TrackFX()).configure(t)
        tindex = {t["id"]: i for i, t in enumerate(tinfo)}

        compiled = []
        missing = set()
        for c in proj.get("clips") or []:
            if c.get("mute") or c["track"] not in tindex or float(c.get("len", 0)) <= 0:
                continue
            sid = c["song"]
            if library.read_raw(sid) is None:
                continue
            trk = tmap[c["track"]]
            req = P.warp_request(proj, c, trk)
            mult = req[5]
            rate = float(c.get("rate", 1.0) or 1.0)
            s0 = int(round(float(c["start"]) * T))
            s1 = int(round((float(c["start"]) + float(c["len"])) * T))
            if s1 <= s0:
                continue
            fi = max(MICRO_FADE, int(float(c.get("fade_in", 0.0)) * T))
            fo = max(MICRO_FADE, int(float(c.get("fade_out", 0.0)) * T))
            gain = 10.0 ** (float(c.get("gain_db", 0.0)) / 20.0)

            r = warp.open_render(*req)
            if r is not None:
                buf, t0 = r
                off_f = float(c["src"]) * mult * T - t0 * SR
                entry = dict(s0=s0, s1=s1, g=gain, fi=fi, fo=fo, ti=tindex[c["track"]],
                             id=c["id"], buf=buf, step=rate,
                             off=off_f + (s0 - float(c["start"]) * T) * rate)
                if abs(rate - 1.0) < 1e-6:
                    entry["off"] = int(round(s0 + (off_f - float(c["start"]) * T)))
                    entry["step"] = 1.0
                compiled.append(entry)
            else:
                missing.add(req)
                if not allow_preview:
                    continue
                # Instant varispeed preview directly from quantized or raw stem while R3 renders
                try:
                    g = G.get_or_build(sid)
                    q_rev = req[2]
                    if q_rev:
                        srcbuf = Q.load_quantized_stem(sid, q_rev, c["stem"])
                        p_src = float(g["quantized"]["period"])
                        t0_src = float(g["quantized"]["t0"])
                    else:
                        srcbuf = library.load_raw_stem(sid, c["stem"], mono=False)
                        p_src = 60.0 / float(g["bpm"])
                        t0_src = float(g["beats"][0])
                    step = (p_src / (60.0 / bpm * mult)) * rate
                    pos0 = (t0_src + float(c["src"]) * p_src) * SR
                    compiled.append(dict(s0=s0, s1=s1, g=gain, fi=fi, fo=fo, ti=tindex[c["track"]],
                                         id=c["id"], buf=srcbuf, step=step, off=pos0))
                except Exception:
                    pass

        # Seamless joins: remove 3ms dip where two clips on same track carry straight on
        joins = self._joins(proj)
        for d in compiled:
            if (d["id"], "in") in joins and d["fi"] == MICRO_FADE:
                d["fi"] = 0
            if (d["id"], "out") in joins and d["fo"] == MICRO_FADE:
                d["fo"] = 0
        compiled.sort(key=lambda d: d["s0"])

        m = proj.get("master") or {}
        sig = (bool(m.get("glue", True)), bool(m.get("limit", True)))
        if sig != self.master_sig:
            fx = []
            if sig[0]:
                fx.append(pb.Compressor(threshold_db=-16.0, ratio=2.0, attack_ms=20.0, release_ms=250.0))
            if sig[1]:
                fx.append(pb.Limiter(threshold_db=-1.2, release_ms=120.0))
            self.master = pb.Pedalboard(fx) if fx else None
            self.master_sig = sig
        self.master_gain = 10.0 ** (float(m.get("gain_db", 0.0)) / 20.0)

        with swap_lock or contextlib.nullcontext():
            self.tracks, self.track_index, self.clips = tinfo, tindex, compiled
            self.end_sample = max([d["s1"] for d in compiled] + [0])
            self.missing = missing
            self.proj = proj
        return missing

    @staticmethod
    def _joins(proj):
        out, by = set(), {}
        for c in proj.get("clips") or []:
            if c.get("mute") or float(c.get("len", 0)) <= 0:
                continue
            by.setdefault((c["track"], c["song"], c["stem"]), []).append(c)
        for (_, sid, _), cs in by.items():
            if len(cs) < 2:
                continue
            cs.sort(key=lambda c: float(c["start"]))
            mult = P.song_mult(proj, sid)
            for a, b in zip(cs, cs[1:]):
                ra, rb = float(a.get("rate", 1.0) or 1.0), float(b.get("rate", 1.0) or 1.0)
                if (abs(float(b["start"]) - (float(a["start"]) + float(a["len"]))) < 1e-4
                        and abs(ra - rb) < 1e-6
                        and abs(float(a.get("pitch", 0)) - float(b.get("pitch", 0))) < 1e-4
                        and abs(float(a.get("gain_db", 0)) - float(b.get("gain_db", 0))) < 1e-4
                        and abs(float(b["src"]) - (float(a["src"]) + float(a["len"]) * ra / mult)) < 1e-3):
                    out.add((a["id"], "out"))
                    out.add((b["id"], "in"))
        return out

    def reset(self):
        self._reset_next = True
        for f in self.fx.values():
            f.duck_env = 0.0

    @staticmethod
    def _mix_clip(c, pos, end, buses):
        a, b = max(pos, c["s0"]), min(end, c["s1"])
        if b <= a:
            return False
        buf = c["buf"]
        if abs(c["step"] - 1.0) > 1e-6:
            seg = varispeed_read(buf, c["off"] + (a - c["s0"]) * c["step"], c["step"], b - a)
            oa = a - pos
            idx = np.arange(a, b)
        else:
            ba = int(c["off"]) + (a - c["s0"])
            bb = int(c["off"]) + (b - c["s0"])
            la, lb = max(ba, 0), min(bb, buf.shape[1])
            if lb <= la:
                return False
            seg = np.asarray(buf[:, la:lb], np.float32)
            oa = a - pos + (la - ba)
            idx = np.arange(a + (la - ba), a + (la - ba) + seg.shape[1])
        env = np.full(seg.shape[1], c["g"], np.float32)
        if c["fi"] > 0:
            fi = (idx - c["s0"]) / c["fi"]
            if fi.min() < 1.0:
                env *= np.sin(np.clip(fi, 0.0, 1.0) * np.pi / 2.0).astype(np.float32)
        if c["fo"] > 0:
            fo = (c["s1"] - idx) / c["fo"]
            if fo.min() < 1.0:
                env *= np.sin(np.clip(fo, 0.0, 1.0) * np.pi / 2.0).astype(np.float32)
        buses[c["ti"], :, oa:oa + seg.shape[1]] += seg * env
        return True

    def render(self, pos, n, master=True):
        tracks, clips = self.tracks, self.clips
        nt = len(tracks)
        buses = np.zeros((nt, 2, n), np.float32) if nt else np.zeros((0, 2, n), np.float32)
        used = np.zeros(nt, bool)
        end = pos + n
        for c in clips:
            if c["s0"] >= end:
                break
            if c["s1"] <= pos:
                continue
            if self._mix_clip(c, pos, end, buses):
                used[c["ti"]] = True

        out = np.zeros((2, n), np.float32)
        reset = self._reset_next
        self._reset_next = False
        vox_level = 0.0
        if any(t["duck"] > 0 for t in tracks):
            vi = [i for i, t in enumerate(tracks) if t["role"] == "vocals" and used[i] and t["gain"] > 0]
            if vi:
                v = buses[vi].sum(0)
                vox_level = float(np.sqrt(np.mean(v ** 2)) + 1e-9)
        for i, t in enumerate(tracks):
            fx = self.fx.get(t["id"])
            if not used[i] and (fx is None or fx.board is None):
                continue
            if t["gain"] == 0.0:
                continue
            x = buses[i]
            if fx is not None and fx.board is not None:
                x = fx.process(x, reset)
            g = t["gain"]
            if t["duck"] > 0 and fx is not None:
                db = 20.0 * np.log10(vox_level) if vox_level > 0 else -120.0
                target = float(np.clip((db + 42.0) / 24.0, 0.0, 1.0)) * t["duck"]
                k = 0.5 if target > fx.duck_env else 0.08
                fx.duck_env += (target - fx.duck_env) * k
                g *= 10.0 ** (-fx.duck_env / 20.0)
            out += x * (t["lr"][:, None] * g)
        out *= self.master_gain
        if master and self.master is not None:
            out = self.master.process(out, SR, reset=reset)
        return out


@numba.njit(cache=True)
def _gain_curve(peak, ceiling, look, rel):
    n = peak.shape[0]
    need = np.empty(n, np.float32)
    for i in range(n):
        need[i] = ceiling / peak[i] if peak[i] > ceiling else 1.0
    g = np.empty(n, np.float32)
    q = np.empty(n, np.int64)
    h, t, j = 0, 0, 0
    for i in range(n):
        while j < n and j <= i + look:
            while t > h and need[q[t - 1]] >= need[j]:
                t -= 1
            q[t] = j
            t += 1
            j += 1
        while q[h] < i:
            h += 1
        g[i] = need[q[h]]
    out = np.empty(n, np.float32)
    cur = 1.0
    for i in range(n):
        cur = g[i] if g[i] < cur else cur + (g[i] - cur) * rel
        out[i] = cur
    res = out.copy()
    step = 1.0 / look
    for i in range(n - 2, -1, -1):
        if res[i] > res[i + 1] + step:
            res[i] = res[i + 1] + step
    return res


def brickwall(x, ceiling=0.891, look_ms=3.0, release_ms=80.0):
    peak = np.abs(x).max(0).astype(np.float32)
    look = max(1, int(look_ms / 1000.0 * SR))
    rel = 1.0 - np.exp(-1.0 / (release_ms / 1000.0 * SR))
    g = _gain_curve(peak, np.float32(ceiling), look, rel)
    return np.clip(x * g[None, :], -ceiling, ceiling)


def bounce(proj, wav_path, progress=lambda f, m="": None, target_lufs=-12.0, block=16384):
    """Offline render to 24-bit WAV with optional 2-pass LUFS loudness normalization."""
    import pyloudnorm as pyln
    reqs = P.render_requests(proj)
    warp.render_many_blocking(reqs, lambda f, m="": progress(0.40 * f, m))
    m = Mixer()
    missing = m.load(proj, allow_preview=False)
    if missing:
        raise RuntimeError(f"{len(missing)} stem renders missing")
    total = m.end_sample + int(0.08 * SR)
    if total <= int(0.1 * SR):
        raise ValueError("Arrangement has no audible clips")

    gain_db = 0.0
    if target_lufs is not None:
        pre = np.zeros((2, total), np.float32)
        m.reset()
        for p in range(0, total, block):
            k = min(block, total - p)
            pre[:, p:p + k] = m.render(p, k, master=False)
            progress(0.40 + 0.25 * (p + k) / total, "measuring loudness")
        lufs = pyln.Meter(SR).integrated_loudness(pre.T.astype(np.float64))
        if np.isfinite(lufs):
            gain_db = float(np.clip(target_lufs - lufs, -24.0, 24.0))
        del pre

    m2 = Mixer()
    pj = dict(proj, master=dict(proj.get("master") or {}, gain_db=float((proj.get("master") or {}).get("gain_db", 0.0)) + gain_db))
    m2.load(pj, allow_preview=False)
    out = np.zeros((2, total), np.float32)
    for p in range(0, total, block):
        k = min(block, total - p)
        out[:, p:p + k] = m2.render(p, k, master=True)
        progress(0.65 + 0.30 * (p + k) / total, "rendering master")

    if target_lufs is not None:
        lufs = pyln.Meter(SR).integrated_loudness(out.T.astype(np.float64))
        if np.isfinite(lufs):
            trim = float(np.clip(target_lufs - lufs, -6.0, 6.0))
            out *= 10.0 ** (trim / 20.0)
            gain_db += trim

    out = brickwall(out, 10.0 ** (-1.0 / 20.0))
    final_lufs = float(pyln.Meter(SR).integrated_loudness(out.T.astype(np.float64)))
    peak_lin = float(np.max(np.abs(out))) if out.size else 1e-6
    peak_db = float(20.0 * np.log10(max(1e-6, peak_lin)))
    audio_io.save_wav(wav_path, out, SR, subtype="PCM_24")
    progress(1.0, "done")
    return dict(
        path=str(wav_path),
        seconds=round(total / SR, 2),
        duration_s=round(total / SR, 2),
        gain_db=round(gain_db, 2),
        lufs=round(final_lufs, 2) if np.isfinite(final_lufs) else -99.0,
        peak_db=round(peak_db, 2),
    )
