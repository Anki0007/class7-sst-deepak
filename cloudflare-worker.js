const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const HISTORY_TTL_SECONDS = 48 * 60 * 60;
const ONLINE_TTL_SECONDS = 60;
const TEMP_ADMIN_TTL_SECONDS = 15 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, "");
}
function validKey(value) {
  return typeof value === "string" && value.length <= 220 && /^[\p{L}\p{N}_-]+_(?:notes|dl|downloads)_[\p{L}\p{N}_-]+_[\p{L}\p{N}_-]+$/u.test(value);
}
function safeFilename(value) {
  return String(value || "File").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 180) || "File";
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const configured = env.ALLOWED_ORIGIN;
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  if (configured && (!origin || origin === configured)) headers["Access-Control-Allow-Origin"] = configured;
  return { headers, allowed: !origin || (configured && origin === configured) };
}
function tokenFrom(request, url) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  return match ? match[1] : "";
}
async function readJson(request, limit = 128 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new Error("Request body too large");
  return JSON.parse(text);
}
async function listAll(kv, prefix, max = 10000) {
  const items = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    items.push(...page.keys);
    if (items.length > max) throw new Error("History result limit exceeded");
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return items;
}
async function isAdmin(request, url, env) {
  const token = tokenFrom(request, url);
  if (!token) return false;
  if (await env.TRACKER_KV.get(`ADMIN_TEMP_${token}`)) return true;
  if (!env.ADMIN_LOCK) return false;
  const id = env.ADMIN_LOCK.idFromName("permanent-admin");
  const stub = env.ADMIN_LOCK.get(id);
  const response = await stub.fetch("https://admin-lock/check", { method: "POST", body: JSON.stringify({ token }) });
  return response.ok && (await response.json()).active === true;
}
function encodedKey(key) {
  const bytes = new TextEncoder().encode(key);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function deleteHistoryKey(key, env) {
  if (!validKey(key)) return false;
  await env.TRACKER_KV.delete(key);
  return true;
}

export default {
  async fetch(request, env) {
    const { headers: cors, allowed } = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.TRACKER_KV) return json({ error: "TRACKER_KV binding is missing" }, 500, cors);
    if (!env.ALLOWED_ORIGIN) return json({ error: "Configure ALLOWED_ORIGIN to the exact website origin" }, 500, cors);
    if (!allowed) return json({ error: "Origin not allowed" }, 403, cors);

    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    if (["save_history", "student_hide_history", "student_event", "heartbeat"].includes(action) && request.method !== "GET" && request.headers.get("Origin") !== env.ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, cors);
    const method = request.method;

    try {
      if (action === "verify_admin") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        if (!env.MASTER_PASSWORD || typeof body.pwd !== "string" || body.pwd !== env.MASTER_PASSWORD) {
          return json({ success: false, error: "Invalid credentials" }, 401, cors);
        }
        const token = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
        if (body.mode === "temporary") {
          await env.TRACKER_KV.put(`ADMIN_TEMP_${token}`, "1", { expirationTtl: TEMP_ADMIN_TTL_SECONDS });
          return json({ success: true, token, expiresIn: TEMP_ADMIN_TTL_SECONDS, mode: "temporary" }, 200, cors);
        }
        if (!env.ADMIN_LOCK) return json({ error: "ADMIN_LOCK Durable Object binding is required for permanent single-device login" }, 503, cors);
        const id = env.ADMIN_LOCK.idFromName("permanent-admin");
        const stub = env.ADMIN_LOCK.get(id);
        const response = await stub.fetch("https://admin-lock/login", { method: "POST", body: JSON.stringify({ token }) });
        if (!response.ok) return json({ error: "Could not establish admin session" }, 503, cors);
        return json({ success: true, token, mode: "permanent" }, 200, cors);
      }

      if (action === "admin_logout") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        const token = body.token || tokenFrom(request, url);
        if (!token) return json({ error: "Missing admin token" }, 401, cors);
        const tempKey = `ADMIN_TEMP_${token}`;
        if (await env.TRACKER_KV.get(tempKey)) {
          await env.TRACKER_KV.delete(tempKey);
        } else if (env.ADMIN_LOCK) {
          const stub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName("permanent-admin"));
          const response = await stub.fetch("https://admin-lock/logout", { method: "POST", body: JSON.stringify({ token }) });
          if (!response.ok) return json({ error: "Admin session is no longer active" }, 401, cors);
        }
        return json({ success: true }, 200, cors);
      }

      if (action === "save_history") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request);
        const record = body.history || body.entry;
        const key = body.key;
        if (!record || typeof record !== "object" || !validKey(key)) return json({ error: "Invalid history record or key" }, 400, cors);
        const parts = key.split("_");
        const kindIndex = parts.findIndex(part => part === "notes" || part === "dl" || part === "downloads");
        const keyStudent = parts.slice(kindIndex + 1, -1).join("_");
        if (!keyStudent || (record.student && normalizeName(record.student) !== keyStudent)) return json({ error: "History key does not match student" }, 400, cors);
        if (!Number.isFinite(Number(record.start)) || Number(record.start) > Date.now() + 300000) return json({ error: "Invalid history timestamp" }, 400, cors);
        const clean = {
          start: Number(record.start), end: Number(record.end || record.start), createdAt: Date.now(),
          duration: Math.max(0, Number(record.duration || 0)), student: String(record.student || keyStudent).slice(0, 80),
          dbKey: key
        };
        if (key.includes("_notes_")) {
          clean.chapter = String(record.chapter || "").slice(0, 180);
          clean.focus = Math.max(0, Number(record.focus || 0));
          clean.blur = Math.max(0, Number(record.blur || 0));
          clean.taps = Math.max(0, Math.floor(Number(record.taps || 0)));
          clean.logs = Array.isArray(record.logs) ? record.logs.slice(0, 1000).map(log => ({
            action: log.action === "Focused" ? "Focused" : "Blurred",
            start: Number(log.start), end: Number(log.end), duration: Math.max(0, Number(log.duration || 0))
          })).filter(log => Number.isFinite(log.start) && Number.isFinite(log.end)) : [];
        } else {
          clean.fileName = safeFilename(record.fileName);
          clean.fileSize = String(record.fileSize || "").slice(0, 40);
          clean.subject = String(record.subject || parts[0]).slice(0, 60);
        }
        if (await env.TRACKER_KV.get(key)) return json({ error: "History key already exists" }, 409, cors);
        await env.TRACKER_KV.put(key, JSON.stringify(clean), { expirationTtl: HISTORY_TTL_SECONDS });
        return json({ success: true, expiresIn: HISTORY_TTL_SECONDS }, 201, cors);
      }

      if (action === "get_history") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        const prefix = url.searchParams.get("prefix") || "";
        const student = url.searchParams.get("student") || "";
        if (!/^[\p{L}\p{N}_-]{1,100}_(?:notes|dl|downloads)_$/u.test(prefix)) return json({ error: "Invalid history prefix" }, 400, cors);
        const admin = await isAdmin(request, url, env);
        if (!admin && !student) return json({ error: "Student name required" }, 400, cors);
        const keys = await listAll(env.TRACKER_KV, prefix);
        const owner = normalizeName(student);
        const hidden = new Set();
        if (!admin) {
          const hiddenKeys = await listAll(env.TRACKER_KV, `HIDE_${owner}_`, 10000);
          for (const hiddenEntry of hiddenKeys) hidden.add(await env.TRACKER_KV.get(hiddenEntry.name));
        }
        const results = [];
        for (const entry of keys) {
          const suffix = entry.name.slice(prefix.length);
          if (!admin && (!suffix.startsWith(`${owner}_`) || hidden.has(entry.name))) continue;
          const value = await env.TRACKER_KV.get(entry.name);
          if (!value) continue;
          try {
            const record = JSON.parse(value);
            const createdAt = Number(record.createdAt || record.end || record.start || Date.now());
            const expiresAt = createdAt + HISTORY_TTL_SECONDS * 1000;
            if (expiresAt <= Date.now()) { await env.TRACKER_KV.delete(entry.name); continue; }
            if (!entry.expiration) await env.TRACKER_KV.put(entry.name, JSON.stringify({ ...record, createdAt }), { expiration: Math.ceil(expiresAt / 1000) });
            if (admin) {
              results.push({ ...record, dbKey: entry.name });
            } else if (prefix.includes("_notes_")) {
              // Students receive only the session summary; detailed focus/tap logs stay admin-only.
              results.push({ start: Number(record.start), end: Number(record.end || record.start), duration: Math.max(0, Number(record.duration || 0)), chapter: String(record.chapter || "").slice(0, 180), dbKey: entry.name });
            } else {
              results.push({ start: Number(record.start), end: Number(record.end || record.start), duration: Math.max(0, Number(record.duration || 0)), fileName: safeFilename(record.fileName), fileSize: String(record.fileSize || "").slice(0, 40), subject: String(record.subject || "").slice(0, 60), dbKey: entry.name });
            }
          } catch { /* skip malformed legacy value */ }
        }
        results.sort((a, b) => Number(b.start) - Number(a.start));
        return json(results, 200, cors);
      }

      if (action === "delete_history") {
        if (method !== "POST" && method !== "DELETE") return json({ error: "Use POST or DELETE" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const body = method === "POST" ? await readJson(request, 4096) : {};
        const key = body.key || url.searchParams.get("key");
        if (!key || !await deleteHistoryKey(key, env)) return json({ error: "Invalid history key" }, 400, cors);
        return json({ success: true }, 200, cors);
      }

      if (action === "student_hide_history") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        const student = normalizeName(body.student);
        const key = body.key;
        if (!student || !validKey(key)) return json({ error: "Invalid student history key" }, 400, cors);
        const prefix = key.split("_").slice(0, 2).join("_") + "_";
        if (!key.startsWith(prefix + student + "_")) return json({ error: "History does not belong to this student" }, 403, cors);
        await env.TRACKER_KV.put(`HIDE_${student}_${encodedKey(key)}`, key, { expirationTtl: HISTORY_TTL_SECONDS });
        return json({ success: true }, 200, cors);
      }

      if (action === "student_event") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        const student = normalizeName(body.student);
        const kind = body.kind;
        if (!student || !/^[\p{L}\p{N}_-]{1,80}$/u.test(student) || !["login", "visit"].includes(kind)) return json({ error: "Invalid student event" }, 400, cors);
        const event = { student: String(body.student).trim().slice(0, 80), kind, timestamp: Date.now() };
        const key = `EVENT_${student}_${crypto.randomUUID()}`;
        await env.TRACKER_KV.put(key, JSON.stringify(event), { expirationTtl: HISTORY_TTL_SECONDS });
        return json({ success: true, eventId: key, expiresIn: HISTORY_TTL_SECONDS }, 201, cors);
      }

      if (action === "get_student_events") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const keys = await listAll(env.TRACKER_KV, "EVENT_", 10000);
        const events = [];
        for (const entry of keys) {
          const value = await env.TRACKER_KV.get(entry.name);
          if (!value) continue;
          try { events.push(JSON.parse(value)); } catch { /* ignore malformed legacy event */ }
        }
        events.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
        return json(events, 200, cors);
      }
      if (action === "heartbeat") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        const subject = normalizeName(body.subj), student = normalizeName(body.studentName);
        if (!subject || !student || !/^[\p{L}\p{N}_-]{1,60}$/u.test(subject) || !/^[\p{L}\p{N}_-]{1,80}$/u.test(student)) return json({ error: "Invalid heartbeat" }, 400, cors);
        await env.TRACKER_KV.put(`ONLINE_${subject}_${student}`, "active", { expirationTtl: ONLINE_TTL_SECONDS });
        return json({ success: true }, 200, cors);
      }

      if (action === "get_online") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const subject = normalizeName(url.searchParams.get("subj"));
        if (!subject) return json({ error: "Subject required" }, 400, cors);
        const keys = await listAll(env.TRACKER_KV, `ONLINE_${subject}_`, 2000);
        return json(keys.map(item => item.name.slice(`ONLINE_${subject}_`.length)), 200, cors);
      }

      if (action === "fetch_notes") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        const raw = url.searchParams.get("url");
        let doc;
        try { doc = new URL(raw); } catch { return json({ error: "Valid Google Docs URL required" }, 400, cors); }
        if (doc.protocol !== "https:" || doc.hostname !== "docs.google.com" || !/^\/document\//.test(doc.pathname)) return json({ error: "Only Google Docs document URLs are allowed" }, 403, cors);
        const upstream = await fetch(doc.toString(), { redirect: "follow", headers: { "Accept": "text/html" } });
        if (!upstream.ok || !upstream.headers.get("content-type")?.includes("text/html")) return json({ error: "Could not fetch Google Docs HTML" }, 502, cors);
        const finalUrl = new URL(upstream.url);
        if (finalUrl.hostname !== "docs.google.com" && finalUrl.hostname !== "drive.google.com") return json({ error: "Unexpected upstream redirect" }, 502, cors);
        let html = await upstream.text();
        if (html.length > 5_000_000) return json({ error: "Document is too large" }, 413, cors);
        html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
        html = html.replace(/>\s*(https?:\/\/[^<]+?\.(?:gif|jpg|jpeg|png|webp)(?:\?[^<]*)?)\s*<\/a>/gi,
          '><img src="$1" style="max-width:100%;border-radius:12px;margin:15px 0;display:block"></a>');
        const nativeCSS = `<meta name="referrer" content="no-referrer"><style>body,html{background:#0a0a0f!important;margin:0!important;padding:5px!important;font-family:Arial,sans-serif!important;overflow-x:hidden!important}#contents{filter:invert(1) hue-rotate(180deg) brightness(.95) contrast(1.1);background:#fff;padding:15px!important;border-radius:12px;max-width:100%!important;margin:0 auto}img,video,iframe,canvas{filter:invert(1) hue-rotate(180deg)!important;border-radius:8px}table{max-width:100%!important;overflow-x:auto!important;display:block!important}#header,#footer{display:none!important}</style>`;
        html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, nativeCSS + "</head>") : nativeCSS + html;
        return new Response(html, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" } });
      }

      if (action === "download" || (!action && url.searchParams.has("id"))) {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        const id = url.searchParams.get("id") || "";
        const subj = safeFilename(url.searchParams.get("subj") || "Subject");
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return json({ error: "Invalid Google Drive file ID" }, 400, cors);
        const upstream = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, { redirect: "follow" });
        const contentType = upstream.headers.get("content-type") || "application/octet-stream";
        if (contentType.includes("text/html")) {
          let html = await upstream.text();
          html = html.replace(/(action|href)="(\/uc[^\"]+)"/g, '$1="https://drive.google.com$2"');
          return new Response(html, { status: upstream.status, headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
        }
        let original = "File";
        const disposition = upstream.headers.get("content-disposition") || "";
        const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        const basic = disposition.match(/filename=['"]?([^;'"]+)['"]?/i);
        try { if (utf8?.[1]) original = decodeURIComponent(utf8[1]); else if (basic?.[1]) original = basic[1]; } catch { original = basic?.[1] || "File"; }
        original = safeFilename(original);
        const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const day = ["sun","mon","tue","wed","thu","fri","sat"][now.getDay()];
        const date = `${String(now.getDate()).padStart(2,"0")}/${String(now.getMonth()+1).padStart(2,"0")}/${String(now.getFullYear()).slice(-2)}`;
        const hour = now.getHours() % 12 || 12, ampm = now.getHours() >= 12 ? "pm" : "am";
        const time = `${String(hour).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")} ${ampm}`;
        const filename = `[${subj}][${date}][${day}][${time}]${original}(Ankits_Cloud_File)`;
        const out = new Response(upstream.body, upstream);
        for (const [name,value] of Object.entries(cors)) out.headers.set(name,value);
        out.headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        out.headers.set("Content-Type", contentType);
        out.headers.set("Cache-Control", "no-store");
        out.headers.set("X-Content-Type-Options", "nosniff");
        return out;
      }

      return json({ error: "Unknown action" }, 404, cors);
    } catch (error) {
      return json({ error: error instanceof SyntaxError ? "Invalid JSON" : "Request could not be completed" }, 500, cors);
    }
  }
};

// Bind this class as ADMIN_LOCK (Durable Object) to make permanent admin login single-session.
export class AdminSessionLock {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => ({}));
    if (path === "/login" && request.method === "POST") {
      await this.state.storage.put("activeToken", body.token);
      return json({ success: true });
    }
    const activeToken = await this.state.storage.get("activeToken");
    if (path === "/check" && request.method === "POST") return json({ active: Boolean(body.token && activeToken && body.token === activeToken) });
    if (path === "/logout" && request.method === "POST") {
      if (!body.token || body.token !== activeToken) return json({ error: "Session replaced" }, 401);
      await this.state.storage.delete("activeToken");
      return json({ success: true });
    }
    return json({ error: "Not found" }, 404);
  }
}
