"""FastAPI HTTP API + SSE live event stream for Re-Tex Core."""
import asyncio
import hashlib
import itertools
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import audio_io, grid as G, library, mixer, project as P, quantize as Q, warp
from .config import CORE_DATA, EXPORTS, SR, STEMS, WEB
from .jobs import bus, jobs
from .player import player

app = FastAPI(title="Re-Tex Core")


def _ui_tag():
    h = hashlib.sha1(b"retex-core-v1")
    if WEB.exists():
        for f in sorted(WEB.rglob("*")):
            if f.is_file():
                h.update(f"{f.relative_to(WEB)}:{f.stat().st_mtime_ns}".encode())
    return h.hexdigest()[:10]


UI_TAG = _ui_tag()
if WEB.exists():
    app.mount(f"/ui/{UI_TAG}", StaticFiles(directory=WEB), name="ui")
    app.mount("/static", StaticFiles(directory=WEB), name="static")

_active = {"project": None}
_active_lock = threading.Lock()
_active_seq = itertools.count()
_applied_seq = {"n": -1}
_settle_timer = {"t": None}


@app.middleware("http")
async def _no_cache_ui(request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith(("/static/", "/ui/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ------------------------------------------------------------------ UI & Events

@app.get("/")
def index():
    html = (WEB / "index.html").read_text(encoding="utf-8").replace('"/static/', f'"/ui/{UI_TAG}/')
    return Response(html, media_type="text/html", headers={"Cache-Control": "no-store"})


@app.get("/api/events")
async def events(request: Request):
    q = bus.subscribe()

    async def stream():
        try:
            yield f"data: {json.dumps({'type': 'hello', 'transport': player.state(), 'jobs': jobs.active(), 'warp_state': warp.get_status()})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/jobs")
def get_jobs():
    return jobs.active()


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: int):
    return {"ok": jobs.cancel(jid)}


# ------------------------------------------------------------------ Library & Songs

@app.get("/api/songs")
def api_songs():
    return library.list_songs()


@app.get("/api/folders")
def api_get_folders():
    return library.get_folders()


@app.put("/api/folders")
async def api_save_folders(request: Request):
    b = await request.json()
    return library.save_folders(b)


@app.post("/api/folders/sync")
def api_sync_folders():
    return library.sync_folders_from_retex()


@app.get("/api/songs/{sid}")
async def api_song_detail(sid: str):
    info = library.read_raw(sid)
    if not info:
        raise HTTPException(404, f"Song not found: {sid}")
    g = await asyncio.to_thread(G.get_or_build, sid, False)
    key_info = info.get("key") or {}
    return {
        "id": sid,
        "title": info.get("title") or sid,
        "duration": float(info.get("duration") or 0.0),
        "raw_bpm": float(info.get("bpm") or 120.0),
        "key": key_info.get("name") or "",
        "camelot": key_info.get("camelot") or "",
        "tonic": key_info.get("tonic"),
        "mode": key_info.get("mode"),
        "separation": info.get("separation") or "legacy",
        "stem_scale": float(info.get("stem_scale", 1.0) or 1.0),
        "loudness": info.get("loudness") or {},
        "stems": list(STEMS),
        "grid": g,
    }


@app.get("/api/audio/source/{sid}/{stem}")
def api_audio_source(sid: str, stem: str, q: str = ""):
    """Stream raw or quantized stem directly from disk for native browser Web Audio decoding (zero GIL/decode overhead)."""
    if stem not in STEMS:
        raise HTTPException(400, f"Invalid stem: {stem}")
    if q:
        from .config import QUANTIZED
        qp = QUANTIZED / sid / Path(q).name / f"{stem}.flac"
        if qp.exists():
            g = G.load_grid(sid) or {}
            gq = g.get("quantized") or {}
            scale = float(gq.get("scale", 1.0) or 1.0) if gq.get("rev") == q else 1.0
            return FileResponse(
                qp,
                media_type="audio/flac",
                headers={
                    "X-Stem-Scale": str(scale),
                    "Cache-Control": "max-age=3600",
                    "Access-Control-Expose-Headers": "X-Stem-Scale",
                },
            )
    sp = library.stem_path(sid, stem)
    if sp is None:
        raise HTTPException(404, f"Stem {stem} missing for {sid}")
    info = library.read_raw(sid) or {}
    scale = float(info.get("stem_scale", 1.0) or 1.0)
    media = "audio/flac" if sp.suffix.lower() == ".flac" else "audio/wav"
    return FileResponse(
        sp,
        media_type=media,
        headers={
            "X-Stem-Scale": str(scale),
            "Cache-Control": "max-age=3600",
            "Access-Control-Expose-Headers": "X-Stem-Scale",
        },
    )


@app.get("/api/audio/warp/{key}")
async def api_audio_warp(key: str):
    """Stream a rendered Rubber Band R3 warped stem as 16-bit stereo WAV for browser Web Audio hot-swap."""
    safe_key = Path(key).name
    wav_bytes, t0 = await asyncio.to_thread(warp.warp_wav_bytes, safe_key)
    if wav_bytes is None:
        raise HTTPException(404, f"Warp render not found: {safe_key}")
    return Response(
        wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Warp-T0": str(t0),
            "Cache-Control": "max-age=3600",
            "Access-Control-Expose-Headers": "X-Warp-T0",
        },
    )


@app.get("/api/warp/status")
def api_warp_status():
    return warp.get_status()


@app.post("/api/warp/cancel")
def api_warp_cancel():
    n = warp.cancel_unneeded([])
    st = warp.get_status()
    bus.publish("warp_progress", warp_state=st)
    return {"cancelled": n, "warp_state": st}


@app.get("/api/songs/{sid}/peaks/{stem}")
async def api_peaks(sid: str, stem: str, q: str = ""):
    if stem not in STEMS:
        raise HTTPException(400, f"Invalid stem: {stem}")
    try:
        data = await asyncio.to_thread(library.get_peaks, sid, stem, q or None)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "max-age=3600"})


@app.post("/api/songs/import")
async def api_import_song(file: UploadFile = File(...), title: str = Form("")):
    up_dir = CORE_DATA / "uploads_tmp"
    up_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._ \-]+", "_", file.filename or "audio.wav")
    dst = up_dir / f"{int(time.time() * 1000)}_{safe}"
    with dst.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    label = title.strip() or Path(safe).stem

    def work(job):
        try:
            sid = library.import_audio_file(dst, title=label, progress=job.sub(0.0, 1.0))
            bus.publish("library_updated", sid=sid)
            return {"id": sid, "title": label}
        finally:
            dst.unlink(missing_ok=True)

    return jobs.submit("import", f"Importing {label}", work).to_dict()


# ------------------------------------------------------------------ Beat Grid & Quantize

@app.post("/api/songs/{sid}/grid/audit")
async def api_grid_audit(sid: str, request: Request):
    b = await request.json() if (await request.body()) else {}
    force = bool(b.get("force", True))
    try:
        g = await asyncio.to_thread(G.get_or_build, sid, force)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    bus.publish("grid_updated", sid=sid, grid=g)
    return g


@app.put("/api/songs/{sid}/grid")
async def api_grid_update(sid: str, request: Request):
    b = await request.json()
    try:
        g = await asyncio.to_thread(
            G.update_grid,
            sid,
            downbeat_shift=int(b.get("downbeat_shift", 0) or 0),
            nudge_ms=float(b.get("nudge_ms", 0.0) or 0.0),
            factor=float(b.get("factor", 1.0) or 1.0),
            bpb=b.get("bpb"),
            custom_beats=b.get("beats"),
        )
    except Exception as e:
        raise HTTPException(400, str(e))
    bus.publish("grid_updated", sid=sid, grid=g)
    return g


@app.post("/api/songs/{sid}/quantize")
def api_quantize_song(sid: str):
    info = library.read_raw(sid)
    if not info:
        raise HTTPException(404, f"Song not found: {sid}")

    def work(job):
        g = Q.quantize_song(sid, progress=job.sub(0.0, 1.0))
        bus.publish("grid_updated", sid=sid, grid=g)
        # Re-sync active project if it uses this song
        if _active["project"] and sid in (_active["project"].get("songs") or {}):
            _sync_active(_active["project"], interactive=False)
        return {"sid": sid, "quantized": g.get("quantized")}

    return jobs.submit("quantize", f"Quantizing {info.get('title', sid)}", work, ref=sid).to_dict()


# ------------------------------------------------------------------ Audition

@app.post("/api/songs/{sid}/audition")
async def api_audition(sid: str, request: Request):
    b = await request.json() if (await request.body()) else {}
    stem = b.get("stem") or "mix"
    start_s = float(b.get("start_s", 0.0) or 0.0)
    use_q = bool(b.get("quantized", False))
    with_click = bool(b.get("click", False))

    def _load():
        g = G.get_or_build(sid)
        q = g.get("quantized") or {}
        q_ok = bool(use_q and q.get("rev") and q.get("sig") == g.get("sig"))
        if stem == "mix":
            parts = [Q.load_quantized_stem(sid, q["rev"], s) if q_ok else library.load_raw_stem(sid, s) for s in STEMS]
            n = min(p.shape[1] for p in parts)
            buf = sum(p[:, :n] for p in parts)
        elif stem in STEMS:
            buf = Q.load_quantized_stem(sid, q["rev"], stem) if q_ok else library.load_raw_stem(sid, stem)
        else:
            raise ValueError(f"Unknown stem: {stem}")
        beats = None
        if with_click:
            if q_ok:
                beats = [float(q["t0"]) + k * float(q["period"]) for k in range(int(q["n_beats"]))]
            else:
                beats = g["beats"]
        return buf, beats, int(g.get("downbeat_offset", 0)), int(g.get("bpb", 4))

    try:
        buf, beats, doff, bpb = await asyncio.to_thread(_load)
        player.audition(buf, start_s=start_s, click_beats=beats, downbeat_offset=doff, bpb=bpb)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/audition/stop")
def api_audition_stop():
    player.audition_stop()
    return {"ok": True}


# ------------------------------------------------------------------ Projects & Active Sync

@app.get("/api/projects")
def api_projects():
    return P.list_projects()


@app.post("/api/projects/new")
async def api_new_project(request: Request):
    b = await request.json() if (await request.body()) else {}
    p = P.empty(b.get("name", "Untitled Mashup"), float(b.get("bpm", 128.0)), int(b.get("bpb", 4)))
    P.save(p)
    return p


@app.get("/api/projects/{pid}")
def api_get_project(pid: str):
    try:
        return P.load(pid)
    except FileNotFoundError:
        raise HTTPException(404, f"Project not found: {pid}")


@app.put("/api/projects/{pid}")
async def api_save_project(pid: str, request: Request):
    proj = await request.json()
    proj["id"] = pid
    P.save(proj)
    return {"ok": True, "id": pid, "modified": proj["modified"]}


@app.post("/api/projects/{pid}/branch")
async def api_branch_project(pid: str, request: Request):
    b = await request.json() if (await request.body()) else {}
    try:
        return P.branch(pid, b.get("name"))
    except FileNotFoundError:
        raise HTTPException(404, "Save the project first before branching")


@app.delete("/api/projects/{pid}")
def api_delete_project(pid: str):
    P.delete(pid)
    return {"ok": True}


def _on_warp_progress(st):
    bus.publish("warp_progress", warp_state=st)


def _on_warp_done(req, key, t0_out, st):
    bus.publish("warp_ready", key=key, t0=float(t0_out), pending=st["pending"],
                stem=req[1], song=req[0], warp_state=st)


def _plan_project_warps(proj):
    """Compute exact warp key for every active clip without touching Python audio locks or decoding FLACs."""
    tmap = {t["id"]: t for t in (proj.get("tracks") or [])}
    ready_keys = {}
    pending_keys = {}
    missing_reqs = []
    seen_missing = set()
    for c in proj.get("clips") or []:
        if c.get("mute") or float(c.get("len", 0)) <= 0:
            continue
        sid = c.get("song")
        if not sid or library.read_raw(sid) is None:
            continue
        req = P.warp_request(proj, c, tmap.get(c.get("track")))
        key = warp.req_key(*req)
        m = warp.read_meta(key)
        if m is not None and warp.cache_paths(key)[0].exists():
            ready_keys[c["id"]] = {"key": key, "t0": float(m.get("t0", 0.0))}
        else:
            pending_keys[c["id"]] = key
            if key not in seen_missing:
                seen_missing.add(key)
                missing_reqs.append(req)
    return ready_keys, pending_keys, missing_reqs


def _sync_active(proj, interactive=False):
    _active["project"] = proj
    ready_keys, pending_keys, missing_reqs = _plan_project_warps(proj)
    if not interactive:
        if _settle_timer["t"] is not None:
            _settle_timer["t"].cancel()
        if missing_reqs:
            reqs = list(missing_reqs)
            t = threading.Timer(
                0.30,
                lambda: warp.submit_missing(reqs, on_done=_on_warp_done, on_progress=_on_warp_progress),
            )
            t.daemon = True
            _settle_timer["t"] = t
            t.start()
        else:
            # No warps needed for current arrangement — cancel any stale queued ones
            if warp.cancel_unneeded(list({v["key"] for v in ready_keys.values()})):
                _on_warp_progress(warp.get_status())
    return {
        "missing": len(missing_reqs),
        "ready_keys": ready_keys,
        "pending_keys": pending_keys,
        "warp_state": warp.get_status(),
    }


@app.post("/api/active")
async def api_set_active(request: Request):
    proj = await request.json()
    interactive = request.query_params.get("interactive") == "1"
    seq = next(_active_seq)

    def _run():
        with _active_lock:
            if seq < _applied_seq["n"]:
                return {"missing": warp.get_status()["pending"], "warp_state": warp.get_status()}
            _applied_seq["n"] = seq
            return _sync_active(proj, interactive=interactive)

    return await asyncio.to_thread(_run)


# ------------------------------------------------------------------ Transport & Audio Devices

@app.get("/api/transport")
def api_get_transport():
    return player.state()


@app.post("/api/transport")
async def api_transport(request: Request):
    b = await request.json()
    if "volume" in b:
        player.set_volume(float(b["volume"]))
    if "click" in b or "click_gain" in b:
        player.set_click(b.get("click"), b.get("click_gain"))
    cmd = b.get("cmd")
    try:
        if cmd == "play":
            player.play(b.get("beat"))
        elif cmd == "stop":
            player.stop()
        elif cmd == "seek":
            player.seek(float(b.get("beat", 0.0)))
    except Exception as e:
        raise HTTPException(500, f"Audio output error: {e}")
    return player.state()


@app.get("/api/audio/outputs")
def api_audio_outputs():
    return {"outputs": player.output_names(), "current": player.device_name or ""}


@app.post("/api/audio/output")
async def api_set_audio_output(request: Request):
    b = await request.json()
    try:
        player.set_output(b.get("device") or "")
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "current": player.device_name or ""}


# ------------------------------------------------------------------ Export

@app.post("/api/export")
async def api_export(request: Request):
    b = await request.json()
    proj = b["project"]
    fmt = (b.get("format") or "wav").lower()
    normalize = bool(b.get("normalize", True))
    name = re.sub(r"[^A-Za-z0-9 _\-x]+", "", str(proj.get("name") or "mashup")).strip() or "mashup"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    wav = EXPORTS / f"{name} {stamp}.wav"

    def work(job):
        target = float((proj.get("master") or {}).get("target_lufs", -12.0)) if normalize else None
        res = mixer.bounce(proj, wav, progress=job.sub(0.0, 0.92), target_lufs=target)
        out = wav
        if fmt == "mp3":
            job.update(0.94, "encoding 320 kbps MP3...", force=True)
            out = wav.with_suffix(".mp3")
            audio_io.save_mp3(wav, out, bitrate="320k")
            wav.unlink(missing_ok=True)
        return dict(res, file=out.name, path=str(out))

    return jobs.submit("export", f"Exporting {name} ({fmt.upper()})", work).to_dict()


@app.get("/api/exports/{name}")
def api_download_export(name: str):
    p = EXPORTS / Path(name).name
    if not p.exists():
        raise HTTPException(404, "Export file not found")
    return FileResponse(p, filename=p.name)


@app.post("/api/reveal")
async def api_reveal(request: Request):
    b = await request.json() if (await request.body()) else {}
    target = Path(b.get("path") or EXPORTS)
    if not target.is_dir():
        target = target.parent
    if not str(target.resolve()).startswith(str(CORE_DATA.resolve())):
        raise HTTPException(400, "Only paths inside Re-Tex Core data folder can be revealed")
    os.startfile(str(target))
    return {"ok": True}
