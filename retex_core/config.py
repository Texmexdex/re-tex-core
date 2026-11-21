"""Configuration and filesystem layout for Re-Tex Core.

Supports two automatic modes:
  - Shared Mode (when F:\\mashup_lab\\data\\songs exists and RETEX_CORE_STANDALONE != 1):
    Reads your existing Re-Tex song/stem library (read-only for existing songs) with zero
    duplication, while keeping Core's projects/grids/quantized/cache/exports isolated in ./data/.
  - Standalone / Portable Mode (on a laptop or fresh GitHub clone, or RETEX_CORE_STANDALONE=1):
    100% self-contained inside ./data/ (own songs/, meta.json, folders.json, models/) using
    Re-Tex Core's built-in 2-stage Mel-Band Roformer stem separation & analysis pipeline.
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

# Isolated Re-Tex Core working data
CORE_DATA = Path(os.environ.get("RETEX_CORE_DATA", str(ROOT / "data")))
CORE_FOLDERS = CORE_DATA / "folders.json"
MODELS = Path(os.environ.get("RETEX_CORE_MODELS", str(CORE_DATA / "models")))

# Detect Shared Re-Tex library vs Standalone portable mode
_force_standalone = os.environ.get("RETEX_CORE_STANDALONE", "").strip().lower() in ("1", "true", "yes")
_default_retex = Path(os.environ.get("RETEX_ROOT", r"F:\mashup_lab"))
_shared_candidate = Path(os.environ.get("RETEX_SHARED_DATA", str(_default_retex / "data")))

if not _force_standalone and (_shared_candidate / "songs").exists():
    MODE = "shared"
    RETEX_ROOT = _default_retex
    SHARED_DATA = _shared_candidate
    SHARED_SONGS = SHARED_DATA / "songs"
    SHARED_META = SHARED_DATA / "meta.json"
    SHARED_FOLDERS = SHARED_DATA / "folders.json"
else:
    MODE = "standalone"
    RETEX_ROOT = None
    SHARED_DATA = CORE_DATA
    SHARED_SONGS = CORE_DATA / "songs"
    SHARED_META = CORE_DATA / "meta.json"
    SHARED_FOLDERS = CORE_FOLDERS

PROJECTS = CORE_DATA / "projects"
GRIDS = CORE_DATA / "grids"
QUANTIZED = CORE_DATA / "quantized"
CACHE = CORE_DATA / "cache"
PEAKS = CORE_DATA / "peaks"
EXPORTS = CORE_DATA / "exports"
SETTINGS_FILE = CORE_DATA / "settings.json"

for _d in (CORE_DATA, SHARED_SONGS, MODELS, PROJECTS, GRIDS, QUANTIZED, CACHE, PEAKS, EXPORTS):
    _d.mkdir(parents=True, exist_ok=True)

SR = 44100
STEMS = ("drums", "bass", "other", "vocals")
PITCHED = {"bass", "other", "vocals"}
PORT = int(os.environ.get("RETEX_CORE_PORT", "8770"))
SEP_ENGINE = os.environ.get("RETEX_CORE_SEP", "auto").strip().lower()  # auto | v2 | retex | fast


def read_settings():
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def write_settings(patch):
    cur = read_settings()
    cur.update(patch)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cur, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)
    return cur
