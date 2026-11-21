# Re-Tex Core

A lean, responsive multi-stem mashup DAW focused on the essentials that matter most: **rock-solid beat alignment, 1-click quantization, per-stem & per-clip key shifting, fast clip editing, and studio `-12 LUFS` export**.

## Key Features
- **Transient-Verified Viterbi Beat Engine (`retex_core/grid.py`)**
  - Uses zero-phase full-band kick (`30–160 Hz`) + snare (`250–3500 Hz`) onsets (`filtfilt`) with a continuity-constrained **Viterbi dynamic-programming phase tracker** and syncopation-aware auditing.
  - Catches detector drift, glitch sub-beats, and off-beat grids loudly — green beat markers and sync ribbons on the timeline *always* reflect verified real drum transients.
- **1-Click Rubber Band R3 + Click-Pilot Quantization (`retex_core/quantize.py`)**
  - Locks drifting songs onto a dead-steady beat grid with sub-millisecond click-pilot correction, then re-audits the rendered quantized drums to prove alignment.
- **Zero-Lag Browser Web Audio Playback (`web/js/audio.js`)**
  - Play, Stop, Seek, Mute, Solo, Gain, Pan, HPF, LPF, Metronome Click, and Grid Modal Audition run natively in Chrome's `AudioContext` (`< 1 ms` Stop even during heavy background warping).
  - Background Rubber Band R3 warps run at below-normal priority and hot-swap seamlessly into live playback when finished; unused `AudioBuffer`s auto-evict from browser RAM when clips/lanes/projects change.
- **Per-Song, Per-Stem & Per-Clip Pitch Control**
  - Transpose a whole song (pitched stems only, drums untouched), shift individual stem lanes (`KEY - 0st +`), or override any clip (`Alt + Scroll` or Clip Inspector).
- **Essential DAW Editing & Library Organization**
  - Split (`S`), Trim edges, Fade handles, Copy/Paste (`Ctrl+C`/`Ctrl+V`), Duplicate After (`Ctrl+D`), Align Bar 1 (`A`), 150-step Undo/Redo, collapsible Folders + Group-By (`Folders / Artists / Genres / Key / Tempo / Flat`), Camelot+BPM `Match` filter, always-visible zoomed-out sync ribbons, and live Progress Tracker + Activity Drawer.
- **Dual Mode: Shared or Portable Standalone**
  - Automatically shares an existing Re-Tex library (`F:\mashup_lab\data\songs`) when present (read-only for existing songs), or runs **100% standalone** inside `./data/` on a laptop or fresh GitHub clone.
  - Includes a clean **2-Stage Standalone Stem Separator (`retex_core/separate.py`)** using **Mel-Band Roformer** (Stage 1 full-band vocals + exact complement instrumental) followed by **vocal-free instrumental splitting** (Stage 2 drums/bass + exact complement `other`) to avoid frequency loss, volume sinks, and vocals leaking into `other`.

---

## Quick Start (Standalone / Laptop)

### Prerequisites
- **Python 3.11 – 3.13**
- **`ffmpeg`** on `PATH` (for MP3 export & compressed audio decoding; on Windows: `winget install Gyan.FFmpeg`)

### Windows
1. Clone this repository.
2. Double-click **`install.bat`** (creates `.venv`, installs lightweight Core DAW packages, and optionally installs `audio-separator` + PyTorch CUDA/CPU for standalone `+ Import` stem separation).
3. Double-click **`Run Re-Tex Core.bat`** -> opens `http://127.0.0.1:8770`.

### macOS / Linux
```bash
chmod +x install.sh
./install.sh
.venv/bin/python -m retex_core
```

---

## Environment Flags (Optional)
| Variable | Default | Purpose |
|---|---|---|
| `RETEX_CORE_STANDALONE` | `0` (auto) | Set to `1` to force standalone `./data/songs` library even if `F:\mashup_lab` exists |
| `RETEX_CORE_SEP` | `auto` | `v2` = 2-stage Mel-Band Roformer + vocal-free split · `fast` = single-pass HTDemucs · `retex` = delegate to Re-Tex |
| `RETEX_CORE_PORT` | `8770` | Local HTTP port |
| `RETEX_CORE_DATA` | `./data` | Override data/projects/cache/exports folder |

---

## Keyboard Shortcuts
- `Space` — Play / Stop (`< 1 ms` Web Audio)
- `Home` — Jump to start
- `S` — Split clip(s) at playhead
- `Ctrl+D` — Duplicate After (preserves relative timing & lanes)
- `A` — Align Bar 1 to nearest project bar
- `M` — Mute / Unmute selected clip(s)
- `L` — Toggle Loop (`Shift + Drag` ruler to draw loop range)
- `K` — Toggle sample-locked Metronome Click
- `Ctrl+C` / `Ctrl+V` — Copy / Paste
- `Ctrl+Z` / `Ctrl+Y` — Undo / Redo (150 steps)
- `Ctrl+S` — Save project
- `Alt + Scroll` over clip — Fine clip pitch (`±1 st`) · `Ctrl + Scroll` — Zoom · `Shift + Scroll` — Pan
