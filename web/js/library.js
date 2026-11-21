// Library browser with Re-Tex folders, Group-By (Folders/Artist/Genre/Key/Tempo/Flat),
// drag-to-folder, search/sort/Camelot-BPM Match filter, drag-to-timeline & audio import

import * as api from "./api.js";
import * as audio from "./audio.js";
import { S, STEMS, addSongStems, emit, onChange, uid } from "./state.js";

let compatOn = false;
let auditioningSid = null;
let renderLimit = 90;
let filteredCache = [];
let groupMode = localStorage.getItem("retex_core_libGroup") || "folders";
let groupCollapsed = (() => {
  try { return JSON.parse(localStorage.getItem("retex_core_libCollapsed") || "{}"); } catch { return {}; }
})();

function saveGroupPrefs() {
  try {
    localStorage.setItem("retex_core_libGroup", groupMode);
    localStorage.setItem("retex_core_libCollapsed", JSON.stringify(groupCollapsed));
  } catch {}
}

function isGroupCollapsed(mode, key) {
  return (groupCollapsed[mode] || []).includes(key);
}

function toggleGroupCollapsed(mode, key) {
  const cur = new Set(groupCollapsed[mode] || []);
  if (cur.has(key)) cur.delete(key); else cur.add(key);
  groupCollapsed[mode] = [...cur];
  saveGroupPrefs();
  renderLibrary(false);
}

async function persistFolders() {
  emit("folders");
  try {
    S.folders = await api.put("/api/folders", S.folders);
  } catch (e) {
    api.toast(`Could not save folders: ${e.message}`, "err");
  }
}

async function createFolder() {
  const name = prompt("New folder name:", "New Folder")?.trim();
  if (!name) return;
  S.folders.folders.push({ id: uid("f"), name, collapsed: false });
  await persistFolders();
  renderLibrary(false);
}

async function renameFolder(f) {
  const name = prompt("Rename folder:", f.name)?.trim();
  if (!name || name === f.name) return;
  f.name = name;
  await persistFolders();
  renderLibrary(false);
}

async function deleteFolder(f) {
  if (!confirm(`Delete folder "${f.name}"? (Your songs stay in the library as Unsorted.)`)) return;
  S.folders.folders = S.folders.folders.filter((x) => x.id !== f.id);
  for (const [sid, fid] of Object.entries(S.folders.assign)) {
    if (fid === f.id) delete S.folders.assign[sid];
  }
  await persistFolders();
  renderLibrary(false);
}

async function moveSongToFolder(sid, fid) {
  if (fid) S.folders.assign[sid] = fid;
  else delete S.folders.assign[sid];
  await persistFolders();
  renderLibrary(false);
}

async function toggleFolderCollapsed(f) {
  f.collapsed = !f.collapsed;
  await persistFolders();
  renderLibrary(false);
}

async function toggleAllFolders() {
  const fs = S.folders.folders || [];
  const anyCollapsed = fs.some((f) => f.collapsed);
  for (const f of fs) f.collapsed = !anyCollapsed;
  await persistFolders();
  renderLibrary(false);
}

async function syncFoldersFromRetex() {
  try {
    S.folders = await api.post("/api/folders/sync", {});
    emit("folders");
    renderLibrary(false);
    api.toast(`Synced ${S.folders.folders.length} folders from Re-Tex (full)`, "ok");
  } catch (e) {
    api.toast(`Folder sync failed: ${e.message}`, "err");
  }
}

function showSongFolderMenu(clientX, clientY, song) {
  const menu = document.getElementById("ctxMenu");
  if (!menu) return;
  menu.innerHTML = "";
  const curFid = S.folders.assign[song.id] || "";

  const header = document.createElement("div");
  header.style.cssText = "padding:4px 10px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;";
  header.textContent = "Move to Folder";
  menu.appendChild(header);

  const addOpt = (label, fid) => {
    const it = document.createElement("div");
    it.className = "ctx-item";
    it.innerHTML = `<span>${label}</span>${curFid === fid ? '<span class="ctx-kbd" style="color:var(--green-hi)">current</span>' : ""}`;
    it.addEventListener("click", () => {
      menu.classList.add("hidden");
      moveSongToFolder(song.id, fid);
    });
    menu.appendChild(it);
  };

  addOpt("Unsorted", "");
  const sep = document.createElement("div");
  sep.className = "ctx-sep";
  menu.appendChild(sep);

  for (const f of S.folders.folders || []) addOpt(f.name, f.id);

  menu.classList.remove("hidden");
  const mw = menu.offsetWidth || 200;
  const mh = Math.min(420, menu.offsetHeight || 260);
  menu.style.maxHeight = "420px";
  menu.style.overflowY = "auto";
  menu.style.left = `${Math.min(window.innerWidth - mw - 8, clientX)}px`;
  menu.style.top = `${Math.min(window.innerHeight - mh - 8, clientY)}px`;
}

// ------------------------------------------------------------------ Filtering & Sorting

function parseCamelot(c) {
  if (!c) return null;
  const m = String(c).trim().match(/^(\d{1,2})([AB])$/i);
  if (!m) return null;
  return { num: parseInt(m[1], 10), mode: m[2].toUpperCase() };
}

function camelotCompatible(c1, c2) {
  const a = parseCamelot(c1);
  const b = parseCamelot(c2);
  if (!a || !b) return true;
  if (a.num === b.num) return true;
  if (a.mode !== b.mode) return false;
  const d = Math.abs(a.num - b.num);
  return d === 1 || d === 11;
}

function bpmCompatible(songBpm, refBpm) {
  if (!songBpm || !refBpm) return true;
  for (const mult of [0.5, 1.0, 2.0]) {
    const ratio = (songBpm * mult) / refBpm;
    if (ratio >= 0.88 && ratio <= 1.12) return true;
  }
  return false;
}

function getRefForMatch() {
  const projBpm = Number(S.project?.bpm || 128);
  const sids = Object.keys(S.project?.songs || {});
  let refCamelot = "";
  if (sids.length) {
    const first = S.details[sids[0]] || S.songs.find((x) => x.id === sids[0]);
    refCamelot = first?.camelot || "";
  }
  return { refBpm: projBpm, refCamelot };
}

function sortSongs(list) {
  const sortBy = document.getElementById("libSort")?.value || "recent";
  if (sortBy === "title") return [...list].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  if (sortBy === "bpm") return [...list].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));
  if (sortBy === "key") return [...list].sort((a, b) => (a.camelot || "ZZ").localeCompare(b.camelot || "ZZ"));
  return [...list].sort((a, b) => (b.created || 0) - (a.created || 0));
}

function getFilteredSongs() {
  const q = (document.getElementById("libSearch")?.value || "").trim().toLowerCase();
  const { refBpm, refCamelot } = getRefForMatch();
  const folderNames = new Map((S.folders.folders || []).map((f) => [f.id, f.name.toLowerCase()]));

  const list = S.songs.filter((s) => {
    if (q) {
      const fname = folderNames.get(S.folders.assign?.[s.id]) || "";
      const hay = `${s.title} ${s.artist} ${s.album || ""} ${s.genre} ${fname} ${s.key} ${s.camelot} ${Math.round(s.bpm)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (compatOn) {
      if (!bpmCompatible(s.bpm, refBpm)) return false;
      if (refCamelot && !camelotCompatible(s.camelot, refCamelot)) return false;
    }
    return true;
  });

  return sortSongs(list);
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function makeSongCard(s) {
  const card = document.createElement("div");
  card.className = "song-card";
  card.dataset.sid = s.id;
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    // Only set song drag if a stem chip didn't already set stem drag
    if (!e.dataTransfer.types.includes("application/x-retex-stem")) {
      e.dataTransfer.setData("application/x-retex-song", s.id);
      e.dataTransfer.effectAllowed = "move";
    }
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showSongFolderMenu(e.clientX, e.clientY, s);
  });

  const top = document.createElement("div");
  top.className = "sc-top";
  const title = document.createElement("div");
  title.className = "sc-title";
  title.textContent = s.title || s.id;
  title.title = [s.title, s.artist, s.genre].filter(Boolean).join(" · ");

  const audBtn = document.createElement("button");
  audBtn.className = "btn-mini btn-ghost";
  audBtn.textContent = auditioningSid === s.id ? "Stop" : "Play";
  audBtn.title = "Preview song audio";
  audBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (auditioningSid === s.id) {
      auditioningSid = null;
      audio.stopAudition();
      renderLibrary(false);
    } else {
      auditioningSid = s.id;
      renderLibrary(false);
      try {
        await audio.auditionSong(s.id, {
          stem: "mix",
          start_s: Math.min(30, (s.duration || 60) * 0.2),
          quantized: Boolean(s.core_grid?.quantized),
          click: false,
        });
      } catch (err) {
        auditioningSid = null;
        api.toast(`Preview failed: ${err.message}`, "err");
        renderLibrary(false);
      }
    }
  });
  top.append(title, audBtn);

  const meta = document.createElement("div");
  meta.className = "sc-meta";
  const bpmEl = document.createElement("span");
  bpmEl.textContent = `${Math.round(s.bpm || 0)} BPM`;
  meta.appendChild(bpmEl);
  if (s.key || s.camelot) {
    const kEl = document.createElement("span");
    kEl.className = "sc-key";
    kEl.textContent = [s.key, s.camelot].filter(Boolean).join(" ");
    meta.appendChild(kEl);
  }
  const durEl = document.createElement("span");
  durEl.textContent = fmtDur(s.duration);
  meta.appendChild(durEl);

  if (s.separation && s.separation.includes("blend")) {
    const b = document.createElement("span");
    b.className = "sc-badge blend";
    b.textContent = "blend";
    meta.appendChild(b);
  }
  if (s.core_grid?.quantized) {
    const q = document.createElement("span");
    q.className = "sc-badge quant";
    q.textContent = "Q";
    q.title = "Quantized stems verified in Re-Tex Core";
    meta.appendChild(q);
  }

  const actions = document.createElement("div");
  actions.className = "sc-actions";
  const shortLabel = { drums: "D", bass: "B", other: "O", vocals: "V" };
  for (const stem of STEMS) {
    const chip = document.createElement("button");
    chip.className = "stem-chip";
    chip.dataset.stem = stem;
    chip.textContent = shortLabel[stem];
    chip.title = `Click to add ${stem} stem, or drag onto timeline`;
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      e.dataTransfer.setData("application/x-retex-stem", JSON.stringify({ sid: s.id, stem }));
      e.dataTransfer.effectAllowed = "copy";
    });
    chip.addEventListener("click", () => addSongStems(s.id, [stem]));
    actions.appendChild(chip);
  }
  const spacer = document.createElement("span");
  spacer.className = "sc-spacer";
  const addAll = document.createElement("button");
  addAll.className = "btn-mini btn-ghost";
  addAll.textContent = "+All";
  addAll.title = "Add all 4 stems aligned to Bar 1";
  addAll.addEventListener("click", () => addSongStems(s.id, STEMS));
  actions.append(spacer, addAll);

  card.append(top, meta, actions);
  return card;
}

// ------------------------------------------------------------------ Grouped Rendering

function buildGroups(songs) {
  const by = (keyFn, labelFn, cmp) => {
    const m = new Map();
    for (const s of songs) {
      const k = keyFn(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    const out = [...m.entries()].map(([k, list]) => ({ key: String(k), label: labelFn(k, list), songs: list }));
    out.sort(cmp || ((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.label.localeCompare(b.label))));
    return out;
  };

  if (groupMode === "folders") {
    const folders = S.folders.folders || [];
    const assign = S.folders.assign || {};
    const map = new Map(folders.map((f) => [f.id, []]));
    const loose = [];
    for (const s of songs) {
      const fid = assign[s.id];
      if (fid && map.has(fid)) map.get(fid).push(s);
      else loose.push(s);
    }
    const out = folders.map((f) => ({ key: f.id, label: f.name, folder: f, songs: map.get(f.id) }));
    out.push({ key: "~unsorted", label: "Unsorted", folder: null, isUnsorted: true, songs: loose });
    return out;
  }

  if (groupMode === "artist") {
    return by((s) => (s.artist || "").trim().toLowerCase(), (k, a) => (k ? a[0].artist : "Unknown Artist"));
  }
  if (groupMode === "genre") {
    return by((s) => (s.genre || "").trim().toLowerCase(), (k, a) => (k ? a[0].genre : "No Genre"));
  }
  if (groupMode === "key") {
    const num = (c) => parseInt(c, 10) || 99;
    return by(
      (s) => s.camelot || "",
      (k, a) => (k ? `${k} · ${a[0].key || ""}` : "Unknown Key"),
      (a, b) => num(a.key) - num(b.key) || a.key.localeCompare(b.key),
    );
  }
  if (groupMode === "tempo") {
    return by(
      (s) => Math.floor((s.bpm || 0) / 10) * 10,
      (k) => `${k}–${Number(k) + 9} BPM`,
      (a, b) => Number(a.key) - Number(b.key),
    );
  }
  return null; // flat
}

function renderGrouped(listEl, songs) {
  const q = (document.getElementById("libSearch")?.value || "").trim();
  const autoExpand = Boolean(q || compatOn);
  const groups = buildGroups(songs);
  const frag = document.createDocumentFragment();

  for (const grp of groups) {
    if (autoExpand && grp.songs.length === 0) continue;
    if (grp.isUnsorted && grp.songs.length === 0 && (S.folders.folders || []).length > 0) continue;

    const wrap = document.createElement("div");
    wrap.className = "lib-group";

    const collapsed = autoExpand
      ? false
      : grp.folder
        ? Boolean(grp.folder.collapsed)
        : isGroupCollapsed(groupMode, grp.key);

    const head = document.createElement("div");
    head.className = "lg-head";

    const chev = document.createElement("span");
    chev.className = "lg-chev";
    chev.textContent = collapsed ? ">" : "v";

    const name = document.createElement("span");
    name.className = "lg-name";
    name.textContent = grp.label;
    name.title = grp.label;

    const cnt = document.createElement("span");
    cnt.className = "lg-count";
    cnt.textContent = String(grp.songs.length);

    head.append(chev, name, cnt);

    if (grp.folder) {
      const acts = document.createElement("div");
      acts.className = "lg-actions";
      const ren = document.createElement("button");
      ren.className = "lg-act";
      ren.textContent = "Ren";
      ren.title = "Rename folder";
      ren.addEventListener("click", (e) => { e.stopPropagation(); renameFolder(grp.folder); });
      const del = document.createElement("button");
      del.className = "lg-act del";
      del.textContent = "x";
      del.title = "Delete folder";
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteFolder(grp.folder); });
      acts.append(ren, del);
      head.appendChild(acts);
    }

    head.addEventListener("click", () => {
      if (grp.folder) toggleFolderCollapsed(grp.folder);
      else toggleGroupCollapsed(groupMode, grp.key);
    });

    // Drag song cards onto folder headers (or Unsorted) to assign
    if (groupMode === "folders") {
      head.addEventListener("dragover", (e) => {
        if ([...(e.dataTransfer?.types || [])].includes("application/x-retex-song")) {
          e.preventDefault();
          head.classList.add("drop-hot");
        }
      });
      head.addEventListener("dragleave", () => head.classList.remove("drop-hot"));
      head.addEventListener("drop", (e) => {
        head.classList.remove("drop-hot");
        const sid = e.dataTransfer?.getData("application/x-retex-song");
        if (sid) {
          e.preventDefault();
          e.stopPropagation();
          moveSongToFolder(sid, grp.folder ? grp.folder.id : "");
          api.toast(`Moved to ${grp.label}`, "ok");
        }
      });
    }

    wrap.appendChild(head);

    if (!collapsed && grp.songs.length > 0) {
      const body = document.createElement("div");
      body.className = "lg-body";
      for (const s of grp.songs) body.appendChild(makeSongCard(s));
      wrap.appendChild(body);
    }
    frag.appendChild(wrap);
  }

  if (!frag.childNodes.length) {
    const emp = document.createElement("div");
    emp.className = "songs-empty";
    emp.style.padding = "14px 8px";
    emp.textContent = S.songs.length ? "No songs match filter." : "Library empty — drop audio files here to import.";
    frag.appendChild(emp);
  }
  listEl.appendChild(frag);
}

export function renderLibrary(resetLimit = true) {
  const listEl = document.getElementById("libList");
  const countEl = document.getElementById("libCount");
  const fbar = document.getElementById("libFolderBar");
  const toggleBtn = document.getElementById("btnToggleAllFolders");
  if (!listEl) return;

  if (fbar) fbar.classList.toggle("hidden", groupMode !== "folders");
  if (toggleBtn && groupMode === "folders") {
    const anyCollapsed = (S.folders.folders || []).some((f) => f.collapsed);
    toggleBtn.textContent = anyCollapsed ? "Expand All" : "Collapse All";
  }

  if (resetLimit) renderLimit = 90;
  filteredCache = getFilteredSongs();
  if (countEl) {
    countEl.textContent = filteredCache.length === S.songs.length
      ? String(S.songs.length)
      : `${filteredCache.length}/${S.songs.length}`;
  }

  const prevScroll = listEl.scrollTop;
  listEl.innerHTML = "";

  if (groupMode !== "flat") {
    renderGrouped(listEl, filteredCache);
    listEl.scrollTop = prevScroll;
    return;
  }

  // Flat mode with progressive append
  const slice = filteredCache.slice(0, renderLimit);
  const frag = document.createDocumentFragment();
  for (const s of slice) frag.appendChild(makeSongCard(s));

  if (filteredCache.length > renderLimit) {
    const more = document.createElement("button");
    more.className = "btn-ghost btn-sm";
    more.textContent = `Show more (${filteredCache.length - renderLimit} remaining)`;
    more.addEventListener("click", () => {
      renderLimit += 100;
      renderLibrary(false);
    });
    frag.appendChild(more);
  }
  if (!filteredCache.length) {
    const emp = document.createElement("div");
    emp.className = "songs-empty";
    emp.style.padding = "14px 8px";
    emp.textContent = S.songs.length ? "No songs match filter." : "Library empty — drop audio files here to import.";
    frag.appendChild(emp);
  }
  listEl.appendChild(frag);
  listEl.scrollTop = prevScroll;
}

async function importFiles(files) {
  for (const file of files) {
    try {
      const title = file.name.replace(/\.[^.]+$/, "");
      await api.upload("/api/songs/import", file, { title });
      api.toast(`Import started: ${title}`, "ok");
    } catch (e) {
      api.toast(`Import failed: ${e.message}`, "err");
    }
  }
}

export function initLibrary() {
  const search = document.getElementById("libSearch");
  const groupSel = document.getElementById("libGroup");
  const sort = document.getElementById("libSort");
  const compatBtn = document.getElementById("btnCompatFilter");
  const importBtn = document.getElementById("btnImportSong");
  const fileInput = document.getElementById("importFileInput");
  const listEl = document.getElementById("libList");

  if (groupSel) {
    groupSel.value = groupMode;
    groupSel.addEventListener("change", () => {
      groupMode = groupSel.value || "folders";
      saveGroupPrefs();
      renderLibrary(true);
    });
  }

  document.getElementById("btnNewFolder")?.addEventListener("click", createFolder);
  document.getElementById("btnToggleAllFolders")?.addEventListener("click", toggleAllFolders);
  document.getElementById("btnSyncFolders")?.addEventListener("click", syncFoldersFromRetex);

  search?.addEventListener("input", () => renderLibrary(true));
  sort?.addEventListener("change", () => renderLibrary(true));
  compatBtn?.addEventListener("click", () => {
    compatOn = !compatOn;
    compatBtn.classList.toggle("on", compatOn);
    renderLibrary(true);
  });

  importBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    if (fileInput.files?.length) {
      importFiles([...fileInput.files]);
      fileInput.value = "";
    }
  });

  listEl?.addEventListener("scroll", () => {
    if (groupMode === "flat" && filteredCache.length > renderLimit && listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 160) {
      renderLimit += 90;
      renderLibrary(false);
    }
  });

  listEl?.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) {
      e.preventDefault();
      listEl.classList.add("drop-hot");
    }
  });
  listEl?.addEventListener("dragleave", () => listEl.classList.remove("drop-hot"));
  listEl?.addEventListener("drop", (e) => {
    listEl.classList.remove("drop-hot");
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      importFiles([...e.dataTransfer.files]);
    }
  });

  onChange((kind) => {
    if (kind === "songs" || kind === "folders" || kind === "song_detail" || (compatOn && kind === "project")) {
      renderLibrary(false);
    }
  });
}
