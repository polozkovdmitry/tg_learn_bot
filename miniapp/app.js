"use strict";

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const $ = (id) => document.getElementById(id);
const MAX_VALUE_LEN = 4096; // CloudStorage value limit
const CHUNK = 100;          // keys per getItems call

// ---------- storage: Telegram CloudStorage, localStorage as fallback ----------

const cloud = tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9") ? tg.CloudStorage : null;

const store = {
  getItems(keys) {
    if (!keys.length) return Promise.resolve({});
    if (!cloud) {
      const out = {};
      for (const k of keys) out[k] = localStorage.getItem(k) || "";
      return Promise.resolve(out);
    }
    return new Promise((res, rej) => cloud.getItems(keys, (e, v) => (e ? rej(new Error(e)) : res(v || {}))));
  },
  async getItem(key) {
    return (await this.getItems([key]))[key] || "";
  },
  setItem(key, value) {
    if (!cloud) {
      localStorage.setItem(key, value);
      return Promise.resolve();
    }
    return new Promise((res, rej) => cloud.setItem(key, value, (e) => (e ? rej(new Error(e)) : res())));
  },
  removeItem(key) {
    if (!cloud) {
      localStorage.removeItem(key);
      return Promise.resolve();
    }
    return new Promise((res, rej) => cloud.removeItem(key, (e) => (e ? rej(new Error(e)) : res())));
  },
};

// ---------- cards: fc_index = ["c1", ...], fc_c<N> = {k, v, g?, s?}, fc_next = counter ----------
// g = group (first layer, e.g. "ipii"), s = subject within the group (second layer, e.g. "recsys")

let cards = new Map(); // id -> {k, v, g?, s?}, insertion order = index order

function parseJSON(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

async function loadCards() {
  const ids = parseJSON(await store.getItem("fc_index"), []);
  cards = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const vals = await store.getItems(part.map((id) => "fc_" + id));
    for (const id of part) {
      const c = parseJSON(vals["fc_" + id], null);
      if (c && typeof c.k === "string") cards.set(id, c);
    }
  }
}

function saveIndex() {
  return store.setItem("fc_index", JSON.stringify([...cards.keys()]));
}

function normTag(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function makeCard(k, v, g, s) {
  const c = { k, v };
  if (g) c.g = g;
  if (g && s) c.s = s;
  return c;
}

async function addCard(c) {
  const n = (parseInt(await store.getItem("fc_next"), 10) || 0) + 1;
  const id = "c" + n;
  await store.setItem("fc_" + id, JSON.stringify(c));
  await store.setItem("fc_next", String(n));
  cards.set(id, c);
  await saveIndex();
  return id;
}

async function updateCard(id, c) {
  await store.setItem("fc_" + id, JSON.stringify(c));
  cards.set(id, c);
}

async function deleteCard(id) {
  cards.delete(id);
  await saveIndex(); // index first: an orphaned card key is harmless, a dangling index entry is skipped on load
  await store.removeItem("fc_" + id);
}

// ---------- filter + session state (memory only, no filter on every open) ----------

let filter = { g: "", s: "" }; // empty = all cards; g alone = whole group; g + s = one subject
let sample = [];
let current = null;
let last = null;

function matches(c) {
  return (!filter.g || c.g === filter.g) && (!filter.s || c.s === filter.s);
}

function matchingIds() {
  return [...cards].filter(([, c]) => matches(c)).map(([id]) => id);
}

// group -> {n, subs: Map(subject -> n)}, for the filter sheet and autocomplete
function tagStats() {
  const groups = new Map();
  for (const c of cards.values()) {
    if (!c.g) continue;
    if (!groups.has(c.g)) groups.set(c.g, { n: 0, subs: new Map() });
    const e = groups.get(c.g);
    e.n++;
    if (c.s) e.subs.set(c.s, (e.subs.get(c.s) || 0) + 1);
  }
  return groups;
}

// drop a filter whose tag no longer exists on any card
function fixFilter() {
  const groups = tagStats();
  if (filter.g && !groups.has(filter.g)) filter = { g: "", s: "" };
  else if (filter.s && !groups.get(filter.g).subs.has(filter.s)) filter.s = "";
}

function filterLabel() {
  return !filter.g ? "All cards" : filter.s ? `${filter.g} › ${filter.s}` : filter.g;
}

function renderFilterButtons() {
  for (const b of document.querySelectorAll(".fbtn")) {
    b.textContent = "🏷 " + filterLabel();
    b.classList.toggle("on", !!filter.g);
  }
}

function setFilter(g, s) {
  filter = { g, s };
  resetSample();
  renderFilterButtons();
  renderSheet();
  next();
  if (!$("list").hidden) renderList();
}

function resetSample() {
  sample = matchingIds();
  current = null;
  last = null;
}

function draw() {
  if (!sample.length) return null;
  let pool = sample;
  if (sample.length > 1 && last) pool = sample.filter((id) => id !== last);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------- ui helpers ----------

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

function haptic(kind) {
  try {
    if (!tg || !tg.HapticFeedback) return;
    if (kind === "ok") tg.HapticFeedback.notificationOccurred("success");
    else tg.HapticFeedback.impactOccurred("light");
  } catch {}
}

function show(screen) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== screen;
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("active", b.dataset.screen === screen);
  if (screen === "review") {
    if ((!current || !cards.has(current)) && sample.length) next();
    else renderReview();
  }
  if (screen === "list") renderList();
  if (screen === "add") refreshTagLists();
  if (screen === "add" && editingId === null) $("add-k").focus();
}

// ---------- review ----------

const card = $("card");

function renderReview() {
  const total = matchingIds().length;
  $("counter").textContent = `${sample.length} / ${total} remaining`;
  const has = current && cards.has(current);
  card.hidden = !has;
  $("actions").hidden = !has;
  $("empty").hidden = has;
  if (!has) {
    $("empty-msg").textContent = total ? "All done 🎉" : cards.size ? "No cards match this filter." : "No cards yet. Add one!";
    $("restart").hidden = !total;
  }
}

function showCard(id) {
  current = id;
  card.classList.add("noflip"); // reset to the front instantly, no visible flip-back
  card.classList.remove("flipped", "snap");
  card.style.transform = "";
  card.style.opacity = "";
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("noflip")));
  if (id) {
    const c = cards.get(id);
    $("front").textContent = c.k;
    $("back").textContent = c.v;
  }
  renderReview();
}

function next() {
  showCard(draw());
}

function answer(done) {
  if (!current) return;
  haptic(done ? "ok" : "light");
  const id = current;
  last = id;
  if (done) sample = sample.filter((x) => x !== id);
  const dir = done ? -1 : 1;
  card.classList.add("snap");
  card.style.transform = `translateX(${dir * window.innerWidth}px) rotate(${dir * 20}deg)`;
  card.style.opacity = "0";
  setTimeout(next, 200);
}

$("done").onclick = () => answer(true);
$("keep").onclick = () => answer(false);
$("restart").onclick = () => {
  resetSample();
  next();
};

// swipe / tap on the card
let drag = null;
const SWIPE_PX = 80;

card.addEventListener("pointerdown", (e) => {
  if (!current || card.classList.contains("snap")) return;
  drag = { x: e.clientX, y: e.clientY, dx: 0, moved: false, id: e.pointerId };
  card.setPointerCapture(e.pointerId);
});

card.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.dx = e.clientX - drag.x;
  if (Math.abs(drag.dx) > 10) drag.moved = true;
  if (drag.moved) card.style.transform = `translateX(${drag.dx}px) rotate(${drag.dx / 20}deg)`;
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.moved) {
    if (e.type === "pointerup") {
      card.classList.toggle("flipped");
      haptic("light");
    }
  } else if (e.type === "pointerup" && Math.abs(d.dx) > SWIPE_PX) {
    answer(d.dx < 0);
  } else {
    card.classList.add("snap");
    card.style.transform = "";
    setTimeout(() => card.classList.remove("snap"), 200);
  }
}
card.addEventListener("pointerup", endDrag);
card.addEventListener("pointercancel", endDrag);

// ---------- add / edit ----------

let editingId = null;
let addTags = null; // {g, s} of the last card added this session; null until then (falls back to the active filter)

function refreshTagLists() {
  const groups = tagStats();
  $("dl-groups").replaceChildren(...[...groups.keys()].map((g) => new Option(g)));
  const subs = groups.get(normTag($("add-g").value));
  $("dl-subjects").replaceChildren(...(subs ? [...subs.subs.keys()] : []).map((s) => new Option(s)));
}
$("add-g").oninput = refreshTagLists;

function setEditing(id) {
  editingId = id;
  const c = id ? cards.get(id) : { k: "", v: "", ...(addTags || filter) };
  $("add-k").value = c.k;
  $("add-v").value = c.v;
  $("add-g").value = c.g || "";
  $("add-s").value = c.s || "";
  refreshTagLists();
  $("add-err").textContent = "";
  $("add-save").textContent = id ? "Update" : "Save";
}

$("add-save").onclick = async () => {
  const k = $("add-k").value.trim();
  const v = $("add-v").value.trim();
  const g = normTag($("add-g").value);
  const s = normTag($("add-s").value);
  if (!k || !v) {
    $("add-err").textContent = "Both key and value are required.";
    return;
  }
  if (s && !g) {
    $("add-err").textContent = "A subject needs a group.";
    return;
  }
  const c = makeCard(k, v, g, s);
  if (JSON.stringify(c).length > MAX_VALUE_LEN) {
    $("add-err").textContent = "Too long: key + value must be under ~4000 characters.";
    return;
  }
  $("add-save").disabled = true;
  try {
    if (editingId) {
      await updateCard(editingId, c);
      if (!matches(c)) sample = sample.filter((x) => x !== editingId);
      fixFilter();
      renderFilterButtons();
      toast("Updated");
      setEditing(null);
      show("list");
    } else {
      const id = await addCard(c);
      if (matches(c)) sample.push(id);
      addTags = { g: c.g || "", s: c.s || "" };
      toast("Saved");
      setEditing(null);
      $("add-k").focus();
    }
    haptic("ok");
  } catch (e) {
    $("add-err").textContent = "Could not save: " + e.message;
  } finally {
    $("add-save").disabled = false;
  }
};

// ---------- list (edit / delete) ----------

function renderList() {
  const box = $("list-items");
  box.replaceChildren();
  const ids = matchingIds();
  $("list-empty").textContent = cards.size ? "No cards match this filter." : "No cards yet.";
  $("list-empty").hidden = ids.length > 0;
  $("list-count").textContent = `${ids.length} / ${cards.size} cards`;
  for (const id of ids) {
    const c = cards.get(id);
    const row = document.createElement("div");
    row.className = "item";
    const t = document.createElement("div");
    t.className = "t";
    const k = document.createElement("div");
    k.className = "k";
    k.textContent = c.k;
    const v = document.createElement("div");
    v.className = "v";
    v.textContent = c.v;
    t.append(k, v);
    if (c.g) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const name of [c.g, c.s]) {
        if (!name) continue;
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = name;
        tags.append(tag);
      }
      t.append(tags);
    }
    const edit = document.createElement("button");
    edit.textContent = "✎";
    edit.onclick = () => {
      setEditing(id);
      show("add");
    };
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "🗑";
    del.onclick = () => confirmDelete(id);
    row.append(t, edit, del);
    box.append(row);
  }
}

function confirmDelete(id) {
  const run = async (ok) => {
    if (!ok) return;
    try {
      await deleteCard(id);
      sample = sample.filter((x) => x !== id);
      if (current === id) current = null;
      fixFilter();
      renderFilterButtons();
      renderList();
    } catch (e) {
      toast("Could not delete: " + e.message);
    }
  };
  if (tg && tg.showConfirm) tg.showConfirm("Delete this card?", run);
  else run(window.confirm("Delete this card?"));
}

// ---------- filter sheet ----------

function chip(label, count, on, onclick) {
  const b = document.createElement("button");
  b.className = "chip" + (on ? " on" : "");
  b.append(label);
  const small = document.createElement("small");
  small.textContent = count;
  b.append(small);
  b.onclick = onclick;
  return b;
}

function renderSheet() {
  const groups = tagStats();
  $("f-groups").replaceChildren(
    chip("All", cards.size, !filter.g, () => setFilter("", "")),
    ...[...groups].map(([g, e]) => chip(g, e.n, filter.g === g, () => setFilter(g, "")))
  );
  const e = groups.get(filter.g);
  $("f-sub-wrap").hidden = !e || !e.subs.size;
  if (e) {
    $("f-subjects").replaceChildren(
      chip(`All ${filter.g}`, e.n, !filter.s, () => setFilter(filter.g, "")),
      ...[...e.subs].map(([s, n]) => chip(s, n, filter.s === s, () => setFilter(filter.g, s)))
    );
  }
}

for (const b of document.querySelectorAll(".fbtn")) {
  b.onclick = () => {
    fixFilter();
    renderSheet();
    $("sheet").hidden = false;
  };
}
$("f-close").onclick = () => ($("sheet").hidden = true);
$("sheet").onclick = (e) => {
  if (e.target === $("sheet")) $("sheet").hidden = true;
};

// ---------- navigation / boot ----------

for (const b of document.querySelectorAll("nav button")) {
  b.onclick = () => {
    // fresh form (re-prefilled with default tags) unless a half-typed new card is waiting
    if (b.dataset.screen === "add" && (editingId || !($("add-k").value || $("add-v").value))) setEditing(null);
    show(b.dataset.screen);
  };
}

(async () => {
  try {
    await loadCards();
  } catch (e) {
    toast("Could not load cards: " + e.message);
  }
  resetSample();
  renderFilterButtons();
  next();
  show("review");
})();
