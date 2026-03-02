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
