// Beat Grid & Drum-Hit Audit Inspector Modal

import * as api from "./api.js";
import * as audio from "./audio.js";
import { S, currentAudSec, ensureSongDetail, getPeaksCached, onChange } from "./state.js";

let currentSid = null;
let viewStartS = 0;
let viewSpanS = 30;
let showQuantizedWave = false;
let dragging = false;
let dragX0 = 0;
let dragStartS0 = 0;
let gmRaf = 0;

function startGmLoop() {
  if (gmRaf) return;
  const step = () => {
    if (!currentSid) { gmRaf = 0; return; }
    const audS = currentAudSec();
    if (audS !== null) {
      if (!dragging && (audS > viewStartS + viewSpanS - 1.5 || audS < viewStartS)) {
        viewStartS = Math.max(0, audS - viewSpanS * 0.2);
      }
      drawGridCanvas();
    }
    gmRaf = requestAnimationFrame(step);
  };
  gmRaf = requestAnimationFrame(step);
}

export async function openGridModal(sid) {
  currentSid = sid;
  viewStartS = 0;
  viewSpanS = 28;
  const modal = document.getElementById("gridModal");
  modal?.classList.remove("hidden");
  await refreshGridModal(true);
  startGmLoop();
}

export function closeGridModal() {
  currentSid = null;
  if (gmRaf) { cancelAnimationFrame(gmRaf); gmRaf = 0; }
  document.getElementById("gridModal")?.classList.add("hidden");
  audio.stopAudition();
}

export async function refreshGridModal(forceFetch = false) {
  if (!currentSid) return;
  const detail = await ensureSongDetail(currentSid, forceFetch);
  if (!detail || !detail.grid) return;
  const g = detail.grid;
  const q = g.quantized && g.quantized.sig === g.sig ? g.quantized : null;
  showQuantizedWave = Boolean(q && S.project?.songs?.[currentSid]?.quantized);

  // Preload drum peaks
  getPeaksCached(currentSid, "drums", "");
  if (q?.rev) getPeaksCached(currentSid, "drums", q.rev);

  const titleEl = document.getElementById("gmTitle");
  const subEl = document.getElementById("gmSubtitle");
  const banner = document.getElementById("gmAuditBanner");
  const playQBtn = document.getElementById("gmPlayQuant");

  if (titleEl) titleEl.textContent = `Beat Grid & Hit Audit — ${detail.title || currentSid}`;
  if (subEl) {
    const qInfo = q ? ` · Quantized: ${q.bpm.toFixed(2)} BPM (${q.audit?.median_offset_ms ?? 0} ms med / ${q.audit?.max_offset_ms ?? 0} ms max)` : " · Not yet quantized";
    subEl.textContent = `Raw: ${Number(g.bpm).toFixed(2)} BPM · ${g.bpb}/4 · ${g.beats.length} beats · mode: ${g.mode}${qInfo}`;
  }
  if (playQBtn) {
    playQBtn.disabled = !q;
    playQBtn.style.opacity = q ? "1" : "0.45";
  }

  // Diagnostic honesty banner
  const aud = g.audit || {};
  const qAud = q?.audit || null;
  if (banner) {
    let cls = "ok";
    const lines = [];
    if (aud.note) lines.push(aud.note);
    if (qAud) {
      lines.push(`Quantized stems verified against real drum hits: ${qAud.median_offset_ms.toFixed(1)} ms median, ${qAud.max_offset_ms.toFixed(1)} ms max, ${qAud.drift_pct.toFixed(2)}% drift (${qAud.bad_windows} bad windows).`);
      cls = qAud.status === "ok" ? "ok" : qAud.status === "warn" ? "warn" : "bad";
    } else {
      lines.push(`Raw grid vs drum hits: ${Number(aud.median_offset_ms || 0).toFixed(1)} ms median, ${Number(aud.max_offset_ms || 0).toFixed(1)} ms max, ${Number(aud.drift_pct || 0).toFixed(2)}% tempo drift.`);
      cls = aud.status === "ok" ? (aud.needs_quantize ? "warn" : "ok") : aud.status === "warn" ? "warn" : "bad";
    }
    banner.className = `audit-banner ${cls}`;
    banner.textContent = lines.join("  |  ");
  }

  // Section audit table
  const tbody = document.getElementById("gmSectionsBody");
  if (tbody) {
    tbody.innerHTML = "";
    const activeAudit = qAud && showQuantizedWave ? qAud : aud;
    const sections = activeAudit.sections || [];
    for (const sec of sections) {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      tr.title = "Click to jump to this section & audition with click";
      const off = Number(sec.offset_ms || 0);
      const absOff = Math.abs(off);
      const offCls = !sec.active ? "" : absOff <= 16 ? "gm-off-ok" : absOff <= 32 ? "gm-off-warn" : "gm-off-bad";
      const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
      tr.innerHTML = `
        <td>${fmtT(sec.t0)} - ${fmtT(sec.t1)}</td>
        <td>${Number(sec.bpm || sec.local_bpm || 0).toFixed(2)}</td>
        <td>${sec.active ? "Drums" : "Break"}</td>
        <td class="${offCls}">${sec.active ? `${off >= 0 ? "+" : ""}${off.toFixed(1)} ms` : "—"}</td>
        <td>${Number(sec.clarity || 0).toFixed(2)}</td>
      `;
      tr.addEventListener("click", () => {
        viewStartS = Math.max(0, sec.t0 - 1.5);
        drawGridCanvas();
        auditionAt(sec.t0, showQuantizedWave);
      });
      tbody.appendChild(tr);
    }
  }

  drawGridCanvas();
}

async function auditionAt(startS, quantized) {
  if (!currentSid) return;
  try {
    await audio.auditionSong(currentSid, {
      stem: "mix",
      start_s: Math.max(0, startS),
      quantized: Boolean(quantized),
      click: true,
    });
  } catch (e) {
    api.toast(`Audition failed: ${e.message}`, "err");
  }
}

export function drawGridCanvas() {
  const cv = document.getElementById("gmCanvas");
  if (!cv || !currentSid) return;
  const detail = S.details[currentSid];
  const g = detail?.grid;
  if (!g) return;

  const rect = cv.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(rect.width * dpr);
  cv.height = Math.round(rect.height * dpr);
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  ctx.fillStyle = "#090b0e";
  ctx.fillRect(0, 0, W, H);

  const q = g.quantized && g.quantized.sig === g.sig ? g.quantized : null;
  const useQ = Boolean(showQuantizedWave && q?.rev);
  const peaks = getPeaksCached(currentSid, "drums", useQ ? q.rev : "");
  const dur = Number(g.duration || 180);
  viewSpanS = Math.max(4, Math.min(dur, viewSpanS));
  viewStartS = Math.max(0, Math.min(Math.max(0, dur - viewSpanS), viewStartS));
  const t0 = viewStartS;
  const t1 = viewStartS + viewSpanS;
  const pxPerSec = W / viewSpanS;

  // Draw drum waveform (orange)
  if (peaks && peaks.length >= 2) {
    const nBins = peaks.length >> 1;
    const mid = H * 0.54;
    const amp = H * 0.40;
    ctx.fillStyle = "rgba(232, 148, 74, 0.55)";
    for (let x = 0; x < W; x++) {
      const sA = t0 + (x / W) * viewSpanS;
      const sB = t0 + ((x + 1) / W) * viewSpanS;
      const i0 = Math.max(0, Math.min(nBins - 1, Math.floor(sA * 100)));
      const i1 = Math.max(i0 + 1, Math.min(nBins, Math.ceil(sB * 100)));
      let lo = 127;
      let hi = -127;
      for (let i = i0; i < i1; i++) {
        const a = peaks[i * 2];
        const b = peaks[i * 2 + 1];
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      const yTop = mid - (hi / 127) * amp;
      const yBot = mid - (lo / 127) * amp;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
  } else {
    ctx.fillStyle = "#5d6675";
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.fillText("Loading drums waveform...", 12, H / 2);
  }

  // Draw beat & bar lines
  const beats = useQ
    ? Array.from({ length: q.n_beats }, (_, k) => q.t0 + k * q.period)
    : g.beats;
  const bpb = Number(g.bpb || 4);
  const downOff = Number(g.downbeat_offset || 0);
  const secList = (useQ ? q.audit?.sections : g.audit?.sections) || [];

  const sectionColor = (bt) => {
    for (const s of secList) {
      if (bt >= s.t0 && bt <= s.t1) {
        if (!s.active) return "rgba(139, 149, 165, 0.45)";
        const absOff = Math.abs(Number(s.offset_ms || 0));
        if (absOff <= 16) return "rgba(46, 224, 110, 0.85)";
        if (absOff <= 32) return "rgba(240, 178, 75, 0.9)";
        return "rgba(240, 82, 98, 0.95)";
      }
    }
    return "rgba(46, 224, 110, 0.75)";
  };

  ctx.font = "10px Consolas, monospace";
  for (let j = 0; j < beats.length; j++) {
    const bt = beats[j];
    if (bt < t0 - 0.1 || bt > t1 + 0.1) continue;
    const x = Math.round((bt - t0) * pxPerSec) + 0.5;
    const isBar = ((j - downOff) % bpb + bpb) % bpb === 0 && j >= downOff;
    ctx.strokeStyle = sectionColor(bt);
    ctx.lineWidth = isBar ? 1.8 : 1.0;
    ctx.globalAlpha = isBar ? 0.95 : 0.45;
    ctx.beginPath();
    ctx.moveTo(x, isBar ? 14 : 22);
    ctx.lineTo(x, H);
    ctx.stroke();
    if (isBar) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#e6ebf2";
      const barNum = Math.floor((j - downOff) / bpb) + 1;
      ctx.fillText(String(barNum), x + 3, 11);
    }
  }
  ctx.globalAlpha = 1.0;

  // Audition playhead tracker on Grid Modal canvas
  const audS = currentAudSec();
  if (audS !== null && audS >= t0 && audS <= t1) {
    const ax = Math.round((audS - t0) * pxPerSec) + 0.5;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(ax, 0);
    ctx.lineTo(ax, H);
    ctx.stroke();
    ctx.strokeStyle = "#2ee06e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax, 0);
    ctx.lineTo(ax, H);
    ctx.stroke();
  }

  // Mode watermark
  ctx.fillStyle = "rgba(139,149,165,0.85)";
  ctx.font = "10px Consolas, monospace";
  ctx.fillText(`${useQ ? "QUANTIZED" : "RAW"} DRUMS  ·  Scroll=Zoom  Drag=Pan  Click=Audition+Click`, 10, H - 6);
}

async function applyGridUpdate(payload) {
  if (!currentSid) return;
  try {
    const g = await api.put(`/api/songs/${encodeURIComponent(currentSid)}/grid`, payload);
    if (S.details[currentSid]) S.details[currentSid].grid = g;
    await refreshGridModal(false);
    api.toast("Beat grid updated & re-audited", "ok");
  } catch (e) {
    api.toast(`Grid update failed: ${e.message}`, "err");
  }
}

export function initGridModal() {
  document.getElementById("gmClose")?.addEventListener("click", closeGridModal);
  document.getElementById("gridModal")?.addEventListener("click", (e) => {
    if (e.target.id === "gridModal") closeGridModal();
  });

  document.getElementById("gmPlayRaw")?.addEventListener("click", () => {
    showQuantizedWave = false;
    drawGridCanvas();
    auditionAt(viewStartS, false);
  });
  document.getElementById("gmPlayQuant")?.addEventListener("click", () => {
    showQuantizedWave = true;
    drawGridCanvas();
    auditionAt(viewStartS, true);
  });
  document.getElementById("gmStopAud")?.addEventListener("click", () => {
    audio.stopAudition();
  });

  document.getElementById("gmAutoFix")?.addEventListener("click", async () => {
    if (!currentSid) return;
    S.busyOp = { label: `Auto-fixing beat grid...`, startedAt: Date.now() };
    try {
      const g = await api.post(`/api/songs/${encodeURIComponent(currentSid)}/grid/audit`, { force: true });
      if (S.details[currentSid]) S.details[currentSid].grid = g;
      await refreshGridModal(false);
      api.toast("Beat grid re-verified against full-band drum hits", "ok");
    } catch (e) {
      api.toast(`Auto-fix failed: ${e.message}`, "err");
    } finally {
      S.busyOp = null;
    }
  });

  document.getElementById("gmQuantize")?.addEventListener("click", async () => {
    if (!currentSid) return;
    try {
      await api.post(`/api/songs/${encodeURIComponent(currentSid)}/quantize`, {});
      api.toast("Quantizing all 4 stems with Rubber Band R3 + click-pilot...", "");
    } catch (e) {
      api.toast(`Quantize failed: ${e.message}`, "err");
    }
  });

  document.getElementById("gmShiftBack")?.addEventListener("click", () => applyGridUpdate({ downbeat_shift: -1 }));
  document.getElementById("gmShiftFwd")?.addEventListener("click", () => applyGridUpdate({ downbeat_shift: 1 }));
  document.getElementById("gmNudgeM10")?.addEventListener("click", () => applyGridUpdate({ nudge_ms: -10 }));
  document.getElementById("gmNudgeM2")?.addEventListener("click", () => applyGridUpdate({ nudge_ms: -2 }));
  document.getElementById("gmNudgeP2")?.addEventListener("click", () => applyGridUpdate({ nudge_ms: 2 }));
  document.getElementById("gmNudgeP10")?.addEventListener("click", () => applyGridUpdate({ nudge_ms: 10 }));
  document.getElementById("gmHalf")?.addEventListener("click", () => applyGridUpdate({ factor: 0.5 }));
  document.getElementById("gmDouble")?.addEventListener("click", () => applyGridUpdate({ factor: 2.0 }));

  // Canvas pan / zoom / click-to-audition
  const cv = document.getElementById("gmCanvas");
  cv?.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const anchor = viewStartS + frac * viewSpanS;
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    viewSpanS = Math.max(4, Math.min(240, viewSpanS * factor));
    viewStartS = Math.max(0, anchor - frac * viewSpanS);
    drawGridCanvas();
  }, { passive: false });

  cv?.addEventListener("mousedown", (e) => {
    dragging = true;
    dragX0 = e.clientX;
    dragStartS0 = viewStartS;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging || !currentSid) return;
    const rect = cv.getBoundingClientRect();
    const dx = e.clientX - dragX0;
    viewStartS = Math.max(0, dragStartS0 - (dx / rect.width) * viewSpanS);
    drawGridCanvas();
  });
  window.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    if (Math.abs(e.clientX - dragX0) < 4 && currentSid) {
      const rect = cv.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      auditionAt(viewStartS + frac * viewSpanS, showQuantizedWave);
    }
  });

  onChange((kind) => {
    if (currentSid && (kind === "peaks" || kind === "song_detail")) {
      refreshGridModal(false);
    }
  });
}
