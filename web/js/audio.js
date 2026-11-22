// Native Browser Web Audio Engine for Re-Tex Core
// - Zero-latency Play / Stop / Seek / Mute / Solo / Gain / Pan / HPF / LPF (< 1 ms, never blocked by Python!)
// - Lazy AudioBuffer caching with automatic RAM eviction when clips/lanes/songs/projects change
// - Seamless background hot-swap: plays instant preview while backend R3 warps, swaps R3 buffer in live!
// - Sample-accurate Web Audio Metronome Click & Grid Modal Audition with Click

import { S, clipTotalSemis, emit, songGrid, songMeta, songMult, songUseQuantized } from "./state.js";

let ctx = null;
let masterBus = null;
let masterComp = null;
let masterGain = null;
let pitchWorkletReady = false;
let pitchWorkletLoading = false;

const PITCH_WORKLET_CODE = `
class RetexPitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "semis", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.size = 4096;
    this.mask = 4095;
    this.grain = 2048;
    this.buf = [new Float32Array(4096), new Float32Array(4096)];
    this.wp = 0;
    this.ph = 0;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !out || !out.length) return true;
    const semis = params.semis[0];
    const n = out[0].length;
    const chs = Math.min(2, out.length);
    if (Math.abs(semis) < 0.01) {
      for (let c = 0; c < chs; c++) out[c].set(inp[Math.min(c, inp.length - 1)]);
      return true;
    }
    const ratio = Math.pow(2, semis / 12);
    const step = (1 - ratio) / this.grain;
    const mask = this.mask, grain = this.grain;
    for (let i = 0; i < n; i++) {
      const wp = this.wp;
      for (let c = 0; c < chs; c++) {
        this.buf[c][wp] = inp[Math.min(c, inp.length - 1)][i];
      }
      let p1 = this.ph;
      let p2 = p1 + 0.5;
      if (p2 >= 1) p2 -= 1;
      const d1 = p1 * grain, d2 = p2 * grain;
      const w1 = 0.5 * (1 - Math.cos(2 * Math.PI * p1));
      const w2 = 1 - w1;
      const r1 = wp - d1, r2 = wp - d2;
      const i1 = Math.floor(r1), f1 = r1 - i1;
      const i2 = Math.floor(r2), f2 = r2 - i2;
      const a1 = i1 & mask, b1 = (i1 + 1) & mask;
      const a2 = i2 & mask, b2 = (i2 + 1) & mask;
      for (let c = 0; c < chs; c++) {
        const b = this.buf[c];
        const s1 = b[a1] * (1 - f1) + b[b1] * f1;
        const s2 = b[a2] * (1 - f2) + b[b2] * f2;
        out[c][i] = s1 * w1 + s2 * w2;
      }
      this.wp = (wp + 1) & mask;
      let np = p1 + step;
      if (np >= 1) np -= 1;
      else if (np < 0) np += 1;
      this.ph = np;
    }
    return true;
  }
}
registerProcessor("retex-pitch", RetexPitchProcessor);
`;

function loadPitchWorklet(ac) {
  if (!ac?.audioWorklet || pitchWorkletReady || pitchWorkletLoading) return;
  pitchWorkletLoading = true;
  try {
    const url = URL.createObjectURL(new Blob([PITCH_WORKLET_CODE], { type: "application/javascript" }));
    ac.audioWorklet.addModule(url).then(() => {
      pitchWorkletReady = true;
      URL.revokeObjectURL(url);
      if (isPlaying) rescheduleLive();
    }).catch(() => { pitchWorkletLoading = false; });
  } catch {
    pitchWorkletLoading = false;
  }
}

// Reference-counted browser AudioBuffer cache
// key -> { buffer: AudioBuffer, scale: number, t0: number, bytes: number }
const cache = new Map();
// key -> { promise: Promise, label: string, startedAt: number }
const loading = new Map();
// Load concurrency limiter so decoding doesn't hitch the UI thread
const loadQueue = [];
let activeLoads = 0;
const MAX_CONCURRENT_LOADS = 2;

// Current project's warp plan from backend
let clipReadyWarps = {};   // clipId -> { key, t0 }
let clipPendingWarps = {}; // clipId -> key
let lastKeepKeys = new Set();

// Live playback state
let isPlaying = false;
let anchorBeat = 0;
let anchorCtxTime = 0;
let playBpm = 128;
let activeSources = [];         // [{ src, gain, clipId }]
let trackNodes = new Map();     // trackId -> { input, hpf, lpf, panner, gain }
let schedTimer = null;
let nextClickBeat = 0;
let arrangementEndBeat = 0;

// Standalone audition state (Library preview & Grid Modal Raw/Quantized + Click)
let audState = null; // { sid, sources: [], startCtxTime, startSec, duration, clickBeats, downOff, bpb, clickTimer, nextClickIdx }
let audCache = new Map(); // small 1-song audition cache (pruned whenever song changes)
let audCacheSid = null;

// Pre-built click AudioBuffers
let clickBufs = null;

function ensureContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ sampleRate: 44100 });
    masterBus = ctx.createGain();
    masterComp = ctx.createDynamicsCompressor();
    masterComp.threshold.value = -14;
    masterComp.knee.value = 8;
    masterComp.ratio.value = 2.5;
    masterComp.attack.value = 0.015;
    masterComp.release.value = 0.18;
    masterGain = ctx.createGain();
    masterGain.gain.value = Number(S.transport.volume ?? 1.0);

    masterBus.connect(masterComp);
    masterComp.connect(masterGain);
    masterGain.connect(ctx.destination);
    buildClickBuffers();
    loadPitchWorklet(ctx);
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

function buildClickBuffers() {
  if (!ctx || clickBufs) return;
  const sr = ctx.sampleRate;
  const make = (freq, level) => {
    const n = Math.floor(0.045 * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const ch = buf.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 16807) % 2147483647;
      const rnd = (seed / 2147483647) * 2 - 1;
      const snap = rnd * Math.exp(-i / (sr * 0.0015)) * 0.55;
      const tone = Math.sin((2 * Math.PI * freq * i) / sr) * Math.exp(-i / (sr * 0.011));
      ch[i] = (snap + tone) * level;
    }
    return buf;
  };
  clickBufs = [make(2000, 0.45), make(2800, 0.72), make(3600, 0.88)];
}

// ------------------------------------------------------------------ Cache & Loader

export function getCacheStats() {
  let bytes = 0;
  for (const v of cache.values()) bytes += v.bytes;
  for (const v of audCache.values()) bytes += v.bytes;
  const activeLoading = [...loading.values()].map((x) => ({ label: x.label, startedAt: x.startedAt }));
  return {
    count: cache.size,
    mb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
    loadingCount: loading.size,
    loadingItems: activeLoading,
  };
}

export function getClipAudioStatus(c) {
  if (!c || c.mute) return "ready";
  const rw = clipReadyWarps[c.id];
  if (rw) {
    const k = `warp:${rw.key}`;
    if (cache.has(k)) return "ready";
    if (loading.has(k)) return "loading";
    return "loading";
  }
  const sk = sourceCacheKeyForClip(c);
  if (cache.has(sk)) return clipPendingWarps[c.id] ? "preview" : "ready";
  return "loading";
}

function sourceCacheKeyForClip(c) {
  const g = songGrid(c.song);
  const useQ = songUseQuantized(c.song);
  const qRev = useQ && g?.quantized?.rev ? g.quantized.rev : "";
  return `src:${c.song}:${c.stem}:${qRev || "raw"}`;
}

function enqueueLoad(key, url, label, kind) {
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (loading.has(key)) return loading.get(key).promise;

  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  loading.set(key, { promise, label, startedAt: Date.now() });
  emit("audio_cache");

  loadQueue.push({ key, url, label, kind, resolveFn, rejectFn });
  pumpLoadQueue();
  return promise;
}

function pumpLoadQueue() {
  while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const task = loadQueue.shift();
    if (!lastKeepKeys.has(task.key) && task.kind !== "audition") {
      // Cancelled before start because clip/lane was removed!
      loading.delete(task.key);
      task.resolveFn(null);
      emit("audio_cache");
      continue;
    }
    activeLoads++;
    runLoadTask(task).finally(() => {
      activeLoads--;
      pumpLoadQueue();
    });
  }
}

async function runLoadTask(task) {
  try {
    const ac = ensureContext();
    const r = await fetch(task.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const scale = parseFloat(r.headers.get("X-Stem-Scale") || "1") || 1.0;
    const t0 = parseFloat(r.headers.get("X-Warp-T0") || "0") || 0.0;
    const ab = await r.arrayBuffer();
    const buffer = await ac.decodeAudioData(ab);
    const bytes = buffer.length * buffer.numberOfChannels * 4;
    const entry = { buffer, scale, t0, bytes };

    if (task.kind === "audition") {
      audCache.set(task.key, entry);
    } else if (lastKeepKeys.has(task.key)) {
      cache.set(task.key, entry);
    }
    loading.delete(task.key);
    emit("audio_cache");
    task.resolveFn(entry);
    // If playing and a needed buffer just became ready, hot-swap it into live playback seamlessly!
    if (task.kind !== "audition" && isPlaying && lastKeepKeys.has(task.key)) {
      rescheduleLive();
    }
  } catch (e) {
    loading.delete(task.key);
    emit("audio_cache");
    task.rejectFn(e);
  }
}

export function pruneCache(keepSet = null) {
  const keep = keepSet || lastKeepKeys;
  let removed = 0;
  for (const k of [...cache.keys()]) {
    if (!keep.has(k)) {
      cache.delete(k);
      removed++;
    }
  }
  if (removed > 0) emit("audio_cache");
  return removed;
}

export function syncProjectPlan(project, readyKeys = null, pendingKeys = null) {
  if (!project) return;
  if (readyKeys !== null) clipReadyWarps = readyKeys || {};
  if (pendingKeys !== null) clipPendingWarps = pendingKeys || {};

  const keep = new Set();
  const toLoad = [];

  for (const c of project.clips || []) {
    if (c.mute || Number(c.len || 0) <= 0) continue;
    const rw = clipReadyWarps[c.id];
    const meta = songMeta(c.song);
    const title = (meta?.title || c.song).slice(0, 22);

    if (rw) {
      const wk = `warp:${rw.key}`;
      keep.add(wk);
      if (!cache.has(wk)) {
        toLoad.push({ key: wk, url: `/api/audio/warp/${encodeURIComponent(rw.key)}`, label: `${title} · ${c.stem} (R3)` });
        // Keep existing preview buffer alive ONLY until the new R3 buffer finishes decoding (zero gap!)
        const sk = sourceCacheKeyForClip(c);
        if (cache.has(sk)) keep.add(sk);
      }
    } else {
      const sk = sourceCacheKeyForClip(c);
      keep.add(sk);
      if (!cache.has(sk)) {
        const g = songGrid(c.song);
        const useQ = songUseQuantized(c.song);
        const qRev = useQ && g?.quantized?.rev ? g.quantized.rev : "";
        const qParam = qRev ? `?q=${encodeURIComponent(qRev)}` : "";
        toLoad.push({
          key: sk,
          url: `/api/audio/source/${encodeURIComponent(c.song)}/${encodeURIComponent(c.stem)}${qParam}`,
          label: `${title} · ${c.stem}`,
        });
      }
    }
  }

  lastKeepKeys = keep;
  pruneCache(keep);

  // Deduplicate load requests
  const seen = new Set();
  for (const item of toLoad) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    enqueueLoad(item.key, item.url, item.label, "project").then(() => {
      // Once an R3 warp finishes loading, prune any superseded preview buffers immediately!
      if (item.key.startsWith("warp:") && S.project) {
        recomputeKeepAndPrune(S.project);
      }
    }).catch(() => {});
  }

  if (isPlaying) {
    updateMixControls(project);
  }
}

function recomputeKeepAndPrune(project) {
  const keep = new Set();
  for (const c of project.clips || []) {
    if (c.mute || Number(c.len || 0) <= 0) continue;
    const rw = clipReadyWarps[c.id];
    if (rw && cache.has(`warp:${rw.key}`)) {
      keep.add(`warp:${rw.key}`);
    } else if (rw) {
      keep.add(`warp:${rw.key}`);
      const sk = sourceCacheKeyForClip(c);
      if (cache.has(sk)) keep.add(sk);
    } else {
      keep.add(sourceCacheKeyForClip(c));
    }
  }
  lastKeepKeys = keep;
  pruneCache(keep);
}

export function onWarpReady(key, t0) {
  if (!S.project) return;
  let matched = false;
  for (const [cid, pKey] of Object.entries(clipPendingWarps)) {
    if (pKey === key) {
      clipReadyWarps[cid] = { key, t0 };
      delete clipPendingWarps[cid];
      matched = true;
    }
  }
  if (matched) {
    syncProjectPlan(S.project, clipReadyWarps, clipPendingWarps);
  }
}

// ------------------------------------------------------------------ Track Mixer Graph (Live zero-restart updates!)

function ensureTrackNodes(project) {
  const ac = ensureContext();
  const validIds = new Set((project.tracks || []).map((t) => t.id));
  for (const [tid, n] of [...trackNodes.entries()]) {
    if (!validIds.has(tid)) {
      try { n.gain.disconnect(); } catch {}
      trackNodes.delete(tid);
    }
  }
  for (const t of project.tracks || []) {
    if (!trackNodes.has(t.id)) {
      const input = ac.createGain();
      const hpf = ac.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = 10;
      const lpf = ac.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = 22000;
      const panner = ac.createStereoPanner();
      const gain = ac.createGain();
      input.connect(hpf);
      hpf.connect(lpf);
      lpf.connect(panner);
      panner.connect(gain);
      gain.connect(masterBus);
      trackNodes.set(t.id, { input, hpf, lpf, panner, gain });
    }
  }
}

export function updateMixControls(project) {
  if (!ctx || !project) return;
  ensureTrackNodes(project);
  const now = ctx.currentTime;
  const anySolo = (project.tracks || []).some((t) => t.solo);
  for (const t of project.tracks || []) {
    const n = trackNodes.get(t.id);
    if (!n) continue;
    const audible = !t.mute && (t.solo || !anySolo);
    const lin = audible ? Math.pow(10, Number(t.gain_db || 0) / 20) : 0.0;
    n.gain.gain.setTargetAtTime(lin, now, 0.012);
    n.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, Number(t.pan || 0))), now, 0.012);
    const hf = Number(t.hpf || 0);
    n.hpf.frequency.setTargetAtTime(hf > 20 ? hf : 10, now, 0.015);
    const lf = Number(t.lpf || 0);
    n.lpf.frequency.setTargetAtTime(lf > 200 && lf < 20000 ? lf : 22000, now, 0.015);
  }
}

export function setMasterVolume(v) {
  S.transport.volume = Math.max(0, Math.min(2, Number(v)));
  if (masterGain && ctx) {
    masterGain.gain.setTargetAtTime(S.transport.volume, ctx.currentTime, 0.01);
  }
}

export function setClickEnabled(on) {
  S.transport.click = Boolean(on);
  emit("transport");
}

// ------------------------------------------------------------------ Live Timeline Playback (< 1 ms Play/Stop/Seek!)

function computeJoins(project) {
  const joins = new Set();
  const by = new Map();
  for (const c of project.clips || []) {
    if (c.mute || Number(c.len || 0) <= 0) continue;
    const k = `${c.track}|${c.song}|${c.stem}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c);
  }
  for (const list of by.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.start - b.start);
    const mult = songMult(list[0].song);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      const ra = Number(a.rate || 1);
      const rb = Number(b.rate || 1);
      if (
        Math.abs(b.start - (a.start + a.len)) < 1e-3 &&
        Math.abs(ra - rb) < 1e-5 &&
        Math.abs(Number(a.pitch || 0) - Number(b.pitch || 0)) < 1e-3 &&
        Math.abs(Number(a.gain_db || 0) - Number(b.gain_db || 0)) < 1e-3 &&
        Math.abs(b.src - (a.src + (a.len * ra) / mult)) < 1e-2
      ) {
        joins.add(`${a.id}|out`);
        joins.add(`${b.id}|in`);
      }
    }
  }
  return joins;
}

function stopActiveSources(fadeSec = 0.008) {
  const now = ctx ? ctx.currentTime : 0;
  for (const item of activeSources) {
    try {
      item.gain.gain.cancelScheduledValues(now);
      item.gain.gain.setValueAtTime(item.gain.gain.value, now);
      item.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      item.src.stop(now + fadeSec + 0.004);
    } catch {}
  }
  activeSources = [];
}

function scheduleClipsFrom(startBeat) {
  const project = S.project;
  if (!project || !ctx) return;
  ensureTrackNodes(project);
  updateMixControls(project);

  const ac = ctx;
  const now = ac.currentTime + 0.015; // 15 ms tiny scheduling headroom for click-free start
  anchorBeat = Math.max(0, startBeat);
  anchorCtxTime = now;
  playBpm = Number(project.bpm || 128);
  const secPerBeat = 60.0 / playBpm;
  const joins = computeJoins(project);

  arrangementEndBeat = Math.max(0, ...(project.clips || []).filter((c) => !c.mute).map((c) => c.start + c.len));
  nextClickBeat = Math.ceil(anchorBeat - 1e-6);

  const lp = project.loop;
  const loopActive = Boolean(lp?.on && lp.end > lp.start + 0.05);
  const stopHorizonBeat = loopActive ? lp.end : Infinity;

  for (const c of project.clips || []) {
    if (c.mute || Number(c.len || 0) <= 0) continue;
    const tNode = trackNodes.get(c.track);
    if (!tNode) continue;
    const cEnd = Math.min(c.start + c.len, stopHorizonBeat);
    if (cEnd <= anchorBeat + 1e-4) continue;
    if (c.start >= stopHorizonBeat - 1e-4) continue;

    // Pick ready R3 warp buffer if cached, otherwise instant preview source buffer!
    const rw = clipReadyWarps[c.id];
    const warpEntry = rw ? cache.get(`warp:${rw.key}`) : null;
    const srcEntry = !warpEntry ? cache.get(sourceCacheKeyForClip(c)) : null;
    if (!warpEntry && !srcEntry) continue;

    const mult = songMult(c.song);
    const rate = Number(c.rate || 1.0);
    let buffer;
    let pbRate = 1.0;
    let clipStartOffSec = 0.0;
    let scaleComp = 1.0;

    if (warpEntry) {
      buffer = warpEntry.buffer;
      pbRate = rate;
      clipStartOffSec = Number(c.src) * mult * secPerBeat - warpEntry.t0;
    } else {
      const g = songGrid(c.song);
      if (!g) continue;
      const useQ = songUseQuantized(c.song);
      const pSrc = useQ && g.quantized?.period ? Number(g.quantized.period) : 60.0 / Number(g.bpm || 120);
      const t0Src = useQ && g.quantized ? Number(g.quantized.t0) : Number(g.beats?.[0] || 0);
      buffer = srcEntry.buffer;
      scaleComp = srcEntry.scale > 1e-5 ? 1.0 / srcEntry.scale : 1.0;
      pbRate = Math.max(0.25, Math.min(4.0, (pSrc / (secPerBeat * mult)) * rate));
      clipStartOffSec = t0Src + Number(c.src) * pSrc;
    }

    const playStartBeat = Math.max(anchorBeat, c.start);
    const playDurBeats = cEnd - playStartBeat;
    if (playDurBeats <= 1e-4) continue;

    let when = now + (playStartBeat - anchorBeat) * secPerBeat;
    let playWallSec = playDurBeats * secPerBeat;
    let offsetSec = clipStartOffSec + (playStartBeat - c.start) * secPerBeat * pbRate;

    if (offsetSec < 0) {
      const shiftWall = -offsetSec / pbRate;
      if (shiftWall >= playWallSec) continue;
      when += shiftWall;
      playWallSec -= shiftWall;
      offsetSec = 0;
    }
    if (offsetSec >= buffer.duration - 0.005) continue;
    const maxWall = (buffer.duration - offsetSec) / pbRate;
    playWallSec = Math.min(playWallSec, maxWall);
    if (playWallSec <= 0.004) continue;

    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pbRate;

    const cg = ac.createGain();
    const baseGain = Math.pow(10, Number(c.gain_db || 0) / 20) * scaleComp;
    const endTime = when + playWallSec;

    // Fade-in & fade-out automation (preserving seamless joins)
    const fiSec = joins.has(`${c.id}|in`) ? 0 : Math.max(0.003, Number(c.fade_in || 0) * secPerBeat);
    const foSec = joins.has(`${c.id}|out`) ? 0 : Math.max(0.003, Number(c.fade_out || 0.04) * secPerBeat);
    const clipAbsStart = now + (c.start - anchorBeat) * secPerBeat;
    const clipAbsEnd = now + (c.start + c.len - anchorBeat) * secPerBeat;

    // Starting gain at `when`
    let gAtStart = baseGain;
    if (fiSec > 0 && when < clipAbsStart + fiSec) {
      const frac = Math.max(0, (when - clipAbsStart) / fiSec);
      gAtStart = baseGain * frac;
      cg.gain.setValueAtTime(gAtStart, when);
      cg.gain.linearRampToValueAtTime(baseGain, Math.min(endTime, clipAbsStart + fiSec));
    } else {
      cg.gain.setValueAtTime(0.0001, Math.max(now, when - 0.001));
      cg.gain.linearRampToValueAtTime(baseGain, when + 0.004);
    }

    if (foSec > 0 && endTime > clipAbsEnd - foSec) {
      const foStart = Math.max(when, clipAbsEnd - foSec);
      if (foStart > when) cg.gain.setValueAtTime(baseGain, foStart);
      cg.gain.linearRampToValueAtTime(0.0001, endTime);
    }

    const totalSemis = clipTotalSemis(c);
    // Keep tonal stems locked to original key while Web Audio playbackRate plays instant preview
    const rateCompSemis = (!warpEntry && c.stem !== "drums" && Math.abs(pbRate - 1.0) > 0.012)
      ? -12 * Math.log2(pbRate)
      : 0;
    const effSemis = totalSemis + rateCompSemis;
    if (!warpEntry && pitchWorkletReady && Math.abs(effSemis) > 0.05) {
      try {
        const pn = new AudioWorkletNode(ac, "retex-pitch", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        pn.parameters.get("semis").setValueAtTime(Math.max(-12, Math.min(12, effSemis)), when);
        src.connect(pn);
        pn.connect(cg);
      } catch {
        src.connect(cg);
      }
    } else {
      src.connect(cg);
    }
    cg.connect(tNode.input);
    src.start(when, offsetSec);
    src.stop(endTime + 0.002);
    activeSources.push({ src, gain: cg, clipId: c.id });
  }
}

function schedulerTick() {
  if (!isPlaying || !ctx || !S.project) return;
  const now = ctx.currentTime;
  const secPerBeat = 60.0 / playBpm;
  const curBeat = getPlayBeat();

  // Handle loop wrap
  const lp = S.project.loop;
  if (lp?.on && lp.end > lp.start + 0.05 && curBeat >= lp.end - 0.015) {
    stopActiveSources(0.005);
    scheduleClipsFrom(lp.start);
    return;
  }

  // Auto-stop shortly after arrangement end when loop is off
  if ((!lp || !lp.on) && arrangementEndBeat > 0 && curBeat >= arrangementEndBeat + 0.5) {
    stop();
    return;
  }

  // Schedule sample-accurate metronome clicks 140 ms ahead
  if (S.transport.click && clickBufs) {
    const bpb = Math.max(1, Number(S.project.bpb || 4));
    const horizonBeat = anchorBeat + (now + 0.14 - anchorCtxTime) / secPerBeat;
    while (nextClickBeat <= horizonBeat) {
      if (lp?.on && lp.end > lp.start + 0.05 && nextClickBeat >= lp.end) break;
      const t = anchorCtxTime + (nextClickBeat - anchorBeat) * secPerBeat;
      if (t >= now - 0.01) {
        const k = Math.round(nextClickBeat);
        const buf = k % (4 * bpb) === 0 ? clickBufs[2] : k % bpb === 0 ? clickBufs[1] : clickBufs[0];
        const s = ctx.createBufferSource();
        s.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = Number(S.transport.click_gain ?? 0.45);
        s.connect(g);
        g.connect(masterGain);
        s.start(Math.max(now, t));
      }
      nextClickBeat += 1;
    }
  } else {
    nextClickBeat = Math.ceil(curBeat);
  }
}

export function getPlayBeat() {
  if (!isPlaying || !ctx) return Math.max(0, S.playheadBeat);
  const dt = Math.max(0, ctx.currentTime - anchorCtxTime);
  let b = anchorBeat + dt * (playBpm / 60);
  const lp = S.project?.loop;
  if (lp?.on && lp.end > lp.start + 0.05 && b >= lp.end) {
    b = lp.start + ((b - lp.start) % (lp.end - lp.start));
  }
  return Math.max(0, b);
}

export function isEnginePlaying() {
  return isPlaying;
}

export function play(fromBeat = null) {
  if (!S.project) return;
  stopAudition();
  ensureContext();
  const startB = fromBeat !== null ? Math.max(0, fromBeat) : Math.max(0, S.playheadBeat);
  stopActiveSources(0.005);
  isPlaying = true;
  scheduleClipsFrom(startB);
  if (schedTimer) clearInterval(schedTimer);
  schedTimer = setInterval(schedulerTick, 35);
  S.transport.playing = true;
  S.playheadBeat = startB;
  emit("transport");
}

export function stop() {
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  if (isPlaying) {
    S.playheadBeat = getPlayBeat();
    isPlaying = false;
    stopActiveSources(0.006);
  }
  S.transport.playing = false;
  emit("transport");
}

export function seek(beat) {
  const b = Math.max(0, Number(beat || 0));
  S.playheadBeat = b;
  if (isPlaying) {
    stopActiveSources(0.005);
    scheduleClipsFrom(b);
  }
  emit("playhead");
}

export function rescheduleLive() {
  if (!isPlaying || !S.project) return;
  const b = getPlayBeat();
  stopActiveSources(0.008);
  scheduleClipsFrom(b);
}

// ------------------------------------------------------------------ Standalone Browser Audition (Library & Grid Modal)

export async function auditionSong(sid, { stem = "mix", start_s = 0, quantized = false, click = false } = {}) {
  stop();
  stopAudition();
  const ac = ensureContext();

  const g = songGrid(sid);
  const useQ = Boolean(quantized && g?.quantized?.rev && g.quantized.sig === g.sig);
  const qRev = useQ ? g.quantized.rev : "";

  if (audCacheSid && audCacheSid !== sid) {
    audCache.clear();
  }
  audCacheSid = sid;

  const stemsToPlay = stem === "mix" ? ["drums", "bass", "other", "vocals"] : [stem];
  const entries = [];
  for (const st of stemsToPlay) {
    const pKey = `src:${sid}:${st}:${qRev || "raw"}`;
    const aKey = `aud:${sid}:${st}:${qRev || "raw"}`;
    if (cache.has(pKey)) {
      entries.push(cache.get(pKey));
    } else if (audCache.has(aKey)) {
      entries.push(audCache.get(aKey));
    } else {
      const qParam = qRev ? `?q=${encodeURIComponent(qRev)}` : "";
      const url = `/api/audio/source/${encodeURIComponent(sid)}/${encodeURIComponent(st)}${qParam}`;
      const ent = await enqueueLoad(aKey, url, `Audition · ${st}`, "audition");
      if (ent) entries.push(ent);
    }
  }
  if (!entries.length) return;

  const now = ac.currentTime + 0.02;
  const dur = Math.min(...entries.map((e) => e.buffer.duration));
  const offset = Math.max(0, Math.min(dur - 0.1, Number(start_s || 0)));
  const sources = [];

  for (const ent of entries) {
    const src = ac.createBufferSource();
    src.buffer = ent.buffer;
    const gn = ac.createGain();
    gn.gain.value = (ent.scale > 1e-5 ? 1.0 / ent.scale : 1.0) * 0.85;
    src.connect(gn);
    gn.connect(masterBus);
    src.start(now, offset);
    sources.push({ src, gain: gn });
  }

  let clickBeats = null;
  let downOff = 0;
  let bpb = 4;
  if (click && g) {
    downOff = Number(g.downbeat_offset || 0);
    bpb = Number(g.bpb || 4);
    if (useQ && g.quantized) {
      clickBeats = Array.from({ length: g.quantized.n_beats }, (_, k) => g.quantized.t0 + k * g.quantized.period);
    } else if (g.beats?.length) {
      clickBeats = g.beats;
    }
  }

  let nextIdx = 0;
  if (clickBeats) {
    while (nextIdx < clickBeats.length && clickBeats[nextIdx] < offset - 0.01) nextIdx++;
  }

  audState = {
    sid,
    sources,
    startCtxTime: now,
    startSec: offset,
    duration: dur,
    clickBeats,
    downOff,
    bpb,
    nextIdx,
    timer: null,
  };

  audState.timer = setInterval(() => {
    if (!audState || !ctx) return;
    const curS = getAuditionSec();
    if (curS === null || curS >= audState.duration) {
      stopAudition();
      return;
    }
    if (audState.clickBeats && clickBufs) {
      const horizonS = curS + 0.14;
      while (audState.nextIdx < audState.clickBeats.length && audState.clickBeats[audState.nextIdx] <= horizonS) {
        const idx = audState.nextIdx++;
        const bt = audState.clickBeats[idx];
        const t = audState.startCtxTime + (bt - audState.startSec);
        if (t >= ctx.currentTime - 0.01) {
          const isBar = ((idx - audState.downOff) % audState.bpb + audState.bpb) % audState.bpb === 0 && idx >= audState.downOff;
          const s = ctx.createBufferSource();
          s.buffer = isBar ? clickBufs[1] : clickBufs[0];
          const gNode = ctx.createGain();
          gNode.gain.value = 0.45;
          s.connect(gNode);
          gNode.connect(masterGain);
          s.start(Math.max(ctx.currentTime, t));
        }
      }
    }
  }, 35);

  emit("audition");
}

export function stopAudition() {
  if (!audState) return;
  if (audState.timer) clearInterval(audState.timer);
  const now = ctx ? ctx.currentTime : 0;
  for (const item of audState.sources) {
    try {
      item.gain.gain.setValueAtTime(item.gain.gain.value, now);
      item.gain.gain.linearRampToValueAtTime(0, now + 0.01);
      item.src.stop(now + 0.015);
    } catch {}
  }
  audState = null;
  emit("audition");
}

export function getAuditionSec() {
  if (!audState || !ctx) return null;
  const s = audState.startSec + Math.max(0, ctx.currentTime - audState.startCtxTime);
  return s <= audState.duration ? s : null;
}

export function getAuditionSid() {
  return audState ? audState.sid : null;
}

// ------------------------------------------------------------------ Browser Audio Output Device (Chrome setSinkId)

export async function listAudioOutputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === "audiooutput").map((d) => ({ id: d.deviceId, label: d.label || "Default Audio Output" }));
  } catch {
    return [];
  }
}

export async function setAudioOutput(deviceId) {
  const ac = ensureContext();
  if (typeof ac.setSinkId === "function") {
    await ac.setSinkId(deviceId || "");
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ Browser Offline WAV Export (for GitHub Pages Demo)

function encodeWav16(audioBuf) {
  const nCh = Math.min(2, audioBuf.numberOfChannels);
  const n = audioBuf.length;
  const sr = audioBuf.sampleRate;
  const dataBytes = n * nCh * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  const wrStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wrStr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  wrStr(8, "WAVE");
  wrStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nCh * 2, true);
  dv.setUint16(32, nCh * 2, true);
  dv.setUint16(34, 16, true);
  wrStr(36, "data");
  dv.setUint32(40, dataBytes, true);
  const chs = Array.from({ length: nCh }, (_, c) => audioBuf.getChannelData(c));
  let pos = 44;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, chs[c][i]));
      if (Math.abs(v) > peak) peak = Math.abs(v);
      dv.setInt16(pos, v < 0 ? v * 32768 : v * 32767, true);
      pos += 2;
    }
  }
  return { blob: new Blob([ab], { type: "audio/wav" }), peakDb: 20 * Math.log10(Math.max(1e-6, peak)) };
}

export async function renderOfflineWav(project) {
  const bpm = Number(project?.bpm || 128);
  const secPerBeat = 60.0 / bpm;
  const endBeat = Math.max(0, ...(project?.clips || []).filter((c) => !c.mute).map((c) => c.start + c.len));
  if (endBeat <= 0.1) throw new Error("No audible clips to export");
  const totalSec = endBeat * secPerBeat + 0.12;
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);

  const mBus = off.createGain();
  const comp = off.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 3.0;
  mBus.connect(comp);
  comp.connect(off.destination);

  const anySolo = (project.tracks || []).some((t) => t.solo);
  const tMap = new Map();
  for (const t of project.tracks || []) {
    const inp = off.createGain();
    const hpf = off.createBiquadFilter(); hpf.type = "highpass"; hpf.frequency.value = Number(t.hpf || 0) > 20 ? Number(t.hpf) : 10;
    const lpf = off.createBiquadFilter(); lpf.type = "lowpass"; lpf.frequency.value = Number(t.lpf || 0) > 200 ? Number(t.lpf) : 22000;
    const pan = off.createStereoPanner(); pan.pan.value = Math.max(-1, Math.min(1, Number(t.pan || 0)));
    const gn = off.createGain();
    const audible = !t.mute && (t.solo || !anySolo);
    gn.gain.value = audible ? Math.pow(10, Number(t.gain_db || 0) / 20) : 0;
    inp.connect(hpf); hpf.connect(lpf); lpf.connect(pan); pan.connect(gn); gn.connect(mBus);
    tMap.set(t.id, inp);
  }

  for (const c of project.clips || []) {
    if (c.mute || Number(c.len || 0) <= 0) continue;
    const dest = tMap.get(c.track);
    if (!dest) continue;
    const ent = cache.get(sourceCacheKeyForClip(c));
    if (!ent) continue;
    const g = songGrid(c.song);
    if (!g) continue;
    const useQ = songUseQuantized(c.song);
    const pSrc = useQ && g.quantized?.period ? Number(g.quantized.period) : 60.0 / Number(g.bpm || 120);
    const t0Src = useQ && g.quantized ? Number(g.quantized.t0) : Number(g.beats?.[0] || 0);
    const mult = songMult(c.song);
    const rate = Number(c.rate || 1.0);
    const pbRate = Math.max(0.25, Math.min(4.0, (pSrc / (secPerBeat * mult)) * rate));
    const when = Math.max(0, c.start * secPerBeat);
    const durWall = c.len * secPerBeat;
    const offSec = Math.max(0, t0Src + Number(c.src) * pSrc);
    const s = off.createBufferSource();
    s.buffer = ent.buffer;
    s.playbackRate.value = pbRate;
    const cg = off.createGain();
    const baseG = Math.pow(10, Number(c.gain_db || 0) / 20) * (ent.scale > 1e-5 ? 1 / ent.scale : 1);
    const fi = Math.max(0.004, Number(c.fade_in || 0) * secPerBeat);
    const fo = Math.max(0.004, Number(c.fade_out || 0.04) * secPerBeat);
    cg.gain.setValueAtTime(0.0001, when);
    cg.gain.linearRampToValueAtTime(baseG, Math.min(when + durWall, when + fi));
    cg.gain.setValueAtTime(baseG, Math.max(when + fi, when + durWall - fo));
    cg.gain.linearRampToValueAtTime(0.0001, when + durWall);
    s.connect(cg); cg.connect(dest);
    s.start(when, offSec);
    s.stop(when + durWall + 0.002);
  }

  const rendered = await off.startRendering();
  const { blob, peakDb } = encodeWav16(rendered);
  return { blob, seconds: Math.round(totalSec * 100) / 100, peakDb: Math.round(peakDb * 100) / 100 };
}

window.__retexRenderOfflineWav = renderOfflineWav;
