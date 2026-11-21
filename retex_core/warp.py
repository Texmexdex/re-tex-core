"""Tempo + per-stem/clip pitch warp cache for Re-Tex Core.

Every warped stem render is keyed by:
    (sid, stem, q_rev_or_raw, grid_sig, bpm, mult, semis)
and stored as float32 .npy + small .json metadata in F:\\retex_core\\data\\cache\\.

Runs background warps on a single low-priority worker thread so browser playback and UI
controls remain 100% instant and never freeze, while publishing live progress updates.
"""
import ctypes
import hashlib
import io
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import soundfile as sf

from . import audio_io, grid as G, library, quantize as Q
from .config import CACHE, SR

_open_lock = threading.Lock()
_open_bufs = {}     # key -> (memmap (2, n), t0_s)
MAX_OPEN = 48

_pool = ThreadPoolExecutor(max_workers=1)
_state_lock = threading.Lock()
_inflight = {}      # key -> {"future": Future, "req": req, "title": str, "state": "queued"|"running", "started": float|None}
_batch = {"done": 0, "total": 0}


def _lower_thread_priority():
    """Keep background warp CPU work below normal priority on Windows so playback & UI stay instant."""
    if sys.platform == "win32":
        try:
            # THREAD_PRIORITY_BELOW_NORMAL = -1
            handle = ctypes.windll.kernel32.GetCurrentThread()
            ctypes.windll.kernel32.SetThreadPriority(handle, -1)
        except Exception:
            pass


def req_key(sid, stem, q_rev, g_sig, bpm, mult, semis):
    raw = f"{sid}|{stem}|{q_rev or 'raw'}|{g_sig}|{bpm:.4f}|{mult:.4f}|{semis:.3f}"
    h = hashlib.sha1(raw.encode()).hexdigest()[:14]
    safe = "".join(c if c.isalnum() or c in "_-" else "_" for c in sid)[:28]
    return f"{safe}_{stem}_{h}"


def cache_paths(key):
    return CACHE / f"{key}.npy", CACHE / f"{key}.json"


def is_cached(sid, stem, q_rev, g_sig, bpm, mult, semis):
    npy, meta = cache_paths(req_key(sid, stem, q_rev, g_sig, bpm, mult, semis))
    return npy.exists() and meta.exists()


def read_meta(key):
    _, meta = cache_paths(key)
    if not meta.exists():
        return None
    try:
        return json.loads(meta.read_text(encoding="utf-8"))
    except Exception:
        return None


def open_render(sid, stem, q_rev, g_sig, bpm, mult, semis):
    """Return (memmap (2, n) float32, t0_s) if cached, else None."""
    key = req_key(sid, stem, q_rev, g_sig, bpm, mult, semis)
    with _open_lock:
        if key in _open_bufs:
            return _open_bufs[key]
    npy, meta = cache_paths(key)
    if not (npy.exists() and meta.exists()):
        return None
    try:
        m = json.loads(meta.read_text(encoding="utf-8"))
        arr = np.load(str(npy), mmap_mode="r")
        res = (arr, float(m["t0"]))
    except Exception:
        return None
    with _open_lock:
        if len(_open_bufs) >= MAX_OPEN:
            _open_bufs.pop(next(iter(_open_bufs)))
        _open_bufs[key] = res
    return res


def warp_wav_bytes(key):
    """Encode cached warped .npy stem to compact 16-bit stereo WAV bytes for fast browser Web Audio loading."""
    npy, meta = cache_paths(key)
    if not (npy.exists() and meta.exists()):
        return None, None
    m = json.loads(meta.read_text(encoding="utf-8"))
    arr = np.load(str(npy), mmap_mode="r")
    buf = io.BytesIO()
    sf.write(buf, np.clip(arr.T, -1.0, 1.0), SR, format="WAV", subtype="PCM_16")
    return buf.getvalue(), float(m.get("t0", 0.0))


def render_one(sid, stem, q_rev, g_sig, bpm, mult, semis):
    """Synchronously render (or return cached) warped stem for exact tempo/mult/semis."""
    key = req_key(sid, stem, q_rev, g_sig, bpm, mult, semis)
    npy, meta = cache_paths(key)
    if npy.exists() and meta.exists():
        return open_render(sid, stem, q_rev, g_sig, bpm, mult, semis)

    g = G.get_or_build(sid)
    if q_rev and g.get("quantized") and g["quantized"].get("rev") == q_rev:
        q = g["quantized"]
        y = Q.load_quantized_stem(sid, q_rev, stem)
        src_beats = float(q["t0"]) + np.arange(int(q["n_beats"]), dtype=np.float64) * float(q["period"])
        Tb_out = (60.0 / float(bpm)) * float(mult)
        scale_t = Tb_out / float(q["period"])
        t0_out = float(q["t0"]) * scale_t
        dst_beats = t0_out + np.arange(len(src_beats), dtype=np.float64) * Tb_out
        t0_ref = -t0_out
    else:
        y = library.load_raw_stem(sid, stem, mono=False)
        beats = np.asarray(g["beats"], np.float64)
        p_song = 60.0 / float(g["bpm"])
        Tb_out = (60.0 / float(bpm)) * float(mult)
        scale_t = Tb_out / p_song
        t_start = float(beats[0])
        t_end = max(t_start + p_song, y.shape[1] / SR)
        src_beats = np.array([t_start, t_end], np.float64)
        dst_beats = np.array([t_start * scale_t, t_end * scale_t], np.float64)
        t0_ref = -t_start * scale_t

    out, method = Q.stretch_beats_r3(y, src_beats, dst_beats, semis=float(semis), stem=stem)
    audio_io.save_npy_atomic(npy, out.astype(np.float32))
    meta.write_text(json.dumps({"t0": float(t0_ref), "method": method, "bpm": bpm, "mult": mult, "semis": semis}), encoding="utf-8")
    return open_render(sid, stem, q_rev, g_sig, bpm, mult, semis)


def get_status():
    """Return live warp queue progress snapshot for the UI Progress Tracker."""
    with _state_lock:
        active = None
        queued = []
        for k, info in _inflight.items():
            req = info["req"]
            item = {
                "key": k,
                "sid": req[0],
                "title": info["title"],
                "stem": req[1],
                "bpm": req[4],
                "semis": req[6],
                "state": info["state"],
                "started": info["started"],
            }
            if info["state"] == "running":
                active = item
            else:
                queued.append(item)
        pending = (1 if active else 0) + len(queued)
        total = _batch["total"] if pending > 0 else 0
        done = _batch["done"] if pending > 0 else 0
        return {
            "pending": pending,
            "done": done,
            "total": max(total, done + pending),
            "active": active,
            "queued": queued[:12],
        }


def cancel_unneeded(keep_keys):
    """Cancel any queued (not yet started) background warps that aren't in `keep_keys`."""
    keep = set(keep_keys)
    cancelled = 0
    with _state_lock:
        for k in list(_inflight.keys()):
            if k not in keep:
                info = _inflight[k]
                if info["state"] == "queued" and info["future"].cancel():
                    _inflight.pop(k, None)
                    _batch["total"] = max(0, _batch["total"] - 1)
                    cancelled += 1
        if not _inflight:
            _batch["done"] = 0
            _batch["total"] = 0
    return cancelled


def submit_missing(reqs, on_done=None, on_progress=None):
    """Queue missing warp requests asynchronously on the low-priority worker with progress callbacks."""
    started = 0
    req_keys = [req_key(*r) for r in reqs]
    cancel_unneeded(req_keys)

    for req, key in zip(reqs, req_keys):
        if is_cached(*req):
            continue
        info_raw = library.read_raw(req[0]) or {}
        title = info_raw.get("title") or req[0]
        with _state_lock:
            if key in _inflight and not _inflight[key]["future"].done():
                continue
            if not _inflight:
                _batch["done"] = 0
                _batch["total"] = 0
            _batch["total"] += 1
            entry = {"future": None, "req": req, "title": title, "state": "queued", "started": None}
            fut = _pool.submit(_run_req, req, key, on_done, on_progress)
            entry["future"] = fut
            _inflight[key] = entry
            started += 1

    if started and on_progress:
        try:
            on_progress(get_status())
        except Exception:
            pass
    return started


def _run_req(req, key, on_done, on_progress):
    _lower_thread_priority()
    with _state_lock:
        if key not in _inflight:
            return
        _inflight[key]["state"] = "running"
        _inflight[key]["started"] = time.time()
    if on_progress:
        try:
            on_progress(get_status())
        except Exception:
            pass

    t0_out = 0.0
    ok = False
    try:
        res = render_one(*req)
        if res is not None:
            t0_out = float(res[1])
            ok = True
    finally:
        with _state_lock:
            _inflight.pop(key, None)
            _batch["done"] += 1
            if not _inflight:
                _batch["done"] = 0
                _batch["total"] = 0
        st = get_status()
        if on_done and ok:
            try:
                on_done(req, key, t0_out, st)
            except Exception:
                pass
        elif on_progress:
            try:
                on_progress(st)
            except Exception:
                pass


def render_many_blocking(reqs, progress=lambda f, m="": None):
    """Render all missing requests synchronously (used for WAV/MP3 export)."""
    todo = [r for r in reqs if not is_cached(*r)]
    if not todo:
        progress(1.0, "cached")
        return
    for k, r in enumerate(todo):
        progress(k / len(todo), f"warping {r[1]} ({k + 1}/{len(todo)})")
        render_one(*r)
    progress(1.0, "warped")
