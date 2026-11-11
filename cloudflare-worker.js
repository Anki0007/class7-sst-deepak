const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ACTIVITY_TTL_SECONDS = 48 * 60 * 60;
const TEMP_ADMIN_TTL_SECONDS = 15 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, "");
}
function nameKey(value) { return normalizeName(value).toLowerCase(); }
function validStudentName(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  return Boolean(normalizeName(raw)) && !/[\u0000-\u001f\u007f]/u.test(raw) && new TextEncoder().encode(raw).length <= 240;
}
function cleanMetadata(value, maxLength, field = "") {
  let text = String(value ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (field === "topic") text = text.replace(/^(?:topic|topics)\s*[:：-]\s*/i, "").trim();
  if (field === "chapterNumber") text = text.replace(/^(?:chapter|ch)\s*/i, "").trim();
  if (field === "chapterName" && /^(?:chapter|ch)\s*(?:[_-]|n\/?a|none|null)?\s*$/i.test(text)) return "";
  const compact = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (!compact || ["na", "none", "null", "undefined", "unknown", "notavailable", "notprovided", "notentered", "notset", "notopic", "nochapter", "topic", "chapter"].includes(compact)) return "";
  return text.slice(0, maxLength);
}
function metadataKey(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function cleanTopic(value, chapterName) {
  const topic = cleanMetadata(value, 2000, "topic");
  return topic && chapterName && metadataKey(topic) === metadataKey(chapterName) ? "" : topic;
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
  if (match) return match[1];
  const queryToken = url.searchParams.get("token") || "";
  return /^[A-Za-z0-9_-]{20,200}$/.test(queryToken) ? queryToken : "";
}
async function readJson(request, limit = 128 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new Error("Request body too large");
  return JSON.parse(text);
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
export default {
  async fetch(request, env) {
    const { headers: cors, allowed } = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.TRACKER_KV) return json({ error: "TRACKER_KV binding is missing" }, 500, cors);
    if (!env.ALLOWED_ORIGIN) return json({ error: "Configure ALLOWED_ORIGIN to the exact website origin" }, 500, cors);
    if (!allowed) return json({ error: "Origin not allowed" }, 403, cors);

    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    if (["student_activity", "delete_student_events", "hide_student_events"].includes(action) && request.method !== "GET" && request.headers.get("Origin") !== env.ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, cors);
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

      if (action === "delete_student_events") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const body = await readJson(request, 4096);
        const student = String(body.student || "").trim();
        const kind = body.kind == null ? "" : String(body.kind);
        const kinds = Array.isArray(body.kinds) ? [...new Set(body.kinds.map(String))] : (kind ? [kind] : []);
        const subject = String(body.subject || "").normalize("NFKC").trim();
        if (kinds.some(value => !["login", "visit", "homework_tap", "notes_session"].includes(value)) || (subject && subject.length > 180)) return json({ error: "Invalid activity filter" }, 400, cors);
        if (body.all === true) {
          const indexStub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName("student-activity-index-v1"));
          const indexResponse = await indexStub.fetch("https://student-activity/students", { method: "GET" });
          if (!indexResponse.ok) return json({ error: "Could not load student list" }, 503, cors);
          const names = (await indexResponse.json()).students || [];
          const results = await Promise.all(names.map(async name => {
            const stub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName(`student-activity-ledger-v1:${nameKey(name)}`));
            const response = await stub.fetch("https://student-activity/delete", { method: "POST", body: JSON.stringify({ all: true, kind, kinds, subject }), headers: { "Content-Type": "application/json" } });
            return response.ok ? Number((await response.json()).deleted || 0) : 0;
          }));
          return json({ success: true, deleted: results.reduce((sum, count) => sum + count, 0) }, 200, cors);
        }
        if (!validStudentName(student)) return json({ error: "Student name required" }, 400, cors);
        const stub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName(`student-activity-ledger-v1:${nameKey(student)}`));
        const response = await stub.fetch("https://student-activity/delete", { method: "POST", body: JSON.stringify({ ...body, kind, kinds, subject }), headers: { "Content-Type": "application/json" } });
        return json(await response.json(), response.status, cors);
      }

      if (action === "hide_student_events") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 16 * 1024);
        const student = String(body.student || "").trim();
        const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
        if (!validStudentName(student) || !ids.length || ids.length > 200 || ids.some(id => !/^[A-Za-z0-9_-]{16,64}$/.test(id))) return json({ error: "Student and 1–200 valid event IDs are required" }, 400, cors);
        const stub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName(`student-activity-ledger-v1:${nameKey(student)}`));
        const response = await stub.fetch("https://student-activity/hide", { method: "POST", body: JSON.stringify({ student, ids }), headers: { "Content-Type": "application/json" } });
        return json(await response.json(), response.status, cors);
      }

      if (action === "student_activity") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 128 * 1024);
        if (!Array.isArray(body.records) || !body.records.length || body.records.length > 100) return json({ error: "Send 1–100 activity records" }, 400, cors);
        const allowedKinds = new Set(["login", "visit", "homework_tap", "notes_session"]);
        const records = [];
        for (const row of body.records) {
          const student = String(row?.student || "").trim();
          const kind = String(row?.kind || "");
          const id = String(row?.id || "");
          const timestamp = Number(row?.timestamp || 0);
          const updatedAt = Number(row?.updatedAt || timestamp);
          if (!validStudentName(student) || !allowedKinds.has(kind) || !/^[A-Za-z0-9_-]{16,64}$/.test(id) || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 300000 || !Number.isFinite(updatedAt) || updatedAt > Date.now() + 300000) return json({ error: "Invalid activity record" }, 400, cors);
          const record = { id, kind, student: student.slice(0, 240), timestamp, updatedAt };
          if (kind === "homework_tap") {
            const chapterName = cleanMetadata(row.chapterName, 180, "chapterName");
            const optional = {
              subject: cleanMetadata(row.subject, 180),
              chapterNumber: cleanMetadata(row.chapterNumber, 32, "chapterNumber"),
              chapterName,
              pageNumber: cleanMetadata(row.pageNumber, 80),
              topic: cleanTopic(row.topic, chapterName),
              buttonName: cleanMetadata(row.buttonName, 120),
              fileSize: cleanMetadata(row.fileSize, 40)
            };
            for (const [field, value] of Object.entries(optional)) if (value) record[field] = value;
            record.buttonSource = row.buttonSource === "GDocs_Link" ? "GDocs_Link" : "GDrive_Link";
          } else if (kind === "notes_session") {
            const startedAt = Number(row.startedAt || timestamp);
            const lastSeenAt = Number(row.lastSeenAt || row.updatedAt || timestamp);
            const endedAt = row.endedAt == null ? null : Number(row.endedAt);
            if (!Number.isFinite(startedAt) || !Number.isFinite(lastSeenAt) || (endedAt !== null && !Number.isFinite(endedAt))) return json({ error: "Invalid notes session timestamps" }, 400, cors);
            record.startedAt = startedAt;
            record.lastSeenAt = lastSeenAt;
            record.endedAt = endedAt;
            record.duration = Math.max(0, Number(row.duration || ((endedAt || lastSeenAt) - startedAt)));
            record.recovered = row.recovered === true;
          }
          records.push(record);
        }
        const groups = new Map();
        for (const record of records) {
          const owner = nameKey(record.student);
          if (!groups.has(owner)) groups.set(owner, []);
          groups.get(owner).push(record);
        }
        let saved = 0;
        for (const group of groups.values()) {
          const student = group[0].student;
          if (group.some(record => record.kind === "login" || record.kind === "visit")) {
            const indexStub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName("student-activity-index-v1"));
            const registered = await indexStub.fetch("https://student-activity/register", { method: "POST", body: JSON.stringify({ student }), headers: { "Content-Type": "application/json" } });
            if (!registered.ok) return json({ error: "Could not register student activity" }, 503, cors);
          }
          const stub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName(`student-activity-ledger-v1:${nameKey(student)}`));
          const response = await stub.fetch("https://student-activity/sync", { method: "POST", body: JSON.stringify({ records: group }), headers: { "Content-Type": "application/json" } });
          if (!response.ok) return json(await response.json().catch(() => ({ error: "Activity sync failed" })), response.status, cors);
          saved += Number((await response.json()).saved || 0);
        }
        return json({ success: true, saved }, 200, cors);
      }

      if (action === "get_student_events") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        const admin = await isAdmin(request, url, env);
        const student = url.searchParams.get("student") || "";
        if (!admin && tokenFrom(request, url)) return json({ error: "Admin session expired" }, 401, cors);
        if (!admin && !validStudentName(student)) return json({ error: "Student name required" }, 400, cors);
        if (!admin) {
          const stub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName(`student-activity-ledger-v1:${nameKey(student)}`));
          const response = await stub.fetch("https://student-activity/list", { method: "POST", body: JSON.stringify({ student }), headers: { "Content-Type": "application/json" } });
          return json(await response.json(), response.status, cors);
        }
        const page = Math.max(0, Math.floor(Number(url.searchParams.get("page") || 0)));
        const indexStub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName("student-activity-index-v1"));
        const indexResponse = await indexStub.fetch("https://student-activity/students", { method: "GET" });
        if (!indexResponse.ok) return json({ error: "Could not load student list" }, 503, cors);
        const names = (await indexResponse.json()).students || [];
        const pageSize = 40;
        const batch = names.slice(page * pageSize, (page + 1) * pageSize);
        const results = await Promise.all(batch.map(async studentName => {
          const stub = env.ADMIN_LOCK.get(env.ADMIN_LOCK.idFromName(`student-activity-ledger-v1:${nameKey(studentName)}`));
          const response = await stub.fetch("https://student-activity/list", { method: "POST", body: JSON.stringify({ student: studentName }), headers: { "Content-Type": "application/json" } });
          if (!response.ok) throw new Error("Could not load activity for " + studentName);
          return (await response.json()).records || [];
        }));
        return json({ records: results.flat(), nextPage: (page + 1) * pageSize < names.length ? page + 1 : null, studentCount: names.length }, 200, cors);
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

// ADMIN_LOCK stores the single admin session and the activity index/per-student Durable Objects.
export class AdminSessionLock {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => ({}));
    if (path === "/activity/register" && request.method === "POST") {
      if (!validStudentName(body.student)) return json({ error: "Valid student name required" }, 400);
      const key = `student:${nameKey(body.student)}`;
      if (!(await this.state.storage.get(key))) await this.state.storage.put(key, String(body.student).trim().slice(0, 240));
      return json({ success: true });
    }
    if (path === "/activity/students" && request.method === "GET") {
      const students = [];
      let startAfter;
      do {
        const page = await this.state.storage.list({ prefix: "student:", limit: 1000, ...(startAfter ? { startAfter } : {}) });
        students.push(...page.values());
        if (page.size < 1000) break;
        startAfter = [...page.keys()].at(-1);
      } while (startAfter);
      return json({ students });
    }
    if (path.startsWith("/activity/")) {
      const listActivity = async () => {
        const rows = [];
        let startAfter;
        do {
          const page = await this.state.storage.list({ prefix: "activity:", limit: 1000, ...(startAfter ? { startAfter } : {}) });
          rows.push(...page.entries());
          if (page.size < 1000) break;
          startAfter = [...page.keys()].at(-1);
        } while (startAfter);
        return rows;
      };
      const listHidden = async () => {
        const rows = [];
        let startAfter;
        do {
          const page = await this.state.storage.list({ prefix: "hidden:", limit: 1000, ...(startAfter ? { startAfter } : {}) });
          rows.push(...page.entries());
          if (page.size < 1000) break;
          startAfter = [...page.keys()].at(-1);
        } while (startAfter);
        return rows;
      };
      const listDeleted = async () => {
        const rows = [];
        let startAfter;
        do {
          const page = await this.state.storage.list({ prefix: "deleted:", limit: 1000, ...(startAfter ? { startAfter } : {}) });
          rows.push(...page.entries());
          if (page.size < 1000) break;
          startAfter = [...page.keys()].at(-1);
        } while (startAfter);
        return rows;
      };
      const now = Date.now();
      const stored = path === "/activity/sync" ? [] : await listActivity();
      const cutoff = now - ACTIVITY_TTL_SECONDS * 1000;
      const expiredKeys = [];
      const current = new Map();
      for (const [key, value] of stored) {
        const timestamp = Number(value.kind === "notes_session" ? (value.endedAt || value.lastSeenAt || value.timestamp) : value.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < cutoff) { expiredKeys.push(key); continue; }
        if (value.kind === "notes_session" && !value.endedAt && now - Number(value.lastSeenAt || 0) > 60000) {
          value.endedAt = Number(value.lastSeenAt || value.startedAt);
          value.duration = Math.max(0, value.endedAt - Number(value.startedAt || value.timestamp));
          value.recovered = true;
          value.updatedAt = now;
          await this.state.storage.put(key, value);
        }
        current.set(key, value);
      }
      for (let offset = 0; offset < expiredKeys.length; offset += 100) await this.state.storage.delete(expiredKeys.slice(offset, offset + 100));

      if (path === "/activity/sync" && request.method === "POST") {
        let saved = 0;
        await this.state.storage.transaction(async txn => {
          for (const incoming of Array.isArray(body.records) ? body.records : []) {
            if (Number(incoming.timestamp || 0) < now - ACTIVITY_TTL_SECONDS * 1000 || await txn.get(`hidden:${incoming.id}`) || await txn.get(`deleted:${incoming.id}`)) continue;
            const key = `activity:${incoming.id}`;
            const existing = await txn.get(key);
            if (existing && Number(existing.updatedAt || 0) > Number(incoming.updatedAt || 0)) continue;
            // Ignore old retries after recovery, but allow an actually resumed reader session to continue.
            if (existing?.kind === "notes_session" && existing.endedAt && !incoming.endedAt && Number(incoming.lastSeenAt || 0) <= Number(existing.endedAt)) continue;
            await txn.put(key, incoming);
            saved++;
          }
        });
        return json({ success: true, saved, count: current.size });
      }
      if (path === "/activity/list" && request.method === "POST") {
        const owner = body.admin ? "" : nameKey(body.student);
        const hiddenRows = await listHidden();
        const cutoffHidden = hiddenRows.filter(([key, timestamp]) => Number(timestamp) >= now - ACTIVITY_TTL_SECONDS * 1000);
        const expiredHidden = hiddenRows.filter(([key, timestamp]) => Number(timestamp) < now - ACTIVITY_TTL_SECONDS * 1000).map(([key]) => key);
        if (expiredHidden.length) await this.state.storage.delete(expiredHidden);
        const hiddenIds = cutoffHidden.map(([key]) => key.slice("hidden:".length));
        const hidden = new Set(hiddenIds);
        const deletedRows = await listDeleted();
        const cutoffDeleted = deletedRows.filter(([key, timestamp]) => Number(timestamp) >= now - ACTIVITY_TTL_SECONDS * 1000);
        const expiredDeleted = deletedRows.filter(([key, timestamp]) => Number(timestamp) < now - ACTIVITY_TTL_SECONDS * 1000).map(([key]) => key);
        if (expiredDeleted.length) await this.state.storage.delete(expiredDeleted);
        const deletedIds = cutoffDeleted.map(([key]) => key.slice("deleted:".length));
        const records = [...current.values()].filter(row => (body.admin || nameKey(row.student) === owner) && (body.admin || !hidden.has(row.id)));
        records.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
        return json({ records, hiddenIds: body.admin ? [] : hiddenIds, deletedIds: body.admin ? [] : deletedIds, refreshedAt: now });
      }
      if (path === "/activity/hide" && request.method === "POST") {
        const owner = nameKey(body.student);
        const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
        if (!owner || !ids.length || ids.length > 200) return json({ error: "Student and event IDs required" }, 400);
        let hidden = 0;
        await this.state.storage.transaction(async txn => {
          for (const eventId of ids) {
            const event = await txn.get(`activity:${eventId}`);
            if (!event || nameKey(event.student) !== owner) continue;
            await txn.put(`hidden:${eventId}`, now);
            hidden++;
          }
        });
        return json({ success: true, hidden });
      }
      if (path === "/activity/delete" && request.method === "POST") {
        if (body.id) {
          if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(body.id))) return json({ error: "Invalid activity id" }, 400);
          const key = `activity:${String(body.id)}`;
          const existed = current.has(key);
          if (existed) await this.state.storage.delete(key);
          await this.state.storage.put(`deleted:${String(body.id)}`, now);
          await this.state.storage.delete(`hidden:${String(body.id)}`);
          return json({ success: true, deleted: Number(existed) });
        }
        const owner = body.student ? nameKey(body.student) : "";
        if (body.all !== true && !owner) return json({ error: "Choose a student or all records" }, 400);
        const kinds = Array.isArray(body.kinds) ? body.kinds.map(String) : (body.kind ? [String(body.kind)] : []);
        const subject = String(body.subject || "").normalize("NFKC").trim();
        const subjectKey = subject.toLowerCase().replace(/\s+/g, "");
        const keys = [...current].filter(([, value]) => {
          if (body.all !== true && nameKey(value.student) !== owner) return false;
          if (kinds.length && !kinds.includes(value.kind)) return false;
          if (subjectKey && (!value.subject || String(value.subject).toLowerCase().replace(/\s+/g, "") !== subjectKey)) return false;
          return true;
        }).map(([key]) => key);
        const ids = keys.map(key => key.slice("activity:".length));
        const hiddenKeys = ids.map(id => `hidden:${id}`);
        for (let offset = 0; offset < keys.length; offset += 100) {
          const keyBatch = keys.slice(offset, offset + 100), idBatch = ids.slice(offset, offset + 100);
          await this.state.storage.delete([...keyBatch, ...hiddenKeys.slice(offset, offset + 100)]);
          await this.state.storage.put(Object.fromEntries(idBatch.map(id => [`deleted:${id}`, now])));
        }
        return json({ success: true, deleted: keys.length });
      }
      return json({ error: "Not found" }, 404);
    }
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
