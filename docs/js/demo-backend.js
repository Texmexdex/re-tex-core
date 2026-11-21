// Faux static backend for GitHub Pages Live Demo (zero server required!)
// Intercepts /api/* fetch calls and /api/events SSE, serving pre-baked royalty-free stems,
// verified raw + quantized beat grids, localStorage project/folder persistence, and real
// in-browser OfflineAudioContext WAV export.

(function () {
  const BASE = new URL("./demo_assets/", document.baseURI);
  const LS_PROJS = "retex_core_pages_projects_v1";
  const LS_FOLDERS = "retex_core_pages_folders_v1";

  const origFetch = window.fetch.bind(window);
  let bundlePromise = null;
  let state = null;
  let nextJobId = 1;
  const sseClients = new Set();

  function emitSSE(type, payload = {}) {
    const data = JSON.stringify({ type, ...payload });
    for (const es of sseClients) {
      try {
        es.onmessage?.({ data });
      } catch {}
    }
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

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

    state = {
      rawBundle: raw,
      songs: clone(raw.songs),
      details: clone(raw.details),
      folders: savedFolders || clone(raw.folders),
      projects,
    };
    return state;
  }

  function persistProjects() {
    if (!state) return;
    try {
      localStorage.setItem(LS_PROJS, JSON.stringify([...state.projects.values()]));
    } catch {}
  }

  function persistFolders() {
    if (!state) return;
    try {
      localStorage.setItem(LS_FOLDERS, JSON.stringify(state.folders));
    } catch {}
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

  // Faux EventSource for /api/events
  const OrigEventSource = window.EventSource;
  window.EventSource = function DemoEventSource(url) {
    if (String(url).startsWith("/api/events")) {
      const es = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        close() {
          this.readyState = 2;
          sseClients.delete(this);
        },
      };
      sseClients.add(es);
      setTimeout(() => {
        es.onopen?.({});
        emitSSE("hello", {
          transport: { playing: false, beat: 0, volume: 1.0, click: false },
          jobs: [],
          warp_state: { pending: 0, done: 0, total: 0, active: null, queued: [] },
        });
      }, 30);
      return es;
    }
    return new OrigEventSource(url);
  };

  async function handleApi(urlObj, init) {
    const method = (init?.method || "GET").toUpperCase();
    const path = urlObj.pathname;
    const st = await ensureState();
    let body = null;
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch {}
    }

    // ---- Songs & Details
    if (path === "/api/songs" && method === "GET") {
      return jsonResp(st.songs);
    }

    const mDetail = path.match(/^\/api\/songs\/([^/]+)$/);
    if (mDetail && method === "GET") {
      const sid = decodeURIComponent(mDetail[1]);
      const d = st.details[sid];
      return d ? jsonResp(d) : jsonResp({ detail: "Song not found" }, 404);
    }

    // ---- Peaks binary (.i8)
    const mPeaks = path.match(/^\/api\/songs\/([^/]+)\/peaks\/([^/]+)$/);
    if (mPeaks && method === "GET") {
      const sid = decodeURIComponent(mPeaks[1]);
      const stem = decodeURIComponent(mPeaks[2]);
      const q = urlObj.searchParams.get("q") || "raw";
      const target = new URL(`peaks/${sid}_${q}_${stem}.i8`, BASE);
      const r = await origFetch(target);
      if (!r.ok && q !== "raw") {
        return origFetch(new URL(`peaks/${sid}_raw_${stem}.i8`, BASE));
      }
      return r;
    }

    // ---- Audio stem streaming (.mp3 decoded directly by Chrome Web Audio!)
    const mAudio = path.match(/^\/api\/audio\/source\/([^/]+)\/([^/]+)$/);
    if (mAudio && method === "GET") {
      const sid = decodeURIComponent(mAudio[1]);
      const stem = decodeURIComponent(mAudio[2]);
      const q = urlObj.searchParams.get("q") || "raw";
      const det = st.details[sid];
      const scale = q !== "raw" && det?.grid?.quantized?.scale
        ? det.grid.quantized.scale
        : (det?.stem_scale || 1.0);
      let r = await origFetch(new URL(`audio/${sid}_${q}_${stem}.mp3`, BASE));
      if (!r.ok && q !== "raw") {
        r = await origFetch(new URL(`audio/${sid}_raw_${stem}.mp3`, BASE));
      }
      const ab = await r.arrayBuffer();
      return new Response(ab, {
        status: r.status,
        headers: {
          "Content-Type": "audio/mpeg",
          "X-Stem-Scale": String(scale),
        },
      });
    }

    // ---- Import (informational in static browser demo)
    if (path === "/api/songs/import" && method === "POST") {
      return jsonResp(
        { detail: "Browser Demo Mode uses the 2 built-in royalty-free tracks. Clone & run install.bat locally to import & AI-separate your own songs!" },
        400,
      );
    }

    // ---- Grid audit / manual grid adjustments / simulated quantize
    const mAudit = path.match(/^\/api\/songs\/([^/]+)\/grid\/audit$/);
    if (mAudit && method === "POST") {
      const sid = decodeURIComponent(mAudit[1]);
      const orig = st.rawBundle.details[sid]?.grid;
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
      const medP = diffs[diffs.length >> 1] || 0.5;
      g.beats = beats;
      g.bars = bars;
      g.bpb = bpb;
      g.downbeat_offset = downOff;
      g.bpm = Math.round((60 / medP) * 10000) / 10000;
      g.mode = "user";
      emitSSE("grid_updated", { sid, grid: g });
      return jsonResp(g);
    }

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
        message: "Rubber Band R3: drums (1/4)",
        created: Date.now() / 1000,
      };
      emitSSE("job", { job: clone(job) });

      const steps = [
        [280, 0.35, "Rubber Band R3: bass (2/4)"],
        [560, 0.62, "Rubber Band R3: other (3/4)"],
        [840, 0.85, "Rubber Band R3: vocals (4/4)"],
        [1080, 0.95, "Verifying quantized drum hits..."],
      ];
      for (const [ms, prog, msg] of steps) {
        setTimeout(() => {
          job.progress = prog;
          job.message = msg;
          emitSSE("job", { job: clone(job) });
        }, ms);
      }
      setTimeout(() => {
        // Restore pre-baked quantized metadata (or synthesize steady quantized metadata for Neon Pulse)
        const origQ = st.rawBundle.details[sid]?.grid?.quantized;
        const g = det.grid;
        if (origQ) {
          g.quantized = clone(origQ);
          g.quantized.sig = g.sig;
        } else {
          const per = 60 / Number(g.bpm || 128);
          g.quantized = {
            rev: "raw",
            sig: g.sig,
            bpm: g.bpm,
            period: per,
            t0: g.beats[0] || 0,
            n_beats: g.beats.length,
            scale: det.stem_scale || 1.0,
            audit: { ...g.audit, status: "ok", median_offset_ms: 0.0, max_offset_ms: 0.0, drift_pct: 0.0, bad_windows: 0 },
          };
        }
        job.status = "done";
        job.progress = 1.0;
        job.message = "quantized & verified (0.0 ms)";
        emitSSE("job", { job: clone(job) });
        emitSSE("grid_updated", { sid, grid: g });
      }, 1250);
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
      const list = [...st.projects.values()].map(projectSummary).sort((a, b) => b.modified - a.modified);
      return jsonResp(list);
    }
    if (path === "/api/projects/new" && method === "POST") {
      const b = body || {};
      const id = "p" + Math.random().toString(36).slice(2, 10);
      const p = {
        id,
        name: b.name || "Untitled Mashup",
        bpm: Number(b.bpm || 128),
        bpb: Number(b.bpb || 4),
        songs: {},
        tracks: [
          { id: "td_" + id, name: "Drums", role: "drums", color: "#e8944a", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
          { id: "tb_" + id, name: "Bass", role: "bass", color: "#4ea4e8", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
          { id: "to_" + id, name: "Other", role: "other", color: "#63c97b", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
          { id: "tv_" + id, name: "Vocals", role: "vocals", color: "#e06c9f", gain_db: 0, pan: 0, pitch: 0, mute: false, solo: false, hpf: 0, lpf: 0, duck: 0, pocket: 0 },
        ],
        clips: [],
        master: { gain_db: 0, glue: true, limit: true, target_lufs: -12 },
        loop: { on: false, start: 0, end: 16 },
        snap: 1,
        created: Date.now() / 1000,
        modified: Date.now() / 1000,
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
      if (method === "GET") {
        const p = st.projects.get(pid);
        return p ? jsonResp(p) : jsonResp({ detail: "Project not found" }, 404);
      }
      if (method === "PUT") {
        const p = body || {};
        p.id = pid;
        p.modified = Date.now() / 1000;
        st.projects.set(pid, p);
        persistProjects();
        return jsonResp({ ok: true, id: pid, modified: p.modified });
      }
      if (method === "DELETE") {
        st.projects.delete(pid);
        persistProjects();
        return jsonResp({ ok: true });
      }
    }

    // ---- Active Sync & Warps (instant Web Audio in browser demo)
    if (path === "/api/active" && method === "POST") {
      return jsonResp({
        missing: 0,
        ready_keys: {},
        pending_keys: {},
        warp_state: { pending: 0, done: 0, total: 0, active: null, queued: [] },
      });
    }
    if (path === "/api/warp/status") {
      return jsonResp({ pending: 0, done: 0, total: 0, active: null, queued: [] });
    }
    if (path === "/api/warp/cancel") {
      return jsonResp({ cancelled: 0, warp_state: { pending: 0, done: 0, total: 0, active: null, queued: [] } });
    }

    // ---- Real In-Browser OfflineAudioContext WAV Export!
    if (path === "/api/export" && method === "POST") {
      const proj = body?.project;
      const jid = nextJobId++;
      const name = String(proj?.name || "retex-demo-mashup").replace(/[^A-Za-z0-9 _\-x]+/g, "").trim() || "mashup";
      const filename = `${name}.wav`;
      const job = {
        id: jid,
        kind: "export",
        label: `Exporting ${filename} (Browser WAV)`,
        status: "running",
        progress: 0.2,
        message: "Rendering mix in browser OfflineAudioContext...",
        created: Date.now() / 1000,
      };
      emitSSE("job", { job: clone(job) });
      (async () => {
        try {
          if (typeof window.__retexRenderOfflineWav !== "function") {
            throw new Error("Offline audio renderer not ready");
          }
          const res = await window.__retexRenderOfflineWav(proj);
          const blobUrl = URL.createObjectURL(res.blob);
          job.status = "done";
          job.progress = 1.0;
          job.message = "done";
          job.result = {
            file: filename,
            blob_url: blobUrl,
            seconds: res.seconds,
            peak_db: res.peakDb,
          };
          emitSSE("job", { job: clone(job) });
        } catch (err) {
          job.status = "error";
          job.error = err.message || String(err);
          emitSSE("job", { job: clone(job) });
        }
      })();
      return jsonResp(job);
    }

    if (path === "/api/reveal") {
      return jsonResp({ detail: "In Browser Demo Mode, click the green download link above to save your bounced WAV!" }, 400);
    }

    if (path.startsWith("/api/jobs/")) {
      return jsonResp({ ok: true });
    }

    return jsonResp({ detail: `Unsupported demo endpoint: ${method} ${path}` }, 404);
  }

  window.fetch = function (input, init) {
    const rawUrl = typeof input === "string" ? input : input?.url || "";
    if (rawUrl.startsWith("/api/")) {
      const u = new URL(rawUrl, window.location.origin);
      return handleApi(u, init);
    }
    return origFetch(input, init);
  };

  // Wire Reset Demo button once DOM loads
  window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("btnResetDemo")?.addEventListener("click", () => {
      try {
        localStorage.removeItem(LS_PROJS);
        localStorage.removeItem(LS_FOLDERS);
      } catch {}
      window.location.reload();
    });
  });
})();
