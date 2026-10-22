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

/* ---------- Favorite Riot IDs (local-only until Supabase is configured) ---------- */
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
  $("mode-filter").addEventListener("change", renderLog);

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
    name.append(el("small", "", r.n + (r.n === 1 ? " game" : " games")));
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
  const selectedMode = filter.value || "all";
  const modes = [...new Set(matches.map((m) => String(m.mode || "Unknown")))].sort((a, b) => a.localeCompare(b));
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
  $("log-count").textContent = matches.length
    ? `Showing ${visibleMatches.length} of ${matches.length} saved match${matches.length === 1 ? "" : "es"}.`
    : "Your saved matches will appear here.";
  visibleMatches.forEach((m) => {
    const tr = el("tr");
    [m.date, m.mode, m.map, m.agent].forEach((v) => tr.append(el("td", "", v)));
    tr.append(
      el("td", "r-" + m.result, m.result[0].toUpperCase() + m.result.slice(1)),
      el("td", "", `${m.roundsWon} – ${m.roundsLost}`),
      el("td", "", `${m.kills} / ${m.deaths} / ${m.assists}`),
      el("td", "", m.acs)
    );
    body.append(tr);
  });
}

init();
