/* Valorant tracker. Works when opened straight from the file (no server needed). */

const API = "https://api.henrikdev.xyz";
// Convenience default for this personal static build. Anyone who can access the source can read this key.
const DEFAULT_API_KEY = "HDEV-8bdeba6c-994a-4cf7-b95d-6f034389fa03";
const KEY_ACCOUNT = "vt:account";
const KEY_API = "vt:apikey";
const KEY_MATCHES = "vt:matches:";
const KEY_FAVORITES = "vt:favorites";
const KEY_TAB = "vt:tab";
const KEY_THEME = "vt:theme";
const KEY_BACKUP = "vt:backup";
const KEY_SNOOZE = "vt:backup-snooze";
const KEY_BLOCK = "vt:blocked-until";

const MIN = 60e3;
const DAY = 864e5;
const FRESH_MS = 10 * MIN;    // automatic refreshes leave the API alone for this long
const COOLDOWN_MS = MIN;      // the Fetch latest button waits this long between calls
const KEEP_DETAILS = 150;     // if browser storage fills up, only the newest matches keep full player details
const RING = 2 * Math.PI * 70;

let account = null; // { name, tag, region }
let matches = [];

const $ = (id) => document.getElementById(id);
const lower = (s) => String(s || "").toLowerCase();
const sum = (list, key) => list.reduce((t, m) => t + m[key], 0);
const pct = (x) => Math.round(x * 100) + "%";
const today = () => new Date().toISOString().slice(0, 10);

const ID_ERROR = "Enter a username and a tag of 3 to 5 letters or numbers, for example lev0nt and 101.";
const sameId = (a, b) => lower(a.name) === lower(b.name) && lower(a.tag) === lower(b.tag);

function parseRiotId(nameText, tagText) {
  let name = String(nameText).trim();
  let tag = String(tagText).trim().replace(/^#/, "");
  const i = name.lastIndexOf("#");
  if (i > 0 && !tag) { // someone pasted "name#tag" into the first box
    tag = name.slice(i + 1).trim();
    name = name.slice(0, i).trim();
  }
  return name && /^[A-Za-z0-9]{3,5}$/.test(tag) ? { name, tag, region: null } : null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- Browser storage (guarded: it can be unavailable) ---------- */

const store = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
};

function ago(ms) {
  const minutes = Math.round(ms / MIN);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

// Runs loader() at most once per maxAge and keeps the result in the browser, so repeat visits don't call the API.
async function cached(key, maxAge, loader) {
  const slot = "vt:cache:" + key;
  try {
    const hit = JSON.parse(store.get(slot) || "null");
    if (hit && Date.now() - hit.t < maxAge) return hit.v;
  } catch (e) { /* ignore a damaged entry */ }
  const v = await loader();
  store.set(slot, JSON.stringify({ t: Date.now(), v }));
  return v;
}

const fetchedKey = () => "vt:fetched:" + lower(account.name) + "#" + lower(account.tag);
function fetchedTimes() {
  try { return JSON.parse(store.get(fetchedKey()) || "{}") || {}; } catch (e) { return {}; }
}
const lastFetched = (kind) => Number(fetchedTimes()[kind]) || 0;
const isFresh = (kind) => Date.now() - lastFetched(kind) < FRESH_MS;
const markFetched = (kind) => store.set(fetchedKey(), JSON.stringify({ ...fetchedTimes(), [kind]: Date.now() }));

const matchKey = () => KEY_MATCHES + lower(account.name) + "#" + lower(account.tag);

function saveMatches() {
  if (store.set(matchKey(), JSON.stringify(matches))) return;
  // Storage is full: keep every match, but drop the heavy player details from the oldest ones.
  const slim = sortMatches(matches).map((m, i) => {
    if (i < KEEP_DETAILS || !m.details) return m;
    const { details, ...rest } = m;
    return rest;
  });
  if (store.set(matchKey(), JSON.stringify(slim))) {
    matches = slim;
    setStatus("Browser storage is nearly full, so older matches were saved without player details. Export a backup soon.", true);
  } else {
    setStatus("Couldn't save in this browser. Use Export to keep your data.", true);
  }
}

function loadMatches() {
  try {
    const parsed = JSON.parse(store.get(matchKey()) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/* ---------- Start up ---------- */

function applyTheme() {
  const pref = store.get(KEY_THEME) || "auto";
  const dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#171916" : "#F2EFE8";
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeChoice === pref)));
}

function registerServiceWorker() {
  // Only works when served over http(s), not when opened straight from a file.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
}

function init() {
  applyTheme();
  registerServiceWorker();
  bindEvents();
  showTab(store.get(KEY_TAB) || "overview");

  let saved = null;
  try { saved = JSON.parse(store.get(KEY_ACCOUNT)); } catch (e) { /* none */ }
  if (saved && saved.name && saved.tag) openAccount(saved, true);
  else showWelcome();
}

function showWelcome() {
  $("app").hidden = true;
  $("welcome").hidden = false;
  renderFavorites();
  $("riot-name").focus();
}

function openAccount(acc, autoFetch) {
  account = acc;
  store.set(KEY_ACCOUNT, JSON.stringify(account));
  matches = loadMatches();
  rankNow = null;
  loadRr();
  $("welcome").hidden = true;
  $("app").hidden = false;
  $("who").replaceChildren(document.createTextNode(account.name), el("small", "", "#" + account.tag));
  setStatus("");
  updateFavoriteButton();
  renderFavorites();
  render();
  if (autoFetch) syncMatches(false);
}

function setStatus(message, isError = false) {
  const node = $("status");
  node.textContent = message;
  node.className = isError ? "error" : "";
}

/* ---------- Lookup (HenrikDev API) ---------- */

async function api(path) {
  const wait = (Number(store.get(KEY_BLOCK)) || 0) - Date.now();
  if (wait > 0) { // HenrikDev recently said "too many requests": don't ask again until the pause is over
    const err = new Error(`HenrikDev asked us to slow down. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    err.status = 429;
    throw err;
  }
  let key = (store.get(KEY_API) || DEFAULT_API_KEY || "").trim();
  if (!key) {
    key = (window.prompt("Enter your HenrikDev API key. It will be stored only in this browser. For a public site, use a server-side proxy instead.") || "").trim();
    if (!key) throw new Error("No API key entered. Fetch cancelled.");
    if (!store.set(KEY_API, key)) throw new Error("This browser could not save the API key. Enable local storage and try again.");
  }
  const url = API + path;
  let res;
  try {
    res = await fetch(url, { headers: { "Authorization": key, "Accept": "application/json" }, cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      const queryUrl = url + (path.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(key);
      const fallback = await fetch(queryUrl, { headers: { "Accept": "application/json" }, cache: "no-store" });
      if (fallback.ok || !res.ok) res = fallback;
    }
  } catch (e) {
    const err = new Error("Could not reach HenrikDev. Check your internet connection, browser console, and API status.");
    err.status = 0;
    throw err;
  }
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 429) store.set(KEY_BLOCK, String(Date.now() + Math.min(Number(res.headers.get("retry-after")) || 60, 300) * 1000));
    const apiMessage = json?.errors?.map(x => x.message).filter(Boolean).join("; ") || json?.message || json?.error;
    const messages = {
      400: "The API rejected the request. Check the Riot ID and region/platform.",
      401: "The API key was rejected. Check your HenrikDev dashboard and try a replacement key.",
      403: "Access denied. The key may be invalid, restricted, or not permitted for this endpoint.",
      404: "No player or match history was found. Check the Riot ID, tag, and region.",
      429: "HenrikDev rate limit reached. Wait about a minute, then try again.",
      500: "HenrikDev returned a server error. Check its status page and try again later.",
      502: "HenrikDev is temporarily unavailable. Try again later.",
      503: "HenrikDev is temporarily unavailable. Try again later."
    };
    const err = new Error((messages[res.status] || `HenrikDev request failed (HTTP ${res.status}).`) + (apiMessage ? ` Details: ${apiMessage}` : ""));
    err.status = res.status;
    throw err;
  }
  if (!json || typeof json !== "object") throw new Error("HenrikDev returned an unexpected response (not JSON).");
  if (Array.isArray(json.errors) && json.errors.length && !Array.isArray(json.data)) {
    throw new Error(json.errors.map(x => x.message).filter(Boolean).join("; ") || "HenrikDev returned an API error.");
  }
  return json;
}

async function lookupRegion(name = account.name, tag = account.tag) {
  try {
    return await cached(`region:${lower(name)}#${lower(tag)}`, 30 * DAY, async () => {
      const json = await api(`/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
      const region = json.data && json.data.region;
      if (!region) throw new Error("No region in the response");
      return region;
    });
  } catch (e) {
    if ([401, 403, 404, 429].includes(e.status)) throw e;
    return "eu"; // best guess when the lookup is unavailable; not saved
  }
}

function extractDetails(m, played, teamId) {
  const list = Array.isArray(m?.players) ? m.players : [];
  const idOf = (p) => String(p?.puuid || `${lower(p?.name)}#${lower(p?.tag)}`);
  const players = list.map((p) => {
    const s = p?.stats || {};
    const head = Number(s.headshots) || 0;
    const shots = head + (Number(s.bodyshots) || 0) + (Number(s.legshots) || 0);
    return {
      key: idOf(p),
      name: String(p?.name || "Unknown"), tag: String(p?.tag || ""),
      team: String(p?.team_id ?? p?.team ?? ""),
      agent: String(p?.agent?.name || "Unknown"),
      tier: String(p?.tier?.name || ""),
      kills: Number(s.kills) || 0, deaths: Number(s.deaths) || 0, assists: Number(s.assists) || 0,
      acs: played > 0 ? Math.round((Number(s.score) || 0) / played) : 0,
      adr: played > 0 ? Math.round((Number(s.damage?.dealt) || 0) / played) : 0,
      hs: shots ? Math.round((head / shots) * 100) : 0,
      fb: 0, fd: 0,
    };
  });
  if (!players.length) return null;

  const index = new Map(players.map((p, i) => [p.key, i]));
  const duelCount = new Map();
  const opening = new Map(); // round -> earliest kill of that round
  (Array.isArray(m?.kills) ? m.kills : []).forEach((k) => {
    const killer = index.get(idOf(k?.killer));
    const victim = index.get(idOf(k?.victim));
    if (killer === undefined || victim === undefined) return;
    const key = killer + ">" + victim;
    duelCount.set(key, (duelCount.get(key) || 0) + 1);
    const time = Number(k?.time_in_round_in_ms);
    if (Number.isFinite(k?.round) && Number.isFinite(time) && (!opening.has(k.round) || time < opening.get(k.round).time)) {
      opening.set(k.round, { time, killer, victim });
    }
  });
  opening.forEach(({ killer, victim }) => { players[killer].fb++; players[victim].fd++; });

  const teams = {};
  (Array.isArray(m?.teams) ? m.teams : []).forEach((t) => {
    const id = String(t?.team_id ?? t?.team ?? "");
    if (id) teams[id] = { won: Number(t?.rounds?.won) || 0, lost: Number(t?.rounds?.lost) || 0 };
  });
  const duels = [...duelCount].map(([key, n]) => [...key.split(">").map(Number), n]);
  return { myTeam: String(teamId ?? ""), teams, players, duels };
}

function parseMatch(m) {
  const meta = m?.metadata || m?.meta || {};
  const players = Array.isArray(m?.players) ? m.players : [];
  const me = players.find((p) => {
    const riotId = p?.name || p?.game_name || p?.riot_id_name || p?.riotIdName;
    const tag = p?.tag || p?.tag_line || p?.riot_id_tag || p?.riotIdTag;
    return lower(riotId) === lower(account.name) && lower(tag) === lower(account.tag);
  });
  if (!me || !(meta.match_id || meta.id)) return null;

  const teamId = me.team_id ?? me.team;
  const teams = Array.isArray(m?.teams) ? m.teams : [];
  const team = teams.find(t => lower(t?.team_id ?? t?.team) === lower(teamId));
  let won = Number(team?.rounds?.won ?? team?.rounds_won ?? team?.roundsWon);
  let lost = Number(team?.rounds?.lost ?? team?.rounds_lost ?? team?.roundsLost);
  if (!Number.isFinite(won) || !Number.isFinite(lost)) { won = NaN; lost = NaN; }

  // Some API response variants expose round outcomes as a list.
  if (!Number.isFinite(won) || !Number.isFinite(lost) || won + lost === 0) {
    const roundList = Array.isArray(m?.rounds) ? m.rounds : [];
    const scores = { blue: 0, red: 0 };
    roundList.forEach(r => {
      const winner = lower(r?.winning_team ?? r?.winningTeam ?? r?.winner);
      if (winner.includes("blue")) scores.blue++;
      if (winner.includes("red")) scores.red++;
    });
    const side = lower(teamId);
    if (side.includes("blue")) { won = scores.blue; lost = scores.red; }
    else if (side.includes("red")) { won = scores.red; lost = scores.blue; }
  }

  const stats = me?.stats || {};
  const kills = Number(stats.kills ?? me.kills ?? 0);
  const deaths = Number(stats.deaths ?? me.deaths ?? 0);
  const assists = Number(stats.assists ?? me.assists ?? 0);
  const score = Number(stats.score ?? me.score ?? 0);
  const played = (Number.isFinite(won) ? won : 0) + (Number.isFinite(lost) ? lost : 0);

  let result = "draw";
  if (team?.won === true || team?.has_won === true) result = "win";
  else if (team?.won === false || team?.has_won === false) result = "loss";
  else if (played > 0) result = won > lost ? "win" : won < lost ? "loss" : "draw";

  if (![kills, deaths, assists].every(Number.isFinite)) return null;
  const started = meta.started_at ?? meta.game_start ?? meta.startedAt ?? meta.game_start_patched;
  const startedMs = typeof started === "number" ? (started < 1e12 ? started * 1000 : started) : Date.parse(started || "");
  const agent = me?.agent?.name ?? me?.agent?.display_name ?? me?.character?.name ?? me?.agent_name;
  const map = meta?.map?.name ?? meta?.map_name ?? "Unknown";
  const queue = meta?.queue?.name ?? meta?.queue?.id ?? meta?.mode ?? "Unknown";
  const details = extractDetails(m, played, teamId);
  return {
    id: String(meta.match_id ?? meta.id),
    date: Number.isFinite(startedMs) ? new Date(startedMs).toISOString().slice(0, 10) : (String(started || "").slice(0, 10) || today()),
    startedAt: Number.isFinite(startedMs) ? startedMs : null,
    mode: String(queue), map: String(map), agent: String(agent || "Unknown"),
    roundsWon: Number.isFinite(won) ? won : 0,
    roundsLost: Number.isFinite(lost) ? lost : 0,
    kills, deaths, assists,
    acs: played > 0 ? Math.round(score / played) : Math.round(score),
    result,
    ...(details ? { details } : {})
  };
}


async function fetchMmr(name, tag, region, force = false) {
  return cached(`mmr:${lower(name)}#${lower(tag)}`, force ? 0 : FRESH_MS, async () => {
    const json = await api(`/valorant/v3/mmr/${encodeURIComponent(region)}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
    const data = (json && json.data) || {};
    return { current: data.current, peak: data.peak }; // only what the app uses, to keep the saved copy small
  });
}

async function fetchRankStats(force = false) {
  const currentNode = $("rank-current");
  const peakNode = $("rank-peak");
  const rrNode = $("rank-rr");
  $("rank-panel").classList.add("rank-loading");
  currentNode.textContent = "Loading…";
  peakNode.textContent = "Loading…";
  rrNode.textContent = "—";
  $("rank-current-season").textContent = "Competitive";
  $("rank-peak-season").textContent = "All-time peak reported by API";
  $("rank-rr-note").textContent = "Ranked rating";
  try {
    const data = await fetchMmr(account.name, account.tag, account.region, force);
    const current = data.current || {};
    const peak = data.peak || {};
    const currentTier = current.tier?.name || current.tier?.name_short || "Unranked / unavailable";
    const peakTier = peak.tier?.name || peak.tier?.name_short || "Unavailable";
    currentNode.textContent = currentTier;
    peakNode.textContent = peakTier;
    $("rank-current-icon").replaceChildren(rankBadge(currentTier, 40));
    $("rank-peak-icon").replaceChildren(rankBadge(peakTier, 40));
    rrNode.textContent = Number.isFinite(Number(current.rr)) ? String(current.rr) : "—";
    const idx = rankIndex(currentTier);
    rankNow = idx === null ? null : { name: currentTier, rr: Number(current.rr) || 0, score: idx * 100 + (Number(current.rr) || 0) };
    if (peak.season?.short || peak.season?.id) {
      $("rank-peak-season").textContent = `Peak season: ${peak.season.short || peak.season.id}`;
    }
    if (Number.isFinite(Number(current.last_change))) {
      const change = Number(current.last_change);
      $("rank-rr-note").textContent = `Last match: ${change > 0 ? "+" : ""}${change} RR`;
    }
  } catch (err) {
    currentNode.textContent = "Unavailable";
    $("rank-current-icon").replaceChildren();
    $("rank-peak-icon").replaceChildren();
    peakNode.textContent = "Unavailable";
    rrNode.textContent = "—";
    $("rank-current-season").textContent = "Could not load competitive rank";
    $("rank-peak-season").textContent = "Check API key or account availability";
    $("rank-rr-note").textContent = "Could not load RR";
    rankNow = null;
    console.warn("Could not fetch Valorant rank stats:", err);
  } finally {
    $("rank-panel").classList.remove("rank-loading");
    renderGoal();
  }
}

let syncing = false;

async function syncMatches(manual = true) {
  if (syncing) return;
  const age = Date.now() - lastFetched("matches");
  if (age < (manual ? COOLDOWN_MS : FRESH_MS)) {
    setStatus(`Up to date. Last fetched ${ago(age)}, ${matches.length} matches saved.${manual ? " You can fetch again in a minute." : ""}`);
    return;
  }
  syncing = true;
  const button = $("sync");
  button.disabled = true;
  button.classList.add("is-loading");
  button.innerHTML = '<span class="status-spinner" aria-hidden="true"></span> Fetching…';
  setStatus("Fetching recent matches from HenrikDev…");
  $("app").classList.toggle("loading", !matches.length);
  try {
    if (!account.region) {
      account.region = await lookupRegion();
      store.set(KEY_ACCOUNT, JSON.stringify(account));
    }
    // Rank is fetched independently so an MMR endpoint issue doesn't block match history.
    await fetchRankStats(manual);
    await fetchRrHistory(manual);
    const path = `/valorant/v4/matches/${encodeURIComponent(account.region)}/pc/${encodeURIComponent(account.name)}/${encodeURIComponent(account.tag)}?size=${age < 6 * 60 * MIN ? 10 : 20}`;
    const json = await api(path);
    const rows = Array.isArray(json.data) ? json.data : [];
    if (!rows.length) {
      setStatus("The API responded, but returned no matches for this Riot ID. Check the region and whether match history is available.", true);
      return;
    }
    const parsed = rows.map(parseMatch).filter(Boolean);
    if (!parsed.length) {
      const shape = Object.keys(rows[0] || {}).join(", ") || "empty object";
      throw new Error(`HenrikDev returned ${rows.length} match(es), but this app couldn't map the response fields (top-level fields: ${shape}). The API response schema may have changed.`);
    }
    const existing = new Map(matches.map(m => [String(m.id), m]));
    let added = 0;
    parsed.forEach(m => {
      if (!existing.has(String(m.id))) added++;
      existing.set(String(m.id), m);
    });
    matches = sortMatches([...existing.values()]);
    markFetched("matches");
    saveMatches();
    render();
    setStatus(`Fetched ${parsed.length} match(es); added ${added} new. ${matches.length} total saved.`);
  } catch (e) {
    setStatus(e.message || "Fetch failed. Check your API key and Riot ID.", true);
  } finally {
    syncing = false;
    $("app").classList.remove("loading");
    button.disabled = false;
    button.classList.remove("is-loading");
    button.innerHTML = '<span class="button-icon" aria-hidden="true">↻</span> Fetch latest';
  }
}

/* ---------- Favorite Riot IDs ---------- */
function getFavorites() {
  try {
    const list = JSON.parse(store.get(KEY_FAVORITES) || "[]");
    return Array.isArray(list) ? list.filter(x => x && x.name && x.tag) : [];
  } catch (_) { return []; }
}
function isFavorite(acc = account) {
  if (!acc) return false;
  return getFavorites().some(f => sameId(f, acc));
}
function updateFavoriteButton() {
  const button = $("favorite-current");
  if (!button || !account) return;
  const active = isFavorite();
  button.setAttribute("aria-pressed", String(active));
  button.innerHTML = `${active ? "★" : "☆"} <span>${active ? "Favorited" : "Add favorite"}</span>`;
}
function toggleCurrentFavorite() {
  if (!account) return;
  let favorites = getFavorites();
  if (isFavorite()) favorites = favorites.filter(f => !sameId(f, account));
  else favorites.push({ name: account.name, tag: account.tag, region: account.region || null });
  store.set(KEY_FAVORITES, JSON.stringify(favorites));
  updateFavoriteButton();
  renderFavorites();
  setStatus(isFavorite() ? "Added to favorites on this browser." : "Removed from favorites.");
}
function renderFavorites() {
  renderCmpFavorites();
  const favorites = getFavorites();
  const panel = $("favorites-panel");
  const welcomeList = $("favorites-list");
  if (panel && welcomeList) {
    welcomeList.replaceChildren();
    panel.hidden = favorites.length === 0;
    favorites.forEach(f => {
      const button = el("button", "chip", `★ ${f.name}#${f.tag}`);
      button.type = "button";
      button.addEventListener("click", () => openAccount({ ...f }, true));
      welcomeList.append(button);
    });
  }
  const switchList = $("favorites-switch-list");
  if (switchList) {
    switchList.replaceChildren();
    favorites.forEach(f => {
      const current = !!account && sameId(account, f);
      const button = el("button", "menu-item");
      button.type = "button";
      button.setAttribute("aria-current", String(current));
      button.append(el("span", "", `★ ${f.name}#${f.tag}`));
      if (current) button.append(el("small", "", "CURRENT"));
      button.addEventListener("click", () => {
        closeAccountMenu();
        openAccount({ ...f }, true);
      });
      switchList.append(button);
    });
  }
} 
function closeAccountMenu() {
  const menu = $("account-menu");
  const trigger = $("change");
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

/* ---------- Events ---------- */

/* ---------- Tabs ---------- */

const TABS = ["overview", "matches", "stats", "progress", "compare"];

let activeTab = null;

function showTab(name, focus = false) {
  if (!TABS.includes(name)) name = "overview";
  const dir = activeTab === null || activeTab === name ? "" : TABS.indexOf(name) > TABS.indexOf(activeTab) ? "from-right" : "from-left";
  activeTab = name;
  if (dir) window.scrollTo({ top: 0 });
  TABS.forEach((t) => {
    const on = t === name;
    const panel = $("tab-" + t);
    panel.hidden = !on;
    panel.classList.remove("from-left", "from-right");
    if (on && dir) panel.classList.add(dir);
    const button = $("tabbtn-" + t);
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
    if (on && focus) button.focus();
  });
  store.set(KEY_TAB, name);
}

function bindTabs() {
  const bar = document.querySelector(".tabs");
  bar.addEventListener("click", (e) => {
    const button = e.target.closest("[data-tab]");
    if (button) showTab(button.dataset.tab);
  });
  bar.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(document.activeElement.dataset.tab);
    const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    showTab(TABS[next], true);
  });

  // Swipe left or right anywhere on the page to move between tabs.
  // Ignored on sideways-scrolling areas, form fields, open menus or dialogs, and the welcome screen.
  let start = null;
  let last = null;
  const canSwipeFrom = (target) => {
    if (!target || target.closest("input, select, textarea, .menu")) return false;
    if ($("app").hidden || document.querySelector("dialog[open]")) return false;
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth + 1) return false;
    }
    return true;
  };
  const finishSwipe = (x, y) => {
    if (!start) return;
    const dx = x - start.x;
    const dy = y - start.y;
    start = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // too short or mostly vertical
    const next = TABS.indexOf(activeTab) + (dx < 0 ? 1 : -1);
    if (next >= 0 && next < TABS.length) showTab(TABS[next]);
  };
  document.addEventListener("touchstart", (e) => {
    start = e.touches.length === 1 && canSwipeFrom(e.target) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    last = start;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (start && e.touches.length === 1) last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  document.addEventListener("touchend", (e) => finishSwipe(e.changedTouches[0].clientX, e.changedTouches[0].clientY), { passive: true });
  document.addEventListener("touchcancel", () => { if (last) finishSwipe(last.x, last.y); start = null; }, { passive: true });
}

function bindEvents() {
  bindTabs();
  bindMatchDetail();
  bindInsights();
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => {
    store.set(KEY_THEME, b.dataset.themeChoice);
    applyTheme();
  }));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  $("account-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const acc = parseRiotId($("riot-name").value, $("riot-tag").value);
    if (!acc) {
      $("welcome-error").textContent = ID_ERROR;
      return;
    }
    $("welcome-error").textContent = "";
    openAccount(acc, true);
  });

  $("change").addEventListener("click", () => {
    const menu = $("account-menu");
    const trigger = $("change");
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) renderFavorites();
  });
  $("switch-account-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = parseRiotId($("switch-riot-name").value, $("switch-riot-tag").value);
    if (!next) {
      $("switch-error").textContent = ID_ERROR;
      return;
    }
    const favorites = getFavorites();
    if (!favorites.some(f => sameId(f, next))) {
      favorites.push(next);
      store.set(KEY_FAVORITES, JSON.stringify(favorites));
    }
    $("switch-error").textContent = "";
    $("switch-riot-name").value = "";
    $("switch-riot-tag").value = "";
    closeAccountMenu();
    openAccount(next, true);
  });

  $("favorite-current").addEventListener("click", toggleCurrentFavorite);
  $("sync").addEventListener("click", () => syncMatches(true));
  $("mode-filter").addEventListener("change", () => { modeChosen = true; render(); });

  $("export").addEventListener("click", exportData);
  $("backup-now").addEventListener("click", exportData);
  $("backup-later").addEventListener("click", () => {
    store.set(KEY_SNOOZE, String(Date.now() + 7 * DAY));
    renderBackupNote();
  });
  // Coming back to the app after a while refreshes it, but never more often than FRESH_MS.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && account && !$("app").hidden) syncMatches(false);
  });

  $("import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.matches;
      if (!Array.isArray(incoming)) throw new Error("No matches");
      const ids = new Set(matches.map((m) => m.id));
      let added = 0;
      incoming.forEach((m) => {
        if (isValidMatch(m) && !ids.has(m.id)) { matches.push(m); ids.add(m.id); added++; }
      });
      if (Array.isArray(data.rr) && lower(data.account) === lower(account.name + "#" + account.tag)) {
        mergeRr(data.rr.filter((h) => h && typeof h.id === "string" && Number.isFinite(h.time)));
      }
      matches = sortMatches(matches);
      saveMatches();
      render();
      setStatus(`Imported ${added} new matches.`);
    } catch (err) {
      setStatus("That file isn't a valid match export.", true);
    }
    e.target.value = "";
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAccountMenu(); });
  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".account-switcher");
    if (wrap && !wrap.contains(e.target)) closeAccountMenu();
  });
 }

function exportData() {
  const data = { account: account.name + "#" + account.tag, exportedAt: new Date().toISOString(), matches, rr: rrHistory };
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  link.href = url;
  link.download = `valorant-${lower(account.name)}-${today()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  store.set(KEY_BACKUP, String(Date.now()));
  renderBackupNote();
  setStatus(`Exported ${matches.length} matches.`);
}

function renderBackupNote() {
  const last = Number(store.get(KEY_BACKUP)) || 0;
  $("backup-info").textContent = last ? `Last backup: ${ago(Date.now() - last)}` : "No backup yet.";
  const due = matches.length >= 10 && Date.now() - last > 14 * DAY && Date.now() > (Number(store.get(KEY_SNOOZE)) || 0);
  $("backup-note").hidden = !due;
}

function isValidMatch(m) {
  return m && typeof m.id === "string" && typeof m.map === "string" && typeof m.agent === "string" &&
    ["win", "loss", "draw"].includes(m.result) &&
    ["kills", "deaths", "assists", "acs", "roundsWon", "roundsLost"].every((k) => Number.isFinite(m[k]));
}

/* ---------- Stats ---------- */

function summarize(list) {
  const n = list.length;
  const wins = list.filter((m) => m.result === "win").length;
  const losses = list.filter((m) => m.result === "loss").length;
  const kills = sum(list, "kills");
  const deaths = sum(list, "deaths");
  return { n, wins, losses, winRate: n ? wins / n : 0, kd: deaths ? kills / deaths : kills, acs: n ? sum(list, "acs") / n : 0 };
}

function groupBy(key, list) {
  const groups = {};
  list.forEach((m) => (groups[m[key]] = groups[m[key]] || []).push(m));
  return Object.entries(groups)
    .map(([name, list]) => ({ name, ...summarize(list) }))
    .sort((a, b) => b.n - a.n || b.winRate - a.winRate);
}

function matchTime(m) {
  if (Number.isFinite(Number(m.startedAt)) && Number(m.startedAt) > 0) return Number(m.startedAt);
  const parsed = Date.parse(String(m.date || "") + "T12:00:00");
  return Number.isFinite(parsed) ? parsed : 0;
}
function sortMatches(list) {
  return [...list].sort((a, b) => matchTime(b) - matchTime(a) || String(b.id).localeCompare(String(a.id)));
}
const byDate = () => sortMatches(matches);

/* ---------- Rendering ---------- */

function render() {
  renderModeFilter();
  const view = scope();
  const s = summarize(view);
  $("s-matches").textContent = s.n;
  $("s-record").textContent = `${s.wins} – ${s.losses}`;
  $("s-kd").textContent = s.kd.toFixed(2);
  $("s-acs").textContent = Math.round(s.acs);
  $("ring-pct").textContent = pct(s.winRate);
  $("ring").style.strokeDasharray = `${(RING * s.winRate).toFixed(1)} ${RING.toFixed(1)}`;
  $("ring").style.opacity = s.n ? 1 : 0;

  renderStrip(view);
  renderBreakdown("by-agent", "agent", view);
  renderBreakdown("by-map", "map", view);
  renderLog(view);
  renderInsights(view);
  renderBackupNote();
  renderCmpFavorites();
}

function renderStrip(list) {
  const strip = $("strip");
  strip.replaceChildren();
  list.slice(0, 20).reverse().forEach((m) => {
    const kd = m.deaths ? m.kills / m.deaths : m.kills;
    const tick = el("div", "tick " + m.result);
    tick.style.height = Math.round(20 + Math.min(kd, 2.5) * 25) + "px";
    tick.title = `${m.date}: ${m.result} on ${m.map} as ${m.agent} (${m.kills}/${m.deaths}/${m.assists})`;
    strip.append(tick);
  });
}

function breakdownRow(name, sub, rate) {
  const row = el("div", "brow");
  const label = el("span", "", name);
  label.append(el("small", "", sub));
  const bar = el("div", "bar");
  const fill = el("div", "fill");
  fill.style.width = pct(rate);
  bar.append(fill);
  row.append(label, bar, el("span", "bpct", pct(rate)));
  return row;
}

function renderBreakdown(id, key, list) {
  const box = $(id);
  box.replaceChildren();
  const rows = groupBy(key, list);
  if (!rows.length) {
    box.append(el("p", "empty", "No matches yet."));
    return;
  }
  rows.forEach((r) => box.append(breakdownRow(r.name, `${r.n} ${r.n === 1 ? "game" : "games"} · K/D ${r.kd.toFixed(2)}`, r.winRate)));
}

function renderModeFilter() {
  const filter = $("mode-filter");
  const modes = [...new Set(matches.map((m) => String(m.mode || "Unknown")))].sort((a, b) => a.localeCompare(b));
  const selectedMode = modeChosen ? (filter.value || "all") : (modes.includes("Competitive") ? "Competitive" : "all");
  const options = [{ value: "all", label: "All game modes" }, ...modes.map((mode) => ({ value: mode, label: mode }))];
  filter.replaceChildren(...options.map(({ value, label }) => {
    const option = el("option", "", label);
    option.value = value;
    return option;
  }));
  filter.value = options.some((option) => option.value === selectedMode) ? selectedMode : "all";
}

// Matches in the selected game mode, newest first. Every tab reads from this.
function scope() {
  const mode = $("mode-filter").value;
  return byDate().filter((m) => mode === "all" || String(m.mode || "Unknown") === mode);
}

function renderLog(visibleMatches) {
  const body = $("log");
  body.replaceChildren();
  $("log-empty").hidden = visibleMatches.length > 0;
  $("log-empty").textContent = matches.length ? "No matches for this game mode." : "No matches yet. Fetch your latest to load match history.";
  const shown = showAllMatches ? visibleMatches : visibleMatches.slice(0, LOG_LIMIT);
  const toggle = $("log-toggle");
  toggle.hidden = visibleMatches.length <= LOG_LIMIT;
  toggle.textContent = showAllMatches ? `Show last ${LOG_LIMIT}` : "Show all";
  $("log-count").textContent = matches.length
    ? `Showing ${showAllMatches || visibleMatches.length <= LOG_LIMIT ? "all " + visibleMatches.length : "the last " + shown.length + " of " + visibleMatches.length} (${matches.length} saved in total).`
    : "Your saved matches will appear here.";
  shown.forEach((m) => {
    const tr = el("tr");
    const kd = m.deaths ? m.kills / m.deaths : m.kills;
    [
      ["Date", m.date], ["Mode", m.mode], ["Map", m.map], ["Agent", m.agent],
      ["Result", m.result[0].toUpperCase() + m.result.slice(1), "r-" + m.result],
      ["Score", `${m.roundsWon} – ${m.roundsLost}`],
      ["K / D / A", `${m.kills} / ${m.deaths} / ${m.assists}`],
      ["K/D", kd.toFixed(2)], ["ACS", m.acs],
    ].forEach(([label, value, cls]) => {
      const td = el("td", cls || "", String(value ?? ""));
      td.dataset.label = label;
      tr.append(td);
    });
    tr.dataset.match = m.id;
    const action = el("td", "row-action");
    const open = el("button", "quiet small", "Details");
    open.type = "button";
    open.dataset.match = m.id;
    open.setAttribute("aria-label", `Open details for the ${m.map} match on ${m.date}`);
    action.append(open);
    tr.append(action);
    body.append(tr);
  });
}

let modeChosen = false;
let rankNow = null; // { name, rr, score } for the tracked account, set by fetchRankStats

/* ---------- Rank badges ---------- */

const RANK_TIERS = ["iron", "bronze", "silver", "gold", "platinum", "diamond", "ascendant", "immortal"];
const RANK_COLORS = { iron: "#6B6E70", bronze: "#9C6B3C", silver: "#A9B1B6", gold: "#D4A62F", platinum: "#3F9DAE", diamond: "#A07BD6", ascendant: "#3E9F6E", immortal: "#C5465F", radiant: "#E4C95A" };
const CHEVRON_Y = { 1: [32], 2: [27, 37], 3: [23, 32, 41] };
const STAR = "24,18 26.9,26 35.4,26.3 28.8,31.5 31.1,39.7 24,35 16.9,39.7 19.2,31.5 12.6,26.3 21.1,26";

function parseRank(name) {
  const m = String(name || "").trim().toLowerCase().match(/^(iron|bronze|silver|gold|platinum|diamond|ascendant|immortal|radiant)\s*(\d)?/);
  return m ? { tier: m[1], division: m[2] ? Number(m[2]) : 0 } : null;
}

function rankIndex(name) { // Iron 1 = 0 ... Immortal 3 = 23, Radiant = 24
  const r = parseRank(name);
  if (!r) return null;
  if (r.tier === "radiant") return 24;
  return RANK_TIERS.indexOf(r.tier) * 3 + Math.max(1, r.division) - 1;
}

function rankBadge(name, width = 44) {
  const r = parseRank(name);
  const color = r ? RANK_COLORS[r.tier] : "#B9B7AD";
  let inner;
  if (!r) inner = '<text x="24" y="37" text-anchor="middle" font-size="22" fill="#FBFAF6">?</text>';
  else if (r.tier === "radiant") inner = `<polygon points="${STAR}" fill="#FBFAF6"/>`;
  else inner = (CHEVRON_Y[r.division] || CHEVRON_Y[1]).map((y) =>
    `<path d="M15 ${y} L24 ${y - 8} L33 ${y}" fill="none" stroke="#FBFAF6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
  const span = el("span", "rank-badge");
  span.innerHTML = `<svg viewBox="0 0 48 56" width="${width}" height="${Math.round(width * 56 / 48)}" role="img"><path d="M24 2 L44 10 V28 C44 40 35 49 24 54 C13 49 4 40 4 28 V10 Z" fill="${color}"/>${inner}</svg>`;
  span.firstChild.setAttribute("aria-label", name || "Unranked");
  return span;
}

/* ---------- Compare ranks (rough estimates) ---------- */

const RR_PER_GAME = 20; // rough size of a win or loss in RR

async function loadRank(name, tag, region) {
  const data = await fetchMmr(name, tag, region || await lookupRegion(name, tag));
  const cur = data.current || {};
  const tierName = (cur.tier && cur.tier.name) || "Unranked";
  const idx = rankIndex(tierName);
  const rr = Number(cur.rr) || 0;
  return { name, tag, tierName, rr, score: idx === null ? null : idx * 100 + rr };
}

function recentCompetitiveWinRate() {
  const list = byDate().filter((m) => lower(m.mode) === "competitive").slice(0, 20);
  return list.length >= 5 ? summarize(list).winRate : null;
}

function gamesFor(gap, winRate) {
  const net = RR_PER_GAME * (2 * winRate - 1);
  if (net <= 0) return null;
  return Math.max(0, Math.round(gap / net / 5) * 5);
}

function gamesText(gap, winRate) {
  const g = gamesFor(gap, winRate);
  return g === null ? "Not reachable" : g < 5 ? "Under 5 games" : `About ${g} games`;
}

// Rows of [win rate, label] used by the compare tab and the rank goal.
function rateRows(withMine) {
  const rows = [[0.55, "55% win rate"], [0.6, "60% win rate"], [0.65, "65% win rate"]];
  const mine = recentCompetitiveWinRate();
  if (withMine && mine !== null) rows.unshift([mine, `Your recent win rate (${pct(mine)})`]);
  return rows;
}

function catchupEl(title, sub, size, rows) {
  const games = rows.map(([rate]) => gamesFor(size, rate));
  const max = Math.max(1, ...games.filter((g) => g !== null));
  const card = el("div", "cmp-catchup card");
  card.append(el("h3", "", title), el("p", "sub", sub));
  rows.forEach(([rate, label], i) => {
    const g = games[i];
    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = g === null ? "0%" : Math.max(4, (g / max) * 100) + "%";
    bar.append(fill);
    const row = el("div", "cmp-row");
    row.append(el("span", "", label), bar, el("span", "est" + (g === null ? " no" : ""), gamesText(size, rate)));
    card.append(row);
  });
  card.append(el("p", "cmp-note", `Assumes about ±${RR_PER_GAME} RR per game. Immortal and Radiant are approximated, and real gains vary with performance.`));
  return card;
}

function ladderEl(me, them) {
  const box = el("div", "cmp-ladder card");
  const stage = el("div", "ladder-stage");
  const track = el("div", "ladder-track");
  [...RANK_TIERS, "radiant"].forEach((t) => {
    const seg = el("span", "ladder-seg");
    seg.style.flexGrow = t === "radiant" ? 1 : 3;
    seg.style.background = RANK_COLORS[t];
    seg.title = t[0].toUpperCase() + t.slice(1);
    track.append(seg);
  });
  stage.append(track);
  const pos = (p) => Math.min(Math.max(p.score / 2500, 0), 1) * 100;
  const a = pos(me);
  const b = pos(them);
  if (Math.abs(a - b) > 0.3) {
    const span = el("div", "ladder-span");
    span.style.left = Math.min(a, b) + "%";
    span.style.width = Math.abs(a - b) + "%";
    stage.append(span);
  }
  // Markers sit above (you) and below (them) the track, so they never cover each other or any text.
  [["me", a], ["them", b]].forEach(([cls, left]) => {
    const mark = el("span", "ladder-mark " + cls);
    mark.style.left = left + "%";
    stage.append(mark);
  });
  const ends = el("div", "ladder-ends");
  ends.append(el("span", "", "Iron"), el("span", "", "Radiant"));
  const legend = el("div", "ladder-legend");
  [["me", me, "You"], ["them", them, them.name]].forEach(([cls, p, name]) => {
    const key = el("span", "ladder-key " + cls);
    key.append(el("i", "ladder-dot"), document.createTextNode(`${name} · ${p.tierName}, ${p.rr} RR`));
    legend.append(key);
  });
  box.append(stage, ends, legend);
  return box;
}

function playerPanel(p, label, ahead) {
  const card = el("div", "cmp-player card" + (ahead ? " ahead" : ""));
  card.append(
    rankBadge(p.score === null ? "" : p.tierName, 64),
    el("span", "cmp-label", ahead ? `${label} · ahead` : label),
    el("strong", "cmp-name", `${p.name}#${p.tag}`),
    el("span", "cmp-rank", p.score === null ? "Unranked" : p.tierName),
    el("span", "cmp-rr", p.score === null ? "No competitive rank" : `${p.rr} RR`)
  );
  return card;
}

function renderCompare(me, them) {
  const box = $("cmp-result");
  const ranked = me.score !== null && them.score !== null;
  const gap = ranked ? them.score - me.score : 0;
  const size = Math.abs(gap);

  const board = el("div", "cmp-board");
  board.append(playerPanel(me, "You", ranked && gap < 0), playerPanel(them, "Them", ranked && gap > 0));
  box.replaceChildren(board);
  if (!ranked) {
    box.append(el("p", "hint", "One of you has no competitive rank right now, so there is nothing to compare."));
    return;
  }

  const summary = el("div", "cmp-summary card");
  if (gap === 0) summary.append(el("b", "", "Even"), el("span", "", "You are at the same rating."));
  else summary.append(el("b", "", `≈ ${size} RR`), el("span", "", gap > 0 ? "They are ahead of you." : "You are ahead of them."));
  box.append(summary, ladderEl(me, them));
  if (gap === 0) return;

  const youTrail = gap > 0;
  box.append(catchupEl(
    youTrail ? "Your catch-up estimate" : "Their catch-up estimate",
    `Rough number of games ${youTrail ? "you need" : "they need"} to close the gap`,
    size,
    rateRows(youTrail)
  ));
}

let cmpActive = "";

function renderCmpFavorites() {
  const box = $("cmp-favorites");
  box.replaceChildren();
  const others = account ? getFavorites().filter((f) => !sameId(f, account)) : [];
  if (!others.length) {
    box.append(el("p", "hint", "Favorite a player with ☆ and they appear here for one-tap comparison."));
    return;
  }
  box.append(el("p", "sub", "From your favorites"));
  const list = el("div", "chips");
  others.forEach((f) => {
    const chip = el("button", "chip", `${f.name}#${f.tag}`);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(cmpActive === lower(f.name) + "#" + lower(f.tag)));
    chip.addEventListener("click", () => runCompare(f.name, f.tag, f.region));
    list.append(chip);
  });
  box.append(list);
}

async function runCompare(name, tag, region) {
  if (!account) return;
  cmpActive = lower(name) + "#" + lower(tag);
  renderCmpFavorites();
  $("cmp-error").textContent = "";
  const go = $("cmp-go");
  go.disabled = true;
  const loading = el("p", "hint");
  loading.append(el("span", "status-spinner"), document.createTextNode("Comparing…"));
  $("cmp-result").replaceChildren(loading);
  try {
    const [me, them] = await Promise.all([loadRank(account.name, account.tag, account.region), loadRank(name, tag, region)]);
    renderCompare(me, them);
  } catch (err) {
    $("cmp-result").replaceChildren();
    $("cmp-error").textContent = err.message || "Couldn't compare. Try again in a moment.";
  }
  go.disabled = false;
}

$("cmp-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const other = parseRiotId($("cmp-name").value, $("cmp-tag").value);
  if (!other) {
    $("cmp-error").textContent = ID_ERROR;
    return;
  }
  runCompare(other.name, other.tag);
});

/* ---------- Match details ---------- */

let detailMatch = null;
let detailPick = 0;
const kdOf = (p) => (p.deaths ? p.kills / p.deaths : p.kills);
const isMine = (p) => !!account && lower(p.name) === lower(account.name) && lower(p.tag) === lower(account.tag);

function openMatch(id) {
  const m = matches.find((x) => String(x.id) === String(id));
  if (!m) return;
  detailMatch = m;
  detailPick = m.details ? Math.max(0, m.details.players.findIndex(isMine)) : 0;
  renderMatchDetail();
  const dialog = $("match-detail");
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

function highlightsEl(d) {
  const box = el("div", "md-chips");
  const best = (key) => d.players.reduce((a, b) => (b[key] > a[key] ? b : a));
  const top = best("acs");
  box.append(el("span", "md-chip", `Top score: ${top.name} (ACS ${top.acs})`));
  const dmg = best("adr");
  box.append(el("span", "md-chip", `Most damage per round: ${dmg.name} (${dmg.adr})`));
  const fb = best("fb");
  if (fb.fb >= 2) box.append(el("span", "md-chip", `Most first bloods: ${fb.name} (${fb.fb})`));
  return box;
}

function playerRow(p, i) {
  const row = el("button", "pl-row");
  row.type = "button";
  row.setAttribute("aria-pressed", String(i === detailPick));
  const who = el("span", "pl-name");
  if (p.tier && parseRank(p.tier)) who.append(rankBadge(p.tier, 22));
  const text = el("span", "pl-text");
  text.append(el("strong", "", `${p.name}#${p.tag}${isMine(p) ? " · you" : ""}`), el("small", "", p.agent + (p.tier ? ` · ${p.tier}` : "")));
  who.append(text);
  const kd = kdOf(p);
  const cells = [
    ["K / D / A", `${p.kills} / ${p.deaths} / ${p.assists}`],
    ["K/D", kd.toFixed(2), kd >= 1 ? "r-win" : "r-loss"],
    ["ACS", p.acs], ["ADR", p.adr], ["HS%", p.hs + "%"], ["FB / FD", `${p.fb} / ${p.fd}`],
  ];
  row.append(who, ...cells.map(([label, value, cls]) => {
    const cell = el("span", cls || "", String(value));
    cell.dataset.label = label;
    return cell;
  }));
  row.addEventListener("click", () => { detailPick = i; renderMatchDetail(); });
  return row;
}

function teamEl(d, id, label) {
  const box = el("section", "team");
  const head = el("div", "team-head");
  head.append(el("span", "", label));
  const t = d.teams[id];
  if (t) {
    const outcome = t.won > t.lost ? "Won" : t.won < t.lost ? "Lost" : "Draw";
    head.append(el("span", "res " + (t.won > t.lost ? "r-win" : t.won < t.lost ? "r-loss" : "r-draw"), `${outcome} ${t.won} – ${t.lost}`));
  }
  const labels = el("div", "pl-head");
  ["Player", "K / D / A", "K/D", "ACS", "ADR", "HS%", "FB / FD"].forEach((l) => labels.append(el("span", "", l)));
  box.append(head, labels);
  d.players
    .map((p, i) => [p, i])
    .filter(([p]) => p.team === id)
    .sort((a, b) => b[0].acs - a[0].acs)
    .forEach(([p, i]) => box.append(playerRow(p, i)));
  return box;
}

function duelsEl(d) {
  const sel = d.players[detailPick];
  const box = el("section", "duels");
  box.append(el("h3", "", `Duels: ${sel.name}`), el("p", "hint", "Kills against each opponent, and how often they killed back. Select any player above to see theirs."));
  if (!d.duels.length) {
    box.append(el("p", "empty", "The API didn't return kill details for this match."));
    return box;
  }
  const count = (a, b) => (d.duels.find(([x, y]) => x === a && y === b) || [0, 0, 0])[2];
  d.players
    .map((p, i) => ({ p, k: count(detailPick, i), back: count(i, detailPick) }))
    .filter(({ p }) => p.team !== sel.team)
    .sort((a, b) => (b.k - b.back) - (a.k - a.back) || b.k - a.k)
    .forEach(({ p, k, back }) => {
      const net = k - back;
      const name = el("span", "");
      name.append(document.createTextNode(p.name), el("small", "", p.agent));
      const bar = el("div", "bar" + (k + back ? "" : " idle"));
      const fill = el("div", "fill");
      fill.style.width = k + back ? (k / (k + back)) * 100 + "%" : "0%";
      bar.append(fill);
      const score = el("span", "duel-score");
      score.append(document.createTextNode(`${k} – ${back} `), el("span", net > 0 ? "r-win" : net < 0 ? "r-loss" : "r-draw", net > 0 ? `+${net}` : String(net)));
      const row = el("div", "duel-row");
      row.append(name, bar, score);
      box.append(row);
    });
  return box;
}

function renderMatchDetail() {
  const m = detailMatch;
  const dialog = $("match-detail");
  const scroll = dialog.scrollTop;
  $("md-title").textContent = `${m.map} · ${m.mode}`;
  $("md-sub").textContent = `${m.date} · ${m.result[0].toUpperCase() + m.result.slice(1)} ${m.roundsWon} – ${m.roundsLost}`;
  const body = $("md-body");
  const d = m.details;
  if (!d) {
    const fetchAgain = el("button", "", "Fetch latest");
    fetchAgain.type = "button";
    fetchAgain.addEventListener("click", () => { dialog.close(); syncMatches(); });
    body.replaceChildren(
      el("p", "", "Player details aren't saved for this match yet. Press Fetch latest to load them. The API only returns your most recent matches, so older ones can't be filled in."),
      fetchAgain
    );
    return;
  }
  const mine = d.players.find(isMine);
  const myTeam = d.myTeam || (mine && mine.team) || d.players[0].team;
  const otherTeams = [...new Set(d.players.map((p) => p.team))].filter((t) => t !== myTeam);
  body.replaceChildren(
    highlightsEl(d),
    teamEl(d, myTeam, "Your team"),
    ...otherTeams.map((t) => teamEl(d, t, "Opponents")),
    duelsEl(d)
  );
  dialog.scrollTop = scroll;
}

function bindMatchDetail() {
  $("log").addEventListener("click", (e) => {
    const target = e.target.closest("[data-match]");
    if (target) openMatch(target.dataset.match);
  });
  const dialog = $("match-detail");
  $("md-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // click on the dimmed backdrop
}

/* ---------- Match log length ---------- */

const LOG_LIMIT = 20;
let showAllMatches = false;
$("log-toggle").addEventListener("click", () => {
  showAllMatches = !showAllMatches;
  render();
});

/* ---------- "Saved on this device" notice ---------- */

function setupStorageNotice() {
  const dialog = $("storage-notice");
  if (!dialog || typeof dialog.showModal !== "function") return;
  $("storage-link").addEventListener("click", () => dialog.showModal());
  if (store.get("vt:notice-seen")) return;
  dialog.showModal();
  dialog.addEventListener("close", () => store.set("vt:notice-seen", "1"), { once: true });
}

setupStorageNotice();
init();
