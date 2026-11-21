"""Low-latency live audio playback with sample-locked metronome click and song audition voice."""
import math
import threading
import time
import numpy as np
import sounddevice as sd

from .config import SR, read_settings, write_settings
from .jobs import bus
from .mixer import Mixer


def _click(freq, level, dur=0.045):
    n = int(dur * SR)
    i = np.arange(n)
    rng = np.random.default_rng(7)
    snap = (rng.uniform(-1, 1, n) * np.exp(-i / (SR * 0.0015))).astype(np.float32) * 0.55
    tone = (np.sin(2.0 * np.pi * freq * i / SR) * np.exp(-i / (SR * 0.011))).astype(np.float32)
    return (snap + tone) * level


CLICKS = (_click(2000, 0.55), _click(2800, 0.85), _click(3600, 1.0))  # beat, bar 1, 4-bar 1


class Player:
    def __init__(self):
        self.mixer = Mixer()
        self.playing = False
        self.pos = 0
        self.loop = None
        self.volume = 1.0
        self.click = False
        self.click_gain = 0.5
        self.aud = None
        self._spb = 60.0 / 128.0 * SR
        self._bpb = 4
        self.stream = None
        self.lock = threading.RLock()
        self.load_lock = threading.Lock()
        self.dev_lock = threading.RLock()
        self.latency = 0.0
        self.error = None
        self.device_name = read_settings().get("audio_output") or None
        self.device_index = self._resolve(self.device_name)
        self._ticker_started = False

    def _ensure_ticker(self):
        if self._ticker_started:
            return
        self._ticker_started = True

        def _loop():
            was_active = False
            while True:
                time.sleep(0.18)
                with self.lock:
                    active = bool(self.playing or self.aud is not None)
                if active or was_active:
                    bus.publish("transport", transport=self.state())
                was_active = active

        t = threading.Thread(target=_loop, daemon=True)
        t.start()

    @staticmethod
    def _outputs():
        apis = sd.query_hostapis()
        return [(i, apis[d["hostapi"]]["name"], d["name"]) for i, d in enumerate(sd.query_devices())
                if d["max_output_channels"] >= 2]

    @classmethod
    def output_names(cls):
        outs = cls._outputs()
        names = [n for _, api, n in outs if api == "Windows DirectSound" and n != "Primary Sound Driver"]
        if not names:
            api0 = sd.query_hostapis(sd.default.hostapi)["name"]
            names = [n for _, api, n in outs if api == api0]
        return list(dict.fromkeys(names))

    @classmethod
    def _resolve(cls, name):
        if not name:
            return None
        try:
            outs = cls._outputs()
            mme = [(i, n) for i, api, n in outs if api == "MME" and n != "Microsoft Sound Mapper - Output"]
            for i, n in mme:
                if n == name:
                    return i
            for i, n in mme:
                if name.startswith(n):
                    return i
            for i, _, n in outs:
                if n == name:
                    return i
        except Exception:
            pass
        return None

    def set_output(self, name):
        name = name or None
        idx = self._resolve(name)
        with self.dev_lock:
            self.device_name = name
            self.device_index = idx
            write_settings({"audio_output": name or ""})
            was_open = self.stream is not None
            self._close()
            if was_open:
                self._ensure_stream()

    def _ensure_stream(self):
        with self.dev_lock:
            if self.stream is not None:
                return
            try:
                self.stream = sd.OutputStream(samplerate=SR, channels=2, dtype="float32",
                                              blocksize=1024, latency="low", callback=self._cb,
                                              device=self.device_index)
                self.stream.start()
                self.latency = float(self.stream.latency or 0.0)
                self.error = None
            except Exception as e:
                self.stream = None
                self.error = str(e)
                raise

    def _close(self):
        s, self.stream = self.stream, None
        if s is not None:
            try:
                s.abort()
                s.close()
            except Exception:
                pass

    def set_project(self, proj):
        with self.load_lock:
            bpm = float(proj.get("bpm") or 128.0)
            bpb = int(proj.get("bpb") or 4)
            spb = (60.0 / bpm) * SR
            lp = proj.get("loop") or {}
            loop = (int(round(float(lp.get("start", 0)) * spb)), int(round(float(lp.get("end", 16)) * spb))) if lp.get("on") and float(lp.get("end", 0)) > float(lp.get("start", 0)) else None
            missing = self.mixer.load(proj, allow_preview=True, swap_lock=self.lock)
            with self.lock:
                old_spb = self._spb
                if old_spb > 0 and abs(old_spb - spb) > 1e-3:
                    self.pos = int(round(self.pos * (spb / old_spb)))
                self._spb = spb
                self._bpb = bpb
                self.loop = loop
            return missing

    def play(self, beat=None):
        self._ensure_stream()
        self._ensure_ticker()
        with self.lock:
            if beat is not None:
                self.pos = max(0, int(round(float(beat) * self._spb)))
            self.playing = True
            self.mixer.reset()
        bus.publish("transport", transport=self.state())

    def stop(self):
        with self.lock:
            self.playing = False
        bus.publish("transport", transport=self.state())

    def seek(self, beat):
        with self.lock:
            self.pos = max(0, int(round(float(beat) * self._spb)))
            self.mixer.reset()
        bus.publish("transport", transport=self.state())

    def set_volume(self, v):
        with self.lock:
            self.volume = float(np.clip(v, 0.0, 2.0))

    def set_click(self, on=None, gain=None):
        with self.lock:
            if on is not None:
                self.click = bool(on)
            if gain is not None:
                self.click_gain = float(np.clip(gain, 0.0, 1.5))
        bus.publish("transport", transport=self.state())

    def audition(self, buf, start_s=0.0, gain=0.85, click_beats=None, downbeat_offset=0, bpb=4):
        """Play a standalone audio buffer (for library preview or Beat Grid inspection with optional click)."""
        self._ensure_stream()
        self._ensure_ticker()
        arr = np.asarray(buf, np.float32)
        if arr.ndim == 1:
            arr = np.stack([arr, arr], axis=0)
        elif arr.shape[0] == 1:
            arr = np.repeat(arr, 2, axis=0)
        if click_beats is not None:
            arr = arr.copy()
            bpb = max(1, int(bpb))
            doff = int(downbeat_offset) % bpb
            for idx_b, bt in enumerate(click_beats):
                s = int(round(float(bt) * SR))
                is_bar = ((idx_b - doff) % bpb == 0) and (idx_b >= doff)
                ck = CLICKS[1] if is_bar else CLICKS[0]
                if 0 <= s < arr.shape[1]:
                    m = min(len(ck), arr.shape[1] - s)
                    arr[:, s:s + m] += ck[:m] * 0.45
        pos = max(0, int(round(float(start_s) * SR)))
        with self.lock:
            self.aud = dict(buf=arr, pos=pos, end=arr.shape[1], gain=float(gain))

    def audition_stop(self):
        with self.lock:
            self.aud = None

    def state(self):
        with self.lock:
            aud_s = round(self.aud["pos"] / SR, 3) if self.aud is not None else None
            return dict(
                playing=self.playing,
                beat=round(self.pos / max(1.0, self._spb), 4),
                aud_s=aud_s,
                t=time.time(),
                volume=self.volume,
                click=self.click,
                click_gain=self.click_gain,
                latency=self.latency,
                error=self.error,
                device=self.device_name or "",
            )

    def _add_clicks(self, out, p0, n):
        spb = self._spb
        bpb = max(1, self._bpb)
        k0 = max(0, int(math.floor(p0 / spb)) - 1)
        k1 = int(math.ceil((p0 + n) / spb)) + 1
        g = self.click_gain
        for k in range(k0, k1):
            s = int(round(k * spb))
            ck = CLICKS[2] if k % (4 * bpb) == 0 else (CLICKS[1] if k % bpb == 0 else CLICKS[0])
            a = max(0, p0 - s)
            b = min(len(ck), p0 + n - s)
            if b > a:
                oa = s + a - p0
                out[:, oa:oa + (b - a)] += ck[a:b] * g

    def _cb(self, outdata, frames, time_info, status):
        buf = np.zeros((2, frames), np.float32)
        with self.lock:
            if self.playing:
                rem = frames
                off = 0
                while rem > 0:
                    p = self.pos
                    lp = self.loop
                    if lp and p >= lp[1]:
                        p = lp[0]
                        self.pos = p
                        self.mixer.reset()
                    chunk = min(rem, lp[1] - p) if (lp and p < lp[1]) else rem
                    if self.mixer.end_sample > 0 and not lp and p >= self.mixer.end_sample + SR:
                        self.playing = False
                        break
                    seg = self.mixer.render(p, chunk, master=True)
                    if self.click:
                        self._add_clicks(seg, p, chunk)
                    buf[:, off:off + chunk] += seg
                    self.pos += chunk
                    off += chunk
                    rem -= chunk
            if self.aud is not None:
                a = self.aud
                k = min(frames, a["end"] - a["pos"])
                if k > 0:
                    buf[:, :k] += a["buf"][:, a["pos"]:a["pos"] + k] * a["gain"]
                    a["pos"] += k
                if a["pos"] >= a["end"]:
                    self.aud = None
            vol = self.volume
        outdata[:] = np.clip(buf.T * vol, -1.0, 1.0)


player = Player()
