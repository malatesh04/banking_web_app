require('dotenv').config();
/**
 * State Bank of Karnataka — Database Layer
 *
 * LOCAL  (development) : sql.js SQLite  → bank.db
 * PRODUCTION (Vercel)  : Neon PostgreSQL / Aiven MySQL → DATABASE_URL env var
 */

const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const hasDbUrl = !!process.env.DATABASE_URL;
const isMysql = hasDbUrl && process.env.DATABASE_URL.startsWith('mysql');
const isPg = hasDbUrl && !isMysql;

if (isProd && !hasDbUrl) {
  const errorMsg = '❌ FATAL ERROR: Running on Vercel but DATABASE_URL is missing. SQLite fallback is not supported in serverless environments. Please add DATABASE_URL to your Vercel Project Settings.';
  console.error(errorMsg);
}

if (isMysql) {
  console.log('🌐 Database Mode: MySQL (Production)');

  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    uri: process.env.DATABASE_URL,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: { rejectUnauthorized: false }
  });

  let initializationPromise = null;

  async function getDb() {
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS users (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            username       VARCHAR(255) NOT NULL,
            phone          VARCHAR(50) UNIQUE NOT NULL,
            password       VARCHAR(255) NOT NULL,
            balance        DECIMAL(15,2) NOT NULL DEFAULT 0.00,
            account_number VARCHAR(100) UNIQUE,
            jwt_token      TEXT,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS transactions (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            sender_id   INT NOT NULL,
            receiver_id INT NOT NULL,
            amount      DECIMAL(15,2) NOT NULL,
            type        VARCHAR(50) NOT NULL DEFAULT 'transfer',
            timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users(id),
            FOREIGN KEY (receiver_id) REFERENCES users(id)
          )
        `);
        console.log('✅ MySQL schema ready');
        return pool;
      } catch (err) {
        console.error('❌ MySQL Schema Error:', err.message);
        initializationPromise = null;
        throw err;
      }
    })();

    return initializationPromise;
  }

  async function dbRun(db, sql, params) {
    const [result] = await db.execute(sql, params || []);
    return { lastID: result.insertId || null, rowCount: result.affectedRows };
  }

  async function dbGet(db, sql, params) {
    const [rows] = await db.query(sql, params || []);
    return rows.length > 0 ? rows[0] : null;
  }

  async function dbAll(db, sql, params) {
    const [rows] = await db.query(sql, params || []);
    return rows;
  }

  function persistDb() { }

  async function generateAccountNumber(db) {
    const BANK_CODE = '4501';
    let acctNum;
    let attempts = 0;
    while (attempts < 100) {
      const random6 = String(Math.floor(100000 + Math.random() * 900000));
      acctNum = BANK_CODE + random6;
      const row = await dbGet(db, 'SELECT id FROM users WHERE account_number = ?', [acctNum]);
      if (!row) return acctNum;
      attempts++;
    }
    throw new Error('Could not generate unique account number.');
  }

  module.exports = { getDb, dbRun, dbGet, dbAll, persistDb, generateAccountNumber, isPg: false, isMysql: true };

} else if (isPg) {
  console.log('🌐 Database Mode: PostgreSQL (Production)');

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  function toPostgres(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  let initializationPromise = null;

  async function getDb() {
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id             SERIAL PRIMARY KEY,
            username       TEXT    NOT NULL,
            phone          TEXT    UNIQUE NOT NULL,
            password       TEXT    NOT NULL,
            balance        NUMERIC(15,2) NOT NULL DEFAULT 0.00,
            account_number TEXT    UNIQUE,
            jwt_token      TEXT,
            created_at     TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS transactions (
            id          SERIAL PRIMARY KEY,
            sender_id   INTEGER NOT NULL REFERENCES users(id),
            receiver_id INTEGER NOT NULL REFERENCES users(id),
            amount      NUMERIC(15,2) NOT NULL,
            type        TEXT NOT NULL DEFAULT 'transfer',
            timestamp   TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await client.query('COMMIT');
        console.log('✅ PostgreSQL schema ready');
        return pool;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Postgres Schema Error:', err.message);
        initializationPromise = null;
        throw err;
      } finally {
        client.release();
      }
    })();

    return initializationPromise;
  }

  async function dbRun(db, sql, params) {
    const res = await db.query(toPostgres(sql), params || []);
    return { lastID: res.rows[0]?.id || null, rowCount: res.rowCount };
  }

  async function dbGet(db, sql, params) {
    const res = await db.query(toPostgres(sql), params || []);
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  async function dbAll(db, sql, params) {
    const res = await db.query(toPostgres(sql), params || []);
    return res.rows;
  }

  function persistDb() { }

  async function generateAccountNumber(db) {
    const BANK_CODE = '4501';
    let acctNum;
    let attempts = 0;
    while (attempts < 100) {
      const random6 = String(Math.floor(100000 + Math.random() * 900000));
      acctNum = BANK_CODE + random6;
      const row = await dbGet(db, 'SELECT id FROM users WHERE account_number = ?', [acctNum]);
      if (!row) return acctNum;
      attempts++;
    }
    throw new Error('Could not generate unique account number.');
  }

  module.exports = { getDb, dbRun, dbGet, dbAll, persistDb, generateAccountNumber, isPg: true, isMysql: false };

} else {
  // ═══════════════════════════════════════════════════════
  //  LOCAL — sql.js SQLite
  // ═══════════════════════════════════════════════════════
  const path = require('path');
  const fs = require('fs');
  const DB_PATH = path.join(__dirname, '..', '..', 'bank.db');
  let dbInstance = null;

  function persistDb(db) {
    if (!db) return;
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (err) {
      console.error('❌ DB persist error:', err.message);
    }
  }

  async function getDb() {
    if (dbInstance) return dbInstance;

    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      dbInstance = new SQL.Database(fs.readFileSync(DB_PATH));
      console.log('✅ Loaded existing database from disk');
    } else {
      dbInstance = new SQL.Database();
      console.log('✅ Created new memory database');
    }

    dbInstance.run(`
      CREATE TABLE IF NOT EXISTS users (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        username       TEXT    NOT NULL,
        phone          TEXT    UNIQUE NOT NULL,
        password       TEXT    NOT NULL,
        balance        REAL    NOT NULL DEFAULT 0.0,
        account_number TEXT    UNIQUE,
        jwt_token      TEXT,
        created_at     TEXT    DEFAULT (datetime('now'))
      )
    `);
    dbInstance.run(`
      CREATE TABLE IF NOT EXISTS transactions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id   INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        amount      REAL    NOT NULL,
        type        TEXT    NOT NULL DEFAULT 'transfer',
        timestamp   TEXT    DEFAULT (datetime('now')),
        FOREIGN KEY (sender_id)   REFERENCES users(id),
        FOREIGN KEY (receiver_id) REFERENCES users(id)
      )
    `);

    try { dbInstance.run(`ALTER TABLE transactions ADD COLUMN type TEXT NOT NULL DEFAULT 'transfer'`); } catch (_) { }
    try { dbInstance.run(`ALTER TABLE users ADD COLUMN account_number TEXT`); } catch (_) { }

    persistDb(dbInstance);
    return dbInstance;
  }

  async function dbRun(db, sql, params) {
    db.run(sql, params || []);
    const res = db.exec('SELECT last_insert_rowid() AS id');
    const lastID = res[0]?.values[0][0];
    return { lastID };
  }

  async function dbGet(db, sql, params) {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const hasRow = stmt.step();
    const row = hasRow ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  async function dbAll(db, sql, params) {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  async function generateAccountNumber(db) {
    const BANK_CODE = '4501';
    let acctNum;
    let attempts = 0;
    while (attempts < 100) {
      const random6 = String(Math.floor(100000 + Math.random() * 900000));
      acctNum = BANK_CODE + random6;
      const row = await dbGet(db, 'SELECT id FROM users WHERE account_number = ?', [acctNum]);
      if (!row) return acctNum;
      attempts++;
    }
    throw new Error('Could not generate unique account number.');
  }

  module.exports = { getDb, dbRun, dbGet, dbAll, persistDb, generateAccountNumber, isPg: false, isMysql: false };
}
