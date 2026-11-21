// High-DPI Canvas DAW Timeline + Synchronized Track Headers

import * as api from "./api.js";
import * as audio from "./audio.js";
import {
  S, ROLE_COLORS, addLane, addSongStems, alignSelectedToBar1, clipTotalSemis,
  clone, copySelected, currentBeat, deleteLane, deleteSelected, duplicateSelectedAfter,
  edit, emit, getPeaksCached, onChange, pasteAt, setPlayhead, snapBeat, songBeatsCount,
  songGrid, songMeta, songMult, songUseQuantized, splitSelectedAt, syncActive, toggleMuteSelected, uid,
} from "./state.js";
import { openGridModal } from "./gridmodal.js";

let canvas = null;
let ctx = null;
let needsDraw = true;
let drag = null; // { mode, ... }
let hoverCursor = "default";
let marquee = null; // { x0, y0, x1, y1 }
let dropPreview = null; // { beat, trackIdx }

const EDGE_PX = 8;
const FADE_R = 9;
const HEADER_H = 18;

// ------------------------------------------------------------------ Coordinate helpers

function beatToX(beat) {
  return beat * S.view.pxPerBeat - S.view.scrollX;
}

function xToBeat(x) {
  return Math.max(0, (x + S.view.scrollX) / S.view.pxPerBeat);
}

function trackIdxToY(idx) {
  return S.view.rulerH + idx * S.view.trackH - S.view.scrollY;
}

function yToTrackIdx(y) {
  if (y < S.view.rulerH) return -1;
  return Math.floor((y - S.view.rulerH + S.view.scrollY) / S.view.trackH);
}

function clipRect(c, trkIdx) {
  const x = beatToX(c.start);
  const w = Math.max(4, c.len * S.view.pxPerBeat);
  const y = trackIdxToY(trkIdx) + 3;
  const h = S.view.trackH - 6;
  return { x, y, w, h };
}

function maxScrollY() {
  if (!canvas || !S.project) return 0;
  const rect = canvas.getBoundingClientRect();
  const contentH = S.project.tracks.length * S.view.trackH + 40;
  return Math.max(0, contentH - (rect.height - S.view.rulerH));
}

export function requestDraw() {
  needsDraw = true;
}

export function zoomBy(factor, anchorCanvasX = null) {
  const rect = canvas?.getBoundingClientRect();
  const ax = anchorCanvasX !== null ? anchorCanvasX : (rect ? rect.width * 0.35 : 300);
  const beatAtAnchor = xToBeat(ax);
  S.view.pxPerBeat = Math.max(1.2, Math.min(180, S.view.pxPerBeat * factor));
  S.view.scrollX = Math.max(0, beatAtAnchor * S.view.pxPerBeat - ax);
  requestDraw();
}

export function zoomFit() {
  if (!canvas || !S.project) return;
  const rect = canvas.getBoundingClientRect();
  const maxBeat = Math.max(32, ...S.project.clips.map((c) => c.start + c.len)) + 8;
  S.view.pxPerBeat = Math.max(1.5, Math.min(80, (rect.width - 24) / maxBeat));
  S.view.scrollX = 0;
  requestDraw();
}

// ------------------------------------------------------------------ Track Headers DOM

function formatPitch(p) {
  const v = Math.round(Number(p || 0) * 10) / 10;
  if (Math.abs(v) < 1e-4) return "0st";
  return `${v > 0 ? "+" : ""}${v}st`;
}

function cycleVal(curr, list) {
  const c = Number(curr || 0);
  for (const v of list) {
    if (v > c + 1e-3) return v;
  }
  return list[0];
}

export function renderTrackHeaders() {
  const list = document.getElementById("trackHeaderList");
  if (!list || !S.project) return;
  list.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const t of S.project.tracks) {
    const hdr = document.createElement("div");
    hdr.className = "track-hdr";
    hdr.style.setProperty("--lane-color", t.color || ROLE_COLORS[t.role] || ROLE_COLORS.any);

    // Row 1: Name + M / S / X
    const top = document.createElement("div");
    top.className = "th-top";

    const nameIn = document.createElement("input");
    nameIn.className = "th-name";
    nameIn.value = t.name || "Lane";
    nameIn.spellcheck = false;
    nameIn.addEventListener("change", () => {
      const val = nameIn.value.trim() || "Lane";
      edit((p) => {
        const trk = p.tracks.find((x) => x.id === t.id);
        if (trk) trk.name = val;
      }, { coalesce: `tname-${t.id}` });
    });

    const btnM = document.createElement("button");
    btnM.className = `th-btn mute${t.mute ? " on" : ""}`;
    btnM.textContent = "M";
    btnM.title = "Mute lane";
    btnM.addEventListener("click", () => {
      edit((p) => {
        const trk = p.tracks.find((x) => x.id === t.id);
        if (trk) trk.mute = !trk.mute;
      });
    });

    const btnS = document.createElement("button");
    btnS.className = `th-btn solo${t.solo ? " on" : ""}`;
    btnS.textContent = "S";
    btnS.title = "Solo lane";
    btnS.addEventListener("click", () => {
      edit((p) => {
        const trk = p.tracks.find((x) => x.id === t.id);
        if (trk) trk.solo = !trk.solo;
      });
    });

    const btnX = document.createElement("button");
    btnX.className = "th-btn btn-ghost";
    btnX.textContent = "x";
    btnX.title = "Delete lane";
    btnX.addEventListener("click", () => deleteLane(t.id));

    top.append(nameIn, btnM, btnS, btnX);

    // Row 2: Gain slider + dB readout
    const mid = document.createElement("div");
    mid.className = "th-mid";
    const gain = document.createElement("input");
    gain.type = "range";
    gain.className = "th-gain";
    gain.min = "-24";
    gain.max = "12";
    gain.step = "0.5";
    gain.value = String(t.gain_db ?? 0);
    gain.title = "Lane gain (double-click to reset 0 dB)";

    const dbEl = document.createElement("span");
    dbEl.className = "th-db";
    const fmtDb = (v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(1)}dB`;
    dbEl.textContent = fmtDb(t.gain_db ?? 0);

    gain.addEventListener("input", () => {
      const v = parseFloat(gain.value);
      dbEl.textContent = fmtDb(v);
      edit((p) => {
        const trk = p.tracks.find((x) => x.id === t.id);
        if (trk) trk.gain_db = v;
      }, { coalesce: `tgain-${t.id}`, interactive: true });
    });
    gain.addEventListener("dblclick", () => {
      edit((p) => {
        const trk = p.tracks.find((x) => x.id === t.id);
        if (trk) trk.gain_db = 0;
      });
    });
    mid.append(gain, dbEl);

    // Row 3: Per-Stem Pitch stepper + HPF / LPF / Duck pills
    const bot = document.createElement("div");
    bot.className = "th-bot";

    const pitchWrap = document.createElement("div");
    pitchWrap.className = "th-pitch-wrap";
    const pLbl = document.createElement("span");
    pLbl.className = "lbl";
    pLbl.textContent = "Key";
    const step = document.createElement("div");
    step.className = "stepper";
    step.title = "Per-stem lane pitch shift (Shift+click for 0.5 st, dbl-click to reset)";

    const pDown = document.createElement("button");
    pDown.textContent = "-";
    const pVal = document.createElement("span");
    pVal.textContent = formatPitch(t.pitch);
    if (Math.abs(t.pitch || 0) > 1e-4) pVal.style.color = "var(--green-hi)";
    const pUp = document.createElement("button");
    pUp.textContent = "+";

    const nudgePitch = (delta) => {
      edit((p) => {
        const trk = p.tracks.find((x) => x.id === t.id);
        if (trk) trk.pitch = Math.max(-12, Math.min(12, Math.round(((trk.pitch || 0) + delta) * 10) / 10));
      }, { coalesce: `tpitch-${t.id}` });
    };
    pDown.addEventListener("click", (e) => nudgePitch(e.shiftKey ? -0.5 : -1));
    pUp.addEventListener("click", (e) => nudgePitch(e.shiftKey ? 0.5 : 1));
    pVal.addEventListener("dblclick", () => {
      edit((p) => {
        const trk = p.tracks.find((x) => x.id === t.id);
        if (trk) trk.pitch = 0;
      });
    });
    step.append(pDown, pVal, pUp);
    pitchWrap.append(pLbl, step);

    const fxMini = document.createElement("div");
    fxMini.className = "th-fx-mini";

    const makeFxPill = (label, val, cycle, fmt, field) => {
      const btn = document.createElement("button");
      btn.className = `th-fx-pill${val > 0 ? " on" : ""}`;
      btn.textContent = val > 0 ? fmt(val) : label;
      btn.title = `${label}: click to cycle presets, right-click to turn off`;
      btn.addEventListener("click", () => {
        const nv = cycleVal(val, cycle);
        edit((p) => {
          const trk = p.tracks.find((x) => x.id === t.id);
          if (trk) trk[field] = nv;
        });
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        edit((p) => {
          const trk = p.tracks.find((x) => x.id === t.id);
          if (trk) trk[field] = 0;
        });
      });
      return btn;
    };

    fxMini.append(
      makeFxPill("HPF", t.hpf || 0, [0, 90, 160, 260], (v) => `H${v}`, "hpf"),
      makeFxPill("LPF", t.lpf || 0, [0, 9000, 4500, 1800], (v) => `L${(v / 1000).toFixed(1)}k`, "lpf"),
      makeFxPill("Dck", t.duck || 0, [0, 3, 6], (v) => `D-${v}`, "duck"),
    );

    bot.append(pitchWrap, fxMini);
    hdr.append(top, mid, bot);
    frag.appendChild(hdr);
  }

  list.appendChild(frag);
  list.scrollTop = S.view.scrollY;
}

// ------------------------------------------------------------------ Canvas Drawing

function hexToRgba(hex, a) {
  const h = (hex || "#8b98a8").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) || 140;
  const g = parseInt(h.slice(2, 4), 16) || 150;
  const b = parseInt(h.slice(4, 6), 16) || 165;
  return `rgba(${r},${g},${b},${a})`;
}

function drawTimeline() {
  if (!canvas || !ctx || !S.project) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;

  const dpr = window.devicePixelRatio || 1;
  const W = rect.width;
  const H = rect.height;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const { pxPerBeat, scrollX, scrollY, trackH, rulerH } = S.view;
  const bpb = Number(S.project.bpb || 4);
  const bpm = Number(S.project.bpm || 128);
  const tracks = S.project.tracks || [];
  const clips = S.project.clips || [];

  // Background
  ctx.fillStyle = "#0a0c0f";
  ctx.fillRect(0, 0, W, H);

  const firstBeat = Math.max(0, Math.floor(scrollX / pxPerBeat));
  const lastBeat = Math.ceil((scrollX + W) / pxPerBeat) + 1;

  // 1) Track lane backgrounds
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, rulerH, W, H - rulerH);
  ctx.clip();

  for (let i = 0; i < tracks.length; i++) {
    const y = trackIdxToY(i);
    if (y + trackH < rulerH || y > H) continue;
    ctx.fillStyle = i % 2 === 0 ? "#0d1015" : "#0b0d11";
    ctx.fillRect(0, y, W, trackH);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + trackH - 0.5);
    ctx.lineTo(W, y + trackH - 0.5);
    ctx.stroke();
  }

  // Vertical grid lines (bars + beats)
  const beatStep = pxPerBeat < 12 ? bpb : 1;
  for (let b = Math.floor(firstBeat / beatStep) * beatStep; b <= lastBeat; b += beatStep) {
    const x = Math.round(beatToX(b)) + 0.5;
    if (x < 0 || x > W) continue;
    const isBar = b % bpb === 0;
    ctx.strokeStyle = isBar ? "rgba(255,255,255,0.11)" : "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, rulerH);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  // Drop target preview
  if (dropPreview && dropPreview.trackIdx >= 0 && dropPreview.trackIdx < tracks.length) {
    const dx = beatToX(dropPreview.beat);
    const dy = trackIdxToY(dropPreview.trackIdx) + 3;
    ctx.fillStyle = "rgba(29, 185, 84, 0.18)";
    ctx.strokeStyle = "#2ee06e";
    ctx.lineWidth = 1.5;
    ctx.fillRect(dx, dy, bpb * 4 * pxPerBeat, trackH - 6);
    ctx.strokeRect(dx + 0.5, dy + 0.5, bpb * 4 * pxPerBeat, trackH - 6);
  }

  // 2) Clips
  const trkIdxMap = new Map(tracks.map((t, i) => [t.id, i]));
  for (const c of clips) {
    const ti = trkIdxMap.get(c.track);
    if (ti === undefined) continue;
    const r = clipRect(c, ti);
    if (r.x + r.w < -4 || r.x > W + 4 || r.y + r.h < rulerH || r.y > H) continue;
    drawClip(c, r, tracks[ti], bpb, bpm, W);
  }

  // Marquee selection box
  if (marquee) {
    const mx = Math.min(marquee.x0, marquee.x1);
    const my = Math.min(marquee.y0, marquee.y1);
    const mw = Math.abs(marquee.x1 - marquee.x0);
    const mh = Math.abs(marquee.y1 - marquee.y0);
    ctx.fillStyle = "rgba(46, 224, 110, 0.12)";
    ctx.strokeStyle = "#2ee06e";
    ctx.lineWidth = 1;
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
  }

  ctx.restore();

  // 3) Top Ruler
  ctx.fillStyle = "#12151b";
  ctx.fillRect(0, 0, W, rulerH);
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, rulerH - 0.5);
  ctx.lineTo(W, rulerH - 0.5);
  ctx.stroke();

  // Loop brace
  const lp = S.project.loop;
  if (lp && lp.end > lp.start + 0.05) {
    const lx0 = beatToX(lp.start);
    const lx1 = beatToX(lp.end);
    ctx.fillStyle = lp.on ? "rgba(29, 185, 84, 0.34)" : "rgba(255, 255, 255, 0.09)";
    ctx.fillRect(Math.max(0, lx0), 0, Math.min(W, lx1) - Math.max(0, lx0), 8);
    ctx.fillStyle = lp.on ? "#2ee06e" : "rgba(255,255,255,0.35)";
    ctx.fillRect(lx0, 0, 2, 10);
    ctx.fillRect(lx1 - 2, 0, 2, 10);
  }

  // Ruler ticks & bar labels
  const barStep = pxPerBeat * bpb < 38 ? 4 : pxPerBeat * bpb < 75 ? 2 : 1;
  ctx.font = "10px Consolas, monospace";
  for (let b = firstBeat; b <= lastBeat; b++) {
    const x = Math.round(beatToX(b)) + 0.5;
    if (x < 0 || x > W) continue;
    const isBar = b % bpb === 0;
    if (isBar) {
      const barNum = Math.floor(b / bpb) + 1;
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x, rulerH);
      ctx.stroke();
      if ((barNum - 1) % barStep === 0) {
        ctx.fillStyle = "#b8c2d1";
        ctx.fillText(String(barNum), x + 4, 21);
      }
    } else if (pxPerBeat >= 14) {
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(x, 22);
      ctx.lineTo(x, rulerH);
      ctx.stroke();
    }
  }

  // 4) Playhead line + cap (with smooth auto-follow during playback)
  const phBeat = currentBeat();
  let rawPx = beatToX(phBeat);
  if (S.transport.playing && !drag) {
    if (rawPx > W - 56) {
      S.view.scrollX = Math.max(0, phBeat * S.view.pxPerBeat - W * 0.25);
      rawPx = beatToX(phBeat);
    } else if (rawPx < 0) {
      S.view.scrollX = Math.max(0, phBeat * S.view.pxPerBeat - 40);
      rawPx = beatToX(phBeat);
    }
  }
  const px = Math.round(rawPx === 0 ? 1.5 : rawPx) + 0.5;
  if (px >= -2 && px <= W + 2) {
    const col = S.transport.playing ? "#2ee06e" : "#f05262";
    // Subtle dark backing halo so playhead pops clearly over every waveform
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();

    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();

    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(px - 7, 0);
    ctx.lineTo(px + 7, 0);
    ctx.lineTo(px, 11);
    ctx.closePath();
    ctx.fill();
  }
}

function drawClip(c, r, trk, bpb, bpm, viewW) {
  const isSel = S.selClips.has(c.id);
  const color = ROLE_COLORS[c.stem] || trk?.color || ROLE_COLORS.any;
  const muted = Boolean(c.mute || trk?.mute);
  const visX0 = Math.max(0, r.x);
  const visX1 = Math.min(viewW, r.x + r.w);
  if (visX1 <= visX0) return;

  ctx.save();
  // Clip rounded body
  roundRect(ctx, r.x, r.y, r.w, r.h, 5);
  ctx.fillStyle = muted ? "rgba(32, 37, 47, 0.55)" : hexToRgba(color, isSel ? 0.24 : 0.14);
  ctx.fill();
  ctx.clip();

  // Header tint
  ctx.fillStyle = muted ? "rgba(255,255,255,0.04)" : hexToRgba(color, isSel ? 0.36 : 0.24);
  ctx.fillRect(r.x, r.y, r.w, HEADER_H);

  // Waveform peaks
  const g = songGrid(c.song);
  const useQ = songUseQuantized(c.song);
  const q = useQ ? g.quantized : null;
  const peaks = getPeaksCached(c.song, c.stem, useQ ? q.rev : "");
  const mult = songMult(c.song);
  const rate = Number(c.rate || 1.0);
  const pxPerBeat = S.view.pxPerBeat;

  const waveTop = r.y + HEADER_H + 2;
  const waveBot = r.y + r.h - 11;
  const waveMid = 0.5 * (waveTop + waveBot);
  const waveAmp = Math.max(4, (waveBot - waveTop) * 0.46);

  if (peaks && peaks.length >= 2 && g) {
    const nBins = peaks.length >> 1;
    const pSong = 60.0 / Number(g.bpm || 120);
    const b0 = Number(g.beats?.[0] || 0);
    ctx.fillStyle = muted ? "rgba(139,149,165,0.3)" : hexToRgba(color, 0.85);
    const startPx = Math.floor(visX0);
    const endPx = Math.ceil(visX1);
    for (let x = startPx; x < endPx; x++) {
      const beatA = xToBeat(x);
      const beatB = xToBeat(x + 1);
      const uA = Number(c.src) + (beatA - c.start) * (rate / mult);
      const uB = Number(c.src) + (beatB - c.start) * (rate / mult);
      const tA = useQ ? (q.t0 + uA * q.period) : (b0 + uA * pSong);
      const tB = useQ ? (q.t0 + uB * q.period) : (b0 + uB * pSong);
      if (tB < 0) continue;
      const i0 = Math.max(0, Math.min(nBins - 1, Math.floor(tA * 100)));
      const i1 = Math.max(i0 + 1, Math.min(nBins, Math.ceil(tB * 100)));
      let lo = 127;
      let hi = -127;
      for (let i = i0; i < i1; i++) {
        const a = peaks[i * 2];
        const b = peaks[i * 2 + 1];
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      if (hi < lo) continue;
      const yt = waveMid - (hi / 127) * waveAmp;
      const yb = waveMid - (lo / 127) * waveAmp;
      ctx.fillRect(x, yt, 1, Math.max(1, yb - yt));
    }
  }

  // Always-visible truthful beat/bar markers + continuous bottom sync status ribbon (works at EVERY zoom level!)
  if (g && g.beats?.length) {
    const pSong = 60.0 / Number(g.bpm || 120);
    const b0 = Number(g.beats[0] || 0);
    const downOff = Number(g.downbeat_offset || 0);
    const songBpb = Number(g.bpb || 4);
    const nBeats = useQ ? Number(q.n_beats) : g.beats.length;
    const auditSecs = (useQ ? q.audit?.sections : g.audit?.sections) || [];
    const msPerProjBeat = 60000 / bpm;

    const uMin = Math.max(0, Math.floor(Number(c.src) + (xToBeat(visX0) - c.start) * (rate / mult)) - 2);
    const uMax = Math.min(nBeats - 1, Math.ceil(Number(c.src) + (xToBeat(visX1) - c.start) * (rate / mult)) + 2);

    // Choose adaptive bar tick stride so marks NEVER disappear when zoomed way out!
    const pxPerBar = pxPerBeat * songBpb * (mult / rate);
    const barStride = pxPerBar >= 9 ? 1 : pxPerBar >= 4.5 ? 2 : pxPerBar >= 2.2 ? 4 : 8;
    const showBeatTicks = pxPerBeat >= 12;

    // 1) Continuous 3 px sync status ribbon along bottom edge (always visible even on 10-min zoomed-out clips)
    let prevX = visX0;
    const ribbonStep = Math.max(1, Math.floor(barStride * songBpb));
    for (let j = uMin; j <= uMax; j += ribbonStep) {
      const u_j = useQ ? j : ((g.beats[j] - b0) / pSong);
      const bx = c.start + (u_j - Number(c.src)) * (mult / rate);
      const x1 = Math.min(visX1, Math.max(visX0, beatToX(bx + ribbonStep * (mult / rate))));
      const x0 = Math.max(visX0, Math.min(prevX, beatToX(bx)));
      if (x1 <= x0) continue;
      const nearestInt = Math.round(bx);
      let errMs = Math.abs(bx - nearestInt) * msPerProjBeat;
      const audioT = useQ ? (q.t0 + j * q.period) : g.beats[j];
      for (const sec of auditSecs) {
        if (audioT >= sec.t0 && audioT <= sec.t1) {
          if (sec.active) errMs = Math.max(errMs, Math.abs(Number(sec.offset_ms || 0)));
          break;
        }
      }
      ctx.fillStyle = errMs > 40 ? "#f05262" : errMs > 20 ? "#f0b24b" : "#2ee06e";
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x0, r.y + r.h - 3, Math.max(1, x1 - x0), 3);
      prevX = x1;
    }
    ctx.globalAlpha = 1.0;

    // 2) Crisp bar / phrase / beat ticks on top of ribbon
    const loopStep = showBeatTicks ? 1 : 1;
    for (let j = uMin; j <= uMax; j += loopStep) {
      const isSongBar = ((j - downOff) % songBpb + songBpb) % songBpb === 0 && j >= downOff;
      if (!isSongBar && !showBeatTicks) continue;
      if (isSongBar && barStride > 1) {
        const barIdx = Math.floor((j - downOff) / songBpb);
        if (barIdx % barStride !== 0) continue;
      }

      const u_j = useQ ? j : ((g.beats[j] - b0) / pSong);
      const bx = c.start + (u_j - Number(c.src)) * (mult / rate);
      if (bx < c.start - 0.01 || bx > c.start + c.len + 0.01) continue;
      const x = Math.round(beatToX(bx)) + 0.5;
      if (x < visX0 - 2 || x > visX1 + 2) continue;

      const nearestInt = Math.round(bx);
      let errMs = Math.abs(bx - nearestInt) * msPerProjBeat;
      const audioT = useQ ? (q.t0 + j * q.period) : g.beats[j];
      for (const sec of auditSecs) {
        if (audioT >= sec.t0 && audioT <= sec.t1) {
          if (sec.active) errMs = Math.max(errMs, Math.abs(Number(sec.offset_ms || 0)));
          break;
        }
      }

      let mColor = "#2ee06e";
      if (errMs > 40) mColor = "#f05262";
      else if (errMs > 20) mColor = "#f0b24b";
      else if (isSongBar && ((nearestInt % bpb) + bpb) % bpb !== 0) mColor = "#5ca8f5";

      ctx.fillStyle = mColor;
      ctx.strokeStyle = mColor;
      if (isSongBar) {
        ctx.globalAlpha = 0.95;
        ctx.fillRect(x - 1, r.y + r.h - 10, 2.5, 9);
        ctx.globalAlpha = pxPerBar >= 14 ? 0.25 : 0.18;
        ctx.beginPath();
        ctx.moveTo(x, r.y + HEADER_H);
        ctx.lineTo(x, r.y + r.h - 10);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      } else {
        ctx.globalAlpha = 0.72;
        ctx.fillRect(x - 0.5, r.y + r.h - 6, 1.5, 5);
        ctx.globalAlpha = 1.0;
      }
    }
  }

  // Fade-in / Fade-out overlays + handles
  const fiPx = Math.min(r.w * 0.5, Number(c.fade_in || 0) * pxPerBeat);
  const foPx = Math.min(r.w * 0.5, Number(c.fade_out || 0) * pxPerBeat);
  if (fiPx > 2) {
    ctx.fillStyle = "rgba(8, 10, 14, 0.55)";
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + HEADER_H);
    ctx.lineTo(r.x + fiPx, r.y + HEADER_H);
    ctx.lineTo(r.x, r.y + r.h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h);
    ctx.lineTo(r.x + fiPx, r.y + HEADER_H);
    ctx.stroke();
  }
  if (foPx > 2) {
    ctx.fillStyle = "rgba(8, 10, 14, 0.55)";
    ctx.beginPath();
    ctx.moveTo(r.x + r.w - foPx, r.y + HEADER_H);
    ctx.lineTo(r.x + r.w, r.y + HEADER_H);
    ctx.lineTo(r.x + r.w, r.y + r.h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(r.x + r.w - foPx, r.y + HEADER_H);
    ctx.lineTo(r.x + r.w, r.y + r.h);
    ctx.stroke();
  }

  // Fade handle dots when selected
  if (isSel && r.w > 28) {
    ctx.fillStyle = "#e6ebf2";
    ctx.beginPath();
    ctx.arc(r.x + Math.max(5, fiPx), r.y + HEADER_H + 2, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(r.x + r.w - Math.max(5, foPx), r.y + HEADER_H + 2, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Clip header label text
  const textX = Math.max(r.x + 6, visX0 + 6);
  if (visX1 - textX > 22) {
    const meta = songMeta(c.song);
    const title = c.label || meta?.title || c.song;
    const stemTag = (c.stem || "?")[0].toUpperCase();
    const totalSt = clipTotalSemis(c);
    const badges = [];
    if (Math.abs(totalSt) > 1e-3) badges.push(`${totalSt > 0 ? "+" : ""}${totalSt}st`);
    if (Math.abs(Number(c.gain_db || 0)) > 0.05) badges.push(`${c.gain_db > 0 ? "+" : ""}${Number(c.gain_db).toFixed(1)}dB`);
    if (Math.abs(rate - 1) > 1e-3) badges.push(`${rate}x`);
    const aStat = audio.getClipAudioStatus(c);
    if (aStat === "loading") badges.push("loading...");
    else if (aStat === "preview") badges.push("R3...");
    if (c.mute) badges.push("MUTE");
    const suffix = badges.length ? `  [${badges.join(" ")}]` : "";

    ctx.font = "600 10.5px Segoe UI, sans-serif";
    ctx.fillStyle = muted ? "#8b95a5" : "#eef3f8";
    ctx.fillText(`${stemTag} · ${title}${suffix}`, textX, r.y + 12.5);
  }

  ctx.restore();

  // Clip crisp border
  roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 5);
  ctx.strokeStyle = isSel ? "#2ee06e" : hexToRgba(color, muted ? 0.25 : 0.6);
  ctx.lineWidth = isSel ? 1.8 : 1;
  ctx.stroke();
}

function roundRect(c, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rad, y);
  c.arcTo(x + w, y, x + w, y + h, rad);
  c.arcTo(x + w, y + h, x, y + h, rad);
  c.arcTo(x, y + h, x, y, rad);
  c.arcTo(x, y, x + w, y, rad);
  c.closePath();
}

// ------------------------------------------------------------------ Hit testing

function hitTest(x, y) {
  if (!S.project) return { type: "none" };
  if (y < S.view.rulerH) {
    const lp = S.project.loop;
    if (lp && lp.end > lp.start + 0.05 && y <= 12) {
      if (Math.abs(x - beatToX(lp.start)) <= 7) return { type: "loop-start" };
      if (Math.abs(x - beatToX(lp.end)) <= 7) return { type: "loop-end" };
    }
    return { type: "ruler", beat: xToBeat(x) };
  }

  const ti = yToTrackIdx(y);
  const trk = S.project.tracks[ti];
  if (!trk) return { type: "empty", beat: xToBeat(x), trackIdx: ti };

  // Search clips on this track (top-most = last drawn)
  const onTrack = S.project.clips.filter((c) => c.track === trk.id);
  for (let i = onTrack.length - 1; i >= 0; i--) {
    const c = onTrack[i];
    const r = clipRect(c, ti);
    if (x >= r.x - 3 && x <= r.x + r.w + 3 && y >= r.y && y <= r.y + r.h) {
      // Fade handles (near top of waveform body)
      const fiX = r.x + Math.max(5, Math.min(r.w * 0.5, Number(c.fade_in || 0) * S.view.pxPerBeat));
      const foX = r.x + r.w - Math.max(5, Math.min(r.w * 0.5, Number(c.fade_out || 0) * S.view.pxPerBeat));
      const fy = r.y + HEADER_H + 2;
      if (S.selClips.has(c.id) && r.w > 28 && Math.abs(y - fy) <= FADE_R) {
        if (Math.abs(x - fiX) <= FADE_R) return { type: "fade-in", clip: c };
        if (Math.abs(x - foX) <= FADE_R) return { type: "fade-out", clip: c };
      }
      if (x <= r.x + EDGE_PX && r.w > EDGE_PX * 2) return { type: "trim-left", clip: c };
      if (x >= r.x + r.w - EDGE_PX && r.w > EDGE_PX * 2) return { type: "trim-right", clip: c };
      return { type: "clip", clip: c, trackIdx: ti };
    }
  }
  return { type: "empty", beat: xToBeat(x), trackIdx: ti };
}

// ------------------------------------------------------------------ Context Menu

export function hideContextMenu() {
  document.getElementById("ctxMenu")?.classList.add("hidden");
}

function showContextMenu(clientX, clientY, clip, clickBeat) {
  const menu = document.getElementById("ctxMenu");
  if (!menu) return;
  menu.innerHTML = "";

  const addItem = (label, kbd, onClick, danger = false) => {
    const it = document.createElement("div");
    it.className = `ctx-item${danger ? " danger" : ""}`;
    it.innerHTML = `<span>${label}</span>${kbd ? `<span class="ctx-kbd">${kbd}</span>` : ""}`;
    it.addEventListener("click", () => {
      hideContextMenu();
      onClick();
    });
    menu.appendChild(it);
  };
  const addSep = () => {
    const s = document.createElement("div");
    s.className = "ctx-sep";
    menu.appendChild(s);
  };

  if (clip) {
    const splitB = snapBeat(clickBeat);
    addItem("Split at Cursor", "S", () => splitSelectedAt(splitB));
    addItem("Duplicate After", "Ctrl+D", () => duplicateSelectedAfter());
    addItem("Align Bar 1 to Grid", "A", () => alignSelectedToBar1());
    addItem("Copy", "Ctrl+C", () => copySelected());
    addSep();
    addItem("Clip Pitch +1 st", "", () => {
      edit((p) => {
        for (const c of p.clips) if (S.selClips.has(c.id)) c.pitch = Math.min(12, Math.round(((c.pitch || 0) + 1) * 10) / 10);
      });
    });
    addItem("Clip Pitch -1 st", "", () => {
      edit((p) => {
        for (const c of p.clips) if (S.selClips.has(c.id)) c.pitch = Math.max(-12, Math.round(((c.pitch || 0) - 1) * 10) / 10);
      });
    });
    addItem("Reset Clip Pitch", "", () => {
      edit((p) => {
        for (const c of p.clips) if (S.selClips.has(c.id)) c.pitch = 0;
      });
    });
    addSep();
    addItem(clip.mute ? "Unmute Clip" : "Mute Clip", "M", () => toggleMuteSelected());
    addItem("Inspect Beat Grid & Hits...", "", () => openGridModal(clip.song));
    addSep();
    addItem("Delete Clip", "Del", () => deleteSelected(), true);
  } else {
    if (S.clipboard.length) {
      addItem("Paste Here", "Ctrl+V", () => pasteAt(clickBeat));
    }
    addItem("Add Track Lane", "", () => addLane());
  }

  menu.classList.remove("hidden");
  const mw = menu.offsetWidth || 190;
  const mh = menu.offsetHeight || 220;
  menu.style.left = `${Math.min(window.innerWidth - mw - 8, clientX)}px`;
  menu.style.top = `${Math.min(window.innerHeight - mh - 8, clientY)}px`;
}

// ------------------------------------------------------------------ Mouse & DnD wiring

function seekTo(beat) {
  const b = Math.max(0, beat);
  audio.seek(b);
  setPlayhead(b);
}

export function initTimeline() {
  canvas = document.getElementById("timelineCanvas");
  if (!canvas) return;
  ctx = canvas.getContext("2d");

  const vp = document.getElementById("timelineViewport");
  const ro = new ResizeObserver(() => requestDraw());
  ro.observe(vp);

  document.getElementById("btnAddLane")?.addEventListener("click", () => addLane());
  document.getElementById("btnZoomIn")?.addEventListener("click", () => zoomBy(1.3));
  document.getElementById("btnZoomOut")?.addEventListener("click", () => zoomBy(1 / 1.3));
  document.getElementById("btnZoomFit")?.addEventListener("click", () => zoomFit());

  // Wheel: Ctrl = zoom, Shift = horiz pan, Alt over clip = clip pitch, plain = vert/horiz scroll
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (e.ctrlKey) {
      zoomBy(e.deltaY > 0 ? 0.84 : 1.19, mx);
      return;
    }
    if (e.altKey) {
      const hit = hitTest(mx, my);
      if (hit.clip) {
        const delta = e.deltaY < 0 ? 1 : -1;
        edit((p) => {
          const c = p.clips.find((x) => x.id === hit.clip.id);
          if (c) c.pitch = Math.max(-12, Math.min(12, Math.round(((c.pitch || 0) + delta) * 10) / 10));
        }, { coalesce: `cpitch-${hit.clip.id}` });
        return;
      }
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dx = Math.abs(e.deltaX) > 0 ? e.deltaX : e.deltaY;
      S.view.scrollX = Math.max(0, S.view.scrollX + dx);
      requestDraw();
    } else {
      const maxY = maxScrollY();
      if (maxY > 0) {
        S.view.scrollY = Math.max(0, Math.min(maxY, S.view.scrollY + e.deltaY * 0.7));
        const thl = document.getElementById("trackHeaderList");
        if (thl) thl.scrollTop = S.view.scrollY;
        requestDraw();
      } else {
        S.view.scrollX = Math.max(0, S.view.scrollX + e.deltaY);
        requestDraw();
      }
    }
  }, { passive: false });

  // Pointer Down
  canvas.addEventListener("mousedown", (e) => {
    hideContextMenu();
    if (e.button === 2) return; // contextmenu handles right-click
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTest(mx, my);

    if (hit.type === "ruler") {
      if (e.shiftKey) {
        const b0 = snapBeat(hit.beat, e.altKey);
        drag = { mode: "loop-draw", b0 };
      } else {
        seekTo(snapBeat(hit.beat, e.altKey));
        drag = { mode: "scrub" };
      }
      return;
    }
    if (hit.type === "loop-start" || hit.type === "loop-end") {
      drag = { mode: hit.type };
      return;
    }

    if (hit.clip) {
      const c = hit.clip;
      if (hit.type === "clip") {
        if (e.shiftKey || e.ctrlKey) {
          if (S.selClips.has(c.id)) S.selClips.delete(c.id);
          else S.selClips.add(c.id);
        } else if (!S.selClips.has(c.id)) {
          S.selClips = new Set([c.id]);
        }
        emit("selection");

        // Snapshot selected clips for move / Ctrl-clone drag
        const trkIdxMap = new Map(S.project.tracks.map((t, i) => [t.id, i]));
        const snap = S.project.clips
          .filter((x) => S.selClips.has(x.id))
          .map((x) => ({ id: x.id, start: x.start, trackIdx: trkIdxMap.get(x.track) ?? 0, orig: clone(x) }));

        drag = {
          mode: "move",
          cloneMode: e.ctrlKey && !e.shiftKey,
          cloned: false,
          startX: mx,
          startY: my,
          beat0: xToBeat(mx),
          trackIdx0: hit.trackIdx,
          snap,
          moved: false,
        };
        return;
      }

      // Single-clip edge/fade drag
      S.selClips = new Set([c.id]);
      emit("selection");
      drag = {
        mode: hit.type,
        clipId: c.id,
        beat0: xToBeat(mx),
        origStart: c.start,
        origSrc: c.src,
        origLen: c.len,
        origFi: c.fade_in || 0,
        origFo: c.fade_out || 0,
      };
      return;
    }

    // Empty timeline click / marquee select
    if (!e.shiftKey) {
      S.selClips.clear();
      emit("selection");
    }
    drag = { mode: "marquee", x0: mx, y0: my, beat0: xToBeat(mx) };
    marquee = null;
  });

  // Pointer Move
  window.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (!drag) {
      if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
        const hit = hitTest(mx, my);
        let cur = "default";
        if (hit.type === "trim-left" || hit.type === "trim-right" || hit.type === "loop-start" || hit.type === "loop-end") cur = "ew-resize";
        else if (hit.type === "fade-in" || hit.type === "fade-out") cur = "col-resize";
        else if (hit.type === "clip") cur = "grab";
        else if (hit.type === "ruler") cur = "pointer";
        if (cur !== hoverCursor) { hoverCursor = cur; canvas.style.cursor = cur; }
      }
      return;
    }

    if (drag.mode === "scrub") {
      seekTo(snapBeat(xToBeat(mx), e.altKey));
      return;
    }
    if (drag.mode === "loop-draw") {
      const b1 = snapBeat(xToBeat(mx), e.altKey);
      const s = Math.min(drag.b0, b1);
      const en = Math.max(drag.b0, b1);
      if (en - s >= 0.5) {
        edit((p) => { p.loop = { on: true, start: s, end: en }; }, { coalesce: "loop", interactive: true });
      }
      return;
    }
    if (drag.mode === "loop-start" || drag.mode === "loop-end") {
      const b = snapBeat(xToBeat(mx), e.altKey);
      edit((p) => {
        if (drag.mode === "loop-start") p.loop.start = Math.min(p.loop.end - 0.5, Math.max(0, b));
        else p.loop.end = Math.max(p.loop.start + 0.5, b);
      }, { coalesce: "loop", interactive: true });
      return;
    }

    if (drag.mode === "marquee") {
      if (Math.hypot(mx - drag.x0, my - drag.y0) > 5) {
        marquee = { x0: drag.x0, y0: drag.y0, x1: mx, y1: my };
        const bx0 = Math.min(marquee.x0, marquee.x1);
        const bx1 = Math.max(marquee.x0, marquee.x1);
        const by0 = Math.min(marquee.y0, marquee.y1);
        const by1 = Math.max(marquee.y0, marquee.y1);
        const trkIdxMap = new Map(S.project.tracks.map((t, i) => [t.id, i]));
        const nextSel = new Set();
        for (const c of S.project.clips) {
          const ti = trkIdxMap.get(c.track);
          if (ti === undefined) continue;
          const r = clipRect(c, ti);
          if (r.x + r.w >= bx0 && r.x <= bx1 && r.y + r.h >= by0 && r.y <= by1) {
            nextSel.add(c.id);
          }
        }
        S.selClips = nextSel;
        emit("selection");
        requestDraw();
      }
      return;
    }

    if (drag.mode === "move") {
      if (!drag.moved && Math.hypot(mx - drag.startX, my - drag.startY) < 4) return;
      drag.moved = true;

      // Ctrl-drag spawns clones once movement begins
      if (drag.cloneMode && !drag.cloned) {
        drag.cloned = true;
        const newSnap = [];
        const newSel = new Set();
        edit((p) => {
          for (const item of drag.snap) {
            const nc = { ...clone(item.orig), id: uid("c") };
            p.clips.push(nc);
            newSnap.push({ ...item, id: nc.id });
            newSel.add(nc.id);
          }
        }, { coalesce: "clone-move", interactive: true });
        drag.snap = newSnap;
        S.selClips = newSel;
        emit("selection");
      }

      const rawDelta = xToBeat(mx) - drag.beat0;
      const minStart = Math.min(...drag.snap.map((s) => s.start));
      let newMin = snapBeat(minStart + rawDelta, e.altKey);
      const deltaBeat = Math.max(-minStart, newMin - minStart);
      const curTi = Math.max(0, Math.min(S.project.tracks.length - 1, yToTrackIdx(my)));
      const deltaTrk = curTi >= 0 ? curTi - drag.trackIdx0 : 0;

      edit((p) => {
        for (const item of drag.snap) {
          const c = p.clips.find((x) => x.id === item.id);
          if (!c) continue;
          c.start = Math.round(Math.max(0, item.start + deltaBeat) * 1e6) / 1e6;
          const nti = Math.max(0, Math.min(p.tracks.length - 1, item.trackIdx + deltaTrk));
          c.track = p.tracks[nti].id;
        }
      }, { coalesce: "clip-move", interactive: true });
      return;
    }

    if (drag.mode === "trim-left") {
      const targetStart = snapBeat(xToBeat(mx), e.altKey);
      edit((p) => {
        const c = p.clips.find((x) => x.id === drag.clipId);
        if (!c) return;
        const mult = Number(p.songs?.[c.song]?.mult || 1.0);
        const rate = Number(c.rate || 1.0);
        let dBeat = targetStart - drag.origStart;
        // Clamp so len >= 0.25 and src >= 0
        const minDelta = -drag.origSrc * (mult / rate);
        const maxDelta = drag.origLen - 0.25;
        dBeat = Math.max(minDelta, Math.min(maxDelta, dBeat));
        c.start = Math.round(Math.max(0, drag.origStart + dBeat) * 1e6) / 1e6;
        c.src = Math.round(Math.max(0, drag.origSrc + dBeat * (rate / mult)) * 1e6) / 1e6;
        c.len = Math.round(Math.max(0.25, drag.origLen - dBeat) * 1e6) / 1e6;
      }, { coalesce: `trimL-${drag.clipId}`, interactive: true });
      return;
    }

    if (drag.mode === "trim-right") {
      const targetEnd = snapBeat(xToBeat(mx), e.altKey);
      edit((p) => {
        const c = p.clips.find((x) => x.id === drag.clipId);
        if (!c) return;
        const mult = Number(p.songs?.[c.song]?.mult || 1.0);
        const rate = Number(c.rate || 1.0);
        const maxSrc = songBeatsCount(c.song);
        const maxLen = Math.max(0.25, (maxSrc - Number(c.src)) * (mult / rate));
        c.len = Math.round(Math.max(0.25, Math.min(maxLen, targetEnd - c.start)) * 1e6) / 1e6;
      }, { coalesce: `trimR-${drag.clipId}`, interactive: true });
      return;
    }

    if (drag.mode === "fade-in" || drag.mode === "fade-out") {
      const b = xToBeat(mx);
      edit((p) => {
        const c = p.clips.find((x) => x.id === drag.clipId);
        if (!c) return;
        if (drag.mode === "fade-in") {
          c.fade_in = Math.round(Math.max(0, Math.min(c.len * 0.5, b - c.start)) * 1000) / 1000;
        } else {
          c.fade_out = Math.round(Math.max(0, Math.min(c.len * 0.5, (c.start + c.len) - b)) * 1000) / 1000;
        }
      }, { coalesce: `fade-${drag.clipId}`, interactive: true });
    }
  });

  // Pointer Up
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    const wasMode = drag.mode;
    const wasMarquee = Boolean(marquee);
    const b0 = drag.beat0;
    drag = null;
    marquee = null;
    if (wasMode === "marquee" && !wasMarquee && b0 !== undefined) {
      seekTo(snapBeat(b0));
    }
    if (["move", "trim-left", "trim-right", "fade-in", "fade-out", "loop-draw", "loop-start", "loop-end"].includes(wasMode)) {
      syncActive(false);
    }
    requestDraw();
  });

  // Right-click Context Menu
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTest(mx, my);
    if (hit.clip && !S.selClips.has(hit.clip.id)) {
      S.selClips = new Set([hit.clip.id]);
      emit("selection");
    }
    showContextMenu(e.clientX, e.clientY, hit.clip || null, xToBeat(mx));
  });

  // Drop stem chip from Library directly onto timeline canvas
  canvas.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("application/x-retex-stem")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const rect = canvas.getBoundingClientRect();
      const beat = snapBeat(xToBeat(e.clientX - rect.left), e.altKey);
      const trackIdx = Math.max(0, Math.min((S.project?.tracks?.length || 1) - 1, yToTrackIdx(e.clientY - rect.top)));
      dropPreview = { beat, trackIdx };
      requestDraw();
    }
  });
  canvas.addEventListener("dragleave", () => {
    dropPreview = null;
    requestDraw();
  });
  canvas.addEventListener("drop", (e) => {
    dropPreview = null;
    requestDraw();
    const raw = e.dataTransfer?.getData("application/x-retex-stem");
    if (!raw) return;
    e.preventDefault();
    try {
      const { sid, stem } = JSON.parse(raw);
      const rect = canvas.getBoundingClientRect();
      const beat = snapBeat(xToBeat(e.clientX - rect.left), e.altKey);
      const ti = yToTrackIdx(e.clientY - rect.top);
      const targetTrackId = S.project?.tracks?.[ti]?.id || null;
      addSongStems(sid, [stem], beat, targetTrackId);
    } catch {}
  });

  window.addEventListener("click", (e) => {
    if (!e.target.closest("#ctxMenu")) hideContextMenu();
  });

  onChange((kind) => {
    if (kind === "project") renderTrackHeaders();
    requestDraw();
  });

  // 60fps animation loop for smooth playhead & lazy canvas repaints
  const tick = () => {
    if (needsDraw || S.transport.playing) {
      needsDraw = false;
      drawTimeline();
      updatePosReadout();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function updatePosReadout() {
  const el = document.getElementById("posReadout");
  if (!el || !S.project) return;
  const b = currentBeat();
  const bpb = Number(S.project.bpb || 4);
  const bpm = Number(S.project.bpm || 128);
  const bar = Math.floor(b / bpb) + 1;
  const beatInBar = (b % bpb) + 1;
  const sec = (b * 60) / bpm;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  el.textContent = `${String(bar).padStart(3, "0")}:${beatInBar.toFixed(2)} · ${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}
