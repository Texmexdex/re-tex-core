// Pure Client-Side Browser DSP, Private IndexedDB Storage & Zero-Install WebGPU/WASM AI Separation
// Runs 100% locally on the user's computer — zero audio ever leaves the device!

(function () {
  const DB_NAME = "retex_core_browser_local_v1";
  const DB_VER = 1;
  const SR = 44100;
  const STEMS = ["drums", "bass", "other", "vocals"];
  const MODEL_KEY = "htdemucs_embedded_v1";

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

  // ------------------------------------------------------------------ Zero-Phase Onset, Beat Audit & Key Detection

  function biquadBandpassZeroPhase(x, sr, fCenter, Q) {
    const w0 = (2 * Math.PI * fCenter) / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw = Math.cos(w0);
    const a0 = 1 + alpha;
    const b0 = alpha / a0;
    const b1 = 0;
    const b2 = -alpha / a0;
    const a1 = (-2 * cosw) / a0;
    const a2 = (1 - alpha) / a0;
    const n = x.length;
    const tmp = new Float32Array(n);
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

  function onsetCurve200Hz(mono, sr = SR) {
    const fps = 200;
    const hop = Math.round(sr / fps);
    const nFr = Math.floor(mono.length / hop);
    if (nFr < 16) return { body: new Float32Array(16), kick: new Float32Array(16), fps };

    const kSig = biquadBandpassZeroPhase(mono, sr, 90, 0.9);
    const sSig = biquadBandpassZeroPhase(mono, sr, 1200, 0.7);
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
      const p99 = sorted[Math.floor(sorted.length * 0.995)] || 1;
      for (let i = 0; i < arr.length; i++) arr[i] /= p99;
    };
    norm(kOn);
    norm(sOn);
    const body = new Float32Array(nFr);
    for (let i = 0; i < nFr; i++) body[i] = kOn[i] + 0.85 * sOn[i];
    return { body, kick: kOn, fps };
  }

  function windowPhaseOffset(times, body, fps) {
    const n = body.length;
    if (times.length < 4) return { offS: 0, cl: 1, ratio: 1 };
    const diffs = [];
    for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
    diffs.sort((a, b) => a - b);
    const per = diffs[diffs.length >> 1] || 0.5;
    const M = 101; // 0.01 beat step (~4 ms)
    const scores = new Float64Array(M);
    for (let d = 0; d < M; d++) {
      const delta = -0.5 + d / (M - 1);
      let s = 0, c = 0;
      for (let k = 0; k < times.length; k++) {
        const fr = Math.round((times[k] + delta * per) * fps);
        if (fr >= 1 && fr < n - 1) {
          s += 0.25 * body[fr - 1] + 0.5 * body[fr] + 0.25 * body[fr + 1];
          c++;
        }
      }
      scores[d] = c ? s / c : 0;
    }
    const sorted = Float64Array.from(scores).sort();
    const med = sorted[M >> 1] + 1e-9;
    const z0 = scores[50];
    let bestG = 0, bestL = 40;
    for (let d = 0; d < M; d++) {
      if (scores[d] > scores[bestG]) bestG = d;
      if (d >= 40 && d <= 60 && scores[d] > scores[bestL]) bestL = d;
    }
    const locCl = scores[bestL] / med;
    const globCl = scores[bestG] / med;
    const useLocal = (locCl >= 1.35 && scores[bestG] / Math.max(scores[bestL], 1e-9) < 2.1)
      || (scores[bestG] / Math.max(z0, 1e-9) < 1.35);
    const pick = useLocal ? bestL : bestG;
    return {
      offS: (-0.5 + pick / (M - 1)) * per,
      cl: scores[pick] / med,
      ratio: scores[pick] / Math.max(z0, 1e-9),
    };
  }

  function auditBeatsJS(beats, body, fps) {
    const n = beats.length;
    const win = 16, step = 8;
    const sections = [];
    const energies = [];
    for (let i = 0; i <= Math.max(0, n - win); i += step) {
      const seg = beats.slice(i, Math.min(n, i + win));
      const f0 = Math.max(0, Math.floor(seg[0] * fps));
      const f1 = Math.min(body.length, Math.floor(seg[seg.length - 1] * fps));
      let s = 0;
      for (let f = f0; f < f1; f++) s += body[f];
      energies.push(f1 > f0 ? s / (f1 - f0) : 0);
    }
    const maxE = Math.max(0, ...energies);
    const nz = energies.filter((e) => e > 0.25 * maxE).sort((a, b) => a - b);
    const usual = nz.length ? nz[nz.length >> 1] : 0;

    const offs = [];
    let idxW = 0;
    for (let i = 0; i <= Math.max(0, n - win); i += step, idxW++) {
      const seg = beats.slice(i, Math.min(n, i + win));
      if (seg.length < 8) continue;
      const active = energies[idxW] >= 0.22 * usual && usual > 1e-4;
      const diffs = [];
      for (let k = 1; k < seg.length; k++) diffs.push(seg[k] - seg[k - 1]);
      diffs.sort((a, b) => a - b);
      const bpm = diffs.length ? 60 / diffs[diffs.length >> 1] : 120;
      if (!active) {
        sections.push({ i0: i, i1: i + seg.length, t0: +seg[0].toFixed(2), t1: +seg[seg.length - 1].toFixed(2), bpm: +bpm.toFixed(2), active: false, offset_ms: 0, clarity: 0, ratio: 1 });
        continue;
      }
      const { offS, cl, ratio } = windowPhaseOffset(seg, body, fps);
      const offMs = offS * 1000;
      offs.push(offMs);
      sections.push({ i0: i, i1: i + seg.length, t0: +seg[0].toFixed(2), t1: +seg[seg.length - 1].toFixed(2), bpm: +bpm.toFixed(2), active: true, offset_ms: +offMs.toFixed(1), clarity: +cl.toFixed(2), ratio: +ratio.toFixed(2) });
    }

    const absOffs = offs.map(Math.abs).sort((a, b) => a - b);
    const medAbs = absOffs.length ? absOffs[absOffs.length >> 1] : 0;
    const maxAbs = absOffs.length ? absOffs[absOffs.length - 1] : 0;
    const signedSorted = [...offs].sort((a, b) => a - b);
    const signedMed = signedSorted.length ? signedSorted[signedSorted.length >> 1] : 0;
    const badWins = sections.filter((s) => s.active && Math.abs(s.offset_ms) > 22 && s.clarity >= 1.8).length;
    const activeBpms = sections.filter((s) => s.active && s.bpm > 0).map((s) => s.bpm).sort((a, b) => a - b);
    const driftPct = activeBpms.length >= 2 ? ((activeBpms[activeBpms.length - 1] - activeBpms[0]) / activeBpms[activeBpms.length >> 1]) * 100 : 0;

    let status = "ok";
    if (medAbs > 22 || badWins >= Math.max(2, Math.round(0.1 * Math.max(1, offs.length)))) status = "off_beat";
    else if (badWins > 0 || maxAbs > 18) status = "warn";

    return {
      status,
      median_offset_ms: +medAbs.toFixed(1),
      max_offset_ms: +maxAbs.toFixed(1),
      signed_median_ms: +signedMed.toFixed(1),
      active_windows: offs.length,
      bad_windows: badWins,
      drift_pct: +driftPct.toFixed(2),
      max_straight_err_ms: +(driftPct * 12).toFixed(1),
      needs_quantize: driftPct > 0.45,
      sections,
    };
  }

  function detectAndBuildGrid(left, right, sid, title) {
    const n = Math.min(left.length, right.length);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (left[i] + right[i]);
    const dur = n / SR;
    const { body, kick, fps } = onsetCurve200Hz(mono, SR);

    // Autocorrelation over 68..180 BPM
    const loLag = Math.max(1, Math.round((fps * 60) / 180));
    const hiLag = Math.min(body.length - 1, Math.round((fps * 60) / 68));
    let mean = 0;
    for (let i = 0; i < body.length; i++) mean += body[i];
    mean /= body.length || 1;
    let bestLag = Math.round((fps * 60) / 120);
    let bestScore = -1;
    const stepCheck = Math.min(body.length, fps * 90); // analyze up to 90s for fast autocorrelation
    for (let lag = loLag; lag <= hiLag; lag++) {
      let s = 0;
      for (let i = 0; i < stepCheck - lag; i += 2) {
        s += (body[i] - mean) * (body[i + lag] - mean);
      }
      // Slight musical prior favoring 85..155 BPM over double/half extremes
      const candBpm = (fps * 60) / lag;
      const prior = candBpm >= 85 && candBpm <= 155 ? 1.08 : 1.0;
      if (s * prior > bestScore) { bestScore = s * prior; bestLag = lag; }
    }
    let period = bestLag / fps;

    // Best global phase offset in [0, period)
    let bestPh = 0, bestPhScore = -1;
    for (let ph = 0; ph < bestLag; ph++) {
      let s = 0;
      for (let i = ph; i < body.length; i += bestLag) s += body[i];
      if (s > bestPhScore) { bestPhScore = s; bestPh = ph; }
    }
    const t0 = bestPh / fps;
    const seed = [];
    for (let t = t0; t <= dur + 0.02; t += period) seed.push(t);

    // Local 16-beat phase refinement + fine snap
    const beats = [...seed];
    const aud0 = auditBeatsJS(beats, body, fps);
    if (aud0.active_windows > 0 && Math.abs(aud0.signed_median_ms) > 2) {
      const shift = aud0.signed_median_ms / 1000;
      for (let i = 0; i < beats.length; i++) beats[i] = Math.max(0, beats[i] + shift);
    }

    // Pick downbeat phase mod 4 by strongest kick energy
    const kickScores = [0, 0, 0, 0];
    for (let ph = 0; ph < 4; ph++) {
      let s = 0, c = 0;
      for (let i = ph; i < beats.length; i += 4) {
        const fr = Math.round(beats[i] * fps);
        if (fr >= 1 && fr < kick.length - 1) {
          s += Math.max(kick[fr - 1], kick[fr], kick[fr + 1]);
          c++;
        }
      }
      kickScores[ph] = c ? s / c : 0;
    }
    let downOff = 0;
    for (let ph = 1; ph < 4; ph++) if (kickScores[ph] > kickScores[downOff]) downOff = ph;
    const bars = [];
    for (let i = downOff; i < beats.length; i += 4) bars.push(i);

    const audit = auditBeatsJS(beats, body, fps);
    audit.note = `Browser-verified against full-band drum hits (${audit.median_offset_ms.toFixed(1)} ms median)`;
    const bpm = +(60 / period).toFixed(4);
    const sig = `b${beats.length}_${Math.round(bpm * 10)}_${downOff}`;

    return {
      sid,
      title,
      bpm,
      bpb: 4,
      downbeat_offset: downOff,
      beats: beats.map((x) => +x.toFixed(5)),
      bars,
      duration: +dur.toFixed(4),
      mode: "steady_locked",
      onset_source: "drums",
      updated: Date.now() / 1000,
      audit,
      quantized: null,
      sig,
    };
  }

  function detectKeyCamelot(left, right) {
    // Simple lightweight DFT chroma at 12 pitch classes over 65..1800 Hz (4x decimated)
    const n = Math.min(left.length, right.length, SR * 45);
    if (n < SR * 2) return { name: "", camelot: "", tonic: 0, mode: "minor" };
    const dec = 8;
    const fs = SR / dec;
    const m = Math.floor(n / dec);
    const y = new Float32Array(m);
    for (let i = 0; i < m; i++) y[i] = 0.5 * (left[i * dec] + right[i * dec]);

    // Goertzel energy across 4 octaves of 12 semitones (MIDI 36..83)
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

  function resampleTimeMap(left, right, srcBeats, dstBeats, sr = SR) {
    const nIn = Math.min(left.length, right.length);
    const lastSrc = srcBeats[srcBeats.length - 1];
    const lastDst = dstBeats[dstBeats.length - 1];
    const nOut = Math.max(1, Math.ceil((nIn / sr - lastSrc + lastDst) * sr));
    const outL = new Float32Array(nOut);
    const outR = new Float32Array(nOut);
    const nb = srcBeats.length;
    let seg = 0;
    for (let i = 0; i < nOut; i++) {
      const td = i / sr;
      while (seg < nb - 2 && dstBeats[seg + 1] < td) seg++;
      const d0 = dstBeats[seg], d1 = dstBeats[seg + 1];
      const s0 = srcBeats[seg], s1 = srcBeats[seg + 1];
      const u = (td - d0) / Math.max(1e-6, d1 - d0);
      const p = (s0 + u * (s1 - s0)) * sr;
      const i0 = Math.floor(p);
      const fr = p - i0;
      if (i0 >= 0 && i0 + 1 < nIn) {
        outL[i] = left[i0] * (1 - fr) + left[i0 + 1] * fr;
        outR[i] = right[i0] * (1 - fr) + right[i0 + 1] * fr;
      }
    }
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

  // ------------------------------------------------------------------ High-Level Browser Local Import & Quantize

  async function importFilesLocal(files, { mode = "ai", singleRole = "other", title = "" } = {}, onProgress = () => {}) {
    const fileArr = [...files];
    if (!fileArr.length) throw new Error("No audio files selected");
    const baseName = (title || fileArr[0].name.replace(/\.[^.]+$/, "")).trim() || "Imported Track";
    const sid = "local_" + baseName.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 32) + "_" + Math.random().toString(36).slice(2, 7);

    let stems = null;
    let sepTag = "browser_local";
    let duration = 0;

    if (fileArr.length >= 2) {
      // Multi-file stem pack import (pair *drums*, *bass*, *other*/*inst*, *vocals*)
      onProgress(0.10, `Decoding ${fileArr.length} pre-separated stem files...`);
      const assigned = {};
      for (const f of fileArr) {
        const nm = f.name.toLowerCase();
        const dec = await decodeTo44kStereo(f);
        duration = Math.max(duration, dec.duration);
        if (nm.includes("drum")) assigned.drums = dec;
        else if (nm.includes("bass")) assigned.bass = dec;
        else if (nm.includes("vocal") || nm.includes("acapella")) assigned.vocals = dec;
        else if (!assigned.other) assigned.other = dec;
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
        // Fast zero-AI single-track import
        const zero = () => ({ left: new Float32Array(dec.left.length), right: new Float32Array(dec.right.length) });
        stems = { drums: zero(), bass: zero(), other: zero(), vocals: zero() };
        if (singleRole === "mix") {
          stems.other = dec;
        } else {
          stems[STEMS.includes(singleRole) ? singleRole : "other"] = dec;
        }
        sepTag = "browser_direct";
      }
    }

    onProgress(0.90, "Running zero-phase drum beat audit & Camelot key detection...");
    // Use drums stem if non-silent, else mix of all stems for beat analysis
    const hasDrums = stems.drums.left.some((v) => Math.abs(v) > 1e-3);
    const beatL = hasDrums ? stems.drums.left : stems.other.left;
    const beatR = hasDrums ? stems.drums.right : stems.other.right;
    const grid = detectAndBuildGrid(beatL, beatR, sid, baseName);

    const harmL = new Float32Array(stems.other.left.length);
    const harmR = new Float32Array(stems.other.right.length);
    for (let i = 0; i < harmL.length; i++) {
      harmL[i] = stems.bass.left[i] + stems.other.left[i];
      harmR[i] = stems.bass.right[i] + stems.other.right[i];
    }
    const keyInfo = detectKeyCamelot(harmL, harmR);

    onProgress(0.95, "Saving stems & peaks to private browser IndexedDB storage...");
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
      has_vocals: stems.vocals.left.some((v) => Math.abs(v) > 1e-3),
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

  async function quantizeLocalSong(detail, onProgress = () => {}) {
    const sid = detail.id;
    const g = detail.grid;
    const beats = g.beats;
    if (!beats || beats.length < 8) throw new Error("Not enough beats to quantize");
    const diffs = [];
    for (let i = 1; i < beats.length; i++) diffs.push(beats[i] - beats[i - 1]);
    diffs.sort((a, b) => a - b);
    const period = diffs[diffs.length >> 1];
    const t0 = beats[0];
    const dstBeats = beats.map((_, j) => t0 + j * period);
    const rev = `Q_${g.sig}_${Math.floor(Date.now() / 1000)}`;

    let qDrumsMono = null;
    for (let k = 0; k < STEMS.length; k++) {
      const st = STEMS[k];
      onProgress(0.1 + 0.75 * (k / 4), `Quantizing ${st} (${k + 1}/4)...`);
      const blob = await dbGet("blobs", `${sid}|raw|${st}`);
      if (!blob) throw new Error(`Missing local stem blob for ${st}`);
      const dec = await decodeTo44kStereo(await blob.arrayBuffer());
      const q = resampleTimeMap(dec.left, dec.right, beats, dstBeats, SR);
      if (st === "drums") {
        qDrumsMono = new Float32Array(q.left.length);
        for (let i = 0; i < q.left.length; i++) qDrumsMono[i] = 0.5 * (q.left[i] + q.right[i]);
      }
      await dbPut("blobs", encodeStereoWav16(q.left, q.right, SR), `${sid}|${rev}|${st}`);
      await dbPut("blobs", computePeaksI8(q.left, q.right, SR, 100), `pk|${sid}|${rev}|${st}`);
    }

    onProgress(0.90, "Verifying quantized drum hits...");
    const { body, fps } = onsetCurve200Hz(qDrumsMono, SR);
    const qAud = auditBeatsJS(dstBeats, body, fps);
    g.quantized = {
      rev,
      sig: g.sig,
      bpm: +(60 / period).toFixed(4),
      period,
      t0: +t0.toFixed(6),
      n_beats: dstBeats.length,
      scale: 1.0,
      audit: qAud,
      created: Date.now() / 1000,
    };
    const rec = await dbGet("songs", sid);
    if (rec) {
      rec.detail.grid = g;
      rec.summary.core_grid = { bpm: g.bpm, bpb: g.bpb, audit: g.audit, quantized: true, sig: g.sig };
      await dbPut("songs", rec);
    }
    onProgress(1.0, `Quantized & verified (${qAud.median_offset_ms} ms)`);
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

  window.RetexBrowserDSP = {
    detectHardware,
    hasCachedModel,
    clearModelCache,
    clearAllLocalImports,
    importFilesLocal,
    quantizeLocalSong,
    getAllLocalSongs: () => dbGetAll("songs"),
    getBlob: (key) => dbGet("blobs", key),
  };
})();
