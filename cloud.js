/* Optional cloud layer: Google sign-in (or guest mode) and sync through Supabase.
   Loaded after script.js and reuses its globals. With empty keys in config.js the app stays local-only. */
(() => {
  const cfg = window.SUPABASE_CONFIG || {};
  const enabled = Boolean(cfg.url && cfg.anonKey && window.supabase);
  const sb = enabled ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;
  const GUEST = "vt:guest";
  let user = null;
  let settings = {}; // { lastAccount, modeFilter }

  const riotKey = (a) => lower(a.name) + "#" + lower(a.tag);
  const fail = (e) => note("Cloud sync failed: " + (e && e.message ? e.message : e), true);
  function note(msg, isError = false) {
    setStatus(msg, isError);
    $("welcome-error").textContent = isError ? msg : "";
    $("gate-note").textContent = isError ? msg : "";
  }
  const showGate = (show) => { $("gate").hidden = !show; };

  /* ----- sign-in UI ----- */
  function renderAuth() {
    document.querySelectorAll("[data-auth]").forEach((box) => {
      box.replaceChildren();
      if (!enabled) return;
      if (!user) {
        const b = el("button", "quiet", "Sign in with Google");
        b.type = "button";
        b.addEventListener("click", signIn);
        box.append(b);
        return;
      }
      const meta = user.user_metadata || {};
      if (meta.avatar_url) {
        const img = el("img", "avatar");
        img.src = meta.avatar_url;
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        box.append(img);
      }
      box.append(el("span", "auth-name", meta.full_name || user.email || "Signed in"));
      const out = el("button", "quiet", "Sign out");
      out.type = "button";
      out.addEventListener("click", signOut);
      box.append(out);
    });
    const hint = $("auth-hint");
    if (hint) {
      hint.textContent = !enabled ? "Cloud sync is off. Add your Supabase keys in config.js to turn it on."
        : user ? "Favorites, matches and settings sync to your Google account."
        : "Guest mode: your data stays in this browser. Sign in with Google to keep it across devices.";
    }
  }

  async function signIn() {
    if (location.protocol === "file:") {
      note("Google sign-in needs http://localhost or your published site, not a file:// page.", true);
      return;
    }
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) note("Sign-in failed: " + error.message, true);
  }

  function wipeLocal() { // keeps the shared computer clean: the data lives in the cloud now
    try {
      Object.keys(localStorage).filter((k) => k.startsWith("vt:") && k !== KEY_API).forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  async function signOut() {
    await sb.auth.signOut();
    wipeLocal();
    location.reload();
  }

  /* ----- favorites ----- */
  async function pullFavorites() {
    const { data, error } = await sb.from("favorite_accounts").select("name,tag,region");
    if (error) throw error;
    const merged = new Map();
    [...(data || []), ...getFavorites()].forEach((f) => {
      merged.set(riotKey(f), { name: f.name, tag: f.tag, region: f.region || null });
    });
    store.set(KEY_FAVORITES, JSON.stringify([...merged.values()]));
  }

  async function pushFavorites() {
    if (!user) return;
    const rows = getFavorites().map((f) => ({
      user_id: user.id, riot_key: riotKey(f), name: f.name, tag: f.tag, region: f.region || null,
    }));
    const { data: cloud, error } = await sb.from("favorite_accounts").select("riot_key");
    if (error) throw error;
    const keep = new Set(rows.map((r) => r.riot_key));
    const gone = (cloud || []).map((r) => r.riot_key).filter((k) => !keep.has(k));
    if (rows.length) {
      const res = await sb.from("favorite_accounts").upsert(rows, { onConflict: "user_id,riot_key" });
      if (res.error) throw res.error;
    }
    if (gone.length) {
      const res = await sb.from("favorite_accounts").delete().in("riot_key", gone);
      if (res.error) throw res.error;
    }
  }

  /* ----- settings ----- */
  async function pullSettings() {
    const { data, error } = await sb.from("user_settings").select("settings").maybeSingle();
    if (error) throw error;
    settings = (data && data.settings) || {};
  }

  function saveSetting(patch) {
    if (!user) return;
    settings = { ...settings, ...patch };
    sb.from("user_settings")
      .upsert({ user_id: user.id, settings, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
      .then(({ error }) => { if (error) fail(error); });
  }

  function applyModeFilter() {
    const f = $("mode-filter");
    if (settings.modeFilter && [...f.options].some((o) => o.value === settings.modeFilter)) {
      f.value = settings.modeFilter;
      renderLog();
    }
  }

  /* ----- matches ----- */
  async function pullMatches() {
    const { data, error } = await sb.from("matches").select("data").eq("riot_key", riotKey(account)).limit(1000);
    if (error) throw error;
    const byId = new Map(matches.map((m) => [String(m.id), m]));
    (data || []).forEach((r) => {
      if (isValidMatch(r.data) && !byId.has(String(r.data.id))) byId.set(String(r.data.id), r.data);
    });
    matches = sortMatches([...byId.values()]);
  }

  async function pushMatches() {
    if (!user || !account) return;
    const key = riotKey(account);
    const rows = matches.map((m) => ({
      user_id: user.id, riot_key: key, match_id: String(m.id),
      started_at: matchTime(m) ? new Date(matchTime(m)).toISOString() : null, data: m,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("matches").upsert(rows.slice(i, i + 200), { onConflict: "user_id,riot_key,match_id" });
      if (error) throw error;
    }
  }

  async function syncAccount() {
    await pullMatches();
    render();
    await pushMatches();
  }

  async function syncAll() {
    try {
      await pullFavorites();
      await pushFavorites();
      renderFavorites();
      await pullSettings();
      if (!account && settings.lastAccount) {
        openAccount({ ...settings.lastAccount }, true); // new device: continue where you left off
      } else if (account) {
        await syncAccount();
        if (!settings.lastAccount) saveSetting({ lastAccount: { name: account.name, tag: account.tag, region: account.region || null } });
      }
      applyModeFilter();
      note("Synced with your Google account.");
    } catch (e) {
      fail(e);
    }
  }

  /* ----- hook into script.js ----- */
  if (enabled) {
    const origSave = saveMatches;
    saveMatches = function () {
      origSave();
      pushMatches().catch(fail);
    };

    const origSet = store.set;
    store.set = function (key, value) {
      const ok = origSet.call(store, key, value);
      if (key === KEY_FAVORITES) pushFavorites().catch(fail);
      return ok;
    };

    const origOpen = openAccount;
    openAccount = function (acc, autoFetch) {
      origOpen(acc, autoFetch);
      if (!user) return;
      saveSetting({ lastAccount: { name: acc.name, tag: acc.tag, region: acc.region || null } });
      syncAccount().catch(fail);
    };

    $("mode-filter").addEventListener("change", (e) => saveSetting({ modeFilter: e.target.value }));
    $("gate-google").addEventListener("click", signIn);
    $("gate-guest").addEventListener("click", () => { store.set(GUEST, "1"); showGate(false); renderAuth(); });

    sb.auth.onAuthStateChange((event, session) => {
      user = session ? session.user : null;
      if (user) { store.remove(GUEST); showGate(false); }
      renderAuth();
      // Run outside the callback: calling Supabase from inside it can stall.
      if (user && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) setTimeout(syncAll, 0);
    });

    // Show the gate only once we know there is no saved session and the person hasn't chosen guest mode.
    sb.auth.getSession().then(({ data }) => {
      if (!data.session && !store.get(GUEST)) showGate(true);
    });
  }

  renderAuth();
})();
