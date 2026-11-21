// Reactive DAW state, 150-step Undo/Redo, project operations & live audio sync

import * as api from "./api.js";

export const STEMS = ["drums", "bass", "other", "vocals"];
export const ROLE_COLORS = {
  drums: "#e8944a",
  bass: "#4ea4e8",
  other: "#63c97b",
  vocals: "#e06c9f",
  any: "#8b98a8",
};

const listeners = new Set();

export const S = {
  songs: [],
  folders: { folders: [], assign: {} },
  details: {},       // sid -> /api/songs/{sid} response (includes grid)
  peaks: {},         // `${sid}|${stem}|${qRev}` -> Int8Array
  peaksPending: new Set(),
  projects: [],
  project: null,
  selClips: new Set(),
  clipboard: [],     // { song, stem, role, src, len, gain_db, fade_in, fade_out, rate, pitch, keep_pitch, label, offsetBeats, trackIdx }
  transport: { playing: false, beat: 0, aud_s: null, bpm: 128, volume: 1.0, click: false, click_gain: 0.38, pending_warps: 0 },
  playheadBeat: 0,
  playClockAnchor: { beat: 0, ts: performance.now() },
  audAnchor: { s: null, ts: performance.now() },
  jobs: [],
  warpState: { pending: 0, done: 0, total: 0, active: null, queued: [] },
  pendingWarps: 0,
  busyOp: null,      // transient short backend op e.g. { label, startedAt }
  dirty: false,
  // External hook for audio engine (avoids circular module import)
  _audioHooks: null,
  // Timeline viewport
  view: {
    pxPerBeat: 28,
    scrollX: 0,      // pixels
    scrollY: 0,      // pixels
    trackH: 82,
    rulerH: 30,
  },
};

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 150;
let lastCoalesceKey = "";
let lastCoalesceTime = 0;
let saveTimer = null;
let syncTimer = null;

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(kind = "all") {
  for (const fn of listeners) {
    try { fn(kind); } catch (e) { console.error("listener error", e); }
  }
}

export function uid(prefix = "id") {
  return prefix + Math.random().toString(36).slice(2, 10);
}

export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function songMeta(sid) {
  return S.details[sid] || S.songs.find((s) => s.id === sid) || null;
}

export function songGrid(sid) {
  return S.details[sid]?.grid || null;
}

export function songUseQuantized(sid) {
  const sc = S.project?.songs?.[sid];
  const g = songGrid(sid);
  return Boolean(sc?.quantized && g?.quantized?.rev && g.quantized.sig === g.sig);
}

export function songMult(sid) {
  return Number(S.project?.songs?.[sid]?.mult || 1.0);
}

export function songBeatsCount(sid) {
  const g = songGrid(sid);
  if (!g) return 256;
  if (songUseQuantized(sid) && g.quantized?.n_beats) return Number(g.quantized.n_beats);
  return (g.beats?.length || 256);
}

export function clipTotalSemis(c) {
  if (!S.project || !c) return 0;
  const sc = S.project.songs?.[c.song] || {};
  const songTr = c.stem !== "drums" ? Number(sc.transpose || 0) : 0;
  const trk = (S.project.tracks || []).find((t) => t.id === c.track);
  const trkP = Number(trk?.pitch || 0);
  const clipP = Number(c.pitch || 0);
  return Math.round((songTr + trkP + clipP) * 1000) / 1000;
}

export function snapBeat(beat, forceOff = false) {
  const snap = Number(S.project?.snap ?? 1);
  if (forceOff || !snap || snap <= 0) return Math.max(0, beat);
  return Math.max(0, Math.round(beat / snap) * snap);
}

export function registerAudioHooks(hooks) {
  S._audioHooks = hooks;
}

export function currentBeat() {
  if (S._audioHooks?.getPlayBeat) return S._audioHooks.getPlayBeat();
  return Math.max(0, S.playheadBeat);
}

export function currentAudSec() {
  if (S._audioHooks?.getAuditionSec) return S._audioHooks.getAuditionSec();
  return null;
}

export function setPlayhead(beat) {
  S.playheadBeat = Math.max(0, beat);
  S.playClockAnchor = { beat: S.playheadBeat, ts: performance.now() };
  emit("playhead");
}

export function updateTransport(t) {
  if (!t) return;
  S.transport = { ...S.transport, ...t };
  if (typeof t.beat === "number") {
    S.playheadBeat = Math.max(0, t.beat);
    S.playClockAnchor = { beat: S.playheadBeat, ts: performance.now() };
  }
  if ("aud_s" in t) {
    S.audAnchor = { s: typeof t.aud_s === "number" ? t.aud_s : null, ts: performance.now() };
  }
  if (typeof t.pending_warps === "number") {
    S.pendingWarps = t.pending_warps;
  }
  emit("transport");
}

// ------------------------------------------------------------------ Detail & Peaks caching

export async function ensureSongDetail(sid, force = false) {
  if (!sid) return null;
  if (!force && S.details[sid]) return S.details[sid];
  const brief = S.songs.find((x) => x.id === sid)?.title || sid;
  S.busyOp = { label: `Analyzing beat grid: ${brief.slice(0, 26)}`, startedAt: Date.now() };
  emit("warps");
  try {
    const d = await api.get(`/api/songs/${encodeURIComponent(sid)}`);
    S.details[sid] = d;
    const idx = S.songs.findIndex((x) => x.id === sid);
    if (idx >= 0 && d.grid) {
      S.songs[idx] = {
        ...S.songs[idx],
        bpm: Math.round(Number(d.grid.bpm || S.songs[idx].bpm) * 100) / 100,
        core_grid: {
          bpm: d.grid.bpm,
          bpb: d.grid.bpb,
          audit: d.grid.audit,
          quantized: Boolean(d.grid.quantized),
          sig: d.grid.sig,
        },
      };
    }
    emit("song_detail");
    return d;
  } finally {
    S.busyOp = null;
    emit("warps");
  }
}

export function getPeaksCached(sid, stem, qRev = "") {
  const key = `${sid}|${stem}|${qRev || ""}`;
  if (S.peaks[key]) return S.peaks[key];
  if (!S.peaksPending.has(key)) {
    S.peaksPending.add(key);
    api.fetchPeaks(sid, stem, qRev).then((arr) => {
      S.peaks[key] = arr;
      S.peaksPending.delete(key);
      emit("peaks");
    }).catch(() => {
      S.peaksPending.delete(key);
    });
  }
  return null;
}

// ------------------------------------------------------------------ Project Editing + Undo/Redo

export function edit(mutator, opts = {}) {
  if (!S.project) return;
  const { coalesce = "", interactive = false, skipUndo = false } = opts;
  const now = performance.now();
  if (!skipUndo) {
    const canCoalesce = coalesce && coalesce === lastCoalesceKey && (now - lastCoalesceTime) < 600;
    if (!canCoalesce) {
      undoStack.push(clone(S.project));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack.length = 0;
    }
    lastCoalesceKey = coalesce;
    lastCoalesceTime = now;
  }

  mutator(S.project);
  S.dirty = true;
  emit("project");
  syncActive(interactive);
  scheduleSave();
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function undo() {
  if (!undoStack.length || !S.project) return;
  redoStack.push(clone(S.project));
  S.project = undoStack.pop();
  pruneSelection();
  lastCoalesceKey = "";
  S.dirty = true;
  emit("project");
  syncActive(false);
  scheduleSave();
}

export function redo() {
  if (!redoStack.length || !S.project) return;
  undoStack.push(clone(S.project));
  S.project = redoStack.pop();
  pruneSelection();
  lastCoalesceKey = "";
  S.dirty = true;
  emit("project");
  syncActive(false);
  scheduleSave();
}

function pruneSelection() {
  const valid = new Set((S.project?.clips || []).map((c) => c.id));
  for (const id of [...S.selClips]) {
    if (!valid.has(id)) S.selClips.delete(id);
  }
}

export function syncActive(interactive = false) {
  if (!S.project) return;
  // Immediate local Web Audio mixer update (< 0.2 ms!)
  S._audioHooks?.updateMixControls?.(S.project);
  // If arrangement/tempo changed while playing and not merely dragging gain/pan, reschedule seamlessly
  if (!interactive && S._audioHooks?.isEnginePlaying?.()) {
    S._audioHooks.rescheduleLive();
  }
  if (syncTimer) clearTimeout(syncTimer);
  const delay = interactive ? 120 : 45;
  syncTimer = setTimeout(async () => {
    try {
      const r = await api.post(`/api/active${interactive ? "?interactive=1" : ""}`, S.project);
      if (r?.warp_state) {
        S.warpState = r.warp_state;
        S.pendingWarps = r.warp_state.pending || 0;
      } else if (typeof r?.missing === "number") {
        S.pendingWarps = r.missing;
      }
      if (r?.ready_keys || r?.pending_keys) {
        S._audioHooks?.syncProjectPlan?.(S.project, r.ready_keys || {}, r.pending_keys || {});
      }
      emit("warps");
    } catch (e) {
      console.error("syncActive failed", e);
    }
  }, delay);
}

export function scheduleSave() {
  if (!S.project) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(true), 1200);
}

export async function saveNow(silent = false) {
  if (!S.project) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    await api.put(`/api/projects/${encodeURIComponent(S.project.id)}`, S.project);
    S.dirty = false;
    S.projects = await api.get("/api/projects");
    emit("projects");
    if (!silent) api.toast("Project saved", "ok");
  } catch (e) {
    api.toast(`Save failed: ${e.message}`, "err");
  }
}

export async function loadProject(pid) {
  S._audioHooks?.stop?.();
  const p = await api.get(`/api/projects/${encodeURIComponent(pid)}`);
  S.project = p;
  S.selClips.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  S.dirty = false;
  setPlayhead(0);
  // Preload details for all songs used in project
  const sids = new Set([
    ...Object.keys(p.songs || {}),
    ...(p.clips || []).map((c) => c.song),
  ]);
  await Promise.all([...sids].map((sid) => ensureSongDetail(sid).catch(() => null)));
  emit("project");
  syncActive(false);
}

// ------------------------------------------------------------------ High-Level DAW Operations

export function smartMult(songBpm, projBpm) {
  const cands = [0.5, 1.0, 2.0];
  let best = 1.0;
  let bestErr = Infinity;
  for (const m of cands) {
    const err = Math.abs(Math.log2((songBpm * m) / projBpm));
    if (err < bestErr) { bestErr = err; best = m; }
  }
  return best;
}

export function findOrCreateTrackForRole(proj, role, occupiedCheckFn = null) {
  // Prefer a matching role lane that doesn't collide if occupiedCheckFn is given
  const matches = proj.tracks.filter((t) => t.role === role);
  for (const t of matches) {
    if (!occupiedCheckFn || !occupiedCheckFn(t.id)) return t;
  }
  // Create a new lane for this role
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  const count = matches.length + 1;
  const nt = {
    id: uid("t"),
    name: count > 1 ? `${label} ${count}` : label,
    role: ROLE_COLORS[role] ? role : "any",
    color: ROLE_COLORS[role] || ROLE_COLORS.any,
    gain_db: 0.0,
    pan: 0.0,
    pitch: 0.0,
    mute: false,
    solo: false,
    hpf: 0.0,
    lpf: 0.0,
    duck: 0.0,
    pocket: 0.0,
  };
  proj.tracks.push(nt);
  return nt;
}

export async function addSongStems(sid, stems = STEMS, dropBeat = null, targetTrackId = null) {
  if (!S.project) return;
  const detail = await ensureSongDetail(sid);
  if (!detail || !detail.grid) {
    api.toast("Could not load song grid", "err");
    return;
  }
  const g = detail.grid;
  const wasEmpty = (S.project.clips.length === 0 && Object.keys(S.project.songs || {}).length === 0);
  let targetBpm = Number(S.project.bpm || 128);
  if (wasEmpty && g.bpm > 30) {
    let initBpm = Number(g.bpm);
    if (initBpm < 75) initBpm *= 2;
    else if (initBpm > 185) initBpm /= 2;
    targetBpm = Math.round(initBpm * 10) / 10;
  }

  const bpb = Number(S.project.bpb || 4);
  const startBeat = dropBeat !== null ? snapBeat(dropBeat) : Math.floor(currentBeat() / bpb) * bpb;
  const downOff = Number(g.downbeat_offset || 0);
  const hasValidQ = Boolean(g.quantized?.rev && g.quantized.sig === g.sig);

  const newIds = [];
  edit((proj) => {
    if (wasEmpty) proj.bpm = targetBpm;
    if (!proj.songs) proj.songs = {};
    if (!proj.songs[sid]) {
      proj.songs[sid] = {
        mult: smartMult(Number(g.bpm || 120), proj.bpm),
        transpose: 0.0,
        quantized: hasValidQ,
      };
    }
    const mult = Number(proj.songs[sid].mult || 1.0);
    const totalSrcBeats = (hasValidQ && g.quantized?.n_beats) ? g.quantized.n_beats : (g.beats?.length || 128);
    const clipLen = Math.max(bpb, Math.round((totalSrcBeats - downOff) * mult * 100) / 100);

    for (const stem of stems) {
      let trk = null;
      if (targetTrackId && stems.length === 1) {
        trk = proj.tracks.find((t) => t.id === targetTrackId);
      }
      if (!trk) {
        trk = findOrCreateTrackForRole(proj, stem, (tid) =>
          proj.clips.some((c) => c.track === tid && c.start < startBeat + clipLen - 0.05 && c.start + c.len > startBeat + 0.05)
        );
      }
      const nc = {
        id: uid("c"),
        track: trk.id,
        song: sid,
        stem,
        start: Math.round(startBeat * 10000) / 10000,
        src: downOff,
        len: clipLen,
        gain_db: 0.0,
        fade_in: 0.0,
        fade_out: 0.04,
        mute: false,
        rate: 1.0,
        pitch: 0.0,
        keep_pitch: true,
        label: detail.title || sid,
      };
      proj.clips.push(nc);
      newIds.push(nc.id);
    }
  });

  S.selClips = new Set(newIds);
  emit("selection");

  const aud = g.audit || {};
  if (!hasValidQ && aud.needs_quantize) {
    api.toast(`${detail.title}: tempo drifts ${aud.drift_pct}% — click Quantize in Songs in Mix to lock beats!`, "");
  } else if (hasValidQ) {
    api.toast(`Added ${detail.title} (quantized & bar-1 aligned)`, "ok");
  } else {
    api.toast(`Added ${detail.title}`, "ok");
  }
}

export function splitSelectedAt(atBeat = null) {
  if (!S.project) return 0;
  const b = atBeat !== null ? atBeat : currentBeat();
  const ids = S.selClips.size
    ? [...S.selClips]
    : S.project.clips.filter((c) => c.start + 0.01 < b && b < c.start + c.len - 0.01).map((c) => c.id);

  let count = 0;
  const rightIds = [];
  edit((proj) => {
    for (const cid of ids) {
      const idx = proj.clips.findIndex((c) => c.id === cid);
      if (idx < 0) continue;
      const c = proj.clips[idx];
      if (!(c.start + 0.01 < b && b < c.start + c.len - 0.01)) continue;
      const leftLen = b - c.start;
      const rightLen = (c.start + c.len) - b;
      const mult = Number(proj.songs?.[c.song]?.mult || 1.0);
      const rate = Number(c.rate || 1.0);
      const srcDelta = (leftLen * rate) / mult;

      const left = {
        ...c,
        len: Math.round(leftLen * 1e6) / 1e6,
        fade_out: Math.min(Number(c.fade_out || 0.04), leftLen * 0.5),
      };
      const right = {
        ...c,
        id: uid("c"),
        start: Math.round(b * 1e6) / 1e6,
        src: Math.round((Number(c.src) + srcDelta) * 1e6) / 1e6,
        len: Math.round(rightLen * 1e6) / 1e6,
        fade_in: 0.0,
      };
      proj.clips.splice(idx, 1, left, right);
      rightIds.push(right.id);
      count++;
    }
  });
  if (count > 0) {
    S.selClips = new Set(rightIds);
    emit("selection");
  } else {
    api.toast("Move playhead inside a clip to split (S)", "");
  }
  return count;
}

export function duplicateSelectedAfter() {
  if (!S.project || !S.selClips.size) {
    api.toast("Select one or more clips first to Duplicate After (Ctrl+D)", "");
    return [];
  }
  const sel = S.project.clips.filter((c) => S.selClips.has(c.id));
  if (!sel.length) return [];
  const minStart = Math.min(...sel.map((c) => c.start));
  const maxEnd = Math.max(...sel.map((c) => c.start + c.len));
  const span = maxEnd - minStart;
  if (span <= 1e-4) return [];

  const createdIds = [];
  edit((proj) => {
    for (const c of sel) {
      const nc = {
        ...clone(c),
        id: uid("c"),
        start: Math.round((c.start + span) * 1e6) / 1e6,
      };
      proj.clips.push(nc);
      createdIds.push(nc.id);
    }
  });
  S.selClips = new Set(createdIds);
  emit("selection");
  return createdIds;
}

export function copySelected() {
  if (!S.project || !S.selClips.size) return;
  const sel = S.project.clips.filter((c) => S.selClips.has(c.id));
  if (!sel.length) return;
  const minStart = Math.min(...sel.map((c) => c.start));
  const trkIdx = new Map(S.project.tracks.map((t, i) => [t.id, i]));
  S.clipboard = sel.map((c) => ({
    clip: clone(c),
    offset: c.start - minStart,
    trackIndex: trkIdx.get(c.track) ?? 0,
  }));
  api.toast(`Copied ${sel.length} clip${sel.length > 1 ? "s" : ""}`, "");
}

export function pasteAt(atBeat = null) {
  if (!S.project || !S.clipboard.length) return;
  const base = snapBeat(atBeat !== null ? atBeat : currentBeat());
  const createdIds = [];
  edit((proj) => {
    for (const item of S.clipboard) {
      const trk = proj.tracks.find((t) => t.id === item.clip.track)
        || proj.tracks[Math.min(item.trackIndex, proj.tracks.length - 1)]
        || proj.tracks[0];
      if (!trk) continue;
      const nc = {
        ...clone(item.clip),
        id: uid("c"),
        track: trk.id,
        start: Math.round((base + item.offset) * 1e6) / 1e6,
      };
      proj.clips.push(nc);
      createdIds.push(nc.id);
    }
  });
  S.selClips = new Set(createdIds);
  emit("selection");
}

export function alignSelectedToBar1() {
  if (!S.project || !S.selClips.size) {
    api.toast("Select a clip to align Bar 1 (A)", "");
    return;
  }
  const bpb = Number(S.project.bpb || 4);
  let moved = 0;
  edit((proj) => {
    for (const c of proj.clips) {
      if (!S.selClips.has(c.id)) continue;
      const g = songGrid(c.song);
      if (!g || !g.beats?.length) continue;
      const useQ = songUseQuantized(c.song);
      const mult = Number(proj.songs?.[c.song]?.mult || 1.0);
      const rate = Number(c.rate || 1.0);
      const pSong = 60.0 / Number(g.bpm || 120);
      const bars = g.bars?.length ? g.bars : [Number(g.downbeat_offset || 0)];
      // Nearest downbeat index in the song to c.src
      let nearestDb = bars[0];
      let bestDist = Infinity;
      for (const bi of bars) {
        const d = Math.abs(bi - Number(c.src));
        if (d < bestDist) { bestDist = d; nearestDb = bi; }
      }
      const uDb = useQ
        ? nearestDb
        : ((g.beats[Math.min(nearestDb, g.beats.length - 1)] - g.beats[0]) / pSong);
      const xDb = Number(c.start) + (uDb - Number(c.src)) * (mult / rate);
      let targetBar = Math.round(xDb / bpb) * bpb;
      let newStart = Number(c.start) + (targetBar - xDb);
      while (newStart < -1e-4) newStart += bpb;
      c.start = Math.round(Math.max(0, newStart) * 1e6) / 1e6;
      moved++;
    }
  });
  if (moved) api.toast(`Aligned ${moved} clip${moved > 1 ? "s" : ""} to Bar 1`, "ok");
}

export function deleteSelected() {
  if (!S.project || !S.selClips.size) return;
  const ids = new Set(S.selClips);
  edit((proj) => {
    proj.clips = proj.clips.filter((c) => !ids.has(c.id));
    cleanupUnusedSongs(proj);
  });
  S.selClips.clear();
  emit("selection");
}

export function toggleMuteSelected() {
  if (!S.project || !S.selClips.size) return;
  edit((proj) => {
    const sel = proj.clips.filter((c) => S.selClips.has(c.id));
    const allMuted = sel.every((c) => c.mute);
    for (const c of sel) c.mute = !allMuted;
  });
}

export function cleanupUnusedSongs(proj) {
  const used = new Set((proj.clips || []).map((c) => c.song));
  for (const sid of Object.keys(proj.songs || {})) {
    if (!used.has(sid)) delete proj.songs[sid];
  }
}

export function addLane(role = "any", name = null) {
  edit((proj) => {
    const idx = proj.tracks.length + 1;
    proj.tracks.push({
      id: uid("t"),
      name: name || `Lane ${idx}`,
      role,
      color: ROLE_COLORS[role] || ROLE_COLORS.any,
      gain_db: 0.0,
      pan: 0.0,
      pitch: 0.0,
      mute: false,
      solo: false,
      hpf: 0.0,
      lpf: 0.0,
      duck: 0.0,
      pocket: 0.0,
    });
  });
}

export function deleteLane(trackId) {
  if (!S.project) return;
  if (S.project.tracks.length <= 1) {
    api.toast("Cannot delete the last track lane", "err");
    return;
  }
  edit((proj) => {
    proj.tracks = proj.tracks.filter((t) => t.id !== trackId);
    proj.clips = proj.clips.filter((c) => c.track !== trackId);
    cleanupUnusedSongs(proj);
  });
  pruneSelection();
  emit("selection");
}
