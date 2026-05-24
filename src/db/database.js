const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

// Ensure data directory exists
const dataDir = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(process.cwd(), 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, 'catherine.db');

let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  // Fallback to in-memory for environments without write access
  logger.warn(`Could not open DB at ${dbPath}: ${err.message}. Using in-memory DB.`);
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
}

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firstName TEXT NOT NULL,
    lastName TEXT,
    phone_number TEXT NOT NULL UNIQUE,
    companyName TEXT,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    booked_at TEXT,
    booking_details TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    call_sid TEXT UNIQUE,
    attempt_number INTEGER,
    started_at TEXT,
    ended_at TEXT,
    duration_seconds INTEGER,
    outcome TEXT,
    booked INTEGER NOT NULL DEFAULT 0,
    next_action TEXT,
    transcript TEXT,
    language_detected TEXT,
    sheets_logged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL UNIQUE,
    lead_id INTEGER REFERENCES leads(id),
    state TEXT NOT NULL DEFAULT 'init',
    language TEXT NOT NULL DEFAULT 'fr',
    history TEXT NOT NULL DEFAULT '[]',
    attempt_number INTEGER NOT NULL DEFAULT 1,
    email_collected TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

logger.info(`Database initialized at ${dbPath}`);

module.exports = db;
