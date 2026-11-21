"""Single-source-of-truth project model for Re-Tex Core.

Units:
  - clip.start, clip.len : PROJECT beats (4 beats = 1 bar in 4/4).
  - clip.src             : SOURCE beat index in the song's unified Core grid (grid.beats).
  - song.quantized       : bool (True = plays verified steady quantized stems; False = plays raw at fixed speed).
  - song.mult            : project beats per source beat (2.0 = half-time song in double-time project, 0.5 = reverse).
  - song.transpose       : semitones applied to pitched stems (bass, other, vocals).
  - track.pitch          : per-lane / per-stem pitch shift in semitones (can shift ANY stem independently!).
  - clip.pitch           : per-clip pitch override in semitones.
"""
import json
import re
import time
import uuid

from . import grid as G, library
from .config import PITCHED, PROJECTS

ROLE_COLORS = {
    "drums": "#e8944a",
    "bass": "#4ea4e8",
    "other": "#63c97b",
    "vocals": "#e06c9f",
    "any": "#8b98a8",
}


def new_id(prefix):
    return f"{prefix}{uuid.uuid4().hex[:8]}"


def track(name, role="any", **kw):
    t = dict(
        id=new_id("t"),
        name=str(name),
        role=role if role in ROLE_COLORS else "any",
        color=ROLE_COLORS.get(role, ROLE_COLORS["any"]),
        gain_db=0.0,
        pan=0.0,
        pitch=0.0,
        mute=False,
        solo=False,
        hpf=0.0,
        lpf=0.0,
        duck=0.0,
        pocket=0.0,
    )
    t.update(kw)
    return t


def clip(track_id, song, stem, start, src, length, **kw):
    c = dict(
        id=new_id("c"),
        track=track_id,
        song=song,
        stem=stem,
        start=float(start),
        src=float(src),
        len=float(length),
        gain_db=0.0,
        fade_in=0.0,
        fade_out=0.04,
        mute=False,
        rate=1.0,
        pitch=0.0,
        keep_pitch=True,
        label="",
    )
    c.update(kw)
    return c


def empty(name="Untitled Mashup", bpm=128.0, bpb=4):
    return dict(
        id=new_id("p"),
        name=str(name),
        bpm=float(bpm),
        bpb=int(bpb),
        songs={},
        tracks=[
            track("Drums", "drums"),
            track("Bass", "bass"),
            track("Other", "other"),
            track("Vocals", "vocals"),
        ],
        clips=[],
        master=dict(gain_db=0.0, glue=True, limit=True, target_lufs=-12.0),
        loop=dict(on=False, start=0.0, end=16.0),
        snap=1.0,
        created=time.time(),
        modified=time.time(),
        notes="",
    )


def song_cfg(project, sid):
    return (project.get("songs") or {}).get(sid) or {}


def song_mult(project, sid):
    return float(song_cfg(project, sid).get("mult", 1.0) or 1.0)


def clip_semis(project, c, trk=None):
    """Total pitch shift in semitones: song transpose (pitched stems) + lane pitch + clip pitch."""
    sc = song_cfg(project, c["song"])
    song_tr = float(sc.get("transpose", 0.0) or 0.0) if c["stem"] in PITCHED else 0.0
    trk_p = float((trk or {}).get("pitch", 0.0) or 0.0)
    clip_p = float(c.get("pitch", 0.0) or 0.0)
    return round(song_tr + trk_p + clip_p, 3)


def warp_request(project, c, trk=None):
    """Return canonical warp key tuple: (sid, stem, q_rev, g_sig, bpm, mult, semis)."""
    sid = c["song"]
    g = G.get_or_build(sid)
    sc = song_cfg(project, sid)
    use_q = bool(sc.get("quantized", False))
    q = g.get("quantized") or {}
    q_rev = q.get("rev") if (use_q and q.get("sig") == g.get("sig") and q.get("rev")) else ""
    bpm = round(float(project.get("bpm") or 120.0), 4)
    mult = round(song_mult(project, sid), 4)
    semis = clip_semis(project, c, trk)
    return (sid, c["stem"], q_rev, g.get("sig", ""), bpm, mult, semis)


def render_requests(project):
    """Unique warp_request() tuples for every active clip in the arrangement."""
    tmap = {t["id"]: t for t in project.get("tracks") or []}
    reqs = []
    for c in project.get("clips") or []:
        if c.get("mute") or c.get("len", 0) <= 0:
            continue
        if library.read_raw(c["song"]) is None:
            continue
        reqs.append(warp_request(project, c, tmap.get(c["track"])))
    return list(dict.fromkeys(reqs))


def length_beats(project):
    return max([float(c["start"]) + float(c["len"]) for c in (project.get("clips") or []) if not c.get("mute")] + [0.0])


# ------------------------------------------------------------------ editing operations (tested & reusable)

def split_clip(project, clip_id, at_beat):
    """Split clip `clip_id` at project beat `at_beat`. Returns (left_clip, right_clip) or None if out of range."""
    clips = project.get("clips") or []
    idx = next((i for i, c in enumerate(clips) if c["id"] == clip_id), None)
    if idx is None:
        return None
    c = clips[idx]
    s0, ln = float(c["start"]), float(c["len"])
    if not (s0 + 1e-4 < at_beat < s0 + ln - 1e-4):
        return None
    left_len = at_beat - s0
    right_len = (s0 + ln) - at_beat
    mult = song_mult(project, c["song"])
    rate = float(c.get("rate", 1.0) or 1.0)
    src_delta = left_len * rate / mult

    left = dict(c, len=round(left_len, 6), fade_out=min(float(c.get("fade_out", 0.04)), left_len * 0.5))
    right = dict(c, id=new_id("c"), start=round(at_beat, 6), src=round(float(c["src"]) + src_delta, 6),
                 len=round(right_len, 6), fade_in=0.0)
    clips[idx] = left
    clips.insert(idx + 1, right)
    return left, right


def duplicate_after(project, clip_ids):
    """Duplicate all selected clips immediately after the end of the selection (Ctrl+D),
    preserving exact relative offsets and lane assignments. Returns list of new clips."""
    id_set = set(clip_ids)
    sel = [c for c in (project.get("clips") or []) if c["id"] in id_set]
    if not sel:
        return []
    min_start = min(float(c["start"]) for c in sel)
    max_end = max(float(c["start"]) + float(c["len"]) for c in sel)
    span = max_end - min_start
    if span <= 1e-6:
        return []
    created = []
    for c in sel:
        nc = dict(c, id=new_id("c"), start=round(float(c["start"]) + span, 6))
        project["clips"].append(nc)
        created.append(nc)
    return created


# ------------------------------------------------------------------ persistence

def save(project):
    project["modified"] = time.time()
    p = PROJECTS / f"{project['id']}.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(project, indent=1), encoding="utf-8")
    tmp.replace(p)
    return p


def load(pid):
    return json.loads((PROJECTS / f"{pid}.json").read_text(encoding="utf-8"))


def delete(pid):
    (PROJECTS / f"{pid}.json").unlink(missing_ok=True)


def list_projects():
    out = []
    for p in PROJECTS.glob("*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append(dict(
                id=d["id"],
                name=d.get("name") or "Untitled Mashup",
                bpm=d.get("bpm", 128.0),
                bpb=d.get("bpb", 4),
                modified=d.get("modified", 0),
                songs=list((d.get("songs") or {}).keys()),
                n_clips=len(d.get("clips") or []),
            ))
        except Exception:
            pass
    return sorted(out, key=lambda x: x["modified"], reverse=True)


_BRANCH = re.compile(r"^(.*?) \(branch (\d+)\)$")


def branch(pid, name=None):
    src = load(pid)
    p = json.loads(json.dumps(src))
    m = _BRANCH.match(src.get("name") or "")
    base = m.group(1) if m else (src.get("name") or "Untitled Mashup")
    taken = [int(mm.group(2)) for q in list_projects() if (mm := _BRANCH.match(q.get("name") or "")) and mm.group(1) == base]
    p["id"] = new_id("p")
    p["name"] = (name or "").strip() or f"{base} (branch {max(taken, default=0) + 1})"
    p["branch_of"] = dict(id=src["id"], name=src.get("name"), at=time.time())
    p["created"] = time.time()
    save(p)
    return p
