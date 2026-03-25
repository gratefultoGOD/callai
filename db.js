// ─── db.js — SQLite Persistence Layer ─────────────────────────────────
// Single source of truth for all database operations.
// Uses better-sqlite3 (synchronous, no callback hell).

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "voiceagent.db");
const db = new Database(DB_PATH);

// ── Performance pragmas ─────────────────────────────────────────────────
db.pragma("journal_mode = WAL");   // Write-Ahead Logging — faster concurrent reads
db.pragma("foreign_keys = ON");    // Enforce FK constraints

// ── Schema ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    google_id   TEXT,
    picture     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL  -- Unix ms timestamp
  );

  CREATE TABLE IF NOT EXISTS agents (
    id                TEXT PRIMARY KEY,
    owner_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    description       TEXT DEFAULT '',
    system_prompt     TEXT NOT NULL,
    greeting          TEXT DEFAULT '',
    voice             TEXT DEFAULT 'coral',
    language          TEXT DEFAULT 'en-US',
    first_message     TEXT DEFAULT '',
    enable_tools      INTEGER DEFAULT 0,  -- 0/1 boolean
    tools             TEXT DEFAULT '[]',  -- JSON array string
    phone_number      TEXT,
    phone_number_sid  TEXT,
    status            TEXT DEFAULT 'active',
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id                TEXT PRIMARY KEY,
    type              TEXT NOT NULL,
    property_id       TEXT NOT NULL,
    property_title    TEXT NOT NULL,
    customer_name     TEXT NOT NULL,
    customer_phone    TEXT NOT NULL,
    date              TEXT,
    time              TEXT,
    notes             TEXT DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS page_views (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL,
    method          TEXT NOT NULL DEFAULT 'GET',
    status_code     INTEGER DEFAULT 200,
    ip              TEXT,
    user_agent      TEXT,
    referer         TEXT,
    response_time   INTEGER,  -- milliseconds
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);
  CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);

  CREATE TABLE IF NOT EXISTS google_calendar_tokens (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expiry_date   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Prepared Statements — Users ─────────────────────────────────────────
const stmts = {
  // Users
  userInsert: db.prepare(`
    INSERT INTO users (id, email, name, password_hash, google_id, picture, created_at)
    VALUES (@id, @email, @name, @password_hash, @google_id, @picture, @created_at)
  `),
  userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  userLinkGoogle: db.prepare(`UPDATE users SET google_id = ?, picture = ? WHERE id = ?`),

  // Sessions
  sessionInsert: db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)
  `),
  sessionByToken: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  sessionDelete: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  sessionCleanup: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),

  // Agents
  agentInsert: db.prepare(`
    INSERT INTO agents
      (id, owner_id, name, description, system_prompt, greeting, voice, language,
       first_message, enable_tools, tools, phone_number, phone_number_sid, status, created_at)
    VALUES
      (@id, @owner_id, @name, @description, @system_prompt, @greeting, @voice, @language,
       @first_message, @enable_tools, @tools, @phone_number, @phone_number_sid, @status, @created_at)
  `),
  agentById: db.prepare(`SELECT * FROM agents WHERE id = ?`),
  agentsByOwner: db.prepare(`SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC`),
  agentAll: db.prepare(`SELECT * FROM agents ORDER BY created_at DESC`),
  agentByPhone: db.prepare(`SELECT * FROM agents WHERE phone_number = ?`),
  agentUpdate: db.prepare(`
    UPDATE agents SET
      name = @name, description = @description, system_prompt = @system_prompt,
      greeting = @greeting, voice = @voice, language = @language,
      first_message = @first_message, enable_tools = @enable_tools,
      tools = @tools, phone_number = @phone_number, phone_number_sid = @phone_number_sid,
      status = @status
    WHERE id = @id
  `),
  agentDelete: db.prepare(`DELETE FROM agents WHERE id = ?`),

  // Reservations
  reservationInsert: db.prepare(`
    INSERT INTO reservations
      (id, type, property_id, property_title, customer_name, customer_phone, date, time, notes, created_at)
    VALUES
      (@id, @type, @property_id, @property_title, @customer_name, @customer_phone, @date, @time, @notes, @created_at)
  `),
  reservationAll: db.prepare(`SELECT * FROM reservations ORDER BY created_at DESC`),

  // Analytics — Page Views
  pageViewInsert: db.prepare(`
    INSERT INTO page_views (path, method, status_code, ip, user_agent, referer, response_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `),
  pageViewsTotal: db.prepare(`SELECT COUNT(*) as count FROM page_views`),
  pageViewsToday: db.prepare(`SELECT COUNT(*) as count FROM page_views WHERE date(created_at) = date('now')`),
  pageViewsLast7Days: db.prepare(`SELECT COUNT(*) as count FROM page_views WHERE created_at >= datetime('now', '-7 days')`),
  pageViewsByPath: db.prepare(`
    SELECT path, COUNT(*) as count
    FROM page_views
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY path ORDER BY count DESC LIMIT 20
  `),
  pageViewsByDay: db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM page_views
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY day ORDER BY day ASC
  `),
  pageViewsByHour: db.prepare(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM page_views
    WHERE date(created_at) = date('now')
    GROUP BY hour ORDER BY hour ASC
  `),
  pageViewsByUserAgent: db.prepare(`
    SELECT user_agent, COUNT(*) as count
    FROM page_views
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY user_agent ORDER BY count DESC LIMIT 10
  `),
  pageViewsByReferer: db.prepare(`
    SELECT referer, COUNT(*) as count
    FROM page_views
    WHERE referer IS NOT NULL AND referer != ''
    AND created_at >= datetime('now', '-30 days')
    GROUP BY referer ORDER BY count DESC LIMIT 10
  `),
  pageViewsRecent: db.prepare(`
    SELECT * FROM page_views ORDER BY id DESC LIMIT 100
  `),
  pageViewsUniqueIPs: db.prepare(`SELECT COUNT(DISTINCT ip) as count FROM page_views WHERE created_at >= datetime('now', '-7 days')`),
  pageViewsAvgResponse: db.prepare(`SELECT AVG(response_time) as avg FROM page_views WHERE response_time IS NOT NULL AND created_at >= datetime('now', '-7 days')`),

  // Google Calendar Tokens
  gcalTokenByUser: db.prepare(`SELECT * FROM google_calendar_tokens WHERE user_id = ?`),
  gcalTokenInsert: db.prepare(`
    INSERT INTO google_calendar_tokens (user_id, access_token, refresh_token, expiry_date, created_at, updated_at)
    VALUES (@user_id, @access_token, @refresh_token, @expiry_date, datetime('now'), datetime('now'))
  `),
  gcalTokenUpdate: db.prepare(`
    UPDATE google_calendar_tokens
    SET access_token = @access_token, refresh_token = @refresh_token, expiry_date = @expiry_date, updated_at = datetime('now')
    WHERE user_id = @user_id
  `),
  gcalTokenDelete: db.prepare(`DELETE FROM google_calendar_tokens WHERE user_id = ?`),
};

// ── Helper: row → JS agent object (parse JSON fields) ───────────────────
function rowToAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    greeting: row.greeting,
    voice: row.voice,
    language: row.language,
    firstMessage: row.first_message,
    enableTools: row.enable_tools === 1,
    tools: JSON.parse(row.tools || "[]"),
    phoneNumber: row.phone_number,
    phoneNumberSid: row.phone_number_sid,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ── Helper: row → JS user object ────────────────────────────────────────
function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    googleId: row.google_id,
    picture: row.picture,
    createdAt: row.created_at,
  };
}

// ── Expired session cleanup (run every 30 minutes) ──────────────────────
setInterval(() => {
  const deleted = stmts.sessionCleanup.run(Date.now());
  if (deleted.changes > 0) console.log(`🧹 Cleaned ${deleted.changes} expired session(s)`);
}, 30 * 60 * 1000);

// ── Exported DB API ─────────────────────────────────────────────────────
module.exports = {
  db,
  stmts,
  rowToAgent,
  rowToUser,
};
