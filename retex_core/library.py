"""Read-only bridge to the user's shared song/stem library at F:\\mashup_lab\\data\\songs.

Never mutates or deletes any file in F:\\mashup_lab\\data\\songs (existing songs stay untouched).
New audio file imports delegate to Re-Tex's own lossless blend separation pipeline so imported
songs are stored once in the shared library and work in both Re-Tex and Re-Tex Core.
"""
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np

from . import audio_io
from .config import (
    CORE_FOLDERS, GRIDS, MODE, PEAKS, QUANTIZED, RETEX_ROOT, SEP_ENGINE,
    SHARED_FOLDERS, SHARED_META, SHARED_SONGS, SR, STEMS,
)

_info_cache = {}
_info_lock = threading.Lock()
_meta_cache = {"mtime": 0.0, "songs": {}}
_stem_cache = {}          # (sid, stem, quantized_sig) -> (2, n) float32
_stem_lock = threading.Lock()
MAX_STEM_CACHE = 24


def song_dir(sid):
    return SHARED_SONGS / str(sid)


def _read_meta():
    if not SHARED_META.exists():
        return {}
    mt = SHARED_META.stat().st_mtime
    if mt != _meta_cache["mtime"]:
        try:
            d = json.loads(SHARED_META.read_text(encoding="utf-8"))
            _meta_cache["songs"] = d.get("songs") or {}
            _meta_cache["mtime"] = mt
        except Exception:
            pass
    return _meta_cache["songs"]


def read_raw(sid):
    """Read raw song.json from shared library (cached by mtime)."""
    p = song_dir(sid) / "song.json"
    if not p.exists():
        return None
    mt = p.stat().st_mtime
    with _info_lock:
        hit = _info_cache.get(sid)
        if hit and hit[0] == mt:
            return hit[1]
    try:
        info = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    with _info_lock:
        _info_cache[sid] = (mt, info)
    return info


def stem_path(sid, stem):
    d = song_dir(sid) / "stems"
    for ext in (".flac", ".wav"):
        p = d / f"{stem}{ext}"
        if p.exists():
            return p
    return None


def has_stems(sid):
    return all(stem_path(sid, s) is not None for s in STEMS)


def load_raw_stem(sid, stem, mono=False):
    """Load an original unquantized stem from the shared library, restoring stem_scale."""
    p = stem_path(sid, stem)
    if p is None:
        raise FileNotFoundError(f"Stem {stem} missing for song {sid}")
    info = read_raw(sid) or {}
    scale = float(info.get("stem_scale", 1.0) or 1.0)
    key = (sid, stem, "raw_mono" if mono else "raw")
    with _stem_lock:
        if key in _stem_cache:
            return _stem_cache[key]
    y = audio_io.load(p, SR, mono=mono)
    if abs(scale - 1.0) > 1e-6 and scale > 0:
        y = y / scale
    with _stem_lock:
        if len(_stem_cache) >= MAX_STEM_CACHE:
            _stem_cache.pop(next(iter(_stem_cache)))
        _stem_cache[key] = y
    return y


def list_songs():
    """Return lightweight metadata list of all ready songs in the shared library, enriched with Core grid status."""
    meta = _read_meta()
    out = []
    if not SHARED_SONGS.exists():
        return out
    for d in SHARED_SONGS.iterdir():
        if not d.is_dir():
            continue
        p = d / "song.json"
        if not p.exists():
            continue
        info = read_raw(d.name)
        if not info or info.get("status") != "ready":
            continue
        sid = info.get("id") or d.name
        m = meta.get(sid) or {}
        artist = (m.get("user") or {}).get("artist") or (m.get("tags") or {}).get("artist") or (m.get("file") or {}).get("artist") or ""
        album = (m.get("user") or {}).get("album") or (m.get("tags") or {}).get("album") or (m.get("file") or {}).get("album") or ""
        genre = (m.get("user") or {}).get("genre") or (m.get("heard") or {}).get("subgenre") or (m.get("heard") or {}).get("genre") or (m.get("tags") or {}).get("genre") or ""
        year = str((m.get("user") or {}).get("year") or (m.get("tags") or {}).get("year") or "")
        key_info = info.get("key") or {}
        # Check if Re-Tex Core has already audited / quantized this song
        gp = GRIDS / f"{sid}.json"
        grid_meta = None
        if gp.exists():
            try:
                g = json.loads(gp.read_text(encoding="utf-8"))
                grid_meta = {
                    "bpm": g.get("bpm"),
                    "bpb": g.get("bpb", 4),
                    "audit": g.get("audit"),
                    "quantized": bool(g.get("quantized")),
                    "sig": g.get("sig"),
                }
            except Exception:
                pass
        out.append({
            "id": sid,
            "title": info.get("title") or sid,
            "artist": artist,
            "album": album,
            "genre": genre,
            "year": year,
            "bpm": round(float(grid_meta["bpm"] if grid_meta and grid_meta.get("bpm") else (info.get("bpm") or 120.0)), 2),
            "raw_bpm": round(float(info.get("bpm") or 120.0), 2),
            "bpb": int(grid_meta["bpb"] if grid_meta else (info.get("bpb") or 4)),
            "key": key_info.get("name") or "",
            "camelot": key_info.get("camelot") or "",
            "tonic": key_info.get("tonic"),
            "mode": key_info.get("mode"),
            "duration": round(float(info.get("duration") or 0.0), 2),
            "separation": info.get("separation") or "legacy",
            "created": float(info.get("created") or p.stat().st_mtime),
            "loudness": info.get("loudness") or {},
            "has_vocals": bool(info.get("has_vocals", True)),
            "core_grid": grid_meta,
        })
    out.sort(key=lambda x: x["created"], reverse=True)
    return out


def get_peaks(sid, stem, quantized_rev=None):
    """Return raw int8 peak bytes (100 peaks/sec min/max pairs) for a raw or quantized stem."""
    if quantized_rev:
        qp = PEAKS / f"{sid}_{quantized_rev}_{stem}.i8"
        if qp.exists():
            return qp.read_bytes()
        sf_path = QUANTIZED / sid / quantized_rev / f"{stem}.flac"
        if sf_path.exists():
            y = audio_io.load(sf_path, SR, mono=True)
            pk = audio_io.peaks_i8(y[0], SR, 100)
            qp.write_bytes(pk.tobytes())
            return pk.tobytes()
    # Try shared library precomputed peaks first (instant, zero CPU!)
    shared_pk = song_dir(sid) / "peaks" / f"{stem}.i8"
    if shared_pk.exists():
        return shared_pk.read_bytes()
    # Fallback: compute and cache in Core's peaks dir
    cp = PEAKS / f"{sid}_raw_{stem}.i8"
    if cp.exists():
        return cp.read_bytes()
    y = load_raw_stem(sid, stem, mono=True)
    pk = audio_io.peaks_i8(y[0], SR, 100)
    cp.write_bytes(pk.tobytes())
    return pk.tobytes()


def import_audio_file(src_path, title=None, progress=lambda f, m="": None):
    """Import and separate a new audio file.

    - In Standalone Mode (or RETEX_CORE_SEP=v2 / fast): uses Re-Tex Core's self-contained
      2-stage Mel-Band Roformer + vocal-free split pipeline (zero external Re-Tex dependency).
    - In Shared Mode (desktop with F:\\mashup_lab): delegates to Re-Tex's library.import_file
      so the song is stored once in the shared library and works in both apps.
    In both modes, immediately runs Re-Tex Core's Viterbi transient-verified beat grid audit.
    """
    from . import grid as core_grid

    use_standalone_sep = (MODE == "standalone") or (SEP_ENGINE in ("v2", "fast")) or (RETEX_ROOT is None)
    if use_standalone_sep:
        from . import separate as core_sep
        preset = "fast" if SEP_ENGINE == "fast" else "studio"
        sid = core_sep.import_standalone(
            Path(src_path), title=title, preset=preset,
            progress=lambda f, m="": progress(0.02 + 0.86 * f, m),
        )
    else:
        if str(RETEX_ROOT) not in sys.path:
            sys.path.insert(0, str(RETEX_ROOT))
        from mashlab import library as retex_lib
        progress(0.02, "running shared Re-Tex lossless blend separation & analysis...")
        info = retex_lib.import_file(
            Path(src_path), title=title,
            progress=lambda f, m="": progress(0.02 + 0.85 * f, m),
        )
        sid = info["id"]

    with _info_lock:
        _info_cache.pop(sid, None)
    progress(0.90, "verifying beat grid against real drum transients...")
    core_grid.get_or_build(sid, force=True)
    progress(1.0, "ready")
    return sid


# ------------------------------------------------------------------ library folders (seeded read-only from Re-Tex full)

def _read_folder_file(path):
    if path.exists():
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(d, dict) and isinstance(d.get("folders"), list) and isinstance(d.get("assign"), dict):
                return {"folders": d["folders"], "assign": d["assign"]}
        except Exception:
            pass
    return None


def get_folders():
    """Return Re-Tex Core's folder tree. On first run, seeds cleanly from F:\\mashup_lab\\data\\folders.json (read-only)."""
    cur = _read_folder_file(CORE_FOLDERS)
    if cur is not None:
        return cur
    seeded = _read_folder_file(SHARED_FOLDERS)
    if seeded is not None:
        save_folders(seeded)
        return seeded
    return {"folders": [], "assign": {}}


def save_folders(data):
    """Save Re-Tex Core's folder tree to F:\\retex_core\\data\\folders.json (never mutates shared Re-Tex data)."""
    clean = {
        "folders": [
            {"id": str(f.get("id", "")), "name": str(f.get("name", "Folder")), "collapsed": bool(f.get("collapsed", False))}
            for f in (data.get("folders") or []) if f.get("id")
        ],
        "assign": {str(k): str(v) for k, v in (data.get("assign") or {}).items() if v},
    }
    tmp = CORE_FOLDERS.with_suffix(".tmp")
    tmp.write_text(json.dumps(clean, indent=1), encoding="utf-8")
    tmp.replace(CORE_FOLDERS)
    return clean


def sync_folders_from_retex():
    """Re-import folders & song assignments from F:\\mashup_lab\\data\\folders.json (read-only)."""
    seeded = _read_folder_file(SHARED_FOLDERS)
    if seeded is None:
        return get_folders()
    return save_folders(seeded)
