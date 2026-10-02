/* cloud.js — Supabase auth + deck sync. Exposes window.Cloud. */
(function () {
  const cfg = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  let client = null, user = null;
  const listeners = [];

  const configured = () =>
    typeof window.supabase !== "undefined" &&
    cfg.url && cfg.key &&
    !cfg.url.includes("PASTE-YOUR") &&
    !cfg.key.includes("PASTE-YOUR");

  function init() {
    if (!configured()) return false;
    client = window.supabase.createClient(cfg.url, cfg.key, {
      auth: {
        storage: window.sessionStorage,
        storageKey: "fc-auth",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        multiTab: false
      }
    });
    client.auth.onAuthStateChange((_ev, session) => {
      user = (session && session.user) || null;
      listeners.forEach(cb => { try { cb(user); } catch (e) {} });
    });
    client.auth.getSession().then(({ data }) => {
      user = (data && data.session && data.session.user) || null;
      listeners.forEach(cb => { try { cb(user); } catch (e) {} });
    });
    return true;
  }

  function onAuth(cb) { listeners.push(cb); cb(user); }
  const current = () => user;
  const isConfigured = configured;

  /* ---------- auth ---------- */
  async function signInEmail(email) {
    return client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname }
    });
  }

  async function verifyOtp(email, token) {
    return client.auth.verifyOtp({ email, token, type: "email" });
  }

  async function signInGoogle() {
    return client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname }
    });
  }

  async function signOut() { return client.auth.signOut(); }

  /* ---------- decks ---------- */
  function rowToDeck(row) {
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      cards: Array.isArray(row.cards) ? row.cards : [],
      created: new Date(row.created_at).getTime(),
      isPublic: !!row.is_public,
      slug: row.public_slug || null
    };
  }
  function deckToRow(deck) {
    return {
      id: deck.id,
      user_id: user.id,
      name: deck.name,
      color: deck.color || null,
      cards: deck.cards || [],
      is_public: !!deck.isPublic,
      public_slug: deck.slug || null,
      created_at: new Date(deck.created || Date.now()).toISOString()
    };
  }

  async function listMyDecks() {
    if (!user) return [];
    const { data, error } = await client
      .from("decks").select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(rowToDeck);
  }

  async function upsertDeck(deck) {
    if (!user) return null;
    const row = deckToRow(deck);
    const { data, error } = await client
      .from("decks").upsert(row, { onConflict: "id" })
      .select().single();
    if (error) throw error;
    return rowToDeck(data);
  }

  async function deleteDeck(id) {
    if (!user) return;
    const { error } = await client.from("decks").delete().eq("id", id);
    if (error) throw error;
  }

  async function bulkUpsert(deckList) {
    if (!user || !deckList.length) return [];
    const rows = deckList.map(deckToRow);
    const { data, error } = await client
      .from("decks").upsert(rows, { onConflict: "id" }).select();
    if (error) throw error;
    return (data || []).map(rowToDeck);
  }

  async function publishDeck(id) {
    if (!user) throw new Error("Sign in first.");
    const slug = makeSlug();
    const { data, error } = await client
      .from("decks")
      .update({ is_public: true, public_slug: slug })
      .eq("id", id).select().single();
    if (error) throw error;
    return rowToDeck(data);
  }
  async function unpublishDeck(id) {
    if (!user) throw new Error("Sign in first.");
    const { data, error } = await client
      .from("decks")
      .update({ is_public: false, public_slug: null })
      .eq("id", id).select().single();
    if (error) throw error;
    return rowToDeck(data);
  }

  async function getPublicDeck(slug) {
    if (!client) {
      if (!configured()) throw new Error("Cloud not configured.");
      client = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
    }
    const { data, error } = await client
      .from("decks")
      .select("name, cards, created_at, public_slug")
      .eq("public_slug", slug).eq("is_public", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      name: data.name, cards: data.cards || [],
      created: new Date(data.created_at).getTime(), slug: data.public_slug
    };
  }

  function makeSlug() {
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    let s = "";
    for (let i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  window.Cloud = {
    init, onAuth, current, isConfigured,
    signInEmail, verifyOtp, signInGoogle, signOut,
    listMyDecks, upsertDeck, deleteDeck, bulkUpsert,
    publishDeck, unpublishDeck, getPublicDeck,
    uuid
  };
})();
