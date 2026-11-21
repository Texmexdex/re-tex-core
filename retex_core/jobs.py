"""Lightweight background job queue + Server-Sent Events (SSE) broadcaster."""
import asyncio
import itertools
import json
import queue
import threading
import time
import traceback


class EventBus:
    def __init__(self):
        self._lock = threading.Lock()
        self._subs = set()

    def subscribe(self):
        q = asyncio.Queue(maxsize=256)
        with self._lock:
            self._subs.add((q, asyncio.get_running_loop()))
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs = {(qq, lp) for (qq, lp) in self._subs if qq is not q}

    def publish(self, event_type, **payload):
        msg = json.dumps({"type": event_type, **payload})
        with self._lock:
            subs = list(self._subs)
        for q, loop in subs:
            try:
                loop.call_soon_threadsafe(self._put_nowait, q, msg)
            except RuntimeError:
                pass

    @staticmethod
    def _put_nowait(q, msg):
        if q.full():
            try:
                q.get_nowait()
            except Exception:
                pass
        try:
            q.put_nowait(msg)
        except Exception:
            pass


bus = EventBus()


class Job:
    def __init__(self, jid, kind, label, ref=None):
        self.id = jid
        self.kind = kind
        self.label = label
        self.ref = ref
        self.status = "queued"
        self.progress = 0.0
        self.message = ""
        self.result = None
        self.error = None
        self.cancelled = False
        self.created = time.time()
        self._last_pub = 0.0

    def update(self, frac, message="", force=False):
        self.progress = float(max(0.0, min(1.0, frac)))
        if message:
            self.message = message
        now = time.time()
        if force or now - self._last_pub >= 0.12:
            self._last_pub = now
            bus.publish("job", job=self.to_dict())

    def sub(self, lo, hi, prefix=""):
        def cb(f, m=""):
            self.update(lo + (hi - lo) * float(f), f"{prefix}{m}" if m else self.message)
        return cb

    def to_dict(self):
        return dict(id=self.id, kind=self.kind, label=self.label, ref=self.ref,
                    status=self.status, progress=round(self.progress, 3),
                    message=self.message, result=self.result, error=self.error)


class JobManager:
    def __init__(self):
        self._seq = itertools.count(1)
        self._lock = threading.Lock()
        self._jobs = {}
        self._q = queue.Queue()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def submit(self, kind, label, fn, ref=None):
        with self._lock:
            # De-duplicate active identical (kind, ref) jobs
            if ref is not None:
                for j in self._jobs.values():
                    if j.kind == kind and j.ref == ref and j.status in ("queued", "running"):
                        return j
            jid = next(self._seq)
            j = Job(jid, kind, label, ref=ref)
            self._jobs[jid] = j
        bus.publish("job", job=j.to_dict())
        self._q.put((j, fn))
        return j

    def active(self):
        with self._lock:
            now = time.time()
            return [j.to_dict() for j in self._jobs.values()
                    if j.status in ("queued", "running") or (now - j.created < 60)]

    def cancel(self, jid):
        with self._lock:
            j = self._jobs.get(jid)
            if j:
                j.cancelled = True
                return True
        return False

    def _run(self):
        while True:
            j, fn = self._q.get()
            if j.cancelled:
                j.status = "cancelled"
                bus.publish("job", job=j.to_dict())
                continue
            j.status = "running"
            j.update(0.01, "starting...", force=True)
            try:
                j.result = fn(j)
                j.status = "cancelled" if j.cancelled else "done"
                j.progress = 1.0 if j.status == "done" else j.progress
            except Exception as e:
                j.status = "error"
                j.error = str(e)
                traceback.print_exc()
            bus.publish("job", job=j.to_dict())


jobs = JobManager()
