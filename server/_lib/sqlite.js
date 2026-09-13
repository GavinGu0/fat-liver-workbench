'use strict';
/**
 * SQLite 存储适配器（基于 Node 22+ 内置 node:sqlite，零外部依赖）
 *
 * 设计：用关系表模拟 memoryStore（Redis 风格）的全部数据结构，
 *      与 memoryStore 接口 1:1 对齐，业务层无感知切换。
 *
 * 数据表：
 *   kv     — KV 值 / 计数器（业务层传入的均为 JSON 字符串，原样存取）
 *   hashes — Hash（字段值 JSON 编码，保证类型保真回读）
 *   lists  — List（pos 单调定位，支持 lpush/rpush/lrange/ltrim）
 *   sets   — Set 成员
 *   zsets  — SortedSet（score REAL + (key,score) 索引）
 *
 * TTL：所有表带 exp 列（毫秒时间戳），读取时过滤 + 30s 定期 GC 清扫。
 * 持久化：本地落盘 <项目>/data/flwb.db（WAL 模式）；Vercel 上自动落 /tmp（实例级临时）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TABLES = ['kv', 'hashes', 'lists', 'sets', 'zsets'];

function open(dbPath, opts = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv     (key TEXT PRIMARY KEY, val TEXT, exp INTEGER);
    CREATE TABLE IF NOT EXISTS hashes (key TEXT, field TEXT, val TEXT, exp INTEGER, PRIMARY KEY (key, field));
    CREATE TABLE IF NOT EXISTS lists  (key TEXT, pos INTEGER, val TEXT, exp INTEGER, PRIMARY KEY (key, pos));
    CREATE TABLE IF NOT EXISTS sets   (key TEXT, member TEXT, exp INTEGER, PRIMARY KEY (key, member));
    CREATE TABLE IF NOT EXISTS zsets  (key TEXT, member TEXT, score REAL, exp INTEGER, PRIMARY KEY (key, member));
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_zsets_key_score ON zsets(key, score)');

  const now = () => Date.now();
  const LIVE = ' AND (exp IS NULL OR exp > ?)';
  const liveArg = () => [now()];
  // 临时运行时状态不入快照/备份（与 storage.js SNAPSHOT_SKIP_PREFIXES 保持一致）
  const SKIP = opts.skipPrefixes || [];
  const shouldKeep = (key) => !SKIP.some(p => key.startsWith(p));

  /* ---------- 通用工具 ---------- */
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  function encodeVal(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
  function decodeField(s) { try { return JSON.parse(s); } catch { return s; } }

  /** key 是否存活于任一表；返回表名或 null */
  function findKey(key) {
    for (const t of TABLES) {
      const row = db.prepare(`SELECT 1 AS x FROM ${t} WHERE key = ?${LIVE}`).get(key, now());
      if (row) return t;
    }
    return null;
  }

  /** 清除 key 在所有表中的行（类型切换/覆盖写前置操作） */
  function clearAll(key) {
    let n = 0;
    for (const t of TABLES) n += db.prepare(`DELETE FROM ${t} WHERE key = ?`).run(key).changes;
    return n;
  }

  /** 列表切片边界（与 memoryStore 公式一致，支持负索引） */
  function bounds(len, start, stop) {
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop + 1 : stop + 1;
    return [s, e];
  }

  function listArr(key) {
    return db.prepare(`SELECT val FROM lists WHERE key = ?${LIVE} ORDER BY pos ASC`).all(key, now()).map(r => r.val);
  }

  /* ---------- 定期 GC：清理过期行 ---------- */
  const gcTimer = setInterval(() => {
    try {
      let cleaned = 0;
      for (const t of TABLES) cleaned += db.prepare(`DELETE FROM ${t} WHERE exp IS NOT NULL AND exp <= ?`).run(now()).changes;
      if (cleaned > 0) console.debug('[sqlite] gc cleaned', cleaned, 'expired rows');
    } catch { /* 数据库已关闭等情况静默 */ }
  }, 30000);
  gcTimer.unref && gcTimer.unref();

  /* ---------- 存储接口（与 memoryStore 1:1 对齐） ---------- */
  const store = {
    _type: 'sqlite',
    _dbPath: dbPath,

    async get(k) {
      const row = db.prepare(`SELECT val FROM kv WHERE key = ?${LIVE}`).get(k, now());
      if (row) return row.val;
      const h = await store.hgetall(k);
      return h === null ? null : { ...h };
    },

    async set(k, v, opts = {}) {
      const val = encodeVal(v);
      const exp = opts.ex ? now() + opts.ex * 1000 : null;
      return tx(() => {
        if (opts.nx && findKey(k)) return null;
        clearAll(k);
        db.prepare('INSERT INTO kv (key, val, exp) VALUES (?, ?, ?)').run(k, val, exp);
        return 'OK';
      });
    },

    async del(...keys) {
      if (!keys.length) return 0;
      return tx(() => {
        let n = 0;
        for (const t of TABLES) {
          const ph = keys.map(() => '?').join(',');
          n += db.prepare(`DELETE FROM ${t} WHERE key IN (${ph})`).run(...keys).changes;
        }
        return n;
      });
    },

    async incr(k) {
      return tx(() => {
        const row = db.prepare(`SELECT val FROM kv WHERE key = ?${LIVE}`).get(k, now());
        if (row) {
          const n = Number(row.val || 0) + 1;
          db.prepare('UPDATE kv SET val = ? WHERE key = ?').run(String(n), k);
          return n;
        }
        // 存在于其他类型或全新 key：清空后作为计数器从头计数（对齐 memoryStore.ensure 语义）
        clearAll(k);
        db.prepare('INSERT INTO kv (key, val, exp) VALUES (?, ?, NULL)').run(k, '1');
        return 1;
      });
    },

    async expire(k, sec) {
      const exp = now() + sec * 1000;
      for (const t of TABLES) {
        const r = db.prepare(`UPDATE ${t} SET exp = ? WHERE key = ? AND (exp IS NULL OR exp > ?)`).run(exp, k, now());
        if (r.changes > 0) return 1;
      }
      return 0;
    },

    /* ---------- Hash ---------- */
    async hset(k, obj) {
      const fields = Object.entries(obj || {});
      return tx(() => {
        db.prepare('DELETE FROM kv WHERE key = ?').run(k); // 类型切换防御
        const up = db.prepare('INSERT OR REPLACE INTO hashes (key, field, val, exp) VALUES (?, ?, ?, NULL)');
        for (const [f, v] of fields) up.run(k, f, JSON.stringify(v));
        return fields.length;
      });
    },

    async hgetall(k) {
      const rows = db.prepare(`SELECT field, val FROM hashes WHERE key = ?${LIVE}`).all(k, now());
      if (!rows.length) return null;
      const o = {};
      for (const r of rows) o[r.field] = decodeField(r.val);
      return o;
    },

    /* ---------- List ---------- */
    async lpush(k, v) {
      return tx(() => {
        const min = db.prepare('SELECT MIN(pos) AS m FROM lists WHERE key = ?').get(k).m;
        const pos = (min === null || min === undefined) ? 0 : min - 1;
        db.prepare('INSERT INTO lists (key, pos, val, exp) VALUES (?, ?, ?, NULL)').run(k, pos, encodeVal(v));
        return db.prepare('SELECT COUNT(*) AS c FROM lists WHERE key = ?').get(k).c;
      });
    },

    async rpush(k, v) {
      return tx(() => {
        const max = db.prepare('SELECT MAX(pos) AS m FROM lists WHERE key = ?').get(k).m;
        const pos = (max === null || max === undefined) ? 0 : max + 1;
        db.prepare('INSERT INTO lists (key, pos, val, exp) VALUES (?, ?, ?, NULL)').run(k, pos, encodeVal(v));
        return db.prepare('SELECT COUNT(*) AS c FROM lists WHERE key = ?').get(k).c;
      });
    },

    async lrange(k, start, stop) {
      const arr = listArr(k);
      const [s, e] = bounds(arr.length, start, stop);
      return arr.slice(s, e);
    },

    async ltrim(k, start, stop) {
      return tx(() => {
        const arr = listArr(k);
        const [s, e] = bounds(arr.length, start, stop);
        const keep = arr.slice(s, e);
        db.prepare('DELETE FROM lists WHERE key = ?').run(k);
        const ins = db.prepare('INSERT INTO lists (key, pos, val, exp) VALUES (?, ?, ?, NULL)');
        keep.forEach((v, i) => ins.run(k, i, v));
        return 'OK';
      });
    },

    /* ---------- Set ---------- */
    async sadd(k, m) {
      const r = db.prepare('INSERT OR IGNORE INTO sets (key, member, exp) VALUES (?, ?, NULL)').run(k, String(m));
      return r.changes > 0 ? 1 : 0;
    },

    async srem(k, m) {
      const r = db.prepare('DELETE FROM sets WHERE key = ? AND member = ?').run(k, String(m));
      return r.changes > 0 ? 1 : 0;
    },

    async smembers(k) {
      return db.prepare(`SELECT member FROM sets WHERE key = ?${LIVE}`).all(k, now()).map(r => r.member);
    },

    async sismember(k, m) {
      const row = db.prepare(`SELECT 1 AS x FROM sets WHERE key = ? AND member = ?${LIVE}`).get(k, String(m), now());
      return row ? 1 : 0;
    },

    /* ---------- SortedSet ---------- */
    async zadd(k, score, member) {
      const r = db.prepare('INSERT OR REPLACE INTO zsets (key, member, score, exp) VALUES (?, ?, ?, NULL)')
        .run(k, String(member), Number(score));
      return r.changes > 0 ? 1 : 0;
    },

    async zrem(k, member) {
      const r = db.prepare('DELETE FROM zsets WHERE key = ? AND member = ?').run(k, String(member));
      return r.changes > 0 ? 1 : 0;
    },

    async zcard(k) {
      return db.prepare(`SELECT COUNT(*) AS c FROM zsets WHERE key = ?${LIVE}`).get(k, now()).c;
    },

    async zscore(k, member) {
      const row = db.prepare(`SELECT score FROM zsets WHERE key = ? AND member = ?${LIVE}`).get(k, String(member), now());
      return row ? Number(row.score) : null;
    },

    async zcount(k, min, max) {
      return db.prepare(`SELECT COUNT(*) AS c FROM zsets WHERE key = ? AND score >= ? AND score <= ?${LIVE}`)
        .get(k, Number(min), Number(max), now()).c;
    },

    async zrevrange(k, start, stop, opts = {}) {
      const rows = db.prepare(`SELECT member, score FROM zsets WHERE key = ?${LIVE} ORDER BY score DESC, member ASC`)
        .all(k, now());
      const [s, e] = bounds(rows.length, start, stop);
      const slice = rows.slice(s, e);
      if (!opts.withScores) return slice.map(r => r.member);
      const flat = [];
      for (const r of slice) { flat.push(r.member); flat.push(Number(r.score)); }
      return flat;
    },

    async zrangebyscore(k, min, max, opts = {}) {
      let rows = db.prepare(`SELECT member, score FROM zsets WHERE key = ? AND score >= ? AND score <= ?${LIVE} ORDER BY score ASC, member ASC`)
        .all(k, Number(min), Number(max), now());
      const lim = opts.limit || {};
      const off = lim.offset || 0;
      rows = rows.slice(off, lim.count ? off + lim.count : undefined);
      if (opts.withScores) {
        const flat = [];
        for (const r of rows) { flat.push(r.member); flat.push(Number(r.score)); }
        return flat;
      }
      return rows.map(r => r.member);
    },

    async ping() { return 'PONG'; },

    /* ---------- 运维接口 ---------- */
    _stats() {
      const s = { total: 0, kv: 0, hash: 0, list: 0, set: 0, zset: 0, dbPath, driver: 'sqlite' };
      s.kv = db.prepare(`SELECT COUNT(*) AS c FROM kv${LIVE.replace(' AND', ' WHERE')}`).get(now()).c;
      s.hash = db.prepare(`SELECT COUNT(*) AS c FROM hashes${LIVE.replace(' AND', ' WHERE')}`).get(now()).c;
      s.list = db.prepare(`SELECT COUNT(*) AS c FROM lists${LIVE.replace(' AND', ' WHERE')}`).get(now()).c;
      s.set = db.prepare(`SELECT COUNT(*) AS c FROM sets${LIVE.replace(' AND', ' WHERE')}`).get(now()).c;
      s.zset = db.prepare(`SELECT COUNT(*) AS c FROM zsets${LIVE.replace(' AND', ' WHERE')}`).get(now()).c;
      s.total = s.kv + s.hash + s.list + s.set + s.zset;
      return s;
    },

    /** 导出全部数据为行式结构（与 memoryStore._export / L3 Blob 快照统一格式） */
    _export() {
      const t = now();
      const out = { kv: [], hashes: [], lists: [], sets: [], zsets: [] };
      for (const r of db.prepare('SELECT key, val, exp FROM kv').all()) {
        if (shouldKeep(r.key) && (!r.exp || r.exp > t)) out.kv.push(r);
      }
      for (const r of db.prepare('SELECT key, field, val, exp FROM hashes').all()) {
        if (shouldKeep(r.key) && (!r.exp || r.exp > t)) out.hashes.push(r);
      }
      for (const r of db.prepare('SELECT key, pos, val, exp FROM lists').all()) {
        if (shouldKeep(r.key) && (!r.exp || r.exp > t)) out.lists.push(r);
      }
      for (const r of db.prepare('SELECT key, member, exp FROM sets').all()) {
        if (shouldKeep(r.key) && (!r.exp || r.exp > t)) out.sets.push(r);
      }
      for (const r of db.prepare('SELECT key, member, score, exp FROM zsets').all()) {
        if (shouldKeep(r.key) && (!r.exp || r.exp > t)) out.zsets.push(r);
      }
      return out;
    },

    /** 从行式结构恢复（事务内全量替换；用于 L3 Blob 快照冷启动引导） */
    restore(rows) {
      return tx(() => {
        for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
        const t = now();
        const ins = {
          kv: db.prepare('INSERT OR REPLACE INTO kv (key, val, exp) VALUES (?, ?, ?)'),
          hashes: db.prepare('INSERT OR REPLACE INTO hashes (key, field, val, exp) VALUES (?, ?, ?, ?)'),
          lists: db.prepare('INSERT OR REPLACE INTO lists (key, pos, val, exp) VALUES (?, ?, ?, ?)'),
          sets: db.prepare('INSERT OR REPLACE INTO sets (key, member, exp) VALUES (?, ?, ?)'),
          zsets: db.prepare('INSERT OR REPLACE INTO zsets (key, member, score, exp) VALUES (?, ?, ?, ?)')
        };
        let n = 0;
        for (const r of rows.kv || []) { if (!r.exp || r.exp > t) { ins.kv.run(r.key, r.val, r.exp ?? null); n++; } }
        for (const r of rows.hashes || []) { if (!r.exp || r.exp > t) { ins.hashes.run(r.key, r.field, r.val, r.exp ?? null); n++; } }
        for (const r of rows.lists || []) { if (!r.exp || r.exp > t) { ins.lists.run(r.key, r.pos, r.val, r.exp ?? null); n++; } }
        for (const r of rows.sets || []) { if (!r.exp || r.exp > t) { ins.sets.run(r.key, r.member, r.exp ?? null); n++; } }
        for (const r of rows.zsets || []) { if (!r.exp || r.exp > t) { ins.zsets.run(r.key, r.member, Number(r.score), r.exp ?? null); n++; } }
        return n;
      });
    },

    close() {
      clearInterval(gcTimer);
      try { db.close(); } catch { /* ignore */ }
    }
  };

  return store;
}

module.exports = { open };
