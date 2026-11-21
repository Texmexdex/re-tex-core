"""Audio I/O utilities (soundfile + soxr + ffmpeg fallback, atomic numpy cache writes)."""
import os
import shutil
import subprocess
import time
import numpy as np
import soundfile as sf
import soxr

from .config import SR


def load(path, sr=SR, mono=False):
    """Load audio file as contiguous float32 shaped (2, n) (or (1, n) when mono=True) at `sr`."""
    path = str(path)
    try:
        y, s = sf.read(path, dtype="float32", always_2d=True)
        y = y.T
    except Exception:
        y, s = _ffmpeg_decode(path, sr)
    if y.shape[0] == 1 and not mono:
        y = np.repeat(y, 2, axis=0)
    elif y.shape[0] > 2:
        y = y[:2]
    if s != sr:
        y = soxr.resample(y.T, s, sr, quality="VHQ").T.astype(np.float32)
    if mono:
        y = y.mean(0, keepdims=True)
    return np.ascontiguousarray(y, dtype=np.float32)


def _ffmpeg_decode(path, sr):
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH — cannot decode compressed audio")
    cmd = [exe, "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    y = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()
    return y, sr


def save_wav(path, y, sr=SR, subtype="PCM_24"):
    sf.write(str(path), np.asarray(y, dtype=np.float32).T, sr, subtype=subtype)


def save_mp3(path_wav, path_mp3, bitrate="320k"):
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH — cannot encode MP3")
    subprocess.run([exe, "-y", "-v", "error", "-i", str(path_wav), "-b:a", bitrate, str(path_mp3)], check=True)


def save_npy_atomic(out_path, arr):
    out_path = str(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path[:-4] + f".{os.getpid()}.{threading_id()}.tmp.npy"
    np.save(tmp, arr)
    for attempt in range(5):
        try:
            os.replace(tmp, out_path)
            return out_path
        except PermissionError:
            if os.path.exists(out_path):
                break
            time.sleep(0.08 * (attempt + 1))
    try:
        os.remove(tmp)
    except OSError:
        pass
    if not os.path.exists(out_path):
        raise PermissionError(f"couldn't write {out_path}")
    return out_path


def threading_id():
    import threading
    return threading.get_ident()


def peaks_i8(y, sr=SR, per_sec=100):
    """Min/max waveform peaks as int8 pairs for fast canvas rendering."""
    m = y.mean(0) if y.ndim == 2 else y
    hop = max(1, int(sr // per_sec))
    nb = int(np.ceil(len(m) / hop))
    pad = np.zeros(nb * hop, np.float32)
    pad[:len(m)] = m
    f = pad.reshape(nb, hop)
    out = np.empty(nb * 2, np.int8)
    out[0::2] = np.clip(f.min(1) * 127, -127, 127).astype(np.int8)
    out[1::2] = np.clip(f.max(1) * 127, -127, 127).astype(np.int8)
    return out
