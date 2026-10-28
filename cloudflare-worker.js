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
function nameKey(value) { return normalizeName(value).toLowerCase(); }
async function studentLogoutTimestamp(kv, student) {
  const suffixes = [...new Set([normalizeName(student), nameKey(student)].filter(Boolean))];
  const values = await Promise.all(suffixes.map(suffix => kv.get(`FORCE_LOGOUT_${suffix}`)));
  return Math.max(0, ...values.map(value => Number(value || 0)));
}
function validStudentName(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  return Boolean(normalizeName(raw)) && !/[\u0000-\u001f\u007f]/u.test(raw) && new TextEncoder().encode(raw).length <= 240;
}
function normalizeSubject(value) { return String(value || "").normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase(); }
function validSubject(value) {
  const raw = String(value || "").normalize("NFKC").trim().replace(/\s+/g, "");
  return Boolean(raw) && !/[\u0000-\u001f\u007f]/u.test(raw) && new TextEncoder().encode(raw).length <= 180;
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
function cleanChapterLabel(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  const labeled = text.match(/^(?:chapter|ch)\s*(.*?)\s*[:：–—]\s*(.*?)\s*$/i);
  if (labeled) {
    const number = cleanMetadata(labeled[1], 32, "chapterNumber");
    const name = cleanMetadata(labeled[2], 180, "chapterName");
    return number && name ? `CHAPTER ${number}: ${name}` : number ? `CHAPTER ${number}` : name;
  }
  const missingNumber = text.match(/^(?:chapter|ch)\s+[_-]\s+(.+)$/i);
  if (missingNumber) return cleanMetadata(missingNumber[1], 180, "chapterName");
  const numberOnly = text.match(/^(?:chapter|ch)\s+([0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)\s*$/i);
  if (numberOnly) {
    const number = cleanMetadata(numberOnly[1], 32, "chapterNumber");
    return number ? `CHAPTER ${number}` : "";
  }
  const nameOnly = text.match(/^(?:chapter|ch)\s+(.+)$/i);
  if (nameOnly) return cleanMetadata(nameOnly[1], 180, "chapterName");
  return cleanMetadata(text, 180, "chapterName");
}
function chapterDataFromLabel(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  const labeled = text.match(/^(?:chapter|ch)\s*(.*?)\s*[:：–—]\s*(.*?)\s*$/i);
  if (labeled) return { chapterNumber: cleanMetadata(labeled[1], 32, "chapterNumber"), chapterName: cleanMetadata(labeled[2], 180, "chapterName") };
  const missingNumber = text.match(/^(?:chapter|ch)\s+[_-]\s+(.+)$/i);
  if (missingNumber) return { chapterNumber: "", chapterName: cleanMetadata(missingNumber[1], 180, "chapterName") };
  const numberOnly = text.match(/^(?:chapter|ch)\s+([0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)\s*$/i);
  if (numberOnly) return { chapterNumber: cleanMetadata(numberOnly[1], 32, "chapterNumber"), chapterName: "" };
  const nameOnly = text.match(/^(?:chapter|ch)\s+(.+)$/i);
  if (nameOnly) return { chapterNumber: "", chapterName: cleanMetadata(nameOnly[1], 180, "chapterName") };
  return { chapterNumber: "", chapterName: "" };
}
function metadataKey(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function cleanTopic(value, chapterName) {
  const topic = cleanMetadata(value, 2000, "topic");
  return topic && chapterName && metadataKey(topic) === metadataKey(chapterName) ? "" : topic;
}
function cleanHistoryFilename(value) {
  const text = cleanMetadata(value, 180);
  if (!text) return "";
  const isChapterLabel = /^(?:chapter|ch)\s*(?:[_-]\s+|[:：]\s*|[0-9]+(?:\.[0-9]+)*(?:\s*[:：–—-]\s*|\s*$)|[IVXLCDM]+(?:\s*[:：–—-]\s*|\s*$))/i.test(text);
  return isChapterLabel ? cleanChapterLabel(text) : safeFilename(text);
}
function parseHistoryKey(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value) || new TextEncoder().encode(value).length > 512) return null;
  const candidates = [];
  const marker = /_(notes|dl|downloads)_/gu;
  let match;
  while ((match = marker.exec(value))) {
    const subject = value.slice(0, match.index);
    const tail = value.slice(marker.lastIndex).match(/^(.+)_([0-9]{10,16})$/u);
    if (!validSubject(subject) || !tail || !validStudentName(tail[1])) continue;
    candidates.push({ subject, kind: match[1] === "downloads" ? "dl" : match[1], student: tail[1], timestamp: Number(tail[2]) });
  }
  // The first valid marker is the subject/type separator. A student name may
  // itself contain a string like "_notes_" and must remain intact.
  return candidates[0] || null;
}
function parseHistoryPrefix(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const match = value.match(/^(.+)_(notes|dl|downloads)_$/u);
  if (!match || !validSubject(match[1])) return null;
  return { subject: match[1], kind: match[2] === "downloads" ? "dl" : match[2] };
}
function validKey(value) {
  return Boolean(parseHistoryKey(value));
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
async function listActiveStudentPresence(kv) {
  const keys = await listAll(kv, "PRESENCE_", 5000);
  const students = new Map();
  const now = Date.now();
  const allLogoutAt = Number(await kv.get("FORCE_LOGOUT_ALL") || 0);
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = await Promise.all(keys.slice(offset, offset + 100).map(async entry => ({ entry, value: await kv.get(entry.name) })));
    for (const { entry, value } of batch) {
      if (!value) continue;
      try {
        const data = JSON.parse(value);
        const updatedAt = Number(data.updatedAt || 0);
        data.loginAt = Number(data.loginAt || 0);
        const studentKey = nameKey(data.student);
        if (!studentKey || !updatedAt || now - updatedAt > ONLINE_TTL_SECONDS * 1000) continue;
        data.chapterNumber = cleanMetadata(data.chapterNumber, 32, "chapterNumber");
        data.chapterName = cleanMetadata(data.chapterName, 180, "chapterName");
        const itemChapter = chapterDataFromLabel(data.item);
        data.chapterNumber = data.chapterNumber || itemChapter.chapterNumber;
        data.chapterName = data.chapterName || itemChapter.chapterName;
        data.topic = cleanTopic(data.topic, data.chapterName);
        data.subject = cleanMetadata(data.subject, 80);
        data.item = cleanHistoryFilename(data.item);
        const previous = students.get(studentKey);
        const rank = mode => mode === "downloading" ? 2 : mode === "reading_notes" ? 1 : 0;
        if (!previous || rank(data.mode) > rank(previous.mode) || (rank(data.mode) === rank(previous.mode) && updatedAt > Number(previous.updatedAt))) students.set(studentKey, data);
      } catch { /* Ignore malformed presence records. */ }
    }
  }
  const active = [];
  const uniqueStudents = [...students.entries()];
  for (let offset = 0; offset < uniqueStudents.length; offset += 100) {
    const batch = await Promise.all(uniqueStudents.slice(offset, offset + 100).map(async ([studentKey, data]) => {
      const forcedAt = Math.max(allLogoutAt, await studentLogoutTimestamp(kv, data.student));
      return forcedAt > data.loginAt ? null : data;
    }));
    active.push(...batch.filter(Boolean));
  }
  return active.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}
async function clearStudentPresence(kv, student = "") {
  const target = student ? nameKey(student) : "";
  const keys = await listAll(kv, "PRESENCE_", 5000);
  let removed = 0;
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = await Promise.all(keys.slice(offset, offset + 100).map(async entry => {
      if (!target) return entry.name;
      const value = await kv.get(entry.name);
      try { return value && nameKey(JSON.parse(value).student) === target ? entry.name : ""; }
      catch { return ""; }
    }));
    const matching = batch.filter(Boolean);
    await Promise.all(matching.map(key => kv.delete(key)));
    removed += matching.length;
  }
  return removed;
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
async function hiddenKeyName(student, key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `HIDE_${student}_${hex}`;
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
    if (["save_history", "student_hide_history", "student_event", "student_presence", "heartbeat"].includes(action) && request.method !== "GET" && request.headers.get("Origin") !== env.ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, cors);
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
        const keyParts = parseHistoryKey(key);
        const keyStudent = keyParts?.student || "";
        if (!keyParts || (record.student && nameKey(record.student) !== nameKey(keyStudent))) return json({ error: "History key does not match student" }, 400, cors);
        if (!Number.isFinite(Number(record.start)) || Number(record.start) > Date.now() + 300000) return json({ error: "Invalid history timestamp" }, 400, cors);
        const clean = {
          start: Number(record.start), end: Number(record.end || record.start), createdAt: Date.now(),
          duration: Math.max(0, Number(record.duration || 0)), student: String(record.student || keyStudent).trim().slice(0, 240),
          dbKey: key
        };
        const titleChapter = chapterDataFromLabel(keyParts.kind === "notes" ? record.chapter : record.fileName);
        clean.chapterNumber = cleanMetadata(record.chapterNumber, 32, "chapterNumber") || titleChapter.chapterNumber;
        clean.chapterName = cleanMetadata(record.chapterName, 180, "chapterName") || titleChapter.chapterName;
        clean.topic = cleanTopic(record.topic, clean.chapterName);
        if (keyParts.kind === "notes") {
          clean.chapter = cleanChapterLabel(record.chapter);
          clean.focus = Math.max(0, Number(record.focus || 0));
          clean.blur = Math.max(0, Number(record.blur || 0));
          clean.taps = Math.max(0, Math.floor(Number(record.taps || 0)));
          clean.logs = Array.isArray(record.logs) ? record.logs.slice(0, 1000).map(log => ({
            action: log.action === "Focused" ? "Focused" : "Blurred",
            start: Number(log.start), end: Number(log.end), duration: Math.max(0, Number(log.duration || 0))
          })).filter(log => Number.isFinite(log.start) && Number.isFinite(log.end)) : [];
        } else {
          clean.fileName = cleanHistoryFilename(record.fileName);
          clean.fileSize = String(record.fileSize || "").slice(0, 40);
          clean.subject = String(record.subject || keyParts.subject).slice(0, 180);
        }
        if (await env.TRACKER_KV.get(key)) return json({ error: "History key already exists" }, 409, cors);
        await env.TRACKER_KV.put(key, JSON.stringify(clean), { expirationTtl: HISTORY_TTL_SECONDS });
        return json({ success: true, expiresIn: HISTORY_TTL_SECONDS }, 201, cors);
      }

      if (action === "get_history") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        const prefix = url.searchParams.get("prefix") || "";
        const student = url.searchParams.get("student") || "";
        const scope = parseHistoryPrefix(prefix);
        if (!scope) return json({ error: "Invalid history prefix" }, 400, cors);
        const admin = await isAdmin(request, url, env);
        if (!admin && !validStudentName(student)) return json({ error: "Student name required" }, 400, cors);
        const keys = await listAll(env.TRACKER_KV, prefix);
        // HIDE_ KV key prefixes preserve the entered name's case for backward
        // compatibility; ownership comparisons below stay case-insensitive.
        const owner = normalizeName(student);
        const ownerKey = nameKey(student);
        const hidden = new Set();
        if (!admin) {
          const hiddenKeys = await listAll(env.TRACKER_KV, `HIDE_${owner}_`, 10000);
          for (const hiddenEntry of hiddenKeys) hidden.add(await env.TRACKER_KV.get(hiddenEntry.name));
        }
        const results = [];
        for (const entry of keys) {
          const keyParts = parseHistoryKey(entry.name);
          if (!keyParts || keyParts.kind !== scope.kind || normalizeSubject(keyParts.subject) !== normalizeSubject(scope.subject)) continue;
          if (!admin && (nameKey(keyParts.student) !== ownerKey || hidden.has(entry.name))) continue;
          const value = await env.TRACKER_KV.get(entry.name);
          if (!value) continue;
          try {
            const record = JSON.parse(value);
            const createdAt = Number(record.createdAt || record.end || record.start || Date.now());
            const expiresAt = createdAt + HISTORY_TTL_SECONDS * 1000;
            if (expiresAt <= Date.now()) { await env.TRACKER_KV.delete(entry.name); continue; }
            if (!entry.expiration) await env.TRACKER_KV.put(entry.name, JSON.stringify({ ...record, createdAt }), { expiration: Math.ceil(expiresAt / 1000) });
            const titleChapter = chapterDataFromLabel(scope.kind === "notes" ? record.chapter : record.fileName);
            const chapterNumber = cleanMetadata(record.chapterNumber, 32, "chapterNumber") || titleChapter.chapterNumber;
            const chapterName = cleanMetadata(record.chapterName, 180, "chapterName") || titleChapter.chapterName;
            const topic = cleanTopic(record.topic, chapterName);
            const chapter = cleanChapterLabel(record.chapter);
            if (admin) {
              results.push({ ...record, chapter, chapterNumber, chapterName, topic, dbKey: entry.name });
            } else if (scope.kind === "notes") {
              // Students receive only the session summary; detailed focus/tap logs stay admin-only.
              results.push({ start: Number(record.start), end: Number(record.end || record.start), duration: Math.max(0, Number(record.duration || 0)), chapter, chapterNumber, chapterName, topic, student: String(record.student || student).slice(0, 240), dbKey: entry.name });
            } else {
              results.push({ start: Number(record.start), end: Number(record.end || record.start), duration: Math.max(0, Number(record.duration || 0)), fileName: cleanHistoryFilename(record.fileName), fileSize: String(record.fileSize || "").slice(0, 40), subject: String(record.subject || "").slice(0, 180), chapterNumber, chapterName, topic, student: String(record.student || student).slice(0, 240), dbKey: entry.name });
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

      if (action === "delete_history_scope" || action === "delete_student_history") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const body = await readJson(request, 4096);
        const subject = String(body.subject || "").normalize("NFKC").trim().replace(/\s+/g, "");
        const kind = body.type === "downloads" || body.type === "dl" ? "dl" : body.type === "notes" ? "notes" : "";
        const student = body.student == null || body.student === "" ? "" : String(body.student);
        if (!kind || !validSubject(subject) || (student && !validStudentName(student)) || (action === "delete_student_history" && !student)) {
          return json({ error: "Valid subject, student (when selecting one), and history type required" }, 400, cors);
        }
        const prefix = `${subject}_${kind}_`;
        const keys = await listAll(env.TRACKER_KV, prefix, 10000);
        let deleted = 0;
        for (const entry of keys) {
          const parts = parseHistoryKey(entry.name);
          if (!parts || parts.kind !== kind || normalizeSubject(parts.subject) !== normalizeSubject(subject)) continue;
          if (student && nameKey(parts.student) !== nameKey(student)) continue;
          await env.TRACKER_KV.delete(entry.name);
          deleted++;
        }
        return json({ success: true, deleted }, 200, cors);
      }

      if (action === "student_hide_history") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 128 * 1024);
        const student = normalizeName(body.student);
        const keys = Array.isArray(body.keys) ? body.keys : body.key ? [body.key] : [];
        if (!student || !keys.length || keys.length > 200) return json({ error: "Student and 1–200 history records are required" }, 400, cors);
        const uniqueKeys = [...new Set(keys)];
        for (const key of uniqueKeys) {
          if (!validKey(key)) return json({ error: "Invalid student history key" }, 400, cors);
          const keyParts = parseHistoryKey(key);
          if (!keyParts || nameKey(keyParts.student) !== nameKey(student)) return json({ error: "History does not belong to this student" }, 403, cors);
        }
        await Promise.all(uniqueKeys.map(async key => {
          const hideKey = await hiddenKeyName(student, key);
          return env.TRACKER_KV.put(hideKey, key, { expirationTtl: HISTORY_TTL_SECONDS });
        }));
        return json({ success: true, hidden: uniqueKeys.length }, 200, cors);
      }

      if (action === "force_student_logout") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const body = await readJson(request, 4096);
        const timestamp = Date.now();
        if (body.all === true) {
          await env.TRACKER_KV.put("FORCE_LOGOUT_ALL", String(timestamp), { expirationTtl: 90 * 24 * 60 * 60 });
          const clearedPresence = await clearStudentPresence(env.TRACKER_KV);
          return json({ success: true, all: true, timestamp, clearedPresence }, 200, cors);
        }
        const student = normalizeName(body.student);
        if (!validStudentName(body.student)) return json({ error: "Valid student name required" }, 400, cors);
        await Promise.all([...new Set([student, nameKey(student)])].map(suffix => env.TRACKER_KV.put(`FORCE_LOGOUT_${suffix}`, String(timestamp), { expirationTtl: 90 * 24 * 60 * 60 })));
        const clearedPresence = await clearStudentPresence(env.TRACKER_KV, student);
        return json({ success: true, student: String(body.student).trim().slice(0, 240), timestamp, clearedPresence }, 200, cors);
      }

      if (action === "student_presence") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        const student = normalizeName(body.student);
        if (!validStudentName(body.student)) return json({ error: "Invalid student" }, 400, cors);
        const clientId = String(body.clientId || "").slice(0, 64);
        if (clientId && !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return json({ error: "Invalid client ID" }, 400, cors);
        const presenceKey = clientId ? `PRESENCE_${student}_${clientId}` : `PRESENCE_${student}`;
        if (body.active === false) {
          await env.TRACKER_KV.delete(presenceKey);
          return json({ success: true, active: false }, 200, cors);
        }
        const loginAt = Number(body.loginAt || 0);
        const allAt = Number(await env.TRACKER_KV.get("FORCE_LOGOUT_ALL") || 0);
        const studentAt = await studentLogoutTimestamp(env.TRACKER_KV, student);
        if (Math.max(allAt, studentAt) > loginAt) {
          await env.TRACKER_KV.delete(presenceKey);
          return json({ success: true, forceLogout: true }, 200, cors);
        }
        const mode = ["reading_notes", "downloading"].includes(body.mode) ? body.mode : "online";
        const item = cleanMetadata(body.item, 180);
        const itemChapter = chapterDataFromLabel(item);
        const chapterNumber = cleanMetadata(body.chapterNumber, 32, "chapterNumber") || itemChapter.chapterNumber;
        const chapterName = cleanMetadata(body.chapterName, 180, "chapterName") || itemChapter.chapterName;
        const data = {
          student: String(body.student).trim().slice(0, 240), loginAt: Number(body.loginAt || 0), mode, updatedAt: Date.now(),
          subject: String(body.subject || "").slice(0, 80),
          chapterNumber,
          chapterName,
          topic: cleanTopic(body.topic, chapterName),
          item: cleanHistoryFilename(item)
        };
        await env.TRACKER_KV.put(presenceKey, JSON.stringify(data), { expirationTtl: ONLINE_TTL_SECONDS });
        return json({ success: true, forceLogout: false, expiresIn: ONLINE_TTL_SECONDS }, 200, cors);
      }

      if (action === "delete_student_events") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const body = await readJson(request, 4096);
        if (body.id) {
          const id = String(body.id);
          if (!id.startsWith("EVENT_") || /[\u0000-\u001f\u007f]/u.test(id) || new TextEncoder().encode(id).length > 512) return json({ error: "Invalid event id" }, 400, cors);
          const exists = await env.TRACKER_KV.get(id);
          if (exists) await env.TRACKER_KV.delete(id);
          return json({ success: true, deleted: exists ? 1 : 0 }, 200, cors);
        }
        const targetStudent = body.student ? normalizeName(body.student) : "";
        if (body.all !== true && (!targetStudent || !validStudentName(body.student))) return json({ error: "Choose a student or all events" }, 400, cors);
        const keys = await listAll(env.TRACKER_KV, "EVENT_", 10000);
        let deleted = 0;
        for (const entry of keys) {
          if (body.all === true) { await env.TRACKER_KV.delete(entry.name); deleted++; continue; }
          const value = await env.TRACKER_KV.get(entry.name);
          try { if (value && nameKey(JSON.parse(value).student) === nameKey(targetStudent)) { await env.TRACKER_KV.delete(entry.name); deleted++; } } catch { /* leave malformed records for manual review */ }
        }
        return json({ success: true, deleted }, 200, cors);
      }

      if (action === "student_event") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        const student = normalizeName(body.student);
        const kind = body.kind;
        if (!validStudentName(body.student) || !["login", "visit"].includes(kind)) return json({ error: "Invalid student event" }, 400, cors);
        const eventId = String(body.eventId || crypto.randomUUID());
        if (!/^[A-Za-z0-9-]{16,64}$/.test(eventId)) return json({ error: "Invalid event id" }, 400, cors);
        const key = `EVENT_${student}_${eventId}`;
        if (await env.TRACKER_KV.get(key)) return json({ success: true, eventId: key, duplicate: true, expiresIn: HISTORY_TTL_SECONDS }, 200, cors);
        const event = { id: key, student: String(body.student).trim().slice(0, 240), kind, timestamp: Date.now() };
        await env.TRACKER_KV.put(key, JSON.stringify(event), { expirationTtl: HISTORY_TTL_SECONDS });
        return json({ success: true, eventId: key, expiresIn: HISTORY_TTL_SECONDS }, 201, cors);
      }

      if (action === "get_student_events") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        const keys = await listAll(env.TRACKER_KV, "EVENT_", 10000);
        const events = [];
        const expired = [];
        const cutoff = Date.now() - HISTORY_TTL_SECONDS * 1000;
        for (let offset = 0; offset < keys.length; offset += 100) {
          const batch = await Promise.all(keys.slice(offset, offset + 100).map(async entry => ({ entry, value: await env.TRACKER_KV.get(entry.name) })));
          for (const { entry, value } of batch) {
            if (!value) continue;
            try {
              const event = JSON.parse(value);
              if (Number(event.timestamp) >= cutoff) events.push({ ...event, id: entry.name });
              else expired.push(entry.name);
            } catch { /* ignore malformed legacy event */ }
          }
        }
        if (expired.length) await Promise.all(expired.map(key => env.TRACKER_KV.delete(key)));
        events.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
        const onlineStudents = await listActiveStudentPresence(env.TRACKER_KV);
        return json({ events, onlineStudents }, 200, cors);
      }
      if (action === "heartbeat") {
        if (method !== "POST") return json({ error: "Use POST" }, 405, cors);
        const body = await readJson(request, 4096);
        const subject = normalizeName(body.subj), student = normalizeName(body.studentName);
        if (!validSubject(subject) || !validStudentName(body.studentName)) return json({ error: "Invalid heartbeat" }, 400, cors);
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

      if (action === "get_online_students") {
        if (method !== "GET") return json({ error: "Use GET" }, 405, cors);
        if (!(await isAdmin(request, url, env))) return json({ error: "Unauthorized" }, 401, cors);
        return json(await listActiveStudentPresence(env.TRACKER_KV), 200, cors);
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
