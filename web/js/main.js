// Re-Tex Core bootstrap: transport, Songs-in-Mix bar, Clip Inspector, modals, shortcuts & SSE

import * as api from "./api.js";
import * as audio from "./audio.js";
import {
  S, alignSelectedToBar1, canRedo, canUndo, clipTotalSemis, copySelected, currentBeat,
  deleteSelected, duplicateSelectedAfter, edit, emit, ensureSongDetail, loadProject,
  onChange, pasteAt, redo, registerAudioHooks, saveNow, setPlayhead, songGrid, songMeta,
  songUseQuantized, splitSelectedAt, toggleMuteSelected, undo, updateTransport,
} from "./state.js";
import { initLibrary, renderLibrary } from "./library.js";
import { initTimeline, renderTrackHeaders, requestDraw, zoomBy, zoomFit } from "./timeline.js";
import { initGridModal, openGridModal, refreshGridModal } from "./gridmodal.js";

let exportJobId = null;
const tapTimes = [];

// ------------------------------------------------------------------ Topbar & Project Controls

function renderProjectList() {
  const sel = document.getElementById("projectSelect");
  if (!sel) return;
  sel.innerHTML = "";
  for (const p of S.projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} (${Math.round(p.bpm)} BPM)`;
    if (S.project && p.id === S.project.id) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderTopbar() {
  if (!S.project) return;
  const nameIn = document.getElementById("projectName");
  if (nameIn && document.activeElement !== nameIn) nameIn.value = S.project.name || "Untitled Mashup";
  const bpmIn = document.getElementById("bpmInput");
  if (bpmIn && document.activeElement !== bpmIn) bpmIn.value = String(Math.round(Number(S.project.bpm || 128) * 10) / 10);
  const bpbSel = document.getElementById("bpbSelect");
  if (bpbSel) bpbSel.value = String(S.project.bpb || 4);
  const snapSel = document.getElementById("snapSelect");
  if (snapSel) snapSel.value = String(S.project.snap ?? 1);

  const playBtn = document.getElementById("btnPlay");
  if (playBtn) {
    playBtn.textContent = S.transport.playing ? "Stop" : "Play";
    playBtn.classList.toggle("playing", Boolean(S.transport.playing));
  }
  const loopBtn = document.getElementById("btnLoop");
  if (loopBtn) loopBtn.classList.toggle("on", Boolean(S.project.loop?.on));
  const clickBtn = document.getElementById("btnClick");
  if (clickBtn) clickBtn.classList.toggle("on", Boolean(S.transport.click));

  const vol = document.getElementById("volSlider");
  if (vol && document.activeElement !== vol && typeof S.transport.volume === "number") {
    vol.value = String(S.transport.volume);
  }

  const undoBtn = document.getElementById("btnUndo");
  const redoBtn = document.getElementById("btnRedo");
  if (undoBtn) undoBtn.style.opacity = canUndo() ? "1" : "0.45";
  if (redoBtn) redoBtn.style.opacity = canRedo() ? "1" : "0.45";

  renderProgressTracker();
}

// ------------------------------------------------------------------ Songs-in-Mix Strip

function renderSongsStrip() {
  const strip = document.getElementById("songsStrip");
  if (!strip || !S.project) return;
  const sids = Object.keys(S.project.songs || {});
  strip.innerHTML = "";
  if (!sids.length) {
    strip.innerHTML = '<div class="songs-empty">Drag stems or click +All in the library to start building a mashup.</div>';
    return;
  }

  for (const sid of sids) {
    const sc = S.project.songs[sid] || {};
    const meta = songMeta(sid);
    const g = songGrid(sid);
    const hasValidQ = Boolean(g?.quantized?.rev && g.quantized.sig === g.sig);
    const useQ = songUseQuantized(sid);

    const pill = document.createElement("div");
    pill.className = "mix-song-pill";

    const title = document.createElement("span");
    title.className = "msp-title";
    title.textContent = meta?.title || sid;
    title.title = meta?.title || sid;

    const info = document.createElement("span");
    info.className = "msp-info";
    const bpmTxt = g ? `${Math.round(g.bpm)} BPM` : (meta?.bpm ? `${Math.round(meta.bpm)} BPM` : "");
    const keyTxt = meta?.camelot || meta?.key || "";
    info.textContent = [bpmTxt, keyTxt].filter(Boolean).join(" · ");

    // Honest Hit-Sync Badge
    const badge = document.createElement("button");
    badge.className = "hit-badge";
    if (!g) {
      badge.classList.add("warn");
      badge.textContent = "Loading...";
    } else if (useQ) {
      const qa = g.quantized.audit || {};
      const ok = qa.status === "ok";
      badge.classList.add(ok ? "ok" : qa.status === "warn" ? "warn" : "bad");
      badge.textContent = ok
        ? `Synced ${Number(qa.median_offset_ms || 0).toFixed(1)}ms`
        : qa.status === "warn"
          ? `Q Warn ${Number(qa.max_offset_ms || 0).toFixed(0)}ms`
          : `Q Off ${Number(qa.max_offset_ms || 0).toFixed(0)}ms`;
      badge.title = `Quantized drums verified: ${Number(qa.median_offset_ms || 0).toFixed(1)} ms median, ${Number(qa.max_offset_ms || 0).toFixed(1)} ms max. Click to inspect grid.`;
    } else {
      const aud = g.audit || {};
      if (aud.status === "off_beat") {
        badge.classList.add("bad");
        badge.textContent = `Off ${Number(aud.median_offset_ms || 0).toFixed(0)}ms`;
      } else if (aud.needs_quantize || aud.status === "drift") {
        badge.classList.add("warn");
        badge.textContent = `Drift ${Number(aud.drift_pct || 0).toFixed(1)}%`;
      } else {
        badge.classList.add("ok");
        badge.textContent = `Steady ${Number(aud.median_offset_ms || 0).toFixed(1)}ms`;
      }
      badge.title = `${aud.note || "Click to inspect Beat Grid & Drum Hits"}`;
    }
    badge.addEventListener("click", () => openGridModal(sid));

    // 1-Click Quantize button / toggle
    const qBtn = document.createElement("button");
    qBtn.className = `btn-mini btn-toggle${useQ ? " on" : ""}`;
    qBtn.textContent = hasValidQ ? (useQ ? "Quantized" : "Quantize Off") : "Quantize";
    qBtn.title = hasValidQ
      ? "Toggle verified quantized stems ON/OFF"
      : "Warp all 4 stems onto steady beat grid with Rubber Band R3 + click-pilot";
    qBtn.addEventListener("click", async () => {
      if (hasValidQ) {
        edit((p) => {
          if (p.songs[sid]) p.songs[sid].quantized = !p.songs[sid].quantized;
        });
      } else {
        try {
          await api.post(`/api/songs/${encodeURIComponent(sid)}/quantize`, {});
          api.toast(`Quantizing ${meta?.title || sid}...`, "");
        } catch (e) {
          api.toast(`Quantize failed: ${e.message}`, "err");
        }
      }
    });

    // Song Transpose stepper (pitched stems)
    const trStep = document.createElement("div");
    trStep.className = "stepper";
    trStep.title = "Song key transpose (bass/other/vocals; drums stay unpitched)";
    const trDown = document.createElement("button");
    trDown.textContent = "-";
    const trVal = document.createElement("span");
    const tv = Math.round(Number(sc.transpose || 0) * 10) / 10;
    trVal.textContent = `${tv > 0 ? "+" : ""}${tv}st`;
    if (Math.abs(tv) > 1e-4) trVal.style.color = "var(--green-hi)";
    const trUp = document.createElement("button");
    trUp.textContent = "+";
    const nudgeTr = (d) => {
      edit((p) => {
        if (p.songs[sid]) {
          p.songs[sid].transpose = Math.max(-12, Math.min(12, Math.round(((p.songs[sid].transpose || 0) + d) * 10) / 10));
        }
      }, { coalesce: `str-${sid}` });
    };
    trDown.addEventListener("click", () => nudgeTr(-1));
    trUp.addEventListener("click", () => nudgeTr(1));
    trVal.addEventListener("dblclick", () => edit((p) => { if (p.songs[sid]) p.songs[sid].transpose = 0; }));
    trStep.append(trDown, trVal, trUp);

    // Speed Mult button (0.5x / 1x / 2x)
    const multBtn = document.createElement("button");
    multBtn.className = "btn-mini btn-ghost";
    const mv = Number(sc.mult || 1);
    multBtn.textContent = `${mv}x`;
    multBtn.title = "Song beat multiplier (0.5x half-time / 1x / 2x double-time)";
    multBtn.addEventListener("click", () => {
      const order = [0.5, 1.0, 2.0];
      const next = order[(order.indexOf(mv) + 1) % order.length] || 1.0;
      edit((p) => {
        if (p.songs[sid]) p.songs[sid].mult = next;
      });
    });

    // Grid modal button
    const gridBtn = document.createElement("button");
    gridBtn.className = "btn-mini btn-ghost";
    gridBtn.textContent = "Grid";
    gridBtn.title = "Open Beat Grid & Drum-Hit Audit inspector";
    gridBtn.addEventListener("click", () => openGridModal(sid));

    pill.append(title, info, badge, qBtn, trStep, multBtn, gridBtn);
    strip.appendChild(pill);
  }
}

// ------------------------------------------------------------------ Bottom Clip Inspector

function renderClipInspector() {
  const el = document.getElementById("clipInspector");
  if (!el || !S.project) return;
  const sel = S.project.clips.filter((c) => S.selClips.has(c.id));

  if (!sel.length) {
    el.innerHTML = '<span class="insp-muted">Click a clip to inspect &middot; Drag edges to trim &middot; Drag top corners to fade &middot; S = Split &middot; Ctrl+D = Duplicate After &middot; A = Align Bar 1</span>';
    return;
  }

  if (sel.length > 1) {
    el.innerHTML = "";
    const chip = document.createElement("span");
    chip.className = "insp-chip";
    chip.textContent = `${sel.length} clips selected`;
    const btnSplit = makeMiniBtn("Split (S)", () => splitSelectedAt());
    const btnDup = makeMiniBtn("Dup After (Ctrl+D)", () => duplicateSelectedAfter());
    const btnAlign = makeMiniBtn("Align Bar 1 (A)", () => alignSelectedToBar1());
    const btnMute = makeMiniBtn("Mute (M)", () => toggleMuteSelected());
    const btnDel = makeMiniBtn("Delete", () => deleteSelected());
    el.append(chip, btnSplit, btnDup, btnAlign, btnMute, btnDel);
    return;
  }

  const c = sel[0];
  const meta = songMeta(c.song);
  const totalSt = clipTotalSemis(c);
  el.innerHTML = "";

  const chip = document.createElement("span");
  chip.className = "insp-chip";
  chip.textContent = `${(meta?.title || c.song).slice(0, 26)} · ${c.stem.toUpperCase()}`;

  const mkNum = (label, val, step, min, max, onVal, suffix = "") => {
    const wrap = document.createElement("label");
    wrap.className = "insp-field";
    const sp = document.createElement("span");
    sp.className = "lbl";
    sp.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = String(step);
    if (min !== null) inp.min = String(min);
    if (max !== null) inp.max = String(max);
    inp.value = String(Math.round(Number(val || 0) * 100) / 100);
    inp.addEventListener("change", () => {
      const n = parseFloat(inp.value);
      if (!Number.isNaN(n)) onVal(n);
    });
    wrap.append(sp, inp);
    if (suffix) {
      const sf = document.createElement("span");
      sf.className = "lbl";
      sf.textContent = suffix;
      wrap.appendChild(sf);
    }
    return wrap;
  };

  const fStart = mkNum("Start", c.start, 0.25, 0, null, (v) => {
    edit((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.start = Math.max(0, v); });
  });
  const fLen = mkNum("Len", c.len, 0.25, 0.25, null, (v) => {
    edit((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.len = Math.max(0.25, v); });
  });
  const fPitch = mkNum("Clip Pitch", c.pitch || 0, 1, -12, 12, (v) => {
    edit((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.pitch = Math.max(-12, Math.min(12, v)); });
  }, totalSt !== (c.pitch || 0) ? `(tot ${totalSt > 0 ? "+" : ""}${totalSt}st)` : "st");
  const fGain = mkNum("Gain", c.gain_db || 0, 0.5, -30, 18, (v) => {
    edit((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.gain_db = Math.max(-30, Math.min(18, v)); });
  }, "dB");
  const fIn = mkNum("Fade In", c.fade_in || 0, 0.25, 0, c.len * 0.5, (v) => {
    edit((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.fade_in = Math.max(0, Math.min(x.len * 0.5, v)); });
  });
  const fOut = mkNum("Fade Out", c.fade_out || 0, 0.25, 0, c.len * 0.5, (v) => {
    edit((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.fade_out = Math.max(0, Math.min(x.len * 0.5, v)); });
  });

  const rateBtn = makeMiniBtn(`Rate ${c.rate || 1}x`, () => {
    const order = [0.5, 1.0, 2.0];
    const next = order[(order.indexOf(Number(c.rate || 1)) + 1) % order.length] || 1.0;
    edit((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.rate = next; });
  });

  el.append(chip, fStart, fLen, fPitch, fGain, fIn, fOut, rateBtn);
}

function makeMiniBtn(text, onClick) {
  const b = document.createElement("button");
  b.className = "btn-mini btn-ghost";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

// ------------------------------------------------------------------ Jobs Banner

// ------------------------------------------------------------------ Progress Tracker & Activity Drawer

function fmtElapsed(msOrSec) {
  if (!msOrSec) return "";
  const ts = msOrSec > 1e12 ? msOrSec : msOrSec * 1000;
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function renderProgressTracker() {
  const pill = document.getElementById("taskPill");
  const lbl = document.getElementById("taskLabel");
  const bar = document.getElementById("taskBar");
  const fill = document.getElementById("taskFill");
  const timer = document.getElementById("taskTimer");
  const cacheTag = document.getElementById("cacheTag");
  const cancelWarpsBtn = document.getElementById("btnCancelWarps");

  const activeJobs = S.jobs.filter((j) => j.status === "queued" || j.status === "running");
  const ws = S.warpState || { pending: 0, done: 0, total: 0, active: null, queued: [] };
  const cs = audio.getCacheStats();

  if (cacheTag) {
    cacheTag.textContent = `${cs.count} stems · ${cs.mb.toFixed(0)} MB`;
  }
  if (cancelWarpsBtn) {
    cancelWarpsBtn.classList.toggle("hidden", (ws.queued?.length || 0) === 0);
  }

  let busy = false;
  let text = S.dirty ? "Unsaved" : "Ready";
  let pct = null; // number 0..100 or "indet" or null
  let startedAt = null;

  if (activeJobs.length > 0) {
    const j = activeJobs[0];
    busy = true;
    const p = Math.round((j.progress || 0) * 100);
    text = `${j.label}${j.message ? ` — ${j.message}` : ""} (${p}%)`;
    pct = p;
    startedAt = j.created;
  } else if (S.busyOp) {
    busy = true;
    text = S.busyOp.label;
    pct = "indet";
    startedAt = S.busyOp.startedAt;
  } else if (ws.pending > 0) {
    busy = true;
    const tot = Math.max(1, ws.total || ws.pending);
    const done = Math.min(tot, ws.done || 0);
    const cur = ws.active;
    const curDesc = cur ? `${cur.stem} (${(cur.title || cur.sid).slice(0, 18)})` : "queued";
    text = `R3 Warp ${done}/${tot}: ${curDesc}`;
    pct = Math.max(8, Math.round((done / tot) * 100));
    startedAt = cur?.started || null;
  } else if (cs.loadingCount > 0) {
    busy = true;
    text = `Caching ${cs.loadingCount} stem${cs.loadingCount > 1 ? "s" : ""} in browser...`;
    pct = "indet";
    startedAt = cs.loadingItems[0]?.startedAt || null;
  }

  if (pill) pill.classList.toggle("busy", busy);
  if (lbl) lbl.textContent = text;
  if (bar && fill) {
    if (pct === null) {
      bar.classList.add("hidden");
      fill.classList.remove("indet");
    } else if (pct === "indet") {
      bar.classList.remove("hidden");
      fill.classList.add("indet");
    } else {
      bar.classList.remove("hidden");
      fill.classList.remove("indet");
      fill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
    }
  }
  if (timer) {
    const el = fmtElapsed(startedAt);
    timer.textContent = el;
    timer.classList.toggle("hidden", !busy || !el);
  }

  // Update open drawer body
  const drawer = document.getElementById("taskDrawer");
  if (drawer && !drawer.classList.contains("hidden")) {
    renderTaskDrawer(activeJobs, ws, cs);
  }
}

function renderTaskDrawer(activeJobs, ws, cs) {
  const body = document.getElementById("tdBody");
  if (!body) return;
  body.innerHTML = "";

  // 1) Backend Jobs (Quantize / Import / Export)
  if (activeJobs.length > 0) {
    const sec = document.createElement("div");
    sec.innerHTML = '<div class="td-sec-title">Active Jobs</div>';
    for (const j of activeJobs) {
      const row = document.createElement("div");
      row.className = "td-row";
      const p = Math.round((j.progress || 0) * 100);
      row.innerHTML = `
        <div class="td-row-top">
          <span>${j.label}</span>
          <button class="btn-mini btn-ghost" data-cancel="${j.id}">Cancel</button>
        </div>
        <div class="td-row-sub"><span>${j.message || j.status}</span><span>${p}% · ${fmtElapsed(j.created)}</span></div>
        <div class="td-pbar"><div class="td-pfill" style="width:${p}%"></div></div>
      `;
      row.querySelector(`[data-cancel="${j.id}"]`)?.addEventListener("click", () => {
        api.post(`/api/jobs/${j.id}/cancel`).catch(() => {});
      });
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }

  // 2) Background Rubber Band R3 Warps
  if (ws.pending > 0) {
    const sec = document.createElement("div");
    sec.innerHTML = `<div class="td-sec-title">Background R3 Stem Warping (${ws.done}/${ws.total} done — live playback unaffected!)</div>`;
    if (ws.active) {
      const a = ws.active;
      const row = document.createElement("div");
      row.className = "td-row";
      const pitchTxt = Math.abs(a.semis || 0) > 1e-3 ? ` · ${a.semis > 0 ? "+" : ""}${a.semis}st` : "";
      row.innerHTML = `
        <div class="td-row-top"><span>Running: ${a.title} · <b>${a.stem}</b></span><span class="task-timer">${fmtElapsed(a.started)}</span></div>
        <div class="td-row-sub"><span>${Number(a.bpm).toFixed(1)} BPM${pitchTxt} — hot-swaps when done</span><span>Rubber Band R3</span></div>
      `;
      sec.appendChild(row);
    }
    for (const q of (ws.queued || []).slice(0, 6)) {
      const row = document.createElement("div");
      row.className = "td-row";
      row.innerHTML = `<div class="td-row-sub"><span>Queued: ${q.title} · ${q.stem}</span><span>${Number(q.bpm).toFixed(1)} BPM</span></div>`;
      sec.appendChild(row);
    }
    if ((ws.queued?.length || 0) > 6) {
      const more = document.createElement("div");
      more.className = "td-row-sub";
      more.textContent = `+ ${ws.queued.length - 6} more queued`;
      sec.appendChild(more);
    }
    body.appendChild(sec);
  }

  // 3) Browser Audio Cache & Loading
  const cSec = document.createElement("div");
  cSec.innerHTML = '<div class="td-sec-title">Browser Web Audio Cache (Instant Play/Stop)</div>';
  const cRow = document.createElement("div");
  cRow.className = "td-row";
  const loadTxt = cs.loadingCount > 0
    ? `Decoding ${cs.loadingCount} stem(s): ${cs.loadingItems.map((x) => x.label).slice(0, 2).join(", ")}`
    : "All active stems decoded and ready for instant <1 ms playback.";
  cRow.innerHTML = `
    <div class="td-row-top"><span>${cs.count} active stem buffers in browser RAM</span><span style="font-family:var(--mono);color:var(--green-hi)">${cs.mb.toFixed(1)} MB</span></div>
    <div class="td-row-sub"><span>${loadTxt}</span></div>
    <div class="td-row-sub"><span>Unused buffers auto-evict whenever clips/lanes/projects change.</span></div>
  `;
  cSec.appendChild(cRow);
  body.appendChild(cSec);
}

// ------------------------------------------------------------------ Transport & Modals

function togglePlay() {
  if (!S.project) return;
  if (audio.isEnginePlaying()) {
    audio.stop();
  } else {
    audio.play(currentBeat());
  }
}

function initModals() {
  // Progress Tracker Drawer controls
  const drawer = document.getElementById("taskDrawer");
  document.getElementById("taskPill")?.addEventListener("click", () => {
    drawer?.classList.toggle("hidden");
    renderProgressTracker();
  });
  document.getElementById("btnCloseDrawer")?.addEventListener("click", () => drawer?.classList.add("hidden"));
  document.getElementById("btnPruneCache")?.addEventListener("click", () => {
    const n = audio.pruneCache();
    renderProgressTracker();
    api.toast(n ? `Freed ${n} unused audio buffer${n > 1 ? "s" : ""}` : "Cache already lean (only active clips loaded)", "ok");
  });
  document.getElementById("btnCancelWarps")?.addEventListener("click", async () => {
    try {
      const r = await api.post("/api/warp/cancel", {});
      if (r?.warp_state) S.warpState = r.warp_state;
      renderProgressTracker();
      api.toast(`Cancelled ${r?.cancelled || 0} queued warp(s)`, "");
    } catch {}
  });

  // Export modal
  const expModal = document.getElementById("exportModal");
  document.getElementById("btnExport")?.addEventListener("click", () => {
    document.getElementById("expResult")?.classList.add("hidden");
    expModal?.classList.remove("hidden");
  });
  document.getElementById("expClose")?.addEventListener("click", () => expModal?.classList.add("hidden"));
  expModal?.addEventListener("click", (e) => { if (e.target.id === "exportModal") expModal.classList.add("hidden"); });

  document.getElementById("expReveal")?.addEventListener("click", () => {
    api.post("/api/reveal", {}).catch((e) => api.toast(e.message, "err"));
  });

  document.getElementById("expRun")?.addEventListener("click", async () => {
    if (!S.project || !S.project.clips.length) {
      api.toast("Add at least one clip before exporting", "err");
      return;
    }
    const fmt = document.getElementById("expFormat")?.value || "mp3";
    const norm = Boolean(document.getElementById("expNorm")?.checked);
    const resEl = document.getElementById("expResult");
    if (resEl) {
      resEl.classList.remove("hidden");
      resEl.textContent = "Rendering stems & mastering mix...";
    }
    try {
      const job = await api.post("/api/export", { project: S.project, format: fmt, normalize: norm });
      exportJobId = job.id;
    } catch (e) {
      if (resEl) resEl.textContent = `Export failed: ${e.message}`;
      api.toast(`Export failed: ${e.message}`, "err");
    }
  });

  // Audio Output Device modal (Browser Web Audio setSinkId)
  const audModal = document.getElementById("audioModal");
  document.getElementById("btnAudioOut")?.addEventListener("click", async () => {
    try {
      const devs = await audio.listAudioOutputs();
      const sel = document.getElementById("audDeviceSelect");
      if (sel) {
        sel.innerHTML = "";
        const def = document.createElement("option");
        def.value = "";
        def.textContent = "Browser / System Default";
        sel.appendChild(def);
        for (const d of devs) {
          if (!d.id || d.id === "default") continue;
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = d.label || d.id;
          sel.appendChild(opt);
        }
      }
      audModal?.classList.remove("hidden");
    } catch (e) {
      api.toast(`Could not list audio devices: ${e.message}`, "err");
    }
  });
  document.getElementById("audClose")?.addEventListener("click", () => audModal?.classList.add("hidden"));
  audModal?.addEventListener("click", (e) => { if (e.target.id === "audioModal") audModal.classList.add("hidden"); });
  document.getElementById("audApply")?.addEventListener("click", async () => {
    const dev = document.getElementById("audDeviceSelect")?.value || "";
    try {
      const ok = await audio.setAudioOutput(dev);
      audModal?.classList.add("hidden");
      api.toast(ok ? "Browser audio output updated" : "Using browser system default output", "ok");
    } catch (e) {
      api.toast(`Audio switch failed: ${e.message}`, "err");
    }
  });
}

function initControls() {
  document.getElementById("projectSelect")?.addEventListener("change", async (e) => {
    const pid = e.target.value;
    if (pid && S.project?.id !== pid) {
      await loadProject(pid);
      renderProjectList();
      zoomFit();
    }
  });

  document.getElementById("projectName")?.addEventListener("change", (e) => {
    const name = e.target.value.trim() || "Untitled Mashup";
    edit((p) => { p.name = name; }, { coalesce: "pname" });
  });

  document.getElementById("btnNewProj")?.addEventListener("click", async () => {
    try {
      const p = await api.post("/api/projects/new", { name: "Untitled Mashup", bpm: 128 });
      S.projects = await api.get("/api/projects");
      await loadProject(p.id);
      renderProjectList();
      api.toast("Created new project", "ok");
    } catch (e) {
      api.toast(`New project failed: ${e.message}`, "err");
    }
  });

  document.getElementById("btnBranchProj")?.addEventListener("click", async () => {
    if (!S.project) return;
    try {
      await saveNow(true);
      const b = await api.post(`/api/projects/${encodeURIComponent(S.project.id)}/branch`, {});
      S.projects = await api.get("/api/projects");
      await loadProject(b.id);
      renderProjectList();
      api.toast(`Branched: ${b.name}`, "ok");
    } catch (e) {
      api.toast(`Branch failed: ${e.message}`, "err");
    }
  });

  document.getElementById("btnSaveProj")?.addEventListener("click", () => saveNow(false));
  document.getElementById("btnRewind")?.addEventListener("click", () => {
    audio.seek(0);
    setPlayhead(0);
  });
  document.getElementById("btnPlay")?.addEventListener("click", togglePlay);

  document.getElementById("btnLoop")?.addEventListener("click", () => {
    edit((p) => {
      if (!p.loop) p.loop = { on: true, start: 0, end: 16 };
      else p.loop.on = !p.loop.on;
    });
  });

  document.getElementById("btnClick")?.addEventListener("click", () => {
    audio.setClickEnabled(!S.transport.click);
  });

  document.getElementById("bpmInput")?.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (!Number.isNaN(v) && v >= 40 && v <= 260) {
      edit((p) => { p.bpm = Math.round(v * 100) / 100; });
    }
  });

  document.getElementById("btnTapBpm")?.addEventListener("click", () => {
    const now = performance.now();
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2200) tapTimes.length = 0;
    tapTimes.push(now);
    if (tapTimes.length > 8) tapTimes.shift();
    if (tapTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
      const avgMs = sum / (tapTimes.length - 1);
      const bpm = Math.max(40, Math.min(260, Math.round((60000 / avgMs) * 10) / 10));
      edit((p) => { p.bpm = bpm; }, { coalesce: "tap-bpm" });
    }
  });

  document.getElementById("bpbSelect")?.addEventListener("change", (e) => {
    edit((p) => { p.bpb = parseInt(e.target.value, 10) || 4; });
  });
  document.getElementById("snapSelect")?.addEventListener("change", (e) => {
    edit((p) => { p.snap = parseFloat(e.target.value) || 0; });
  });

  document.getElementById("btnSplit")?.addEventListener("click", () => splitSelectedAt());
  document.getElementById("btnDupAfter")?.addEventListener("click", () => duplicateSelectedAfter());
  document.getElementById("btnAlignBar")?.addEventListener("click", () => alignSelectedToBar1());
  document.getElementById("btnUndo")?.addEventListener("click", () => undo());
  document.getElementById("btnRedo")?.addEventListener("click", () => redo());

  document.getElementById("volSlider")?.addEventListener("input", (e) => {
    audio.setMasterVolume(parseFloat(e.target.value));
  });
}

function initKeyboard() {
  window.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    const editingText = tag === "input" || tag === "textarea" || tag === "select";
    const ctrl = e.ctrlKey || e.metaKey;

    if (e.key === "Escape") {
      document.getElementById("gridModal")?.classList.add("hidden");
      document.getElementById("exportModal")?.classList.add("hidden");
      document.getElementById("audioModal")?.classList.add("hidden");
      document.getElementById("taskDrawer")?.classList.add("hidden");
      document.getElementById("ctxMenu")?.classList.add("hidden");
      return;
    }

    if (ctrl && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveNow(false);
      return;
    }
    if (editingText) return;

    if (e.code === "Space") { e.preventDefault(); togglePlay(); return; }
    if (e.key === "Home") { e.preventDefault(); audio.seek(0); setPlayhead(0); return; }
    if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelectedAfter(); return; }
    if (ctrl && e.key.toLowerCase() === "c") { e.preventDefault(); copySelected(); return; }
    if (ctrl && e.key.toLowerCase() === "v") { e.preventDefault(); pasteAt(); return; }

    if (!ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); splitSelectedAt(); return; }
    if (!ctrl && e.key.toLowerCase() === "a") { e.preventDefault(); alignSelectedToBar1(); return; }
    if (!ctrl && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMuteSelected(); return; }
    if (!ctrl && e.key.toLowerCase() === "l") { e.preventDefault(); document.getElementById("btnLoop")?.click(); return; }
    if (!ctrl && e.key.toLowerCase() === "k") { e.preventDefault(); document.getElementById("btnClick")?.click(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
    if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomBy(1.25); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(0.8); return; }
  });
}

// ------------------------------------------------------------------ SSE Event Stream

function handleEvent(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === "hello") {
    if (Array.isArray(msg.jobs)) S.jobs = msg.jobs;
    if (msg.warp_state) {
      S.warpState = msg.warp_state;
      S.pendingWarps = msg.warp_state.pending || 0;
    }
    renderProgressTracker();
  } else if (msg.type === "warp_progress") {
    if (msg.warp_state) {
      S.warpState = msg.warp_state;
      S.pendingWarps = msg.warp_state.pending || 0;
    }
    renderProgressTracker();
  } else if (msg.type === "warp_ready") {
    if (msg.warp_state) {
      S.warpState = msg.warp_state;
      S.pendingWarps = msg.warp_state.pending || 0;
    } else if (typeof msg.pending === "number") {
      S.pendingWarps = msg.pending;
    }
    if (msg.key) audio.onWarpReady(msg.key, Number(msg.t0 || 0));
    renderProgressTracker();
    requestDraw();
  } else if (msg.type === "job" && msg.job) {
    const j = msg.job;
    const idx = S.jobs.findIndex((x) => x.id === j.id);
    if (idx >= 0) S.jobs[idx] = j;
    else S.jobs.push(j);
    renderProgressTracker();

    if (j.status === "done") {
      if (j.kind === "quantize") {
        api.toast(`${j.label} complete — verified!`, "ok");
      } else if (j.kind === "import") {
        api.toast(`${j.label} complete`, "ok");
      } else if (j.kind === "export" && j.id === exportJobId) {
        const res = j.result || {};
        const resEl = document.getElementById("expResult");
        if (resEl) {
          resEl.classList.remove("hidden");
          const lufs = res.lufs !== undefined ? ` · ${Number(res.lufs).toFixed(1)} LUFS` : "";
          const peak = res.peak_db !== undefined ? ` · peak ${Number(res.peak_db).toFixed(1)} dBFS` : "";
          const href = res.blob_url || `/api/exports/${encodeURIComponent(res.file)}`;
          resEl.innerHTML = `Saved: <a href="${href}" style="color:#2ee06e" download="${res.file}">${res.file}</a>${lufs}${peak}`;
        }
        api.toast(`Export complete: ${res.file}`, "ok");
      }
    } else if (j.status === "error") {
      api.toast(`${j.label} failed: ${j.error}`, "err");
      if (j.id === exportJobId) {
        const resEl = document.getElementById("expResult");
        if (resEl) { resEl.classList.remove("hidden"); resEl.textContent = `Export failed: ${j.error}`; }
      }
    }
  } else if (msg.type === "grid_updated" && msg.sid && msg.grid) {
    if (S.details[msg.sid]) {
      S.details[msg.sid].grid = msg.grid;
    } else {
      ensureSongDetail(msg.sid, true).catch(() => {});
    }
    const idx = S.songs.findIndex((x) => x.id === msg.sid);
    if (idx >= 0) {
      S.songs[idx] = {
        ...S.songs[idx],
        bpm: Math.round(Number(msg.grid.bpm || S.songs[idx].bpm) * 100) / 100,
        core_grid: {
          bpm: msg.grid.bpm,
          bpb: msg.grid.bpb,
          audit: msg.grid.audit,
          quantized: Boolean(msg.grid.quantized),
          sig: msg.grid.sig,
        },
      };
    }
    // Auto-enable quantized playback on the song once quantization finishes & clean up sub-beat raw start offset
    if (msg.grid.quantized && S.project?.songs?.[msg.sid]) {
      const needsFlip = !S.project.songs[msg.sid].quantized;
      const hasSubBeatStart = (S.project.clips || []).some(
        (c) => c.song === msg.sid && Math.abs(c.start - Math.round(c.start)) > 1e-4 && Math.abs(c.start - Math.round(c.start)) < 0.08
      );
      if (needsFlip || hasSubBeatStart) {
        edit((p) => {
          p.songs[msg.sid].quantized = true;
          for (const c of p.clips) {
            if (c.song === msg.sid && Math.abs(c.start - Math.round(c.start)) < 0.08) {
              c.start = Math.round(c.start);
            }
          }
        });
      }
    }
    emit("song_detail");
    renderSongsStrip();
    refreshGridModal(false);
    requestDraw();
  } else if (msg.type === "library_updated") {
    api.get("/api/songs").then((list) => {
      S.songs = list;
      emit("songs");
    }).catch(() => {});
  }
}

// ------------------------------------------------------------------ Boot

async function boot() {
  registerAudioHooks(audio);
  initLibrary();
  initTimeline();
  initGridModal();
  initModals();
  initControls();
  initKeyboard();

  onChange((kind) => {
    if (["project", "projects", "transport", "warps", "audio_cache", "all"].includes(kind)) renderTopbar();
    if (["project", "song_detail", "all"].includes(kind)) renderSongsStrip();
    if (["project", "selection", "song_detail", "all"].includes(kind)) renderClipInspector();
    if (kind === "projects") renderProjectList();
    if (kind === "audio_cache") requestDraw();
  });

  // Live 500ms ticker for elapsed task timers in the Progress Tracker
  setInterval(renderProgressTracker, 500);

  api.connectEvents(handleEvent);

  try {
    const [songs, folders, projects] = await Promise.all([
      api.get("/api/songs"),
      api.get("/api/folders").catch(() => ({ folders: [], assign: {} })),
      api.get("/api/projects"),
    ]);
    S.songs = songs || [];
    S.folders = folders || { folders: [], assign: {} };
    S.projects = projects || [];
    renderLibrary(true);

    if (S.projects.length > 0) {
      await loadProject(S.projects[0].id);
    } else {
      const p = await api.post("/api/projects/new", { name: "Untitled Mashup", bpm: 128 });
      S.projects = await api.get("/api/projects");
      await loadProject(p.id);
    }
    renderProjectList();
    renderTrackHeaders();
    renderSongsStrip();
    renderClipInspector();
    renderTopbar();
    zoomFit();
  } catch (e) {
    console.error("Boot failed", e);
    api.toast(`Failed to load Re-Tex Core: ${e.message}`, "err");
  }
}

boot();
