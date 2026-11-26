// Replaced with CommonJS + idempotente migraties gebaseerd op appelkaas_db.sql
require('dotenv').config();
const mysql = require('mysql2/promise');

let pool;

async function setSessionTimeZone(conn) {
  try {
    // Probeer named timezone (vereist timezone tables)
    await conn.query("SET time_zone = 'Europe/Amsterdam'");
  } catch {
    // Fallback: offset (werkt zonder timezone tables)
    try {
      const offsetMinutes = -1 * new Date().getTimezoneOffset(); // CET/CEST klopt als TZ=Europe/Amsterdam
      const sign = offsetMinutes >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutes);
      const hh = String(Math.floor(abs / 60)).padStart(2, '0');
      const mm = String(abs % 60).padStart(2, '0');
      await conn.query('SET time_zone = ?', [`${sign}${hh}:${mm}`]);
    } catch (e2) {
      console.warn('[DB] Kon time_zone niet instellen:', e2.message || e2);
    }
  }
}

async function setSessionCharsetCollation(conn) {
  try {
    await conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
  } catch (e) {
    console.warn('[DB] Kon sessie-charset/collatie niet instellen:', e.message || e);
  }
}

async function tableExists(table) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return rows[0]?.c > 0;
}

async function ensureTable(table, createSql) {
  if (!(await tableExists(table))) {
    await pool.query(createSql);
    console.log(`[DB] Tabel aangemaakt: ${table}`);
  }
}

async function hasPrimaryKey(table) {
  const [rows] = await pool.query(`SHOW KEYS FROM \`${table}\` WHERE Key_name = 'PRIMARY'`);
  return rows.length > 0;
}

async function ensurePrimaryKey(table, columns) {
  if (!(await hasPrimaryKey(table))) {
    await pool.query(
      `ALTER TABLE \`${table}\` ADD PRIMARY KEY (${columns.map(c => `\`${c}\``).join(', ')})`
    );
    console.log(`[DB] PRIMARY KEY toegevoegd op ${table}: ${columns.join(', ')}`);
  }
}

async function indexExists(table, name) {
  const [rows] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
  return rows.length > 0;
}

async function ensureUniqueKey(table, name, columns) {
  if (!(await indexExists(table, name))) {
    await pool.query(
      `ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${name}\` (${columns.map(c => `\`${c}\``).join(', ')})`
    );
    console.log(`[DB] UNIQUE KEY toegevoegd op ${table}: ${name}`);
  }
}

async function ensureKey(table, name, columns) {
  if (!(await indexExists(table, name))) {
    await pool.query(
      `ALTER TABLE \`${table}\` ADD KEY \`${name}\` (${columns.map(c => `\`${c}\``).join(', ')})`
    );
    console.log(`[DB] KEY toegevoegd op ${table}: ${name}`);
  }
}

async function isAutoIncrement(table, column) {
  const [rows] = await pool.query(
    `SELECT EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Boolean(rows[0]?.EXTRA?.includes('auto_increment'));
}

async function ensureAutoIncrementInt(table, column) {
  if (!(await isAutoIncrement(table, column))) {
    await pool.query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` int NOT NULL AUTO_INCREMENT`);
    console.log(`[DB] AUTO_INCREMENT ingesteld op ${table}.${column}`);
  }
}

async function fkExists(name) {
  const [rows] = await pool.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS 
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?`,
    [name]
  );
  return rows.length > 0;
}

async function ensureForeignKey(table, name, columnList, refTable, refColumns, onDelete = 'CASCADE', onUpdate = 'NO ACTION') {
  if (!(await fkExists(name))) {
    await pool.query(
      `ALTER TABLE \`${table}\` 
       ADD CONSTRAINT \`${name}\` 
       FOREIGN KEY (${columnList.map(c => `\`${c}\``).join(', ')})
       REFERENCES \`${refTable}\` (${refColumns.map(c => `\`${c}\``).join(', ')})
       ON DELETE ${onDelete} ON UPDATE ${onUpdate}`
    );
    console.log(`[DB] FOREIGN KEY toegevoegd: ${name}`);
  }
}

async function getTableCollation(table) {
  const [rows] = await pool.query(
    `SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return rows[0]?.TABLE_COLLATION || null;
}

async function ensureTableCollation(table, charset = 'utf8mb4', collate = 'utf8mb4_unicode_ci') {
  try {
    const current = await getTableCollation(table);
    if (current && current !== collate) {
      await pool.query(`ALTER TABLE \`${table}\` CONVERT TO CHARACTER SET ${charset} COLLATE ${collate}`);
      console.log(`[DB] Tabelcollatie bijgewerkt: ${table} -> ${collate}`);
    }
  } catch (e) {
    console.warn(`[DB] Kon collatie niet aanpassen voor ${table}:`, e.message || e);
  }
}

async function migrate() {
  // Tabellen (CREATE IF NOT EXISTS) — gebaseerd op apelkaas_db.sql
  await ensureTable('giveaway', `
    CREATE TABLE IF NOT EXISTS \`giveaway\` (
      \`id\` int NOT NULL,
      \`message_id\` varchar(32) NOT NULL,
      \`channel_id\` varchar(32) NOT NULL,
      \`prize\` varchar(255) NOT NULL,
      \`winners\` int NOT NULL,
      \`end_time\` datetime NOT NULL,
      \`ended\` tinyint(1) DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureTable('giveaway_entry', `
    CREATE TABLE IF NOT EXISTS \`giveaway_entry\` (
      \`id\` int NOT NULL,
      \`giveaway_id\` int NOT NULL,
      \`user_id\` varchar(32) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureTable('tempban', `
    CREATE TABLE IF NOT EXISTS \`tempban\` (
      \`tempbanid\` int NOT NULL,
      \`userid\` varchar(45) NOT NULL,
      \`expiration_date\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureTable('warn', `
    CREATE TABLE IF NOT EXISTS \`warn\` (
      \`warnid\` int NOT NULL,
      \`userid\` varchar(45) NOT NULL,
      \`reason\` text NOT NULL,
      \`date\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureTable('checkin_session', `
    CREATE TABLE IF NOT EXISTS \`checkin_session\` (
      \`id\` int NOT NULL,
      \`guild_id\` varchar(32) NOT NULL,
      \`channel_id\` varchar(32) DEFAULT NULL,
      \`started_by\` varchar(32) DEFAULT NULL,
      \`started_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`ended_at\` datetime DEFAULT NULL,
      \`active_round\` int NOT NULL DEFAULT 0,
      \`active\` tinyint(1) NOT NULL DEFAULT 1,
      \`name\` text DEFAULT NULL,
      \`minute_offset\` int NOT NULL DEFAULT 0,
      \`allow_late_join_after_round1_reset\` tinyint(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try {
    const [colRows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkin_session' AND COLUMN_NAME = 'minute_offset' LIMIT 1`
    );
    if (!colRows.length) {
      await pool.query("ALTER TABLE `checkin_session` ADD COLUMN `minute_offset` int NOT NULL DEFAULT 0");
      console.log('[DB] Kolom minute_offset toegevoegd aan checkin_session');
    }
  } catch (e) {
    console.warn('[DB] Kon minute_offset niet toevoegen:', e.message || e);
  }

  try {
    const [colRows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkin_session' AND COLUMN_NAME = 'allow_late_join_after_round1_reset' LIMIT 1`
    );
    if (!colRows.length) {
      await pool.query("ALTER TABLE `checkin_session` ADD COLUMN `allow_late_join_after_round1_reset` tinyint(1) NOT NULL DEFAULT 0");
      console.log('[DB] Kolom allow_late_join_after_round1_reset toegevoegd aan checkin_session');
    }
  } catch (e) {
    console.warn('[DB] Kon allow_late_join_after_round1_reset niet toevoegen:', e.message || e);
  }

  await ensureTable('checkin_round', `
    CREATE TABLE IF NOT EXISTS \`checkin_round\` (
      \`id\` int NOT NULL,
      \`session_id\` int NOT NULL,
      \`round_number\` int NOT NULL,
      \`word\` varchar(64) NOT NULL,
      \`start_time\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureTable('checkin_player', `
    CREATE TABLE IF NOT EXISTS \`checkin_player\` (
      \`id\` int NOT NULL,
      \`session_id\` int NOT NULL,
      \`user_id\` varchar(32) NOT NULL,
      \`joined_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`eliminated\` tinyint(1) NOT NULL DEFAULT 0,
      \`eliminated_reason\` varchar(32) DEFAULT NULL,
      \`eliminated_at\` datetime DEFAULT NULL,
      \`total_checkins\` int NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureTable('checkin_entry', `
    CREATE TABLE IF NOT EXISTS \`checkin_entry\` (
      \`id\` int NOT NULL,
      \`session_id\` int NOT NULL,
      \`round_id\` int NOT NULL,
      \`user_id\` varchar(32) NOT NULL,
      \`word_submitted\` varchar(64) DEFAULT NULL,
      \`is_correct\` tinyint(1) NOT NULL DEFAULT 0,
      \`submitted_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Indexen/keys
  await ensurePrimaryKey('giveaway', ['id']);
  await ensureAutoIncrementInt('giveaway', 'id');

  await ensurePrimaryKey('giveaway_entry', ['id']);
  await ensureUniqueKey('giveaway_entry', 'giveaway_id', ['giveaway_id', 'user_id']);
  await ensureAutoIncrementInt('giveaway_entry', 'id');

  await ensurePrimaryKey('tempban', ['tempbanid']);
  await ensureUniqueKey('tempban', 'userid_UNIQUE', ['userid']);
  await ensureAutoIncrementInt('tempban', 'tempbanid');

  await ensurePrimaryKey('warn', ['warnid']);
  await ensureAutoIncrementInt('warn', 'warnid');

  await ensurePrimaryKey('checkin_session', ['id']);
  await ensureKey('checkin_session', 'idx_checkin_session_guild_active', ['guild_id', 'active']);
  await ensureAutoIncrementInt('checkin_session', 'id');

  await ensurePrimaryKey('checkin_round', ['id']);
  await ensureUniqueKey('checkin_round', 'uniq_session_round', ['session_id', 'round_number']);
  await ensureKey('checkin_round', 'idx_checkin_round_session', ['session_id']);
  await ensureAutoIncrementInt('checkin_round', 'id');

  await ensurePrimaryKey('checkin_player', ['id']);
  await ensureUniqueKey('checkin_player', 'uniq_session_user', ['session_id', 'user_id']);
  await ensureKey('checkin_player', 'idx_checkin_player_session', ['session_id']);
  await ensureAutoIncrementInt('checkin_player', 'id');

  await ensurePrimaryKey('checkin_entry', ['id']);
  await ensureUniqueKey('checkin_entry', 'uniq_session_round_user', ['session_id', 'round_id', 'user_id']);
  await ensureKey('checkin_entry', 'idx_checkin_entry_session_round', ['session_id', 'round_id']);
  await ensureAutoIncrementInt('checkin_entry', 'id');

  // Foreign keys
  await ensureForeignKey('checkin_round', 'fk_round_session', ['session_id'], 'checkin_session', ['id'], 'CASCADE');
  await ensureForeignKey('checkin_player', 'fk_player_session', ['session_id'], 'checkin_session', ['id'], 'CASCADE');
  await ensureForeignKey('checkin_entry', 'fk_entry_session', ['session_id'], 'checkin_session', ['id'], 'CASCADE');
  await ensureForeignKey('checkin_entry', 'fk_entry_round', ['round_id'], 'checkin_round', ['id'], 'CASCADE');

  // Collatie afdwingen voor bestaande tabellen (zonder overschrijven van data)
  await ensureTableCollation('giveaway');
  await ensureTableCollation('giveaway_entry');
  await ensureTableCollation('tempban');
  await ensureTableCollation('warn');
  await ensureTableCollation('checkin_session');
  await ensureTableCollation('checkin_round');
  await ensureTableCollation('checkin_player');
  await ensureTableCollation('checkin_entry');
}

async function initDB() {
  pool = await mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0
  });

  const conn = await pool.getConnection();
  console.log('MySQL verbonden als ID ' + conn.threadId);
  try {
    await setSessionTimeZone(conn);
    await setSessionCharsetCollation(conn);
  } finally {
    conn.release();
  }

  await migrate();
  console.log('✅ Database gecontroleerd en up-to-date.');
}

function getPool() {
  if (!pool) throw new Error('DB pool is nog niet geïnitialiseerd. Roep initDB() eerst aan.');
  return pool;
}

module.exports = { initDB, getPool };