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

// ---------- cards: fc:index = ["c1", ...], fc:c<N> = {k, v}, fc:next = counter ----------

let cards = new Map(); // id -> {k, v}, insertion order = index order

function parseJSON(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

async function loadCards() {
  const ids = parseJSON(await store.getItem("fc:index"), []);
  cards = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const vals = await store.getItems(part.map((id) => "fc:" + id));
    for (const id of part) {
      const c = parseJSON(vals["fc:" + id], null);
      if (c && typeof c.k === "string") cards.set(id, c);
    }
  }
}

function saveIndex() {
  return store.setItem("fc:index", JSON.stringify([...cards.keys()]));
}

async function addCard(k, v) {
  const n = (parseInt(await store.getItem("fc:next"), 10) || 0) + 1;
  const id = "c" + n;
  await store.setItem("fc:" + id, JSON.stringify({ k, v }));
  await store.setItem("fc:next", String(n));
  cards.set(id, { k, v });
  await saveIndex();
  return id;
}

async function updateCard(id, k, v) {
  await store.setItem("fc:" + id, JSON.stringify({ k, v }));
  cards.set(id, { k, v });
}

async function deleteCard(id) {
  cards.delete(id);
  await saveIndex(); // index first: an orphaned card key is harmless, a dangling index entry is skipped on load
  await store.removeItem("fc:" + id);
}

// ---------- session state (memory only, full set on every open) ----------

let sample = [];
let current = null;
let last = null;

function resetSample() {
  sample = [...cards.keys()];
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
  if (screen === "add" && editingId === null) $("add-k").focus();
}

// ---------- review ----------

const card = $("card");

function renderReview() {
  $("counter").textContent = `${sample.length} / ${cards.size} remaining`;
  const has = current && cards.has(current);
  card.hidden = !has;
  $("actions").hidden = !has;
  $("empty").hidden = has;
  if (!has) {
    $("empty-msg").textContent = cards.size ? "All done 🎉" : "No cards yet. Add one!";
    $("restart").hidden = !cards.size;
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

function setEditing(id) {
  editingId = id;
  const c = id ? cards.get(id) : { k: "", v: "" };
  $("add-k").value = c.k;
  $("add-v").value = c.v;
  $("add-err").textContent = "";
  $("add-save").textContent = id ? "Update" : "Save";
}

$("add-save").onclick = async () => {
  const k = $("add-k").value.trim();
  const v = $("add-v").value.trim();
  if (!k || !v) {
    $("add-err").textContent = "Both key and value are required.";
    return;
  }
  if (JSON.stringify({ k, v }).length > MAX_VALUE_LEN) {
    $("add-err").textContent = "Too long: key + value must be under ~4000 characters.";
    return;
  }
  $("add-save").disabled = true;
  try {
    if (editingId) {
      await updateCard(editingId, k, v);
      toast("Updated");
      setEditing(null);
      show("list");
    } else {
      const id = await addCard(k, v);
      sample.push(id);
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
  $("list-empty").hidden = cards.size > 0;
  for (const [id, c] of cards) {
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
      renderList();
    } catch (e) {
      toast("Could not delete: " + e.message);
    }
  };
  if (tg && tg.showConfirm) tg.showConfirm("Delete this card?", run);
  else run(window.confirm("Delete this card?"));
}

// ---------- navigation / boot ----------

for (const b of document.querySelectorAll("nav button")) {
  b.onclick = () => {
    if (b.dataset.screen === "add" && editingId) setEditing(null);
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
  next();
  show("review");
})();
