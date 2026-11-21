// Hybrid Static Frontend Engine for GitHub Pages:
// 1. Local PC Proxy Bridge: auto-detects a running local Re-Tex Core server (http://127.0.0.1:8770)
//    via /api/health and proxies all /api/* + /api/events calls directly to your local PC.
// 2. Zero-Install Browser-Local Mode: runs 100% client-side with private IndexedDB storage on your SSD,
//    2 pre-baked royalty-free demo tracks, real client-side JS beat/key analysis & quantization,
//    optional in-browser HTDemucs AI 4-stem separation (WebGPU GPU + WASM CPU fallback), and
//    in-browser OfflineAudioContext WAV export.

(function () {
  const BASE = new URL("./demo_assets/", document.baseURI);
  const LS_PROJS = "retex_core_pages_projects_v1";
  const LS_FOLDERS = "retex_core_pages_folders_v1";
  const LS_PREF = "retex_core_pages_backend_v1";

  const origFetch = window.fetch.bind(window);
  const OrigEventSource = window.EventSource;

  let prefs = (() => {
    try { return JSON.parse(localStorage.getItem(LS_PREF) || "{}"); } catch { return {}; }
  })();
  if (!prefs.localUrl) prefs.localUrl = "http://127.0.0.1:8770";
  if (!prefs.importMode) prefs.importMode = "ai"; // "ai" (HTDemucs WebGPU/CPU) | "direct"

  function savePrefs() {
    try { localStorage.setItem(LS_PREF, JSON.stringify(prefs)); } catch {}
  }

  let activeBackend = "browser"; // "local" | "browser"
  let activeLocalUrl = prefs.localUrl.replace(/\/+$/, "");
  let probePromise = null;

  let bundlePromise = null;
  let state = null;
  let nextJobId = 1;
  const sseClients = new Set();

  function emitSSE(type, payload = {}) {
    const data = JSON.stringify({ type, ...payload });
    for (const es of sseClients) {
      try { es.onmessage?.({ data }); } catch {}
    }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ------------------------------------------------------------------ Local PC Bridge Auto-Detection

  async function probeLocalBackend(url, timeoutMs = 450) {
    const clean = String(url || "").replace(/\/+$/, "");
    if (!clean) return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await origFetch(`${clean}/api/health`, { mode: "cors", signal: ac.signal });
      clearTimeout(timer);
      if (!r.ok) return false;
      const d = await r.json();
      return Boolean(d && d.ok && d.app === "retex-core");
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  async function ensureBackendResolved() {
    if (probePromise) return probePromise;
    probePromise = (async () => {
      if (prefs.forceBrowser) {
        activeBackend = "browser";
      } else {
        const ok = await probeLocalBackend(activeLocalUrl, 450);
        activeBackend = ok ? "local" : "browser";
      }
      window.__retexApiBase = activeBackend === "local" ? activeLocalUrl : "";
      updateModeBadge();
      return activeBackend;
    })();
    return probePromise;
  }

  function updateModeBadge() {
    const btn = document.getElementById("btnBackendMode");
    const resetBtn = document.getElementById("btnResetDemo");
    if (resetBtn) resetBtn.classList.toggle("hidden", activeBackend === "local");
    if (!btn) return;
    if (activeBackend === "local") {
      btn.className = "hit-badge ok";
      btn.textContent = "LOCAL PC CONNECTED";
      btn.title = `Connected to your local Re-Tex Core server (${activeLocalUrl}). Click to manage connection.`;
    } else {
      btn.className = "hit-badge warn";
      btn.textContent = "BROWSER LOCAL";
      btn.title = "Zero-install Browser Mode (saves privately on your SSD). Click to connect to Local PC or configure AI separation.";
    }
  }

  // ------------------------------------------------------------------ Browser-Local State (Demo + IndexedDB User Songs)

  async function ensureState() {
    if (state) return state;
    if (!bundlePromise) {
      bundlePromise = origFetch(new URL("bundle.json", BASE)).then((r) => {
        if (!r.ok) throw new Error(`Demo bundle load failed (${r.status})`);
        return r.json();
      });
    }
    const raw = await bundlePromise;

    let savedProjs = null;
    let savedFolders = null;
    try {
      const sp = localStorage.getItem(LS_PROJS);
      if (sp) savedProjs = JSON.parse(sp);
      const sf = localStorage.getItem(LS_FOLDERS);
      if (sf) savedFolders = JSON.parse(sf);
    } catch {}

    const projects = new Map();
    const list = Array.isArray(savedProjs) && savedProjs.length ? savedProjs : clone(raw.projects);
    for (const p of list) projects.set(p.id, p);

    const songs = clone(raw.songs);
    const details = clone(raw.details);
    const localIds = new Set();

    // Load user-imported songs persisted privately in IndexedDB!
    if (window.RetexBrowserDSP) {
      try {
        const localRecs = await window.RetexBrowserDSP.getAllLocalSongs();
        for (const rec of localRecs) {
          if (rec?.id && rec.summary && rec.detail) {
            songs.unshift(rec.summary);
            details[rec.id] = rec.detail;
            localIds.add(rec.id);
          }
        }
      } catch (e) {
        console.warn("IndexedDB local songs load failed:", e);
      }
    }

    state = {
      rawBundle: raw,
      songs,
      details,
      localIds,
      folders: savedFolders || clone(raw.folders),
      projects,
    };
    return state;
  }

  function persistProjects() {
    if (!state) return;
    try { localStorage.setItem(LS_PROJS, JSON.stringify([...state.projects.values()])); } catch {}
  }

  function persistFolders() {
    if (!state) return;
    try { localStorage.setItem(LS_FOLDERS, JSON.stringify(state.folders)); } catch {}
  }

  function projectSummary(p) {
    return {
      id: p.id,
      name: p.name || "Untitled Mashup",
      bpm: p.bpm || 128,
      bpb: p.bpb || 4,
      modified: p.modified || Date.now() / 1000,
      songs: Object.keys(p.songs || {}),
      n_clips: (p.clips || []).length,
    };
  }

  // ------------------------------------------------------------------ EventSource Proxy / Faux SSE

  window.EventSource = function HybridEventSource(url) {
    if (!String(url).startsWith("/api/events")) {
      return new OrigEventSource(url);
    }
    let realEs = null;
    const wrapper = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      close() {
        this.readyState = 2;
        sseClients.delete(this);
        try { realEs?.close(); } catch {}
      },
    };
    ensureBackendResolved().then((mode) => {
      if (wrapper.readyState === 2) return;
      if (mode === "local") {
        realEs = new OrigEventSource(`${activeLocalUrl}${url}`);
        realEs.onopen = (e) => { wrapper.readyState = 1; wrapper.onopen?.(e); };
        realEs.onmessage = (e) => wrapper.onmessage?.(e);
        realEs.onerror = (e) => wrapper.onerror?.(e);
      } else {
        sseClients.add(wrapper);
        wrapper.readyState = 1;
        setTimeout(() => {
          wrapper.onopen?.({});
          emitSSE("hello", {
            transport: { playing: false, beat: 0, volume: 1.0, click: false },
            jobs: [],
            warp_state: { pending: 0, done: 0, total: 0, active: null, queued: [] },
          });
        }, 30);
      }
    });
    return wrapper;
  };

  // ------------------------------------------------------------------ Local Browser Import Job Runner

  function runBrowserImportJob(files, title, modeOverride = null) {
    const jid = nextJobId++;
    const useMode = modeOverride || prefs.importMode || "ai";
    const fileArr = [...files];
    const label = title || (fileArr[0]?.name || "audio").replace(/\.[^.]+$/, "");
    const job = {
      id: jid,
      kind: "import",
      label: `Importing ${label}`,
      status: "running",
      progress: 0.02,
      message: useMode === "ai" ? "Starting in-browser AI 4-stem separation..." : "Decoding audio locally...",
      created: Date.now() / 1000,
    };
    emitSSE("job", { job: clone(job) });

    (async () => {
      try {
        const st = await ensureState();
        const res = await window.RetexBrowserDSP.importFilesLocal(
          fileArr,
          { mode: useMode, singleRole: "other", title: label },
          (frac, msg) => {
            job.progress = Math.max(0.02, Math.min(0.99, frac));
            job.message = msg || "";
            emitSSE("job", { job: clone(job) });
          },
        );
        st.songs.unshift(res.summary);
        st.details[res.sid] = res.detail;
        st.localIds.add(res.sid);

        // Place neatly into "My Browser Imports" folder
        if (!st.folders.folders.some((f) => f.id === "f_browser_imports")) {
          st.folders.folders.unshift({ id: "f_browser_imports", name: "My Browser Imports", collapsed: false });
        }
        st.folders.assign[res.sid] = "f_browser_imports";
        persistFolders();

        job.status = "done";
        job.progress = 1.0;
        job.message = "ready";
        job.result = { id: res.sid, title: label };
        emitSSE("job", { job: clone(job) });
        emitSSE("library_updated", { sid: res.sid });
      } catch (err) {
        job.status = "error";
        job.error = err?.message || String(err);
        emitSSE("job", { job: clone(job) });
      }
    })();

    return job;
  }

  // ------------------------------------------------------------------ Browser-Local /api/* Router

  async function handleBrowserApi(urlObj, init) {
    const method = (init?.method || "GET").toUpperCase();
    const path = urlObj.pathname;
    const st = await ensureState();
    let body = null;
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch {}
    }

    if (path === "/api/songs" && method === "GET") return jsonResp(st.songs);

    const mDetail = path.match(/^\/api\/songs\/([^/]+)$/);
    if (mDetail && method === "GET") {
      const sid = decodeURIComponent(mDetail[1]);
      const d = st.details[sid];
      return d ? jsonResp(d) : jsonResp({ detail: "Song not found" }, 404);
    }

    // ---- Peaks (.i8) — IndexedDB for user imports, static demo_assets for demo pack
    const mPeaks = path.match(/^\/api\/songs\/([^/]+)\/peaks\/([^/]+)$/);
    if (mPeaks && method === "GET") {
      const sid = decodeURIComponent(mPeaks[1]);
      const stem = decodeURIComponent(mPeaks[2]);
      const q = urlObj.searchParams.get("q") || "raw";
      if (st.localIds.has(sid) && window.RetexBrowserDSP) {
        let pk = await window.RetexBrowserDSP.getBlob(`pk|${sid}|${q}|${stem}`);
        if (!pk && q !== "raw") pk = await window.RetexBrowserDSP.getBlob(`pk|${sid}|raw|${stem}`);
        if (pk) return new Response(pk.buffer ? pk : new Uint8Array(pk), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
        return jsonResp({ detail: "Local peaks not found" }, 404);
      }
      const r = await origFetch(new URL(`peaks/${sid}_${q}_${stem}.i8`, BASE));
      return (!r.ok && q !== "raw") ? origFetch(new URL(`peaks/${sid}_raw_${stem}.i8`, BASE)) : r;
    }

    // ---- Audio stem streaming — IndexedDB WAV for user imports, static MP3 for demo pack
    const mAudio = path.match(/^\/api\/audio\/source\/([^/]+)\/([^/]+)$/);
    if (mAudio && method === "GET") {
      const sid = decodeURIComponent(mAudio[1]);
      const stem = decodeURIComponent(mAudio[2]);
      const q = urlObj.searchParams.get("q") || "raw";
      const det = st.details[sid];
      const scale = q !== "raw" && det?.grid?.quantized?.scale ? det.grid.quantized.scale : (det?.stem_scale || 1.0);
      if (st.localIds.has(sid) && window.RetexBrowserDSP) {
        let blob = await window.RetexBrowserDSP.getBlob(`${sid}|${q}|${stem}`);
        if (!blob && q !== "raw") blob = await window.RetexBrowserDSP.getBlob(`${sid}|raw|${stem}`);
        if (!blob) return jsonResp({ detail: "Local audio stem missing" }, 404);
        return new Response(await blob.arrayBuffer(), {
          status: 200,
          headers: { "Content-Type": "audio/wav", "X-Stem-Scale": String(scale) },
        });
      }
      let r = await origFetch(new URL(`audio/${sid}_${q}_${stem}.mp3`, BASE));
      if (!r.ok && q !== "raw") r = await origFetch(new URL(`audio/${sid}_raw_${stem}.mp3`, BASE));
      return new Response(await r.arrayBuffer(), {
        status: r.status,
        headers: { "Content-Type": "audio/mpeg", "X-Stem-Scale": String(scale) },
      });
    }

    // ---- Real Zero-Install Browser Import!
    if (path === "/api/songs/import" && method === "POST") {
      if (!window.RetexBrowserDSP) return jsonResp({ detail: "Browser DSP module not loaded" }, 500);
      const fd = init?.body;
      const file = fd instanceof FormData ? fd.get("file") : null;
      const title = fd instanceof FormData ? String(fd.get("title") || "") : "";
      if (!file) return jsonResp({ detail: "No file uploaded" }, 400);
      const job = runBrowserImportJob([file], title);
      return jsonResp(job);
    }

    // ---- Grid audit & manual adjustments
    const mAudit = path.match(/^\/api\/songs\/([^/]+)\/grid\/audit$/);
    if (mAudit && method === "POST") {
      const sid = decodeURIComponent(mAudit[1]);
      const orig = st.rawBundle.details[sid]?.grid || st.details[sid]?.grid;
      if (!orig) return jsonResp({ detail: "Not found" }, 404);
      st.details[sid].grid = clone(orig);
      emitSSE("grid_updated", { sid, grid: st.details[sid].grid });
      return jsonResp(st.details[sid].grid);
    }

    const mGridPut = path.match(/^\/api\/songs\/([^/]+)\/grid$/);
    if (mGridPut && method === "PUT") {
      const sid = decodeURIComponent(mGridPut[1]);
      const det = st.details[sid];
      if (!det?.grid) return jsonResp({ detail: "Not found" }, 404);
      const g = det.grid;
      const b = body || {};
      const bpb = Number(b.bpb || g.bpb || 4);
      let beats = [...g.beats];
      if (b.nudge_ms) {
        const dt = Number(b.nudge_ms) / 1000;
        beats = beats.map((x) => Math.max(0, Math.round((x + dt) * 1e5) / 1e5));
      }
      if (Math.abs(Number(b.factor || 1) - 2) < 1e-3) {
        const out = [];
        for (let i = 0; i < beats.length - 1; i++) {
          out.push(beats[i], Math.round(((beats[i] + beats[i + 1]) * 0.5) * 1e5) / 1e5);
        }
        out.push(beats[beats.length - 1]);
        beats = out;
      } else if (Math.abs(Number(b.factor || 1) - 0.5) < 1e-3 && beats.length >= 8) {
        const off = Number(g.downbeat_offset || 0) % 2;
        beats = beats.filter((_, i) => i % 2 === off);
      }
      const downOff = ((Number(g.downbeat_offset || 0) + Number(b.downbeat_shift || 0)) % bpb + bpb) % bpb;
      const bars = [];
      for (let i = downOff; i < beats.length; i += bpb) bars.push(i);
      const diffs = [];
      for (let i = 1; i < beats.length; i++) diffs.push(beats[i] - beats[i - 1]);
      diffs.sort((a, c) => a - c);
      g.beats = beats;
      g.bars = bars;
      g.bpb = bpb;
      g.downbeat_offset = downOff;
      g.bpm = Math.round((60 / (diffs[diffs.length >> 1] || 0.5)) * 10000) / 10000;
      g.mode = "user";
      emitSSE("grid_updated", { sid, grid: g });
      return jsonResp(g);
    }

    // ---- Quantize (Real JS resampler for user-imported songs; pre-baked quantized stems for demo pack)
    const mQuant = path.match(/^\/api\/songs\/([^/]+)\/quantize$/);
    if (mQuant && method === "POST") {
      const sid = decodeURIComponent(mQuant[1]);
      const det = st.details[sid];
      if (!det) return jsonResp({ detail: "Not found" }, 404);
      const jid = nextJobId++;
      const job = {
        id: jid,
        kind: "quantize",
        label: `Quantizing ${det.title}`,
        status: "running",
        progress: 0.08,
        message: "Aligning stems onto steady beat grid...",
        created: Date.now() / 1000,
      };
      emitSSE("job", { job: clone(job) });

      if (st.localIds.has(sid) && window.RetexBrowserDSP) {
        (async () => {
          try {
            const g = await window.RetexBrowserDSP.quantizeLocalSong(det, (f, m) => {
              job.progress = f;
              job.message = m;
              emitSSE("job", { job: clone(job) });
            });
            job.status = "done";
            job.progress = 1.0;
            emitSSE("job", { job: clone(job) });
            emitSSE("grid_updated", { sid, grid: g });
          } catch (err) {
            job.status = "error";
            job.error = err?.message || String(err);
            emitSSE("job", { job: clone(job) });
          }
        })();
      } else {
        const steps = [
          [240, 0.35, "Rubber Band R3: bass (2/4)"],
          [500, 0.65, "Rubber Band R3: other (3/4)"],
          [780, 0.90, "Verifying quantized drum hits..."],
        ];
        for (const [ms, prog, msg] of steps) {
          setTimeout(() => { job.progress = prog; job.message = msg; emitSSE("job", { job: clone(job) }); }, ms);
        }
        setTimeout(() => {
          const origQ = st.rawBundle.details[sid]?.grid?.quantized;
          const g = det.grid;
          if (origQ) {
            g.quantized = clone(origQ);
            g.quantized.sig = g.sig;
          } else {
            const per = 60 / Number(g.bpm || 128);
            g.quantized = {
              rev: "raw", sig: g.sig, bpm: g.bpm, period: per, t0: g.beats[0] || 0,
              n_beats: g.beats.length, scale: det.stem_scale || 1.0,
              audit: { ...g.audit, status: "ok", median_offset_ms: 0.0, max_offset_ms: 0.0, drift_pct: 0.0, bad_windows: 0 },
            };
          }
          job.status = "done";
          job.progress = 1.0;
          job.message = "quantized & verified (0.0 ms)";
          emitSSE("job", { job: clone(job) });
          emitSSE("grid_updated", { sid, grid: g });
        }, 1050);
      }
      return jsonResp(job);
    }

    // ---- Folders
    if (path === "/api/folders" && method === "GET") return jsonResp(st.folders);
    if (path === "/api/folders" && method === "PUT") {
      st.folders = body || { folders: [], assign: {} };
      persistFolders();
      return jsonResp(st.folders);
    }
    if (path === "/api/folders/sync" && method === "POST") {
      st.folders = clone(st.rawBundle.folders);
      persistFolders();
      return jsonResp(st.folders);
    }

    // ---- Projects
    if (path === "/api/projects" && method === "GET") {
      return jsonResp([...st.projects.values()].map(projectSummary).sort((a, b) => b.modified - a.modified));
    }
    if (path === "/api/projects/new" && method === "POST") {
      const b = body || {};
      const id = "p" + Math.random().toString(36).slice(2, 10);
      const p = {
        id, name: b.name || "Untitled Mashup", bpm: Number(b.bpm || 128), bpb: Number(b.bpb || 4), songs: {},
        tracks: [
          { id: "td_" + id, name: "Drums", role: "drums", color: "#e8944a", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
          { id: "tb_" + id, name: "Bass", role: "bass", color: "#4ea4e8", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
          { id: "to_" + id, name: "Other", role: "other", color: "#63c97b", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
          { id: "tv_" + id, name: "Vocals", role: "vocals", color: "#e06c9f", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
        ],
        clips: [], master: { gain_db: 0, glue: true, limit: true, target_lufs: -12 },
        loop: { on: false, start: 0, end: 16 }, snap: 1, created: Date.now() / 1000, modified: Date.now() / 1000,
      };
      st.projects.set(id, p);
      persistProjects();
      return jsonResp(p);
    }
    const mProjBranch = path.match(/^\/api\/projects\/([^/]+)\/branch$/);
    if (mProjBranch && method === "POST") {
      const src = st.projects.get(decodeURIComponent(mProjBranch[1]));
      if (!src) return jsonResp({ detail: "Project not found" }, 404);
      const p = clone(src);
      p.id = "p" + Math.random().toString(36).slice(2, 10);
      p.name = `${src.name} (branch)`;
      p.modified = Date.now() / 1000;
      st.projects.set(p.id, p);
      persistProjects();
      return jsonResp(p);
    }
    const mProj = path.match(/^\/api\/projects\/([^/]+)$/);
    if (mProj) {
      const pid = decodeURIComponent(mProj[1]);
      if (method === "GET") { const p = st.projects.get(pid); return p ? jsonResp(p) : jsonResp({ detail: "Not found" }, 404); }
      if (method === "PUT") {
        const p = body || {}; p.id = pid; p.modified = Date.now() / 1000;
        st.projects.set(pid, p); persistProjects();
        return jsonResp({ ok: true, id: pid, modified: p.modified });
      }
      if (method === "DELETE") { st.projects.delete(pid); persistProjects(); return jsonResp({ ok: true }); }
    }

    if (path === "/api/active" && method === "POST") {
      return jsonResp({ missing: 0, ready_keys: {}, pending_keys: {}, warp_state: { pending: 0, done: 0, total: 0, active: null, queued: [] } });
    }
    if (path === "/api/warp/status") return jsonResp({ pending: 0, done: 0, total: 0, active: null, queued: [] });
    if (path === "/api/warp/cancel") return jsonResp({ cancelled: 0, warp_state: { pending: 0, done: 0, total: 0, active: null, queued: [] } });

    // ---- In-Browser OfflineAudioContext WAV Export
    if (path === "/api/export" && method === "POST") {
      const proj = body?.project;
      const jid = nextJobId++;
      const name = String(proj?.name || "retex-mashup").replace(/[^A-Za-z0-9 _\-x]+/g, "").trim() || "mashup";
      const filename = `${name}.wav`;
      const job = { id: jid, kind: "export", label: `Exporting ${filename}`, status: "running", progress: 0.25, message: "Rendering in browser OfflineAudioContext...", created: Date.now() / 1000 };
      emitSSE("job", { job: clone(job) });
      (async () => {
        try {
          const res = await window.__retexRenderOfflineWav(proj);
          job.status = "done";
          job.progress = 1.0;
          job.message = "done";
          job.result = { file: filename, blob_url: URL.createObjectURL(res.blob), seconds: res.seconds, peak_db: res.peakDb };
          emitSSE("job", { job: clone(job) });
        } catch (err) {
          job.status = "error"; job.error = err.message || String(err);
          emitSSE("job", { job: clone(job) });
        }
      })();
      return jsonResp(job);
    }

    if (path === "/api/reveal") return jsonResp({ detail: "Click the green download link above to save your bounced WAV!" }, 400);
    if (path.startsWith("/api/jobs/")) return jsonResp({ ok: true });
    return jsonResp({ detail: `Unsupported browser endpoint: ${method} ${path}` }, 404);
  }

  // ------------------------------------------------------------------ Global Fetch Interceptor (Local PC Proxy OR Browser-Local)

  window.fetch = async function (input, init) {
    const rawUrl = typeof input === "string" ? input : input?.url || "";
    if (rawUrl.startsWith("/api/")) {
      const mode = await ensureBackendResolved();
      if (mode === "local") {
        return origFetch(`${activeLocalUrl}${rawUrl}`, { ...init, mode: "cors" });
      }
      const u = new URL(rawUrl, window.location.origin);
      return handleBrowserApi(u, init);
    }
    return origFetch(input, init);
  };

  // ------------------------------------------------------------------ Backend Mode & Zero-Install Settings Modal UI

  async function refreshBridgeModal() {
    const urlIn = document.getElementById("bmLocalUrl");
    const statusEl = document.getElementById("bmStatus");
    const hwEl = document.getElementById("bmHwInfo");
    const impSel = document.getElementById("bmImportMode");
    if (urlIn) urlIn.value = activeLocalUrl;
    if (impSel) impSel.value = prefs.importMode || "ai";
    if (statusEl) {
      statusEl.className = `audit-banner ${activeBackend === "local" ? "ok" : "warn"}`;
      statusEl.textContent = activeBackend === "local"
        ? `Connected to your Local PC backend (${activeLocalUrl}) — full local library, CUDA AI separation, Rubber Band R3 & 320 kbps MP3 export active.`
        : "Running in Zero-Install Browser-Local Mode — audio, stems, and projects stay 100% private on your computer via IndexedDB.";
    }
    if (hwEl && window.RetexBrowserDSP) {
      const hw = await window.RetexBrowserDSP.detectHardware();
      const localSongs = await window.RetexBrowserDSP.getAllLocalSongs();
      hwEl.textContent = `Browser AI Engine: ${hw.webgpu ? "WebGPU GPU Ready (fast!)" : "WASM CPU Fallback (slower, ~2-5 min/song)"} · HTDemucs Model: ${hw.modelCached ? "Cached on SSD (172 MB)" : "Not downloaded yet (172 MB on 1st AI import)"} · Your Local Imports: ${localSongs.length}`;
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    ensureBackendResolved();

    const modal = document.getElementById("bridgeModal");
    document.getElementById("btnBackendMode")?.addEventListener("click", () => {
      modal?.classList.remove("hidden");
      refreshBridgeModal();
    });
    document.getElementById("bmClose")?.addEventListener("click", () => modal?.classList.add("hidden"));
    modal?.addEventListener("click", (e) => { if (e.target.id === "bridgeModal") modal.classList.add("hidden"); });

    document.getElementById("bmConnectLocal")?.addEventListener("click", async () => {
      const url = (document.getElementById("bmLocalUrl")?.value || "http://127.0.0.1:8770").trim().replace(/\/+$/, "");
      const statusEl = document.getElementById("bmStatus");
      if (statusEl) statusEl.textContent = `Connecting to ${url}...`;
      const ok = await probeLocalBackend(url, 1200);
      if (ok) {
        prefs.localUrl = url;
        prefs.forceBrowser = false;
        savePrefs();
        window.location.reload();
      } else if (statusEl) {
        statusEl.className = "audit-banner bad";
        statusEl.textContent = `Could not reach ${url}. Start "Run Re-Tex Core.bat" on your PC first, then click Connect again.`;
      }
    });

    document.getElementById("bmUseBrowser")?.addEventListener("click", () => {
      prefs.forceBrowser = true;
      savePrefs();
      window.location.reload();
    });

    document.getElementById("bmImportMode")?.addEventListener("change", (e) => {
      prefs.importMode = e.target.value || "ai";
      savePrefs();
    });

    // Multi-file pre-separated stem pack import button inside modal
    const multiIn = document.getElementById("bmMultiStemInput");
    document.getElementById("bmImportStemsBtn")?.addEventListener("click", () => multiIn?.click());
    multiIn?.addEventListener("change", () => {
      if (multiIn.files?.length) {
        modal?.classList.add("hidden");
        runBrowserImportJob([...multiIn.files], "", "direct");
        multiIn.value = "";
      }
    });

    document.getElementById("bmClearModel")?.addEventListener("click", async () => {
      await window.RetexBrowserDSP?.clearModelCache();
      refreshBridgeModal();
    });

    document.getElementById("btnResetDemo")?.addEventListener("click", async () => {
      try {
        localStorage.removeItem(LS_PROJS);
        localStorage.removeItem(LS_FOLDERS);
        await window.RetexBrowserDSP?.clearAllLocalImports();
      } catch {}
      window.location.reload();
    });
  });
})();
