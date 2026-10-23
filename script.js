/* Valorant tracker. Works when opened straight from the file (no server needed).
   data.json is optional: if it loads, it overrides the built-in agent, map and mode lists. */

const DEFAULTS = {
  modes: ["Competitive", "Premier", "Unrated", "Swiftplay", "Spike Rush"],
  maps: ["Abyss", "Ascent", "Bind", "Breeze", "Corrode", "Fracture", "Haven", "Icebox", "Lotus", "Pearl", "Split", "Sunset"],
  agents: [
    ["Controller", "Clove", "Astra", "Brimstone", "Harbor", "Omen", "Viper"],
    ["Duelist", "Iso", "Jett", "Neon", "Phoenix", "Raze", "Reyna", "Waylay", "Yoru"],
    ["Initiator", "Breach", "Fade", "Gekko", "KAY/O", "Skye", "Sova", "Tejo"],
    ["Sentinel", "Chamber", "Cypher", "Deadlock", "Killjoy", "Sage", "Vyse"],
  ].flatMap(([role, ...names]) => names.map((name) => ({ name, role }))),
};

const API = "https://api.henrikdev.xyz";
// Convenience default for this personal static build. Anyone who can access the source can read this key.
const DEFAULT_API_KEY = "HDEV-8bdeba6c-994a-4cf7-b95d-6f034389fa03";
const KEY_ACCOUNT = "vt:account";
const KEY_API = "vt:apikey";
const KEY_MATCHES = "vt:matches:";
const KEY_FAVORITES = "vt:favorites";
const RING = 2 * Math.PI * 70;

let config = DEFAULTS;
let account = null; // { name, tag, region }
let matches = [];

const $ = (id) => document.getElementById(id);
const lower = (s) => String(s || "").toLowerCase();
const sum = (list, key) => list.reduce((t, m) => t + m[key], 0);
const pct = (x) => Math.round(x * 100) + "%";
const today = () => new Date().toISOString().slice(0, 10);

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

const matchKey = () => KEY_MATCHES + lower(account.name) + "#" + lower(account.tag);

function saveMatches() {
  if (!store.set(matchKey(), JSON.stringify(matches))) {
    setStatus("Couldn't save in this browser. Use Export JSON to keep your data.", true);
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

async function init() {
  try {
    const res = await fetch("data.json");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.agents) && Array.isArray(data.maps) && Array.isArray(data.modes)) {
        config = { agents: data.agents, maps: data.maps, modes: data.modes };
      }
    }
  } catch (e) { /* opened from a file: use the built-in lists */ }

  bindEvents();

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
  $("welcome").hidden = true;
  $("app").hidden = false;
  $("who").replaceChildren(document.createTextNode(account.name), el("small", "", "#" + account.tag));
  setStatus("");
  updateFavoriteButton();
  renderFavorites();
  render();
  if (autoFetch) syncMatches();
}

function readAccount() {
  let name = $("riot-name").value.trim();
  let tag = $("riot-tag").value.trim().replace(/^#/, "");
  const i = name.lastIndexOf("#");
  if (i > 0 && !tag) { // someone pasted "name#tag" into the first box
    tag = name.slice(i + 1).trim();
    name = name.slice(0, i).trim();
  }
  if (!name || !/^[A-Za-z0-9]{3,5}$/.test(tag)) return null;
  return { name, tag, region: null };
}

function setStatus(message, isError = false) {
  const node = $("status");
  node.textContent = message;
  node.className = isError ? "error" : "";
}

/* ---------- Lookup (HenrikDev API) ---------- */

async function api(path) {
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

async function lookupRegion() {
  try {
    const json = await api(`/valorant/v2/account/${encodeURIComponent(account.name)}/${encodeURIComponent(account.tag)}`);
    return (json.data && json.data.region) || "eu";
  } catch (e) {
    if ([401, 403, 404, 429].includes(e.status)) throw e;
    return "eu";
  }
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
  return {
    id: String(meta.match_id ?? meta.id),
    date: Number.isFinite(startedMs) ? new Date(startedMs).toISOString().slice(0, 10) : (String(started || "").slice(0, 10) || today()),
    startedAt: Number.isFinite(startedMs) ? startedMs : null,
    mode: String(queue), map: String(map), agent: String(agent || "Unknown"),
    roundsWon: Number.isFinite(won) ? won : 0,
    roundsLost: Number.isFinite(lost) ? lost : 0,
    kills, deaths, assists,
    acs: played > 0 ? Math.round(score / played) : Math.round(score),
    result
  };
}


async function fetchRankStats() {
  const currentNode = $("rank-current");
  const peakNode = $("rank-peak");
  const rrNode = $("rank-rr");
  currentNode.textContent = "Loading…";
  peakNode.textContent = "Loading…";
  rrNode.textContent = "—";
  $("rank-current-season").textContent = "Competitive";
  $("rank-peak-season").textContent = "All-time peak reported by API";
  $("rank-rr-note").textContent = "Ranked rating";
  try {
    const path = `/valorant/v3/mmr/${encodeURIComponent(account.region)}/pc/${encodeURIComponent(account.name)}/${encodeURIComponent(account.tag)}`;
    const json = await api(path);
    const data = json?.data || {};
    const current = data.current || {};
    const peak = data.peak || {};
    const currentTier = current.tier?.name || current.tier?.name_short || "Unranked / unavailable";
    const peakTier = peak.tier?.name || peak.tier?.name_short || "Unavailable";
    currentNode.textContent = currentTier;
    peakNode.textContent = peakTier;
    $("rank-current-icon").replaceChildren(rankBadge(currentTier, 40));
    $("rank-peak-icon").replaceChildren(rankBadge(peakTier, 40));
    rrNode.textContent = Number.isFinite(Number(current.rr)) ? String(current.rr) : "—";
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
    console.warn("Could not fetch Valorant rank stats:", err);
  }
}

async function syncMatches() {
  const button = $("sync");
  button.disabled = true;
  button.classList.add("is-loading");
  button.innerHTML = '<span class="status-spinner" aria-hidden="true"></span> Fetching…';
  setStatus("Fetching recent matches from HenrikDev…");
  try {
    if (!account.region) {
      account.region = await lookupRegion();
      store.set(KEY_ACCOUNT, JSON.stringify(account));
    }
    // Rank is fetched independently so an MMR endpoint issue doesn't block match history.
    await fetchRankStats();
    const path = `/valorant/v4/matches/${encodeURIComponent(account.region)}/pc/${encodeURIComponent(account.name)}/${encodeURIComponent(account.tag)}?size=20`;
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
    saveMatches();
    render();
    setStatus(`Fetched ${parsed.length} match(es); added ${added} new. ${matches.length} total saved.`);
  } catch (e) {
    setStatus(e.message || "Fetch failed. Check your API key and Riot ID.", true);
  } finally {
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
  return getFavorites().some(f => lower(f.name) === lower(acc.name) && lower(f.tag) === lower(acc.tag));
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
  if (isFavorite()) favorites = favorites.filter(f => !(lower(f.name) === lower(account.name) && lower(f.tag) === lower(account.tag)));
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
      const button = el("button", "favorite-chip", `★ ${f.name}#${f.tag}`);
      button.type = "button";
      button.addEventListener("click", () => openAccount({ ...f }, true));
      welcomeList.append(button);
    });
  }
  const switchList = $("favorites-switch-list");
  if (switchList) {
    switchList.replaceChildren();
    favorites.forEach(f => {
      const button = el("button", "switch-favorite");
      button.type = "button";
      button.setAttribute("aria-current", String(!!account && lower(account.name) === lower(f.name) && lower(account.tag) === lower(f.tag)));
      button.append(el("span", "", `★  ${f.name}#${f.tag}`));
      if (account && lower(account.name) === lower(f.name) && lower(account.tag) === lower(f.tag)) button.append(el("small", "", "CURRENT"));
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

function bindEvents() {
  $("account-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const acc = readAccount();
    if (!acc) {
      $("welcome-error").textContent = "Enter your username and a tag of 3 to 5 letters or numbers, for example lev0nt and 101.";
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
    const name = $("switch-riot-name").value.trim();
    const tag = $("switch-riot-tag").value.trim().replace(/^#/, "");
    if (!name || !/^[A-Za-z0-9]{3,5}$/.test(tag)) {
      $("switch-error").textContent = "Enter a Riot ID and a tag of 3–5 letters or numbers.";
      return;
    }
    const next = { name, tag, region: null };
    const favorites = getFavorites();
    if (!favorites.some(f => lower(f.name) === lower(name) && lower(f.tag) === lower(tag))) {
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
  $("sync").addEventListener("click", syncMatches);
  $("mode-filter").addEventListener("change", () => { modeChosen = true; renderLog(); });

  $("export").addEventListener("click", () => {
    const data = { account: account.name + "#" + account.tag, matches };
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    link.href = url;
    link.download = "valorant-matches.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported ${matches.length} matches.`);
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

function groupBy(key) {
  const groups = {};
  matches.forEach((m) => (groups[m[key]] = groups[m[key]] || []).push(m));
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
  const s = summarize(matches);
  $("s-matches").textContent = s.n;
  $("s-record").textContent = `${s.wins} – ${s.losses}`;
  $("s-kd").textContent = s.kd.toFixed(2);
  $("s-acs").textContent = Math.round(s.acs);
  $("ring-pct").textContent = pct(s.winRate);
  $("ring").style.strokeDasharray = `${(RING * s.winRate).toFixed(1)} ${RING.toFixed(1)}`;
  $("ring").style.opacity = s.n ? 1 : 0;

  renderStrip();
  renderBreakdown("by-agent", "agent");
  renderBreakdown("by-map", "map");
  renderLog();
  renderCmpFavorites();
}

function renderStrip() {
  const strip = $("strip");
  strip.replaceChildren();
  byDate().slice(0, 20).reverse().forEach((m) => {
    const kd = m.deaths ? m.kills / m.deaths : m.kills;
    const tick = el("div", "tick " + m.result);
    tick.style.height = Math.round(20 + Math.min(kd, 2.5) * 25) + "px";
    tick.title = `${m.date}: ${m.result} on ${m.map} as ${m.agent} (${m.kills}/${m.deaths}/${m.assists})`;
    strip.append(tick);
  });
}

function renderBreakdown(id, key) {
  const box = $(id);
  box.replaceChildren();
  const rows = groupBy(key);
  if (!rows.length) {
    box.append(el("p", "empty", "No matches yet."));
    return;
  }
  rows.forEach((r) => {
    const row = el("div", "brow");
    const name = el("span", "", r.name);
    name.append(el("small", "", `${r.n} ${r.n === 1 ? "game" : "games"} · K/D ${r.kd.toFixed(2)}`));
    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = pct(r.winRate);
    bar.append(fill);
    row.append(name, bar, el("span", "bpct", pct(r.winRate)));
    box.append(row);
  });
}

function renderLog() {
  const body = $("log");
  body.replaceChildren();

  const filter = $("mode-filter");
  const modes = [...new Set(matches.map((m) => String(m.mode || "Unknown")))].sort((a, b) => a.localeCompare(b));
  const selectedMode = modeChosen ? (filter.value || "all") : (modes.includes("Competitive") ? "Competitive" : "all");
  const options = [
    { value: "all", label: "All game modes" },
    ...modes.map((mode) => ({ value: mode, label: mode }))
  ];
  filter.replaceChildren(...options.map(({ value, label }) => {
    const option = el("option", "", label);
    option.value = value;
    return option;
  }));
  filter.value = options.some((option) => option.value === selectedMode) ? selectedMode : "all";

  const visibleMatches = byDate().filter((m) => filter.value === "all" || String(m.mode || "Unknown") === filter.value);
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
    body.append(tr);
  });
}

let modeChosen = false;

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

async function regionFor(name, tag) {
  try {
    const json = await api(`/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
    return (json.data && json.data.region) || "eu";
  } catch (e) {
    if ([401, 403, 404, 429].includes(e.status)) throw e;
    return "eu";
  }
}

async function loadRank(name, tag, region) {
  const r = region || await regionFor(name, tag);
  const json = await api(`/valorant/v3/mmr/${encodeURIComponent(r)}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  const cur = (json && json.data && json.data.current) || {};
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

function ladderEl(me, them) {
  const box = el("div", "cmp-ladder");
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
  [[me, "me", "You", a], [them, "them", them.name, b]].forEach(([, cls, text, left]) => {
    const pin = el("div", "ladder-pin " + cls);
    pin.style.left = left + "%";
    pin.append(el("span", "", text));
    stage.append(pin);
  });
  const ends = el("div", "ladder-ends");
  ends.append(el("span", "", "Iron"), el("span", "", "Radiant"));
  box.append(stage, ends);
  return box;
}

function playerPanel(p, label, ahead) {
  const card = el("div", "cmp-player" + (ahead ? " ahead" : ""));
  const who = el("div", "who");
  const meta = el("div", "cmp-meta");
  meta.append(el("span", "", label));
  if (ahead) meta.append(el("span", "cmp-ahead", "Ahead"));
  who.append(
    meta,
    el("strong", "cmp-name", `${p.name}#${p.tag}`),
    el("span", "cmp-rank", p.score === null ? "Unranked" : p.tierName),
    el("span", "cmp-rr", p.score === null ? "No competitive rank" : `${p.rr} RR`)
  );
  card.append(rankBadge(p.score === null ? "" : p.tierName, 56), who);
  return card;
}

function renderCompare(me, them) {
  const box = $("cmp-result");
  const ranked = me.score !== null && them.score !== null;
  const gap = ranked ? them.score - me.score : 0;
  const size = Math.abs(gap);

  const gapBox = el("div", "cmp-gap");
  if (!ranked) gapBox.append(el("b", "", "—"), el("small", "", "No rank to compare"));
  else if (gap === 0) gapBox.append(el("b", "", "Even"), el("small", "", "Same rating"));
  else gapBox.append(el("b", "", `≈ ${size}`), el("small", "", `RR · ${gap > 0 ? "they are ahead" : "you are ahead"}`));

  const board = el("div", "cmp-board");
  board.append(playerPanel(me, "You", ranked && gap < 0), gapBox, playerPanel(them, "Them", ranked && gap > 0));
  box.replaceChildren(board);
  if (!ranked) return;
  box.append(ladderEl(me, them));
  if (gap === 0) return;

  const youTrail = gap > 0;
  const rows = [[0.55, "55% win rate"], [0.6, "60% win rate"], [0.65, "65% win rate"]];
  const mine = recentCompetitiveWinRate();
  if (youTrail && mine !== null) rows.unshift([mine, `Your recent win rate (${pct(mine)})`]);
  const games = rows.map(([rate]) => gamesFor(size, rate));
  const max = Math.max(1, ...games.filter((g) => g !== null));

  const card = el("div", "cmp-catchup");
  card.append(
    el("h3", "", youTrail ? "Your catch-up estimate" : "Their catch-up estimate"),
    el("p", "sub", `Rough number of games ${youTrail ? "you need" : "they need"} to close the gap`)
  );
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
  box.append(card);
}

let cmpActive = "";

function renderCmpFavorites() {
  const box = $("cmp-favorites");
  if (!box) return;
  box.replaceChildren();
  const others = account
    ? getFavorites().filter((f) => !(lower(f.name) === lower(account.name) && lower(f.tag) === lower(account.tag)))
    : [];
  if (!others.length) {
    box.append(el("p", "hint", "Favorite a player with ☆ and they appear here for one-tap comparison."));
    return;
  }
  box.append(el("p", "cmp-sub", "From your favorites"));
  const list = el("div", "cmp-chips");
  others.forEach((f) => {
    const chip = el("button", "cmp-chip", `${f.name}#${f.tag}`);
    chip.type = "button";
    chip.setAttribute("aria-pressed", cmpActive === lower(f.name) + "#" + lower(f.tag) ? "true" : "false");
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
  const loading = el("p", "cmp-loading");
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
  let name = $("cmp-name").value.trim();
  let tag = $("cmp-tag").value.trim().replace(/^#/, "");
  const i = name.lastIndexOf("#");
  if (i > 0 && !tag) { tag = name.slice(i + 1).trim(); name = name.slice(0, i).trim(); }
  if (!name || !/^[A-Za-z0-9]{3,5}$/.test(tag)) {
    $("cmp-error").textContent = "Enter the other player's username and a tag of 3 to 5 letters or numbers.";
    return;
  }
  runCompare(name, tag);
});

/* ---------- Match log length ---------- */

const LOG_LIMIT = 20;
let showAllMatches = false;
$("log-toggle").addEventListener("click", () => {
  showAllMatches = !showAllMatches;
  renderLog();
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
