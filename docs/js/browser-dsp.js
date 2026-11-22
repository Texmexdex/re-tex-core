// Pure Client-Side Browser DSP, Private IndexedDB Storage & Zero-Install WebGPU/WASM AI Separation
// Runs 100% locally on the user's computer — zero audio ever leaves the device!

(function () {
  const ROOT = typeof window !== "undefined" ? window : globalThis;
  const DB_NAME = "retex_core_browser_local_v1";
  const DB_VER = 1;
  const SR = 44100;
  const ENV_FPS = 500;
  const ACTIVE_SHARE = 0.22;
  const OFFBEAT_WARN_MS = 22.0;
  const DRIFT_WARN_MS = 16.0;
  const STEMS = ["drums", "bass", "other", "vocals"];
  const MODEL_KEY = "htdemucs_embedded_v1";

  const N_DELTAS = 201; // 0.005 beat step (~2-3 ms resolution), matching grid.py
  const DELTAS = new Float64Array(N_DELTAS);
  for (let i = 0; i < N_DELTAS; i++) DELTAS[i] = -0.5 + i / (N_DELTAS - 1);

  let dbPromise = null;
  let demucsState = { processor: null, provider: null };

  // ------------------------------------------------------------------ IndexedDB Private SSD Storage

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
        if (!db.objectStoreNames.contains("models")) db.createObjectStore("models");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbPut(store, val, key = undefined) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      if (key !== undefined) os.put(val, key); else os.put(val);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  }

  async function dbGet(store, key) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
  }

  async function dbGetAll(store) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  async function dbDelete(store, key) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  }

  async function dbClearStore(store) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).clear();
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  }

  async function hasCachedModel() {
    try {
      const db = await openDB();
      return await new Promise((res) => {
        const tx = db.transaction("models", "readonly");
        const req = tx.objectStore("models").count(MODEL_KEY);
        req.onsuccess = () => res((req.result || 0) > 0);
        req.onerror = () => res(false);
      });
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ Audio Decode, Resample, WAV & Peaks

  async function decodeTo44kStereo(fileOrArrayBuffer) {
    const ab = fileOrArrayBuffer instanceof ArrayBuffer ? fileOrArrayBuffer : await fileOrArrayBuffer.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const tmp = new AC();
    let decoded;
    try {
      decoded = await tmp.decodeAudioData(ab.slice(0));
    } finally {
      try { await tmp.close(); } catch {}
    }
    const targetLen = Math.max(1, Math.ceil(decoded.duration * SR));
    if (decoded.sampleRate === SR && decoded.numberOfChannels >= 2) {
      return {
        left: new Float32Array(decoded.getChannelData(0)),
        right: new Float32Array(decoded.getChannelData(1)),
        duration: decoded.duration,
      };
    }
    const off = new OfflineAudioContext(2, targetLen, SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start(0);
    const res = await off.startRendering();
    return {
      left: new Float32Array(res.getChannelData(0)),
      right: new Float32Array(res.getChannelData(1)),
      duration: res.duration,
    };
  }

  function encodeStereoWav16(left, right, sr = SR) {
    const n = Math.min(left.length, right.length);
    const dataBytes = n * 4;
    const ab = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(ab);
    const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    wr(0, "RIFF");
    dv.setUint32(4, 36 + dataBytes, true);
    wr(8, "WAVE");
    wr(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true);
    wr(36, "data");
    dv.setUint32(40, dataBytes, true);
    let pos = 44;
    for (let i = 0; i < n; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      dv.setInt16(pos, l < 0 ? l * 32768 : l * 32767, true);
      dv.setInt16(pos + 2, r < 0 ? r * 32768 : r * 32767, true);
      pos += 4;
    }
    return new Blob([ab], { type: "audio/wav" });
  }

  function computePeaksI8(left, right, sr = SR, perSec = 100) {
    const n = Math.min(left.length, right.length);
    const hop = Math.max(1, Math.floor(sr / perSec));
    const nb = Math.ceil(n / hop);
    const out = new Int8Array(nb * 2);
    for (let b = 0; b < nb; b++) {
      const i0 = b * hop;
      const i1 = Math.min(n, i0 + hop);
      let lo = 0;
      let hi = 0;
      for (let i = i0; i < i1; i++) {
        const m = 0.5 * (left[i] + right[i]);
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
      out[b * 2] = Math.max(-127, Math.min(127, Math.round(lo * 127)));
      out[b * 2 + 1] = Math.max(-127, Math.min(127, Math.round(hi * 127)));
    }
    return out;
  }

  // ------------------------------------------------------------------ Numeric Helpers

  function medianOf(arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  function percentileOf(arr, pct) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((a, b) => a - b);
    const pos = Math.max(0, Math.min(s.length - 1, (pct / 100) * (s.length - 1)));
    const i0 = Math.floor(pos);
    const i1 = Math.min(s.length - 1, i0 + 1);
    return s[i0] + (pos - i0) * (s[i1] - s[i0]);
  }

  function medianDiff(arr) {
    if (arr.length < 2) return 0.5;
    const d = new Float64Array(arr.length - 1);
    for (let i = 1; i < arr.length; i++) d[i - 1] = arr[i] - arr[i - 1];
    d.sort();
    const m = d.length >> 1;
    return d.length % 2 ? d[m] : 0.5 * (d[m - 1] + d[m]);
  }

  function linearFit(xs, ys) {
    const n = xs.length;
    if (n < 2) return { slope: 0.5, intercept: ys[0] || 0 };
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = ys[i];
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) return { slope: 0.5, intercept: sy / n };
    const slope = (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    return { slope, intercept };
  }

  function gridSigJS(grid) {
    const b = grid.beats || [];
    let h = 2166136261 >>> 0;
    const mix = (str) => {
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
    };
    mix(`${b.length}:${grid.bpb || 4}:${grid.downbeat_offset || 0}:`);
    for (let i = 0; i < b.length; i++) mix(`${Math.round(b[i] * 1000)},`);
    return `b${b.length}_${h.toString(16).padStart(8, "0")}`;
  }

  // ------------------------------------------------------------------ Zero-Phase 500 Hz Full-Band Onsets (Exact port of grid.py)

  function biquadCoeffs(type, fc, sr, Q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * fc) / sr;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    if (type === "hpf") {
      return {
        b0: ((1 + cosw) * 0.5) / a0,
        b1: -(1 + cosw) / a0,
        b2: ((1 + cosw) * 0.5) / a0,
        a1: (-2 * cosw) / a0,
        a2: (1 - alpha) / a0,
      };
    }
    return {
      b0: ((1 - cosw) * 0.5) / a0,
      b1: (1 - cosw) / a0,
      b2: ((1 - cosw) * 0.5) / a0,
      a1: (-2 * cosw) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  function filtfiltBiquad(x, c) {
    const n = x.length;
    const tmp = new Float32Array(n);
    const { b0, b1, b2, a1, a2 } = c;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      tmp[i] = yi;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    }
    const out = new Float32Array(n);
    x1 = x2 = y1 = y2 = 0;
    for (let i = n - 1; i >= 0; i--) {
      const xi = tmp[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = yi;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    }
    return out;
  }

  function bandpassZeroPhase(x, sr, fLo, fHi) {
    // Cascaded 2nd-order Butterworth HPF then LPF, forward+reverse -> 0.0 ms group delay & rock-solid stability
    const hp = filtfiltBiquad(x, biquadCoeffs("hpf", fLo, sr, Math.SQRT1_2));
    return filtfiltBiquad(hp, biquadCoeffs("lpf", fHi, sr, Math.SQRT1_2));
  }

  function smoothBody6ms(body) {
    const n = body.length;
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = body[i > 1 ? i - 2 : 0];
      const b = body[i > 0 ? i - 1 : 0];
      const c = body[i];
      const d = body[i + 1 < n ? i + 1 : n - 1];
      const e = body[i + 2 < n ? i + 2 : n - 1];
      sm[i] = 0.1 * a + 0.2 * b + 0.4 * c + 0.2 * d + 0.1 * e;
    }
    return sm;
  }

  function onsetCurves500Hz(mono, sr = SR) {
    const hop = Math.max(1, Math.round(sr / ENV_FPS));
    const fps = sr / hop;
    const nFr = Math.floor(mono.length / hop);
    if (nFr < 16) {
      const z = new Float32Array(Math.max(16, nFr));
      return { body: z, bodySmooth: z, kick: z, snare: z, fps };
    }

    const kSig = bandpassZeroPhase(mono, sr, 30, 160);
    const sSig = bandpassZeroPhase(mono, sr, 250, 3500);
    const kOn = new Float32Array(nFr);
    const sOn = new Float32Array(nFr);
    let pkPrev = 0, psPrev = 0;
    for (let f = 0; f < nFr; f++) {
      let ks = 0, ss = 0;
      const base = f * hop;
      for (let i = 0; i < hop; i++) {
        const kv = kSig[base + i];
        const sv = sSig[base + i];
        ks += kv * kv;
        ss += sv * sv;
      }
      const kr = Math.log1p(25 * Math.sqrt(ks / hop));
      const srVal = Math.log1p(25 * Math.sqrt(ss / hop));
      kOn[f] = Math.max(0, kr - pkPrev);
      sOn[f] = Math.max(0, srVal - psPrev);
      pkPrev = kr;
      psPrev = srVal;
    }
    const norm = (arr) => {
      const sorted = Float32Array.from(arr).sort();
      const p995 = sorted[Math.floor(sorted.length * 0.995)] || 1;
      const inv = 1 / p995;
      for (let i = 0; i < arr.length; i++) arr[i] *= inv;
    };
    norm(kOn);
    norm(sOn);
    const body = new Float32Array(nFr);
    for (let i = 0; i < nFr; i++) body[i] = kOn[i] + 0.85 * sOn[i];
    const bodySmooth = smoothBody6ms(body);
    return { body, bodySmooth, kick: kOn, snare: sOn, fps };
  }

  // ------------------------------------------------------------------ k=1 Beat-Hit Audit & Viterbi Phase Tracker (Exact port of grid.py)

  function windowPhaseProfile(times, bodySmooth, fps) {
    const n = bodySmooth.length;
    const clarityCurve = new Float64Array(N_DELTAS);
    const scores = new Float64Array(N_DELTAS);
    if (times.length < 4) {
      clarityCurve.fill(1);
      return { clarityCurve, scores, per: 0.5, medScore: 1 };
    }
    const per = medianDiff(times);
    if (per <= 0.1 || per >= 2.5) {
      clarityCurve.fill(1);
      return { clarityCurve, scores, per: 0.5, medScore: 1 };
    }
    for (let d = 0; d < N_DELTAS; d++) {
      const shift = DELTAS[d] * per;
      let s = 0, c = 0;
      for (let k = 0; k < times.length; k++) {
        const fr = Math.round((times[k] + shift) * fps);
        if (fr >= 0 && fr < n) {
          s += bodySmooth[fr];
          c++;
        }
      }
      scores[d] = c ? s / c : 0;
    }
    const sorted = Float64Array.from(scores).sort();
    const medScore = sorted[N_DELTAS >> 1] + 1e-9;
    const invMed = 1 / medScore;
    for (let d = 0; d < N_DELTAS; d++) clarityCurve[d] = scores[d] * invMed;
    return { clarityCurve, scores, per, medScore };
  }

  function windowPhaseOffset(times, bodySmooth, fps) {
    const { clarityCurve, scores, per } = windowPhaseProfile(times, bodySmooth, fps);
    const z0 = scores[100]; // delta = 0.0
    let globI = 0;
    let locI = 80; // delta = -0.10 .. +0.10 -> indices 80..120
    for (let d = 0; d < N_DELTAS; d++) {
      if (scores[d] > scores[globI]) globI = d;
      if (d >= 80 && d <= 120 && scores[d] > scores[locI]) locI = d;
    }
    const globScore = scores[globI];
    const locScore = scores[locI];
    const locCl = clarityCurve[locI];
    const useLocal = (locCl >= 1.35 && globScore / Math.max(locScore, 1e-9) < 2.1)
      || (globScore / Math.max(z0, 1e-9) < 1.35);
    const pick = useLocal ? locI : globI;
    return {
      offS: DELTAS[pick] * per,
      peak: scores[pick],
      z0,
      cl: clarityCurve[pick],
      ratio: scores[pick] / Math.max(z0, 1e-9),
    };
  }

  function viterbiPhaseTrack(curves, winCenters, pMed) {
    const W = curves.length;
    if (W === 0) return new Float64Array(0);
    const prior = new Float64Array(N_DELTAS);
    for (let d = 0; d < N_DELTAS; d++) {
      const r = DELTAS[d] / 0.065;
      prior[d] = 0.22 * Math.exp(-r * r);
    }
    if (W === 1) {
      let best = 0, bestV = -1e9;
      for (let d = 0; d < N_DELTAS; d++) {
        const v = Math.min(curves[0][d], 10.0) + prior[d];
        if (v > bestV) { bestV = v; best = d; }
      }
      return Float64Array.from([DELTAS[best] * pMed]);
    }

    // Circular shortest signed distance matrix between delta states
    const diffSq = new Float64Array(N_DELTAS * N_DELTAS);
    for (let i = 0; i < N_DELTAS; i++) {
      const di = DELTAS[i];
      const row = i * N_DELTAS;
      for (let j = 0; j < N_DELTAS; j++) {
        let df = (DELTAS[j] - di + 0.5) % 1.0;
        if (df < 0) df += 1.0;
        df -= 0.5;
        diffSq[row + j] = df * df;
      }
    }

    const dp = new Float64Array(W * N_DELTAS);
    const back = new Int32Array(W * N_DELTAS);
    for (let d = 0; d < N_DELTAS; d++) {
      dp[d] = Math.min(curves[0][d], 10.0) + prior[d];
    }

    for (let w = 1; w < W; w++) {
      const gapBeats = Math.max(4.0, winCenters[w] - winCenters[w - 1]);
      const lam = 220.0 / Math.pow(gapBeats / 4.0, 0.75);
      const prevOff = (w - 1) * N_DELTAS;
      const curOff = w * N_DELTAS;
      const cCurve = curves[w];
      for (let j = 0; j < N_DELTAS; j++) {
        let bestI = 0;
        let bestVal = -1e18;
        for (let i = 0; i < N_DELTAS; i++) {
          const val = dp[prevOff + i] - lam * diffSq[i * N_DELTAS + j];
          if (val > bestVal) { bestVal = val; bestI = i; }
        }
        back[curOff + j] = bestI;
        dp[curOff + j] = Math.min(cCurve[j], 10.0) + prior[j] + bestVal;
      }
    }

    const path = new Int32Array(W);
    let lastBest = 0;
    const lastOff = (W - 1) * N_DELTAS;
    for (let d = 1; d < N_DELTAS; d++) {
      if (dp[lastOff + d] > dp[lastOff + lastBest]) lastBest = d;
    }
    path[W - 1] = lastBest;
    for (let w = W - 2; w >= 0; w--) {
      path[w] = back[(w + 1) * N_DELTAS + path[w + 1]];
    }

    // Unwrap along exact circular step deltas (never suffers abrupt +-0.5 wrap flips!)
    const deltasUnwrapped = new Float64Array(W);
    deltasUnwrapped[0] = DELTAS[path[0]];
    for (let w = 1; w < W; w++) {
      let stepD = (DELTAS[path[w]] - DELTAS[path[w - 1]] + 0.5) % 1.0;
      if (stepD < 0) stepD += 1.0;
      stepD -= 0.5;
      deltasUnwrapped[w] = deltasUnwrapped[w - 1] + stepD;
    }
    const medD = medianOf(deltasUnwrapped);
    const shiftInt = Math.round(medD);
    for (let w = 0; w < W; w++) deltasUnwrapped[w] = (deltasUnwrapped[w] - shiftInt) * pMed;
    return deltasUnwrapped;
  }

  function auditBeatsJS(beats, body, bodySmooth, fps, winBeats = 16, stepBeats = 8) {
    const n = beats.length;
    if (n < 8) {
      return {
        status: "warn", median_offset_ms: 0, max_offset_ms: 0, signed_median_ms: 0,
        active_windows: 0, bad_windows: 0, drift_pct: 0, max_straight_err_ms: 0,
        needs_quantize: false, sections: [],
      };
    }

    const winStarts = [];
    const energies = [];
    const lastI = Math.max(0, n - winBeats);
    for (let i = 0; i <= lastI; i += stepBeats) {
      const seg = beats.slice(i, Math.min(n, i + winBeats));
      const f0 = Math.max(0, Math.floor(seg[0] * fps));
      const f1 = Math.min(body.length, Math.floor(seg[seg.length - 1] * fps));
      let s = 0;
      for (let f = f0; f < f1; f++) s += body[f];
      winStarts.push(i);
      energies.push(f1 > f0 ? s / (f1 - f0) : 0);
    }
    let maxE = 0;
    for (const e of energies) if (e > maxE) maxE = e;
    const nz = energies.filter((e) => e > 0.25 * maxE);
    const usual = nz.length ? medianOf(nz) : 0;

    const sections = [];
    const offs = [];
    for (let idxW = 0; idxW < winStarts.length; idxW++) {
      const i = winStarts[idxW];
      const seg = beats.slice(i, Math.min(n, i + winBeats));
      if (seg.length < 8) continue;
      const active = energies[idxW] >= ACTIVE_SHARE * usual && usual > 1e-4;
      const per = medianDiff(seg);
      const bpm = per > 0 ? 60 / per : 120;
      if (!active) {
        sections.push({
          i0: i, i1: i + seg.length, t0: +seg[0].toFixed(2), t1: +seg[seg.length - 1].toFixed(2),
          bpm: +bpm.toFixed(2), active: false, offset_ms: 0, clarity: 0, ratio: 1,
        });
        continue;
      }
      const { offS, cl, ratio } = windowPhaseOffset(seg, bodySmooth, fps);
      const offMs = offS * 1000;
      offs.push(offMs);
      sections.push({
        i0: i, i1: i + seg.length, t0: +seg[0].toFixed(2), t1: +seg[seg.length - 1].toFixed(2),
        bpm: +bpm.toFixed(2), active: true, offset_ms: +offMs.toFixed(1),
        clarity: +cl.toFixed(2), ratio: +ratio.toFixed(2),
      });
    }

    // Straight-line deviation across beats (exact match to grid.py)
    const jIdx = Array.from({ length: n }, (_, k) => k);
    const { slope, intercept } = linearFit(jIdx, beats);
    const straightErrMs = beats.map((bt, k) => Math.abs(bt - (intercept + slope * k)) * 1000);
    const maxStraightErrMs = percentileOf(straightErrMs, 95);

    const activeBpms = sections.filter((s) => s.active && s.bpm > 0).map((s) => s.bpm);
    const driftPct = activeBpms.length >= 2
      ? ((Math.max(...activeBpms) - Math.min(...activeBpms)) / Math.max(1e-6, medianOf(activeBpms))) * 100
      : 0;

    const absOffs = offs.map(Math.abs);
    const medAbs = absOffs.length ? medianOf(absOffs) : 0;
    const maxAbs = absOffs.length ? Math.max(...absOffs) : 0;
    const signedMed = offs.length ? medianOf(offs) : 0;
    const badWins = sections.filter((s) => s.active && Math.abs(s.offset_ms) > OFFBEAT_WARN_MS && s.clarity >= 1.8).length;
    const badThresh = Math.max(2, Math.round(0.1 * Math.max(1, offs.length)));

    let status = "ok";
    if (medAbs > OFFBEAT_WARN_MS || badWins >= badThresh) status = "off_beat";
    else if (badWins > 0 || maxAbs > 18) status = "warn";

    return {
      status,
      median_offset_ms: +medAbs.toFixed(1),
      max_offset_ms: +maxAbs.toFixed(1),
      signed_median_ms: +signedMed.toFixed(1),
      active_windows: offs.length,
      bad_windows: badWins,
      drift_pct: +driftPct.toFixed(2),
      max_straight_err_ms: +maxStraightErrMs.toFixed(1),
      needs_quantize: maxStraightErrMs > DRIFT_WARN_MS || driftPct > 0.35,
      sections,
    };
  }

  // ------------------------------------------------------------------ Multi-Window Tempo + Local-Tempo Ellis DP Beat Tracker

  function phaseHistSharpness(bodySmooth, fps, fStart, fEnd, periodS, nBins = 64) {
    const hist = new Float64Array(nBins);
    const cnt = new Int32Array(nBins);
    const invP = 1.0 / periodS;
    const invFps = 1.0 / fps;
    for (let f = fStart; f < fEnd; f++) {
      const ph = (f * invFps) * invP;
      const frac = ph - Math.floor(ph);
      const b = Math.min(nBins - 1, Math.floor(frac * nBins));
      hist[b] += bodySmooth[f];
      cnt[b]++;
    }
    let bestBin = 0;
    let bestVal = 0;
    for (let b = 0; b < nBins; b++) {
      if (cnt[b] > 0) hist[b] /= cnt[b];
      if (hist[b] > bestVal) { bestVal = hist[b]; bestBin = b; }
    }
    const sorted = Float64Array.from(hist).sort();
    const med = sorted[nBins >> 1] + 1e-9;
    return { clarity: bestVal / med, peak: bestVal, bestBin, hist };
  }

  function estimateGlobalPeriod(body, bodySmooth, fps, preferBpm = null) {
    // Max-pool 500 Hz body -> ~100 Hz for fast full-song autocorrelation
    const dec = 5;
    const fps100 = fps / dec;
    const n100 = Math.floor(body.length / dec);
    const env100 = new Float32Array(n100);
    let mean = 0;
    for (let i = 0; i < n100; i++) {
      let mx = 0;
      const base = i * dec;
      for (let k = 0; k < dec; k++) {
        const v = body[base + k];
        if (v > mx) mx = v;
      }
      env100[i] = mx;
      mean += mx;
    }
    mean /= n100 || 1;
    const centered = new Float32Array(n100);
    for (let i = 0; i < n100; i++) centered[i] = env100[i] - mean;

    const minBpm = preferBpm ? Math.max(45, preferBpm * 0.86) : 60;
    const maxBpm = preferBpm ? Math.min(220, preferBpm * 1.16) : 196;
    const loLag = Math.max(20, Math.floor((fps100 * 60) / maxBpm));
    const hiLag = Math.min(n100 - 2, Math.ceil((fps100 * 60) / minBpm));
    const maxAcfLag = Math.min(n100 - 1, hiLag * 3 + 2);
    const acf = new Float64Array(maxAcfLag + 1);
    const stepI = n100 > 30000 ? 2 : 1;
    for (let lag = Math.max(10, Math.floor(loLag / 2)); lag <= maxAcfLag; lag++) {
      let s = 0;
      const lim = n100 - lag;
      for (let i = 0; i < lim; i += stepI) s += centered[i] * centered[i + lag];
      acf[lag] = lim > 0 ? s / (lim / stepI) : 0;
    }

    // Harmonic comb scoring across loLag..hiLag
    const comb = new Float64Array(hiLag + 1);
    for (let lag = loLag; lag <= hiLag; lag++) {
      const bpm = (fps100 * 60) / lag;
      const l2 = lag * 2;
      const l3 = lag * 3;
      const lh = Math.round(lag * 0.5);
      let sc = acf[lag];
      if (l2 <= maxAcfLag) sc += 0.55 * acf[l2];
      if (l3 <= maxAcfLag) sc += 0.25 * acf[l3];
      if (lh >= 10 && lh <= maxAcfLag) sc += 0.28 * acf[lh];
      const prior = preferBpm
        ? Math.exp(-0.5 * Math.pow((bpm - preferBpm) / (0.08 * preferBpm), 2))
        : (0.76 + 0.24 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.55, 2)));
      comb[lag] = Math.max(0, sc) * prior;
    }

    // Collect top distinct local peaks
    const peaks = [];
    for (let lag = loLag + 1; lag < hiLag; lag++) {
      if (comb[lag] >= comb[lag - 1] && comb[lag] >= comb[lag + 1] && comb[lag] > 0) {
        peaks.push({ lag, score: comb[lag] });
      }
    }
    peaks.sort((a, b) => b.score - a.score);
    const candPeriods = [];
    const addCand = (p) => {
      const bpm = 60 / p;
      if (bpm < minBpm || bpm > maxBpm) return;
      if (candPeriods.some((x) => Math.abs(x - p) / p < 0.015)) return;
      candPeriods.push(p);
    };
    if (preferBpm) addCand(60 / preferBpm);
    for (const pk of peaks.slice(0, 6)) {
      const p = pk.lag / fps100;
      addCand(p);
      if (!preferBpm) {
        addCand(p * 0.5);
        addCand(p * 2.0);
      }
    }
    if (!candPeriods.length) candPeriods.push(preferBpm ? 60 / preferBpm : 0.5);

    // Choose up to 6 active 20-second slices across the song so drifting songs don't smear!
    const sliceLen = Math.min(bodySmooth.length, Math.round(20 * fps));
    const sliceStep = Math.max(1, Math.floor((bodySmooth.length - sliceLen) / 5));
    const rawSlices = [];
    for (let s0 = 0; s0 + sliceLen <= bodySmooth.length; s0 += sliceStep) {
      let e = 0;
      for (let f = s0; f < s0 + sliceLen; f++) e += body[f];
      rawSlices.push({ f0: s0, f1: s0 + sliceLen, e: e / sliceLen });
      if (rawSlices.length >= 6) break;
    }
    if (!rawSlices.length) rawSlices.push({ f0: 0, f1: bodySmooth.length, e: 1 });
    const maxSE = Math.max(...rawSlices.map((s) => s.e));
    const slices = rawSlices.filter((s) => s.e >= 0.25 * maxSE);
    const useSlices = slices.length ? slices : rawSlices;

    // Refine each candidate period to ~0.01 BPM precision via phase-histogram sharpness across active slices
    const evalPeriod = (p) => {
      let tot = 0;
      for (const sl of useSlices) tot += phaseHistSharpness(bodySmooth, fps, sl.f0, sl.f1, p, 64).clarity;
      return tot / useSlices.length;
    };

    let bestP = candPeriods[0];
    let bestScore = -1;
    const refined = [];
    for (const p0 of candPeriods) {
      let pBest = p0;
      let scBest = -1;
      for (let k = -20; k <= 20; k++) {
        const p = p0 * (1 + k * 0.0012);
        const sc = evalPeriod(p);
        if (sc > scBest) { scBest = sc; pBest = p; }
      }
      // Fine zoom +-0.15% at 0.01% step (~0.012 BPM)
      const pMid = pBest;
      for (let k = -15; k <= 15; k++) {
        const p = pMid * (1 + k * 0.0001);
        const sc = evalPeriod(p);
        if (sc > scBest) { scBest = sc; pBest = p; }
      }
      const bpm = 60 / pBest;
      const prior = preferBpm
        ? 1.0
        : (0.86 + 0.14 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.55, 2)));
      refined.push({ p: pBest, rawScore: scBest, score: scBest * prior });
      if (scBest * prior > bestScore) { bestScore = scBest * prior; bestP = pBest; }
    }

    // Octave check (unless user locked preferBpm): prevent half-BPM lock when odd beats also carry real drum hits!
    if (!preferBpm) {
      const checkSubHit = (periodCheck) => {
        let ratioSum = 0;
        for (const sl of useSlices) {
          const { hist, bestBin, peak } = phaseHistSharpness(bodySmooth, fps, sl.f0, sl.f1, periodCheck, 64);
          const opp = (bestBin + 32) & 63;
          let oppPeak = 0;
          for (let d = -2; d <= 2; d++) {
            const v = hist[(opp + d + 64) & 63];
            if (v > oppPeak) oppPeak = v;
          }
          ratioSum += oppPeak / Math.max(peak, 1e-9);
        }
        return ratioSum / useSlices.length;
      };
      const curBpm = 60 / bestP;
      if (curBpm < 76 && curBpm * 2 <= 185) {
        if (checkSubHit(bestP) >= 0.28) bestP *= 0.5;
      } else if (curBpm < 96 && curBpm * 2 <= 185) {
        if (checkSubHit(bestP) >= 0.42) bestP *= 0.5;
      }
      // If BPM > 158 and odd beats on 2*bestP are mostly empty (< 30% of even beats), halve it!
      if (60 / bestP > 158 && 60 / (bestP * 2.0) >= 68) {
        if (checkSubHit(bestP * 2.0) < 0.30) bestP *= 2.0;
      }
    }

    return { period: bestP, env100, fps100 };
  }

  function buildLocalPeriodCurve(body, bodySmooth, fps, p0, n100, fps100) {
    // Measure local tempo in overlapping 10s windows (step 4s) within +-12% of p0
    const winFr = Math.min(body.length, Math.round(10 * fps));
    const stepFr = Math.max(1, Math.round(4 * fps));
    const rawWins = [];
    for (let f0 = 0; f0 + Math.min(winFr, Math.round(4 * fps)) <= body.length; f0 += stepFr) {
      const f1 = Math.min(body.length, f0 + winFr);
      let e = 0;
      for (let f = f0; f < f1; f++) e += body[f];
      rawWins.push({ f0, f1, tMid: 0.5 * (f0 + f1) / fps, e: e / (f1 - f0) });
    }
    const maxE = rawWins.length ? Math.max(...rawWins.map((w) => w.e)) : 0;
    const nz = rawWins.filter((w) => w.e > 0.25 * maxE).map((w) => w.e);
    const usual = nz.length ? medianOf(nz) : 0;

    const anchorsT = [];
    const anchorsP = [];
    for (const w of rawWins) {
      if (w.e < ACTIVE_SHARE * usual || usual <= 1e-4) continue;
      let bestP = p0;
      let bestSc = -1;
      let bestCl = 0;
      for (let k = -24; k <= 24; k++) {
        const frac = k * 0.005; // +-12%
        const p = p0 * (1 + frac);
        const { clarity } = phaseHistSharpness(bodySmooth, fps, w.f0, w.f1, p, 48);
        const sc = clarity * (1 - 0.14 * frac * frac * 25);
        if (sc > bestSc) { bestSc = sc; bestP = p; bestCl = clarity; }
      }
      if (bestCl >= 1.9) {
        anchorsT.push(w.tMid);
        anchorsP.push(bestP);
      }
    }

    const out = new Float32Array(n100);
    if (anchorsP.length < 2) {
      out.fill(p0);
      return out;
    }

    // 3-point median filter on anchor periods to reject any single fill outlier
    const cleanP = anchorsP.map((v, i) => {
      const a = anchorsP[Math.max(0, i - 1)];
      const b = v;
      const c = anchorsP[Math.min(anchorsP.length - 1, i + 1)];
      return medianOf([a, b, c]);
    });

    // Linearly interpolate local period across every 100 Hz frame
    let seg = 0;
    for (let i = 0; i < n100; i++) {
      const t = i / fps100;
      if (t <= anchorsT[0]) { out[i] = cleanP[0]; continue; }
      if (t >= anchorsT[anchorsT.length - 1]) { out[i] = cleanP[cleanP.length - 1]; continue; }
      while (seg < anchorsT.length - 2 && anchorsT[seg + 1] < t) seg++;
      const u = (t - anchorsT[seg]) / Math.max(1e-6, anchorsT[seg + 1] - anchorsT[seg]);
      out[i] = cleanP[seg] + u * (cleanP[seg + 1] - cleanP[seg]);
    }
    return out;
  }

  function trackBeatsDP(env100, fps100, localPeriod, bodySmooth, fps500) {
    const n = env100.length;
    if (n < 32) return [];

    // Smooth & normalize onset strength for DP (cap huge crashes so continuity holds through fills)
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = env100[i > 0 ? i - 1 : 0];
      const b = env100[i];
      const c = env100[i + 1 < n ? i + 1 : n - 1];
      env[i] = 0.25 * a + 0.5 * b + 0.25 * c;
    }
    const sorted = Float32Array.from(env).sort();
    const p98 = sorted[Math.floor(sorted.length * 0.98)] || 1;
    for (let i = 0; i < n; i++) env[i] = Math.min(2.6, env[i] / p98);

    const C = new Float64Array(n);
    const back = new Int32Array(n);
    back.fill(-1);
    const alpha = 68.0;

    for (let t = 0; t < n; t++) {
      const lagT = Math.max(15, localPeriod[t] * fps100);
      const pMin = Math.max(0, Math.round(t - 1.58 * lagT));
      const pMax = Math.round(t - 0.56 * lagT);
      if (pMax < 0) {
        C[t] = env[t];
        back[t] = -1;
        continue;
      }
      let bestP = -1;
      let bestSc = -1e18;
      const invLag = 1.0 / lagT;
      for (let p = pMin; p <= pMax; p++) {
        const lr = Math.log((t - p) * invLag);
        const sc = C[p] - alpha * lr * lr;
        if (sc > bestSc) { bestSc = sc; bestP = p; }
      }
      C[t] = env[t] + bestSc;
      back[t] = bestP;
    }

    // Backtrack from best ending beat in final 1.6 beat periods
    const endLag = Math.max(15, Math.round(localPeriod[n - 1] * fps100 * 1.6));
    let cur = Math.max(0, n - endLag);
    for (let i = cur + 1; i < n; i++) {
      if (C[i] > C[cur]) cur = i;
    }
    const rev = [];
    while (cur >= 0) {
      rev.push(cur / fps100);
      cur = back[cur];
    }
    rev.reverse();

    // Sub-frame polish each beat onto nearest 500 Hz peak within +-8 ms if clear
    const w500 = Math.round(0.008 * fps500);
    const n500 = bodySmooth.length;
    for (let k = 0; k < rev.length; k++) {
      const c = Math.round(rev[k] * fps500);
      const lo = Math.max(1, c - w500);
      const hi = Math.min(n500 - 2, c + w500);
      let pk = c;
      for (let f = lo; f <= hi; f++) if (bodySmooth[f] > bodySmooth[pk]) pk = f;
      if (pk > lo && pk < hi && bodySmooth[pk] > 1.5 * bodySmooth[c]) {
        rev[k] = pk / fps500;
      }
    }
    return rev;
  }

  // ------------------------------------------------------------------ Exact grid.py Post-Processing Helpers

  function recountSlips(beats) {
    if (beats.length < 12) return [...beats];
    const p0 = medianDiff(beats);
    if (p0 <= 0.05) return [...beats];
    const out = [beats[0]];
    let i = 1;
    while (i < beats.length) {
      const d = beats[i] - out[out.length - 1];
      if (d < 0.38 * p0) { i++; continue; }
      if (d >= 0.38 * p0 && d <= 0.58 * p0 && i + 1 < beats.length) {
        const d2 = beats[i + 1] - beats[i];
        if (d2 >= 0.38 * p0 && d2 <= 0.62 * p0) {
          out.push(beats[i + 1]);
          i += 2;
          continue;
        }
      }
      if (d >= 1.75 * p0) {
        const nSub = Math.max(2, Math.round(d / p0));
        const prev = out[out.length - 1];
        for (let k = 1; k < nSub; k++) out.push(prev + (d * k) / nSub);
        out.push(beats[i]);
        i++;
        continue;
      }
      out.push(beats[i]);
      i++;
    }
    return out;
  }

  function evenInactiveGaps(beats, activeMask) {
    const b = [...beats];
    const n = b.length;
    let i = 0;
    while (i < n) {
      if (activeMask[i]) { i++; continue; }
      let j = i;
      while (j < n && !activeMask[j]) j++;
      if (i > 0 && j < n) {
        const span = b[j] - b[i - 1];
        const steps = j - i + 1;
        for (let k = i; k < j; k++) b[k] = b[i - 1] + (span * (k - i + 1)) / steps;
      } else if (i === 0 && j < n) {
        const per = j + 2 < n ? medianDiff(b.slice(j, Math.min(n, j + 16))) : medianDiff(b);
        for (let k = 0; k < j; k++) b[k] = b[j] - (j - k) * per;
      } else if (j === n && i > 0) {
        const per = i >= 2 ? medianDiff(b.slice(Math.max(0, i - 16), i)) : medianDiff(b);
        for (let k = i; k < n; k++) b[k] = b[i - 1] + (k - i + 1) * per;
      }
      i = j;
    }
    return b;
  }

  function gentleHitSnap(beats, activeMask, body, fps, maxShiftS = 0.012) {
    const b = [...beats];
    const w = Math.max(1, Math.round(maxShiftS * fps));
    const ctxW = w * 6;
    const n = body.length;
    for (let k = 1; k < b.length - 1; k++) {
      if (!activeMask[k]) continue;
      const i = Math.round(b[k] * fps);
      const lo = Math.max(0, i - w);
      const hi = Math.min(n, i + w + 1);
      if (hi - lo < 3) continue;
      let p = 0;
      for (let x = 1; x < hi - lo; x++) if (body[lo + x] > body[lo + p]) p = x;
      const ctxLo = Math.max(0, i - ctxW);
      const ctxHi = Math.min(n, i + ctxW + 1);
      const ctxSlice = [];
      for (let x = ctxLo; x < ctxHi; x += 2) ctxSlice.push(body[x]);
      const ctxMed = medianOf(ctxSlice);
      if (body[lo + p] > 2.0 * (ctxMed + 1e-6) && p !== 0 && p !== hi - lo - 1) {
        const cand = (lo + p) / fps;
        if (cand > b[k - 1] + 0.15 && cand < b[k + 1] - 0.15) b[k] = cand;
      }
    }
    return b;
  }

  function runViterbiPass(seed, body, bodySmooth, fps, win = 16, step = 4) {
    const n = seed.length;
    const pMed = medianDiff(seed);
    const winStarts = [];
    const allE = [];
    const lastI = Math.max(0, n - win);
    for (let i = 0; i <= lastI; i += step) {
      const seg = seed.slice(i, Math.min(n, i + win));
      const f0 = Math.max(0, Math.floor(seg[0] * fps));
      const f1 = Math.min(body.length, Math.floor(seg[seg.length - 1] * fps));
      let s = 0;
      for (let f = f0; f < f1; f++) s += body[f];
      winStarts.push(i);
      allE.push(f1 > f0 ? s / (f1 - f0) : 0);
    }
    let maxE = 0;
    for (const e of allE) if (e > maxE) maxE = e;
    const nz = allE.filter((e) => e > 0.25 * maxE);
    const usual = nz.length ? medianOf(nz) : 0;

    const winCenters = [];
    const winCurves = [];
    for (let idxW = 0; idxW < winStarts.length; idxW++) {
      const i = winStarts[idxW];
      const seg = seed.slice(i, Math.min(n, i + win));
      if (seg.length < 8) continue;
      if (allE[idxW] < ACTIVE_SHARE * usual || usual <= 1e-4) continue;
      const { clarityCurve } = windowPhaseProfile(seg, bodySmooth, fps);
      let cMax = 0;
      for (let d = 0; d < N_DELTAS; d++) if (clarityCurve[d] > cMax) cMax = clarityCurve[d];
      if (cMax >= 1.5) {
        winCenters.push(i + 0.5 * (seg.length - 1));
        winCurves.push(clarityCurve);
      }
    }

    const activeMask = new Uint8Array(n);
    for (const cIdx of winCenters) {
      const lo = Math.max(0, Math.floor(cIdx - win * 0.5));
      const hi = Math.min(n, Math.ceil(cIdx + win * 0.5));
      for (let k = lo; k < hi; k++) activeMask[k] = 1;
    }

    if (winCenters.length === 0) return { cand: [...seed], activeMask, winCount: 0 };
    if (winCenters.length === 1) {
      let best = 0;
      for (let d = 1; d < N_DELTAS; d++) if (winCurves[0][d] > winCurves[0][best]) best = d;
      const offS = DELTAS[best] * pMed;
      return { cand: seed.map((x) => x + offS), activeMask, winCount: 1 };
    }

    const wo = viterbiPhaseTrack(winCurves, winCenters, pMed);
    // Interpolate wo across all beats 0..n-1
    const offCurve = new Float64Array(n);
    let seg = 0;
    for (let j = 0; j < n; j++) {
      if (j <= winCenters[0]) { offCurve[j] = wo[0]; continue; }
      if (j >= winCenters[winCenters.length - 1]) { offCurve[j] = wo[wo.length - 1]; continue; }
      while (seg < winCenters.length - 2 && winCenters[seg + 1] < j) seg++;
      const u = (j - winCenters[seg]) / Math.max(1e-6, winCenters[seg + 1] - winCenters[seg]);
      offCurve[j] = wo[seg] + u * (wo[seg + 1] - wo[seg]);
    }
    // Compact 7-beat Hanning smooth (matching grid.py)
    const kerLen = Math.min(7, Math.max(3, Math.floor(n / 16) | 1));
    const half = kerLen >> 1;
    const ker = new Float64Array(kerLen);
    let kSum = 0;
    for (let k = 0; k < kerLen; k++) {
      ker[k] = 0.5 * (1 - Math.cos((2 * Math.PI * (k + 1)) / (kerLen + 1)));
      kSum += ker[k];
    }
    for (let k = 0; k < kerLen; k++) ker[k] /= kSum;

    const cand = new Array(n);
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = -half; k <= half; k++) {
        const idx = Math.max(0, Math.min(n - 1, j + k));
        acc += offCurve[idx] * ker[k + half];
      }
      cand[j] = seed[j] + acc;
    }

    // Enforce strict monotonic spacing
    const minGap = 0.35 * pMed;
    for (let k = 1; k < n; k++) {
      if (cand[k] < cand[k - 1] + minGap) cand[k] = cand[k - 1] + minGap;
    }
    return { cand, activeMask, winCount: winCenters.length };
  }

  function smoothDriftBeats(beats) {
    // 4-pass strictly positive binomial [0.25, 0.5, 0.25] smoother: zero overshoot at break edges,
    // <0.3 ms bias on quadratic tempo ramps, and eliminates beat-to-beat micro-jitter!
    const n = beats.length;
    if (n < 8) return [...beats];
    let cur = [...beats];
    for (let pass = 0; pass < 4; pass++) {
      const nxt = [...cur];
      for (let i = 1; i < n - 1; i++) {
        nxt[i] = 0.25 * cur[i - 1] + 0.5 * cur[i] + 0.25 * cur[i + 1];
      }
      cur = nxt;
    }
    const pMed = medianDiff(beats);
    const minGap = 0.6 * pMed;
    for (let i = 1; i < n; i++) {
      if (cur[i] < cur[i - 1] + minGap) cur[i] = cur[i - 1] + minGap;
    }
    return cur;
  }

  function fitIrlsStraight(beats, activeMask) {
    const actJ = [], actT = [];
    for (let j = 0; j < beats.length; j++) {
      if (activeMask[j]) { actJ.push(j); actT.push(beats[j]); }
    }
    if (actJ.length < 8) return null;
    let { slope, intercept } = linearFit(actJ, actT);
    const res = actJ.map((j, idx) => Math.abs(actT[idx] - (intercept + slope * j)));
    const thr = Math.max(0.018, percentileOf(res, 75) * 1.8);
    const inJ = [], inT = [];
    for (let k = 0; k < actJ.length; k++) {
      if (res[k] <= thr) { inJ.push(actJ[k]); inT.push(actT[k]); }
    }
    if (inJ.length >= 8) ({ slope, intercept } = linearFit(inJ, inT));
    const candStraight = Array.from({ length: beats.length }, (_, j) => intercept + slope * j);
    const straightDev = percentileOf(
      actJ.map((j, idx) => Math.abs(actT[idx] - candStraight[j]) * 1000),
      85,
    );
    return { candStraight, straightDev };
  }

  function detectAndBuildGrid(left, right, sid, title, opts = {}) {
    const n = Math.min(left.length, right.length);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (left[i] + right[i]);
    const dur = n / SR;
    const bpb = Number(opts.bpb || 4);
    const preferBpm = opts.preferBpm ? Number(opts.preferBpm) : null;

    const { body, bodySmooth, kick, fps } = onsetCurves500Hz(mono, SR);
    const { period: p0, env100, fps100 } = estimateGlobalPeriod(body, bodySmooth, fps, preferBpm);

    // 1) STEADY-FIRST CHECK: Test a dead-steady constant-BPM grid first so studio-recorded songs
    //    NEVER get tricked into false beat-to-beat drift by intros, fills, or guitar hits!
    let fixed = null;
    let action = "verified";
    {
      const { bestBin } = phaseHistSharpness(bodySmooth, fps, 0, bodySmooth.length, p0, 256);
      const t0Init = ((bestBin + 0.5) / 256) * p0;
      const straightSeed = [];
      for (let t = t0Init; t <= dur + 0.02; t += p0) straightSeed.push(t);
      if (straightSeed.length >= 8) {
        const pSt = runViterbiPass(straightSeed, body, bodySmooth, fps, 16, 4);
        const fit0 = pSt.winCount >= 2 ? fitIrlsStraight(pSt.cand, pSt.activeMask) : null;
        if (fit0) {
          const aud0 = auditBeatsJS(fit0.candStraight, body, bodySmooth, fps);
          if (
            fit0.straightDev <= 14.0
            && aud0.active_windows >= 2
            && aud0.bad_windows === 0
            && aud0.median_offset_ms <= 12.0
            && aud0.max_offset_ms <= 24.0
          ) {
            fixed = fit0.candStraight;
            action = "steady_locked";
          }
        }
      }
    }

    // 2) DRIFT-TRACKING PATH: Only if steady grid failed, run local-tempo DP + Viterbi tracking
    if (!fixed) {
      const localPeriod = buildLocalPeriodCurve(body, bodySmooth, fps, p0, env100.length, fps100);
      let seed = trackBeatsDP(env100, fps100, localPeriod, bodySmooth, fps);
      if (seed.length < 8) {
        seed = [];
        for (let t = 0; t <= dur + 0.02; t += p0) seed.push(t);
      }
      seed = recountSlips(seed);

      let pass = runViterbiPass(seed, body, bodySmooth, fps, 16, 4);
      let candFollow = pass.cand;
      let activeMask = pass.activeMask;
      let audFollow = auditBeatsJS(candFollow, body, bodySmooth, fps);

      if (pass.winCount >= 2 && (audFollow.bad_windows > 0 || audFollow.max_offset_ms > OFFBEAT_WARN_MS)) {
        const pass2 = runViterbiPass(recountSlips(candFollow), body, bodySmooth, fps, 12, 4);
        const aud2 = auditBeatsJS(pass2.cand, body, bodySmooth, fps);
        if (aud2.bad_windows < audFollow.bad_windows
          || (aud2.bad_windows === audFollow.bad_windows && aud2.max_offset_ms < audFollow.max_offset_ms - 2.0)) {
          candFollow = pass2.cand;
          activeMask = pass2.activeMask;
          audFollow = aud2;
        }
      }

      fixed = candFollow;
      action = pass.winCount >= 2 ? "drift_tracked" : (pass.winCount === 1 ? "phase_shifted" : "verified");

      if (pass.winCount >= 2 && candFollow.length >= 8) {
        const fit = fitIrlsStraight(candFollow, activeMask);
        if (fit) {
          const audStraight = auditBeatsJS(fit.candStraight, body, bodySmooth, fps);
          if (
            fit.straightDev <= 14.0
            && audStraight.median_offset_ms <= Math.max(10.0, audFollow.median_offset_ms + 4.0)
            && audStraight.bad_windows <= audFollow.bad_windows
          ) {
            fixed = fit.candStraight;
            action = "steady_locked";
          } else {
            const evened = evenInactiveGaps(candFollow, activeMask);
            const smoothed = smoothDriftBeats(evened);
            const audSm = auditBeatsJS(smoothed, body, bodySmooth, fps);
            fixed = audSm.bad_windows <= audFollow.bad_windows ? smoothed : evened;
            action = "drift_tracked";
          }
        }
      }
    }

    // Trim / extend cleanly to cover [0, dur]
    const pStart = medianDiff(fixed.slice(0, Math.min(fixed.length, 16)));
    const pEnd = medianDiff(fixed.slice(Math.max(0, fixed.length - 16)));
    while (fixed.length && fixed[0] - pStart >= 0.0) fixed.unshift(fixed[0] - pStart);
    while (fixed.length > 2 && fixed[0] < 0.0) fixed.shift();
    while (fixed.length && fixed[fixed.length - 1] + pEnd <= dur + 0.05) fixed.push(fixed[fixed.length - 1] + pEnd);

    // Pick downbeat phase mod bpb by strongest kick energy (within +-18 ms window)
    const rKick = Math.max(1, Math.round(0.018 * fps));
    const kickScores = new Float64Array(bpb);
    for (let ph = 0; ph < bpb; ph++) {
      let s = 0, c = 0;
      for (let i = ph; i < fixed.length; i += bpb) {
        const center = Math.round(fixed[i] * fps);
        if (center >= 0 && center < kick.length) {
          let mx = 0;
          const lo = Math.max(0, center - rKick);
          const hi = Math.min(kick.length - 1, center + rKick);
          for (let f = lo; f <= hi; f++) if (kick[f] > mx) mx = kick[f];
          s += mx;
          c++;
        }
      }
      kickScores[ph] = c ? s / c : 0;
    }
    let downOff = 0;
    for (let ph = 1; ph < bpb; ph++) if (kickScores[ph] > kickScores[downOff]) downOff = ph;
    const bars = [];
    for (let i = downOff; i < fixed.length; i += bpb) bars.push(i);

    const audit = auditBeatsJS(fixed, body, bodySmooth, fps);
    const notes = [];
    if (audit.needs_quantize) {
      notes.push(`Song drifts ${audit.drift_pct.toFixed(1)}% (${audit.max_straight_err_ms.toFixed(0)} ms) — click Quantize to lock onto steady grid`);
    } else {
      notes.push(`Browser-verified against full-band drum hits (${audit.median_offset_ms.toFixed(1)} ms median, ${action})`);
    }
    audit.note = notes.join("; ");

    const bpm = +(60 / medianDiff(fixed)).toFixed(4);
    const grid = {
      sid,
      title,
      bpm,
      bpb,
      downbeat_offset: downOff,
      beats: fixed.map((x) => +x.toFixed(5)),
      bars,
      duration: +dur.toFixed(4),
      mode: action,
      onset_source: opts.onsetSource || "drums",
      updated: Date.now() / 1000,
      audit,
      quantized: null,
    };
    grid.sig = gridSigJS(grid);
    return grid;
  }

  // ------------------------------------------------------------------ Key Detection (Goertzel Chroma)

  function detectKeyCamelot(left, right) {
    const n = Math.min(left.length, right.length, SR * 45);
    if (n < SR * 2) return { name: "", camelot: "", tonic: 0, mode: "minor" };
    const dec = 8;
    const fs = SR / dec;
    const m = Math.floor(n / dec);
    const y = new Float32Array(m);
    for (let i = 0; i < m; i++) y[i] = 0.5 * (left[i * dec] + right[i * dec]);

    const chroma = new Float64Array(12);
    const block = 2048;
    const step = 4096;
    for (let midi = 40; midi <= 83; midi++) {
      const hz = 440 * Math.pow(2, (midi - 69) / 12);
      const w = (2 * Math.PI * hz) / fs;
      const coeff = 2 * Math.cos(w);
      let e = 0;
      for (let st = 0; st + block <= m; st += step) {
        let s1 = 0, s2 = 0;
        for (let i = 0; i < block; i++) {
          const s0 = y[st + i] + coeff * s1 - s2;
          s2 = s1; s1 = s0;
        }
        e += s1 * s1 + s2 * s2 - coeff * s1 * s2;
      }
      chroma[midi % 12] += e;
    }
    const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    const CMAJ = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
    const CMIN = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
    const corr = (a, b) => {
      let ma = 0, mb = 0;
      for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
      ma /= 12; mb /= 12;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) {
        const xa = a[i] - ma, xb = b[i] - mb;
        num += xa * xb; da += xa * xa; db += xb * xb;
      }
      return num / (Math.sqrt(da * db) + 1e-12);
    };
    let best = -9, bt = 0, bm = "minor";
    for (let t = 0; t < 12; t++) {
      const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
      const smaj = corr(rot, KS_MAJ);
      const smin = corr(rot, KS_MIN);
      if (smaj > best) { best = smaj; bt = t; bm = "major"; }
      if (smin > best) { best = smin; bt = t; bm = "minor"; }
    }
    return { name: `${NAMES[bt]} ${bm}`, camelot: bm === "major" ? CMAJ[bt] : CMIN[bt], tonic: bt, mode: bm };
  }

  // ------------------------------------------------------------------ Cubic Catmull-Rom Beat-Map Resampler

  function resampleTimeMap(left, right, srcBeats, dstBeats, sr = SR) {
    const nIn = Math.min(left.length, right.length);
    const nb = srcBeats.length;
    const slopeStart = (srcBeats[1] - srcBeats[0]) / Math.max(1e-6, dstBeats[1] - dstBeats[0]);
    const slopeEnd = (srcBeats[nb - 1] - srcBeats[nb - 2]) / Math.max(1e-6, dstBeats[nb - 1] - dstBeats[nb - 2]);
    const lastSrc = srcBeats[nb - 1];
    const lastDst = dstBeats[nb - 1];
    const outSec = lastDst + (nIn / sr - lastSrc) / Math.max(0.25, slopeEnd);
    const nOut = Math.max(1, Math.ceil(outSec * sr));
    const outL = new Float32Array(nOut);
    const outR = new Float32Array(nOut);

    const dFirst = dstBeats[0], sFirst = srcBeats[0];
    let seg = 0;
    for (let i = 0; i < nOut; i++) {
      const td = i / sr;
      let ts;
      if (td < dFirst) {
        ts = sFirst + (td - dFirst) * slopeStart;
      } else if (td >= lastDst) {
        ts = lastSrc + (td - lastDst) * slopeEnd;
      } else {
        while (seg < nb - 2 && dstBeats[seg + 1] < td) seg++;
        const d0 = dstBeats[seg], d1 = dstBeats[seg + 1];
        const s0 = srcBeats[seg], s1 = srcBeats[seg + 1];
        const u = (td - d0) / Math.max(1e-6, d1 - d0);
        ts = s0 + u * (s1 - s0);
      }
      const p = ts * sr;
      const i1 = Math.floor(p);
      const t = p - i1;
      if (i1 >= 1 && i1 + 2 < nIn) {
        // 4-point Catmull-Rom cubic interpolation (preserves sharp drum/cymbal highs!)
        const t2 = t * t;
        const t3 = t2 * t;
        const w0 = -0.5 * t3 + t2 - 0.5 * t;
        const w1 = 1.5 * t3 - 2.5 * t2 + 1.0;
        const w2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
        const w3 = 0.5 * t3 - 0.5 * t2;
        outL[i] = w0 * left[i1 - 1] + w1 * left[i1] + w2 * left[i1 + 1] + w3 * left[i1 + 2];
        outR[i] = w0 * right[i1 - 1] + w1 * right[i1] + w2 * right[i1 + 1] + w3 * right[i1 + 2];
      } else if (i1 >= 0 && i1 + 1 < nIn) {
        outL[i] = left[i1] * (1 - t) + left[i1 + 1] * t;
        outR[i] = right[i1] * (1 - t) + right[i1 + 1] * t;
      }
    }
    return { left: outL, right: outR };
  }

  // ------------------------------------------------------------------ Rubber Band R3 WebAssembly (Pitch-Preserving Time-Stretch + Click-Pilot!)

  const RB_WASM_KEY = "rubberband_wasm_330";
  const RB_ESM_URL = "https://cdn.jsdelivr.net/npm/rubberband-wasm@3.3.0/dist/index.esm.min.js";
  const RB_WASM_URL = "https://cdn.jsdelivr.net/npm/rubberband-wasm@3.3.0/dist/rubberband.wasm";
  let rbLoadPromise = null;

  async function ensureRubberBandR3() {
    if (rbLoadPromise) return rbLoadPromise;
    rbLoadPromise = (async () => {
      const { RubberBandInterface, RubberBandOption } = await import(RB_ESM_URL);
      let wasmBuf = null;
      try { wasmBuf = await dbGet("models", RB_WASM_KEY); } catch {}
      if (!wasmBuf) {
        const resp = await fetch(RB_WASM_URL);
        if (!resp.ok) throw new Error(`Rubber Band WASM download failed (HTTP ${resp.status})`);
        wasmBuf = await resp.arrayBuffer();
        try { await dbPut("models", wasmBuf, RB_WASM_KEY); } catch {}
      }
      const wasmMod = await WebAssembly.compile(wasmBuf);
      const rb = await RubberBandInterface.initialize(wasmMod);
      return { rb, opt: RubberBandOption };
    })().catch((err) => {
      rbLoadPromise = null;
      throw err;
    });
    return rbLoadPromise;
  }

  function ratioAtSample(pos, srcS, dstS) {
    const nb = srcS.length;
    if (nb < 2) return 1.0;
    if (pos <= srcS[0]) return Math.max(0.5, Math.min(2.0, (dstS[1] - dstS[0]) / Math.max(1, srcS[1] - srcS[0])));
    if (pos >= srcS[nb - 1]) return Math.max(0.5, Math.min(2.0, (dstS[nb - 1] - dstS[nb - 2]) / Math.max(1, srcS[nb - 1] - srcS[nb - 2])));
    let lo = 0, hi = nb - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (srcS[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return Math.max(0.5, Math.min(2.0, (dstS[lo + 1] - dstS[lo]) / Math.max(1, srcS[lo + 1] - srcS[lo])));
  }

  function rbOptionsForStem(opt, stem) {
    let flags = opt.RubberBandOptionProcessRealTime
      | opt.RubberBandOptionThreadingNever
      | opt.RubberBandOptionChannelsTogether
      | opt.RubberBandOptionEngineFiner
      | opt.RubberBandOptionPitchHighQuality
      | (stem === "drums" ? opt.RubberBandOptionTransientsCrisp : opt.RubberBandOptionTransientsMixed);
    if (stem === "vocals") flags |= opt.RubberBandOptionFormantPreserved;
    return flags;
  }

  async function runR3RealTime(rb, channels, getRatioAt, optsFlags, pitchScale = 1.0, sr = SR, onFrac = null) {
    const nCh = channels.length;
    const nS = channels[0].length;
    const st = rb.rubberband_new(sr, nCh, optsFlags, getRatioAt(0), pitchScale);
    const startPad = rb.rubberband_get_preferred_start_pad(st);
    const startDelay = rb.rubberband_get_start_delay(st);
    const block = 512;
    rb.rubberband_set_max_process_size(st, block);

    const chArr = rb.malloc(nCh * 4);
    const ptrs = [];
    for (let c = 0; c < nCh; c++) {
      const p = rb.malloc(block * 4);
      ptrs.push(p);
      rb.memWritePtr(chArr + c * 4, p);
    }
    const z = new Float32Array(block);
    const chunks = Array.from({ length: nCh }, () => []);
    let tot = 0;
    const drain = () => {
      let a;
      while ((a = rb.rubberband_available(st)) > 0) {
        const g = rb.rubberband_retrieve(st, chArr, Math.min(block, a));
        if (g <= 0) break;
        for (let c = 0; c < nCh; c++) chunks[c].push(new Float32Array(rb.memReadF32(ptrs[c], g)));
        tot += g;
      }
    };

    try {
      for (let rem = startPad; rem > 0; rem -= block) {
        const l = Math.min(block, rem);
        for (let c = 0; c < nCh; c++) rb.memWrite(ptrs[c], z.subarray(0, l));
        rb.rubberband_process(st, chArr, l, 0);
        drain();
      }
      let iter = 0;
      for (let pos = 0; pos < nS; pos += block) {
        const l = Math.min(block, nS - pos);
        rb.rubberband_set_time_ratio(st, getRatioAt(pos + l * 0.5));
        for (let c = 0; c < nCh; c++) rb.memWrite(ptrs[c], channels[c].subarray(pos, pos + l));
        rb.rubberband_process(st, chArr, l, pos + l >= nS ? 1 : 0);
        drain();
        if ((++iter & 127) === 0) {
          if (onFrac) onFrac(pos / Math.max(1, nS));
          await tick();
        }
      }
    } finally {
      rb.rubberband_delete(st);
      for (const p of ptrs) rb.free(p);
      rb.free(chArr);
    }

    const outLen = Math.max(1, tot - startDelay);
    const out = Array.from({ length: nCh }, () => new Float32Array(outLen));
    for (let c = 0; c < nCh; c++) {
      let skip = startDelay, dst = 0;
      for (const ch of chunks[c]) {
        if (skip >= ch.length) { skip -= ch.length; continue; }
        const sl = skip > 0 ? ch.subarray(skip) : ch;
        skip = 0;
        const copyLen = Math.min(sl.length, outLen - dst);
        out[c].set(sl.subarray(0, copyLen), dst);
        dst += copyLen;
      }
    }
    return out;
  }

  async function measurePilotR3(rb, nS, srcB, dstB, optsFlags) {
    const srcS = srcB.map((x) => x * SR);
    const dstS = dstB.map((x) => x * SR);
    const pilot = new Float32Array(nS);
    const click = [1.0, 0.8, 0.5, 0.25];
    for (let j = 0; j < srcS.length; j++) {
      const idx = Math.round(srcS[j]);
      if (idx >= 0 && idx < nS - 8) {
        for (let k = 0; k < 4; k++) pilot[idx + k] += click[k];
      }
    }
    const [pOut] = await runR3RealTime(rb, [pilot], (p) => ratioAtSample(p, srcS, dstS), optsFlags, 1.0, SR);
    const nP = pOut.length;
    const env = new Float32Array(nP);
    let run = 0;
    for (let i = 0; i < nP; i++) {
      run += pOut[i] * pOut[i];
      if (i >= 32) run -= pOut[i - 32] * pOut[i - 32];
      env[i] = run / 32;
    }
    const per = medianDiff(dstB);
    const win = Math.max(Math.round(0.02 * SR), Math.min(Math.round(0.3 * SR), Math.round(0.3 * per * SR)));
    const rawMeas = [];
    let drift = 0;
    for (let j = 0; j < dstS.length; j++) {
      const c = dstS[j] + 16 + drift;
      const a = Math.max(1, Math.floor(c - win));
      const e = Math.min(nP - 2, Math.floor(c + win));
      if (e <= a + 2) continue;
      let pk = a;
      for (let i = a + 1; i < e; i++) if (env[i] > env[pk]) pk = i;
      if (env[pk] <= 1e-6) continue;
      const measured = pk - 16;
      drift = measured - dstS[j];
      rawMeas.push({ mS: measured / SR, dS: dstB[j], err: (measured - dstS[j]) / SR });
    }
    // 7-point median outlier filter + 9-beat Hann smooth + strict +-0.8% slope clamp (<=13.8 cents, 100% inaudible!)
    const keepD = [], keepE = [];
    for (let i = 0; i < rawMeas.length; i++) {
      const winErr = [];
      for (let k = -3; k <= 3; k++) winErr.push(rawMeas[Math.max(0, Math.min(rawMeas.length - 1, i + k))].err);
      if (Math.abs(rawMeas[i].err - medianOf(winErr)) < 0.025) {
        keepD.push(rawMeas[i].dS);
        keepE.push(rawMeas[i].err);
      }
    }
    if (keepD.length < 4) return { measB: [], goodDstB: [] };
    // Interpolate onto every dstB[j]
    const errAll = new Float64Array(dstB.length);
    let seg = 0;
    for (let j = 0; j < dstB.length; j++) {
      const d = dstB[j];
      if (d <= keepD[0]) { errAll[j] = keepE[0]; continue; }
      if (d >= keepD[keepD.length - 1]) { errAll[j] = keepE[keepE.length - 1]; continue; }
      while (seg < keepD.length - 2 && keepD[seg + 1] < d) seg++;
      const u = (d - keepD[seg]) / Math.max(1e-6, keepD[seg + 1] - keepD[seg]);
      errAll[j] = keepE[seg] + u * (keepE[seg + 1] - keepE[seg]);
    }
    // 9-beat Hann smooth
    const errSm = new Float64Array(dstB.length);
    const ker = [0.0955, 0.3455, 0.6545, 0.9045, 1.0, 0.9045, 0.6545, 0.3455, 0.0955];
    const kSum = ker.reduce((a, b) => a + b, 0);
    for (let j = 0; j < dstB.length; j++) {
      let acc = 0;
      for (let k = -4; k <= 4; k++) acc += errAll[Math.max(0, Math.min(dstB.length - 1, j + k))] * ker[k + 4];
      errSm[j] = acc / kSum;
    }
    // Bidirectional +-0.8% slope clamp
    const maxSlope = 0.008;
    const fwd = Float64Array.from(errSm);
    for (let j = 1; j < fwd.length; j++) {
      const lim = maxSlope * Math.max(1e-4, dstB[j] - dstB[j - 1]);
      fwd[j] = Math.max(fwd[j - 1] - lim, Math.min(fwd[j - 1] + lim, fwd[j]));
    }
    const bwd = Float64Array.from(errSm);
    for (let j = bwd.length - 2; j >= 0; j--) {
      const lim = maxSlope * Math.max(1e-4, dstB[j + 1] - dstB[j]);
      bwd[j] = Math.max(bwd[j + 1] - lim, Math.min(bwd[j + 1] + lim, bwd[j]));
    }
    const measB = dstB.map((d, j) => d + 0.5 * (fwd[j] + bwd[j]));
    return { measB, goodDstB: [...dstB] };
  }

  async function stretchBeatsR3Wasm(inL, inR, srcB, dstB, stem, pilotCache, onFrac = null) {
    // Fast-path: if beats are already steady (<0.12% deviation), skip R3 completely (zero artifacts!)
    let maxDev = 0;
    for (let j = 0; j < srcB.length - 1; j++) {
      const r = (dstB[j + 1] - dstB[j]) / Math.max(1e-6, srcB[j + 1] - srcB[j]);
      const d = Math.abs(r - 1.0);
      if (d > maxDev) maxDev = d;
    }
    if (maxDev < 0.0012) {
      return { ...resampleTimeMap(inL, inR, srcB, dstB, SR), method: "steady-copy" };
    }

    const { rb, opt } = await ensureRubberBandR3();
    const optsFlags = rbOptionsForStem(opt, stem);
    const srcS = srcB.map((x) => x * SR);
    const dstS = dstB.map((x) => x * SR);
    const [rawL, rawR] = await runR3RealTime(
      rb,
      [inL, inR],
      (p) => ratioAtSample(p, srcS, dstS),
      optsFlags,
      1.0,
      SR,
      onFrac,
    );

    const pKey = `${optsFlags}|${inL.length}`;
    if (!pilotCache.has(pKey)) {
      pilotCache.set(pKey, await measurePilotR3(rb, inL.length, srcB, dstB, optsFlags));
    }
    const { measB, goodDstB } = pilotCache.get(pKey);
    if (measB.length >= 4) {
      return { ...resampleTimeMap(rawL, rawR, measB, goodDstB, SR), method: "r3-wasm" };
    }
    return { left: rawL, right: rawR, method: "r3-wasm" };
  }

  async function stretchSegmentR3(inL, inR, timeRatio = 1.0, semis = 0.0, stem = "other", sr = SR) {
    const ratio = Math.max(0.25, Math.min(4.0, Number(timeRatio || 1.0)));
    const pitchScale = Math.pow(2, Math.max(-12, Math.min(12, Number(semis || 0))) / 12);
    if (Math.abs(ratio - 1.0) < 0.002 && Math.abs(pitchScale - 1.0) < 0.001) {
      return { left: inL, right: inR };
    }
    const { rb, opt } = await ensureRubberBandR3();
    const optsFlags = rbOptionsForStem(opt, stem);
    const [outL, outR] = await runR3RealTime(rb, [inL, inR], () => ratio, optsFlags, pitchScale, sr);
    return { left: outL, right: outR };
  }

  // ------------------------------------------------------------------ Zero-Install Browser AI Separation (HTDemucs ONNX WebGPU / WASM CPU)

  async function detectHardware() {
    let webgpu = false;
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        webgpu = Boolean(adapter);
      }
    } catch {}
    return { webgpu, modelCached: await hasCachedModel() };
  }

  async function separateWithDemucsWeb(left, right, onProgress = () => {}) {
    const hw = await detectHardware();
    const providerLabel = hw.webgpu ? "WebGPU GPU" : "WASM CPU";
    onProgress(0.02, `Loading ONNX Runtime (${providerLabel})...`);

    const ort = await import("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/+esm");
    const { DemucsProcessor, CONSTANTS } = await import("https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/+esm");

    // Works on GitHub Pages without COOP/COEP headers!
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
    ort.env.wasm.numThreads = window.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.wasm.proxy = false;

    if (!demucsState.processor) {
      let modelBuf = await dbGet("models", MODEL_KEY);
      if (!modelBuf) {
        onProgress(0.04, "Downloading HTDemucs ONNX (~172 MB, cached once on your SSD)...");
        const resp = await fetch(CONSTANTS.DEFAULT_MODEL_URL);
        if (!resp.ok) throw new Error(`Model download failed (HTTP ${resp.status})`);
        const total = parseInt(resp.headers.get("Content-Length") || "176000000", 10);
        const reader = resp.body.getReader();
        const chunks = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          const mb = (loaded / (1024 * 1024)).toFixed(0);
          const totMb = (total / (1024 * 1024)).toFixed(0);
          onProgress(0.04 + 0.24 * Math.min(1, loaded / total), `Downloading HTDemucs (${mb}/${totMb} MB)...`);
        }
        const combined = new Uint8Array(loaded);
        let off = 0;
        for (const ch of chunks) { combined.set(ch, off); off += ch.length; }
        modelBuf = combined.buffer;
        onProgress(0.29, "Caching HTDemucs model in browser SSD storage...");
        try { await dbPut("models", modelBuf, MODEL_KEY); } catch {}
      } else {
        onProgress(0.15, `Loaded cached HTDemucs model from SSD (${providerLabel})...`);
      }

      const proc = new DemucsProcessor({
        ort,
        sessionOptions: {
          executionProviders: hw.webgpu ? ["webgpu", "wasm"] : ["wasm"],
          graphOptimizationLevel: "basic",
        },
        onProgress: (info) => {
          const frac = typeof info === "number" ? info : (info?.progress || 0);
          const segTxt = info?.totalSegments ? `chunk ${info.currentSegment}/${info.totalSegments}` : `${Math.round(frac * 100)}%`;
          onProgress(0.32 + 0.56 * frac, `Separating 4 stems (${providerLabel} · ${segTxt})...`);
        },
      });
      await proc.loadModel(modelBuf);
      demucsState = { processor: proc, provider: providerLabel };
    } else {
      demucsState.processor.onProgress = (info) => {
        const frac = typeof info === "number" ? info : (info?.progress || 0);
        const segTxt = info?.totalSegments ? `chunk ${info.currentSegment}/${info.totalSegments}` : `${Math.round(frac * 100)}%`;
        onProgress(0.15 + 0.73 * frac, `Separating 4 stems (${demucsState.provider} · ${segTxt})...`);
      };
    }

    const res = await demucsState.processor.separate(left, right);
    return {
      drums: res.drums,
      bass: res.bass,
      other: res.other,
      vocals: res.vocals,
      tag: `browser_htdemucs_${hw.webgpu ? "webgpu" : "cpu"}`,
    };
  }

  // ------------------------------------------------------------------ Helper: Load Local Song Beat Audio (Drums or Mix Fallback)

  function arrayRms(arr) {
    let s = 0;
    const step = arr.length > 441000 ? 4 : 1;
    let c = 0;
    for (let i = 0; i < arr.length; i += step) { s += arr[i] * arr[i]; c++; }
    return Math.sqrt(s / Math.max(1, c));
  }

  async function loadLocalBeatStereo(sid, rev = "raw") {
    const dBlob = await dbGet("blobs", `${sid}|${rev}|drums`);
    if (dBlob) {
      const dec = await decodeTo44kStereo(await dBlob.arrayBuffer());
      if (arrayRms(dec.left) >= 1e-4 || arrayRms(dec.right) >= 1e-4) {
        return { left: dec.left, right: dec.right, source: "drums" };
      }
    }
    // Drumless / direct track fallback: mix available stems
    const parts = [];
    for (const st of ["bass", "other", "vocals"]) {
      const b = await dbGet("blobs", `${sid}|${rev}|${st}`);
      if (b) parts.push(await decodeTo44kStereo(await b.arrayBuffer()));
    }
    if (!parts.length) throw new Error("Local audio stems missing from IndexedDB");
    const n = Math.min(...parts.map((p) => p.left.length));
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (const p of parts) {
      for (let i = 0; i < n; i++) { L[i] += p.left[i]; R[i] += p.right[i]; }
    }
    return { left: L, right: R, source: "mix" };
  }

  async function saveLocalGridToDB(sid, grid) {
    const rec = await dbGet("songs", sid);
    if (!rec) return;
    rec.detail.grid = grid;
    rec.summary.bpm = +Number(grid.bpm).toFixed(2);
    rec.summary.bpb = grid.bpb;
    rec.summary.core_grid = {
      bpm: grid.bpm,
      bpb: grid.bpb,
      audit: grid.audit,
      quantized: Boolean(grid.quantized && grid.quantized.sig === grid.sig),
      sig: grid.sig,
    };
    await dbPut("songs", rec);
  }

  // ------------------------------------------------------------------ High-Level Browser Local Import, Grid Auto-Fix, Update & Quantize

  async function importFilesLocal(files, { mode = "ai", singleRole = "other", title = "" } = {}, onProgress = () => {}) {
    const fileArr = [...files];
    if (!fileArr.length) throw new Error("No audio files selected");
    const baseName = (title || fileArr[0].name.replace(/\.[^.]+$/, "")).trim() || "Imported Track";
    const sid = "local_" + baseName.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 32) + "_" + Math.random().toString(36).slice(2, 7);

    let stems = null;
    let sepTag = "browser_local";
    let duration = 0;

    if (fileArr.length >= 2) {
      onProgress(0.10, `Decoding ${fileArr.length} pre-separated stem files...`);
      const assigned = {};
      const unassigned = [];
      for (const f of fileArr) {
        const nm = f.name.toLowerCase();
        const dec = await decodeTo44kStereo(f);
        duration = Math.max(duration, dec.duration);
        if ((nm.includes("drum") || nm.includes("perc")) && !assigned.drums) assigned.drums = dec;
        else if (nm.includes("bass") && !assigned.bass) assigned.bass = dec;
        else if ((nm.includes("vocal") || nm.includes("vox") || nm.includes("acapella")) && !assigned.vocals) assigned.vocals = dec;
        else if ((nm.includes("other") || nm.includes("inst") || nm.includes("music") || nm.includes("melod") || nm.includes("guitar") || nm.includes("synth")) && !assigned.other) assigned.other = dec;
        else unassigned.push(dec);
      }
      for (const u of unassigned) {
        const slot = STEMS.find((s) => !assigned[s]);
        if (slot) assigned[slot] = u;
      }
      const nSamp = Math.max(1, Math.ceil(duration * SR));
      const pad = (x) => {
        const L = new Float32Array(nSamp), R = new Float32Array(nSamp);
        if (x) { L.set(x.left.subarray(0, nSamp)); R.set(x.right.subarray(0, nSamp)); }
        return { left: L, right: R };
      };
      stems = { drums: pad(assigned.drums), bass: pad(assigned.bass), other: pad(assigned.other), vocals: pad(assigned.vocals) };
      sepTag = "imported_stems";
    } else {
      onProgress(0.04, `Decoding ${fileArr[0].name} at 44.1 kHz...`);
      const dec = await decodeTo44kStereo(fileArr[0]);
      duration = dec.duration;
      if (mode === "ai") {
        const out = await separateWithDemucsWeb(dec.left, dec.right, onProgress);
        stems = { drums: out.drums, bass: out.bass, other: out.other, vocals: out.vocals };
        sepTag = out.tag;
      } else {
        const zero = () => ({ left: new Float32Array(dec.left.length), right: new Float32Array(dec.right.length) });
        stems = { drums: zero(), bass: zero(), other: zero(), vocals: zero() };
        if (singleRole === "mix") stems.other = dec;
        else stems[STEMS.includes(singleRole) ? singleRole : "other"] = dec;
        sepTag = "browser_direct";
      }
    }

    onProgress(0.88, "Running Viterbi drum-hit beat tracker & Camelot key detection...");
    const hasDrums = arrayRms(stems.drums.left) >= 1e-4 || arrayRms(stems.drums.right) >= 1e-4;
    let beatL, beatR, onsetSource = "drums";
    if (hasDrums) {
      beatL = stems.drums.left;
      beatR = stems.drums.right;
    } else {
      onsetSource = "mix";
      const nS = stems.other.left.length;
      beatL = new Float32Array(nS);
      beatR = new Float32Array(nS);
      for (let i = 0; i < nS; i++) {
        beatL[i] = stems.bass.left[i] + stems.other.left[i] + stems.vocals.left[i];
        beatR[i] = stems.bass.right[i] + stems.other.right[i] + stems.vocals.right[i];
      }
    }
    const grid = detectAndBuildGrid(beatL, beatR, sid, baseName, { onsetSource });

    const harmL = new Float32Array(stems.other.left.length);
    const harmR = new Float32Array(stems.other.right.length);
    for (let i = 0; i < harmL.length; i++) {
      harmL[i] = stems.bass.left[i] + stems.other.left[i];
      harmR[i] = stems.bass.right[i] + stems.other.right[i];
    }
    const keyInfo = detectKeyCamelot(harmL, harmR);

    onProgress(0.94, "Saving stems & peaks to private browser IndexedDB storage...");
    for (const st of STEMS) {
      const wavBlob = encodeStereoWav16(stems[st].left, stems[st].right, SR);
      const pk = computePeaksI8(stems[st].left, stems[st].right, SR, 100);
      await dbPut("blobs", wavBlob, `${sid}|raw|${st}`);
      await dbPut("blobs", pk, `pk|${sid}|raw|${st}`);
    }

    const songSummary = {
      id: sid,
      title: baseName,
      artist: "Local Browser Import",
      album: "Browser Library",
      genre: sepTag.includes("htdemucs") ? "AI 4-Stem" : "Local Import",
      year: String(new Date().getFullYear()),
      bpm: +Number(grid.bpm).toFixed(2),
      raw_bpm: +Number(grid.bpm).toFixed(2),
      bpb: grid.bpb,
      key: keyInfo.name,
      camelot: keyInfo.camelot,
      tonic: keyInfo.tonic,
      mode: keyInfo.mode,
      duration: +duration.toFixed(2),
      separation: sepTag,
      created: Date.now() / 1000,
      loudness: {},
      has_vocals: arrayRms(stems.vocals.left) >= 1e-4,
      core_grid: { bpm: grid.bpm, bpb: grid.bpb, audit: grid.audit, quantized: false, sig: grid.sig },
    };

    const detail = {
      id: sid,
      title: baseName,
      duration: +duration.toFixed(4),
      raw_bpm: grid.bpm,
      key: keyInfo.name,
      camelot: keyInfo.camelot,
      tonic: keyInfo.tonic,
      mode: keyInfo.mode,
      separation: sepTag,
      stem_scale: 1.0,
      loudness: {},
      stems: [...STEMS],
      grid,
    };

    await dbPut("songs", { id: sid, summary: songSummary, detail });
    onProgress(1.0, "Ready in browser library!");
    return { sid, summary: songSummary, detail };
  }

  async function autoFixLocalGrid(detail) {
    const sid = detail.id;
    const prev = detail.grid || {};
    const { left, right, source } = await loadLocalBeatStereo(sid, "raw");
    const preferBpm = prev._userOctaveBpm || null;
    const grid = detectAndBuildGrid(left, right, sid, detail.title || sid, {
      bpb: prev.bpb || 4,
      preferBpm,
      onsetSource: source,
    });
    if (preferBpm) grid._userOctaveBpm = preferBpm;
    detail.grid = grid;
    await saveLocalGridToDB(sid, grid);
    return grid;
  }

  async function updateLocalGrid(detail, payload = {}) {
    const sid = detail.id;
    const g = detail.grid;
    if (!g?.beats?.length) throw new Error("Grid missing");
    const bpb = Number(payload.bpb || g.bpb || 4);
    let beats = [...g.beats];

    if (payload.nudge_ms) {
      const dt = Number(payload.nudge_ms) / 1000;
      beats = beats.map((x) => +(x + dt).toFixed(5)).filter((x) => x >= 0);
    }
    const factor = Number(payload.factor || 1);
    if (Math.abs(factor - 2) < 1e-3) {
      const out = [];
      for (let i = 0; i < beats.length - 1; i++) {
        out.push(beats[i], +((beats[i] + beats[i + 1]) * 0.5).toFixed(5));
      }
      out.push(beats[beats.length - 1]);
      beats = out;
    } else if (Math.abs(factor - 0.5) < 1e-3 && beats.length >= 8) {
      const off = Number(g.downbeat_offset || 0) % 2;
      beats = beats.filter((_, i) => i % 2 === off);
    }

    const downOff = ((Number(g.downbeat_offset || 0) + Number(payload.downbeat_shift || 0)) % bpb + bpb) % bpb;
    const bars = [];
    for (let i = downOff; i < beats.length; i += bpb) bars.push(i);
    const bpm = +(60 / medianDiff(beats)).toFixed(4);

    // Re-audit immediately against REAL stored drum hits so UI stays 100% honest!
    const { left, right } = await loadLocalBeatStereo(sid, "raw");
    const n = Math.min(left.length, right.length);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (left[i] + right[i]);
    const { body, bodySmooth, fps } = onsetCurves500Hz(mono, SR);
    const aud = auditBeatsJS(beats, body, bodySmooth, fps);
    aud.note = `User adjusted (${aud.median_offset_ms.toFixed(1)} ms median vs drum hits)`;

    g.beats = beats;
    g.bars = bars;
    g.bpb = bpb;
    g.downbeat_offset = downOff;
    g.bpm = bpm;
    g.mode = "user";
    g.audit = aud;
    g.updated = Date.now() / 1000;
    if (Math.abs(factor - 2) < 1e-3 || Math.abs(factor - 0.5) < 1e-3) {
      g._userOctaveBpm = bpm;
    }
    const newSig = gridSigJS(g);
    g.sig = newSig;
    if (g.quantized && g.quantized.sig !== newSig) g.quantized = null;

    await saveLocalGridToDB(sid, g);
    return g;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function quantizeLocalSong(detail, onProgress = () => {}) {
    const sid = detail.id;
    const g = detail.grid;
    const beats = g.beats;
    if (!beats || beats.length < 8) throw new Error("Not enough beats to quantize");

    const period = medianDiff(beats);
    let t0 = beats[0];
    let dstBeats = beats.map((_, j) => t0 + j * period);
    const oldRev = g.quantized?.rev || null;
    const rev = `Q_${g.sig}_${Math.floor(Date.now() / 1000)}`;

    const rendered = {};
    const pilotCache = new Map();
    let usedMethod = "r3-wasm";
    for (let k = 0; k < STEMS.length; k++) {
      const st = STEMS[k];
      const baseProg = 0.06 + 0.78 * (k / 4);
      onProgress(baseProg, `Rubber Band R3 WASM: ${st} (${k + 1}/4)...`);
      await tick();
      const blob = await dbGet("blobs", `${sid}|raw|${st}`);
      if (!blob) throw new Error(`Missing local stem blob for ${st}`);
      const dec = await decodeTo44kStereo(await blob.arrayBuffer());
      // Skip R3 completely on silent stems (e.g. Direct Import zero-filled stems!)
      if (arrayRms(dec.left) < 1e-5 && arrayRms(dec.right) < 1e-5) {
        const lastSrc = beats[beats.length - 1], lastDst = dstBeats[dstBeats.length - 1];
        const slopeEnd = (beats[beats.length - 1] - beats[beats.length - 2]) / Math.max(1e-6, dstBeats[dstBeats.length - 1] - dstBeats[dstBeats.length - 2]);
        const nOut = Math.max(1, Math.ceil((lastDst + (dec.left.length / SR - lastSrc) / Math.max(0.25, slopeEnd)) * SR));
        rendered[st] = { left: new Float32Array(nOut), right: new Float32Array(nOut), method: "silent" };
        continue;
      }
      try {
        rendered[st] = await stretchBeatsR3Wasm(dec.left, dec.right, beats, dstBeats, st, pilotCache, (frac) => {
          onProgress(baseProg + 0.18 * frac, `Rubber Band R3 WASM: ${st} (${k + 1}/4 · ${Math.round(frac * 100)}%)...`);
        });
        if (st === "drums" || usedMethod === "r3-wasm") usedMethod = rendered[st].method || "r3-wasm";
      } catch (err) {
        console.warn("Rubber Band R3 WASM unavailable, falling back to resampler:", err);
        rendered[st] = { ...resampleTimeMap(dec.left, dec.right, beats, dstBeats, SR), method: "varispeed" };
        usedMethod = "varispeed";
      }
    }

    // Align lengths across all 4 quantized stems & normalize peak safely if > 0.98
    const nMin = Math.min(...STEMS.map((st) => rendered[st].left.length));
    let peak = 0;
    for (const st of STEMS) {
      const L = rendered[st].left, R = rendered[st].right;
      for (let i = 0; i < nMin; i++) {
        const a = Math.abs(L[i]), b = Math.abs(R[i]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
    }
    const scale = peak > 0.98 ? +(Math.min(1.0, 0.96 / peak)).toFixed(6) : 1.0;

    for (const st of STEMS) {
      let L = rendered[st].left.subarray(0, nMin);
      let R = rendered[st].right.subarray(0, nMin);
      if (scale < 1.0) {
        const sL = new Float32Array(nMin), sR = new Float32Array(nMin);
        for (let i = 0; i < nMin; i++) { sL[i] = L[i] * scale; sR[i] = R[i] * scale; }
        L = sL; R = sR;
      }
      await dbPut("blobs", encodeStereoWav16(L, R, SR), `${sid}|${rev}|${st}`);
      await dbPut("blobs", computePeaksI8(L, R, SR, 100), `pk|${sid}|${rev}|${st}`);
    }

    onProgress(0.88, "Verifying quantized drum hits against grid...");
    await tick();
    const qDrumsMono = new Float32Array(nMin);
    const hasQDrums = arrayRms(rendered.drums.left) >= 1e-4 || arrayRms(rendered.drums.right) >= 1e-4;
    if (hasQDrums) {
      for (let i = 0; i < nMin; i++) qDrumsMono[i] = 0.5 * (rendered.drums.left[i] + rendered.drums.right[i]);
    } else {
      for (let i = 0; i < nMin; i++) {
        qDrumsMono[i] = 0.5 * (
          rendered.bass.left[i] + rendered.bass.right[i]
          + rendered.other.left[i] + rendered.other.right[i]
          + rendered.vocals.left[i] + rendered.vocals.right[i]
        );
      }
    }

    const { body, bodySmooth, fps } = onsetCurves500Hz(qDrumsMono, SR);
    let qAud = auditBeatsJS(dstBeats, body, bodySmooth, fps);
    // Lock residual uniform offset (3..25 ms) dead-center onto real hits (matching quantize.py!)
    const resMs = Number(qAud.signed_median_ms || 0);
    if (Math.abs(resMs) >= 3.0 && Math.abs(resMs) <= 25.0 && (t0 + resMs / 1000) >= 0) {
      t0 += resMs / 1000;
      dstBeats = beats.map((_, j) => t0 + j * period);
      qAud = auditBeatsJS(dstBeats, body, bodySmooth, fps);
    }
    qAud.note = `Verified quantized audio: ${qAud.median_offset_ms.toFixed(1)} ms median (max ${qAud.max_offset_ms.toFixed(1)} ms across ${qAud.active_windows} sections)`;

    // Clean up older quantized blobs from IndexedDB so SSD storage stays lean
    if (oldRev && oldRev !== rev) {
      for (const st of STEMS) {
        try { await dbDelete("blobs", `${sid}|${oldRev}|${st}`); } catch {}
        try { await dbDelete("blobs", `pk|${sid}|${oldRev}|${st}`); } catch {}
      }
    }

    g.quantized = {
      rev,
      sig: g.sig,
      bpm: +(60 / period).toFixed(4),
      period,
      t0: +t0.toFixed(6),
      n_samples: nMin,
      n_beats: dstBeats.length,
      scale,
      method: usedMethod,
      audit: qAud,
      created: Date.now() / 1000,
    };
    await saveLocalGridToDB(sid, g);
    onProgress(1.0, `Quantized (${usedMethod}) & verified (${qAud.median_offset_ms.toFixed(1)} ms)`);
    return g;
  }

  async function clearModelCache() {
    demucsState = { processor: null, provider: null };
    await dbDelete("models", MODEL_KEY);
  }

  async function clearAllLocalImports() {
    await dbClearStore("songs");
    await dbClearStore("blobs");
  }

  ROOT.RetexBrowserDSP = {
    detectHardware,
    hasCachedModel,
    clearModelCache,
    clearAllLocalImports,
    importFilesLocal,
    autoFixLocalGrid,
    updateLocalGrid,
    quantizeLocalSong,
    stretchSegmentR3,
    getAllLocalSongs: () => dbGetAll("songs"),
    getBlob: (key) => dbGet("blobs", key),
    // Exposed pure-DSP helpers for verification/benchmarking
    _dsp: { onsetCurves500Hz, detectAndBuildGrid, auditBeatsJS, resampleTimeMap, gridSigJS },
  };
})();
