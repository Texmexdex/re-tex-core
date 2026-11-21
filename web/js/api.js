// HTTP JSON / binary peaks / SSE client + toast notifications for Re-Tex Core

export async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const d = await r.json();
      if (d && d.detail) msg = typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail);
    } catch {
      try { const t = await r.text(); if (t) msg = t; } catch {}
    }
    throw new Error(msg);
  }
  return r.json();
}

export const get = (url) => req("GET", url);
export const post = (url, body) => req("POST", url, body);
export const put = (url, body) => req("PUT", url, body);
export const del = (url) => req("DELETE", url);

export async function upload(url, file, extra = {}) {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(url, { method: "POST", body: fd });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const d = await r.json(); if (d?.detail) msg = d.detail; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

export async function fetchPeaks(sid, stem, qRev = "") {
  const q = qRev ? `?q=${encodeURIComponent(qRev)}` : "";
  const r = await fetch(`/api/songs/${encodeURIComponent(sid)}/peaks/${encodeURIComponent(stem)}${q}`);
  if (!r.ok) throw new Error(`Peaks failed (${r.status})`);
  const buf = await r.arrayBuffer();
  return new Int8Array(buf);
}

export function connectEvents(onEvent) {
  let es = null;
  let retryMs = 800;
  let closed = false;

  const open = () => {
    if (closed) return;
    es = new EventSource("/api/events");
    es.onopen = () => { retryMs = 800; };
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        onEvent(msg);
      } catch {}
    };
    es.onerror = () => {
      try { es.close(); } catch {}
      if (!closed) {
        setTimeout(open, retryMs);
        retryMs = Math.min(5000, Math.round(retryMs * 1.5));
      }
    };
  };
  open();
  return () => {
    closed = true;
    try { es?.close(); } catch {}
  };
}

export function toast(msg, kind = "") {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`.trim();
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.25s";
    setTimeout(() => el.remove(), 260);
  }, kind === "err" ? 5000 : 3000);
}
