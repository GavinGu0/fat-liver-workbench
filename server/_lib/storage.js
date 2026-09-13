'use strict';
/**
 * Storage Adapter — 纯内存存储（零外部依赖）
 * 设计定位：演示/开发模式，数据存于 Node.js 进程内存。
 *           Vercel Serverless 多实例场景下，各实例内存相互隔离；
 *           实例回收后数据重置，下次冷启动重新播种。
 *           业务层仅依赖本模块暴露的接口。
 *
 * 快照机制（同实例内冷启动恢复）：
 *   写操作触发 debounce 500ms 写入 /tmp/flwb-snapshot.json；
 *   初始化时若快照存在则先恢复，再执行 seed（幂等，有 flag 守护）。
 *   注意：Vercel /tmp 在实例回收后也会清空，快照≠持久化。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ApiError } = require('./response');

/* ---------------- Key 设计（与业务层约定，勿随意改动） ---------------- */
const K = {
  user: (id) => `user:${id}`,
  usernameIdx: (u) => `user:index:username:${String(u).toLowerCase()}`,
  phoneIdx: (p) => `user:index:phone:${p}`,
  patient: (id) => `patient:${id}`,
  docPatients: (docId) => `patient:index:doc:${docId}`,
  allPatients: 'patient:index:all',
  patientCreated: (docId) => `patient:created:doc:${docId}`,
  diet: (pid) => `record:diet:${pid}`,
  exercise: (pid) => `record:exercise:${pid}`,
  vitals: (pid) => `record:vitals:${pid}`,
  labs: (pid) => `record:labs:${pid}`,
  guidance: (pid) => `guidance:${pid}`,
  guidanceIdx: (nurseId) => `guidance:index:nurse:${nurseId}`,
  eduLog: (pid) => `education:log:${pid}`,
  msg: (uid) => `msg:${uid}`,
  msgUnread: (uid) => `msg:unread:${uid}`,
  followupDue: (date) => `followup:due:${date}`,
  revisit: (pid) => `revisit:${pid}`,
  mdt: (id) => `mdt:${id}`,
  mdtIdx: (docId) => `mdt:index:doc:${docId}`,
  report: (id) => `report:${id}`,
  reportIdxPatient: (pid) => `report:index:patient:${pid}`,
  reportIdxNurse: (uid) => `report:index:nurse:${uid}`,
  archive: (pid) => `patient:archive:${pid}`,
  sms: (phone) => `sms:code:${phone}`,
  idem: (k) => `idem:${k}`,
  lock: (k) => `lock:${k}`,
  refresh: (t) => `refresh:${t}`,
  refreshIdxUid: (uid) => `refresh:index:uid:${uid}`,
  track: (date) => `track:${date}`,
  audit: (month) => `audit:${month}`,
  config: (key) => `config:${key}`,
  backup: (date) => `backup:${date}`,
  img: (id) => `img:${id}`,
  flag: (k) => `flag:${k}`,
  medrec: (pid) => `medrec:${pid}`,
  screening: (id) => `screen:${id}`,
  screeningIdx: (docId) => `screen:index:doc:${docId}`,
  screeningAll: 'screen:index:all',
  screeningPid: (pid) => `screen:index:pid:${pid}`,
  alert: (id) => `alert:${id}`,
  alertIdx: (uid) => `alert:index:uid:${uid}`,
  alertUnread: (uid) => `alert:unread:uid:${uid}`,
  followupRec: (pid) => `followup:rec:${pid}`,
  notifyLog: (date) => `notify:log:${date}`,
  notifyItem: (id) => `notify:item:${id}`,
  notifyRetry: 'notify:retry:queue',
  loginLog: (date) => `login:log:${date}`,
  loginFail: (key) => `login:fail:${key}`,
  loginLock: (key) => `login:lock:${key}`,
  loginIpUser: (ip) => `login:ip-user:${ip}`,
  patientIdxIdCard: (id) => `patient:index:idcard:${String(id).toUpperCase()}`,
  patientIdxPhone: (p) => `patient:index:phone:${p}`
};

/** 以上海时区计算 yyyy-MM-dd（服务运行于 UTC，业务日期按本地时区取） */
function dateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
}

/* ---------------- 快照机制 ---------------- */
const SNAPSHOT_PATH = path.join(os.tmpdir(), 'flwb-snapshot.json');
const SNAPSHOT_SKIP_PREFIXES = ['lock:', 'idem:', 'sms:code:', 'login:fail:', 'login:lock:', 'notify:retry:queue'];
const SNAPSHOT_DEBOUNCE_MS = 500;
let _snapshotTimer = null;
let _dirty = false;

/** 判断一个 key 是否需要持久化到快照（临时运行时状态跳过） */
function shouldSnapshot(key) {
  for (const p of SNAPSHOT_SKIP_PREFIXES) {
    if (key.startsWith(p)) return false;
  }
  return true;
}

function scheduleSnapshot() {
  _dirty = true;
  if (_snapshotTimer) return;
  _snapshotTimer = setTimeout(async () => {
    _snapshotTimer = null;
    if (!_dirty) return;
    _dirty = false;
    try {
      const db = await _rawDb;
      if (!db) return;
      const snap = db._export();
      // 写临时文件再 rename，防止写一半实例被杀
      const tmp = SNAPSHOT_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ t: Date.now(), data: snap }));
      fs.renameSync(tmp, SNAPSHOT_PATH);
    } catch (e) {
      // 快照失败不影响主流程
      console.warn('[storage] snapshot write failed:', e.message);
    }
  }, SNAPSHOT_DEBOUNCE_MS);
}

function tryRestoreSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return null;
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.data && typeof parsed.data === 'object') return parsed.data;
  } catch (e) {
    console.warn('[storage] snapshot restore failed:', e.message);
  }
  return null;
}

/* ---------------- 内存存储实现 ---------------- */
const MAX_KEYS = 50000; // 单实例上限保护，防止 Vercel 内存溢出

function memoryStore(initialData) {
  const data = new Map();

  // 恢复快照数据
  if (initialData) {
    for (const [k, v] of Object.entries(initialData)) {
      if (v && typeof v === 'object' && 't' in v && 'v' in v && 'type' in v) {
        const entry = { type: v.type, v: v.v, exp: v.exp ?? null };
        // 过期键直接跳过
        if (entry.exp && entry.exp <= Date.now()) continue;
        // 重新构造内部数据结构（Set/Map/Array/Object）
        switch (entry.type) {
          case 's': entry.v = new Set(entry.v); break;
          case 'z': {
            const m = new Map();
            for (const [mk, mv] of Object.entries(entry.v)) m.set(mk, mv);
            entry.v = m;
            break;
          }
          case 'l': if (!Array.isArray(entry.v)) entry.v = []; break;
          case 'h': if (typeof entry.v !== 'object') entry.v = {}; break;
          default: break;
        }
        data.set(k, entry);
      }
    }
  }

  const entry = (k) => data.get(k);
  const alive = (k) => {
    const e = data.get(k);
    if (!e) return false;
    if (e.exp && e.exp <= Date.now()) { data.delete(k); return false; }
    return true;
  };
  const ensure = (k, type) => {
    if (!alive(k)) {
      // 容量保护：超过上限时清理 10% 过期键
      if (data.size >= MAX_KEYS) {
        let cleaned = 0;
        for (const [dk, de] of data) {
          if (de.exp && de.exp <= Date.now()) { data.delete(dk); cleaned++; if (cleaned > MAX_KEYS * 0.1) break; }
        }
      }
      if (data.size >= MAX_KEYS * 0.9) {
        console.warn('[storage] memory approaching capacity limit, size=', data.size);
      }
      data.set(k, { type, v: type === 'z' ? new Map() : type === 's' ? new Set() : type === 'l' ? [] : type === 'h' ? {} : 0, exp: null });
    }
    return data.get(k);
  };

  // 定期清理过期键（每 30 秒扫描一次）
  const gcTimer = setInterval(() => {
    let cleaned = 0;
    for (const [k, e] of data) {
      if (e.exp && e.exp <= Date.now()) { data.delete(k); cleaned++; }
    }
    if (cleaned > 0) console.debug('[storage] gc cleaned', cleaned, 'expired keys');
  }, 30000);
  gcTimer.unref && gcTimer.unref(); // 不阻塞进程退出

  function writeHook(key) {
    if (shouldSnapshot(key)) scheduleSnapshot();
  }

  const store = {
    _type: 'memory',
    async get(k) { if (!alive(k)) return null; const e = entry(k); return e.type === 'kv' ? e.v : e.type === 'h' ? { ...e.v } : null; },
    async set(k, v, opts = {}) {
      if (opts.nx && alive(k)) return null;
      data.set(k, { type: 'kv', v, exp: opts.ex ? Date.now() + opts.ex * 1000 : null });
      writeHook(k);
      return 'OK';
    },
    async del(...keys) { let n = 0; for (const k of keys) { if (data.delete(k)) n++; } writeHook(keys[0]); return n; },
    async incr(k) { const e = ensure(k, 'counter'); e.v = Number(e.v || 0) + 1; writeHook(k); return e.v; },
    async expire(k, sec) { if (alive(k)) { entry(k).exp = Date.now() + sec * 1000; writeHook(k); return 1; } return 0; },
    async hset(k, obj) { const e = ensure(k, 'h'); Object.assign(e.v, obj); writeHook(k); return Object.keys(obj).length; },
    async hgetall(k) { if (!alive(k)) return null; return { ...entry(k).v }; },
    async lpush(k, v) { const e = ensure(k, 'l'); e.v.unshift(v); writeHook(k); return e.v.length; },
    async rpush(k, v) { const e = ensure(k, 'l'); e.v.push(v); writeHook(k); return e.v.length; },
    async lrange(k, start, stop) { if (!alive(k)) return []; const a = entry(k).v; const s = start < 0 ? Math.max(a.length + start, 0) : start; const end = stop < 0 ? a.length + stop + 1 : stop + 1; return a.slice(s, end); },
    async ltrim(k, start, stop) { if (alive(k)) { const a = entry(k).v; entry(k).v = a.slice(start, stop < 0 ? a.length + stop + 1 : stop + 1); writeHook(k); } return 'OK'; },
    async sadd(k, m) { const e = ensure(k, 's'); const add = !e.v.has(m); e.v.add(m); writeHook(k); return add ? 1 : 0; },
    async srem(k, m) { const e = data.get(k); if (!e) return 0; const had = e.v.has(m); e.v.delete(m); if (had) writeHook(k); return had ? 1 : 0; },
    async smembers(k) { return alive(k) ? [...entry(k).v] : []; },
    async sismember(k, m) { return alive(k) && entry(k).v.has(m) ? 1 : 0; },
    async zadd(k, score, member) { const e = ensure(k, 'z'); const isNew = !e.v.has(String(member)); e.v.set(String(member), Number(score)); writeHook(k); return isNew ? 1 : 0; },
    async zrem(k, member) { const e = data.get(k); if (!e) return 0; const had = e.v.has(String(member)); e.v.delete(String(member)); if (had) writeHook(k); return had ? 1 : 0; },
    async zcard(k) { return alive(k) ? entry(k).v.size : 0; },
    async zscore(k, member) { return alive(k) ? (entry(k).v.get(String(member)) ?? null) : null; },
    async zcount(k, min, max) { if (!alive(k)) return 0; let n = 0; for (const s of entry(k).v.values()) if (s >= min && s <= max) n++; return n; },
    async zrevrange(k, start, stop, opts = {}) {
      if (!alive(k)) return [];
      const arr = [...entry(k).v.entries()].sort((a, b) => b[1] - a[1]).map(([m, s]) => [m, s]);
      const s = start < 0 ? Math.max(arr.length + start, 0) : start;
      const e = stop < 0 ? arr.length + stop + 1 : stop + 1;
      const slice = arr.slice(s, e);
      if (!opts.withScores) return slice.map(x => x[0]);
      const flat = [];
      for (const [m, sc] of slice) { flat.push(m); flat.push(sc); }
      return flat;
    },
    async zrangebyscore(k, min, max, opts = {}) {
      if (!alive(k)) return [];
      const arr = [...entry(k).v.entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]);
      const lim = opts.limit || {};
      const off = lim.offset || 0;
      let slice = arr.slice(off, lim.count ? off + lim.count : undefined);
      if (opts.withScores) { const flat = []; for (const [m, sc] of slice) { flat.push(m); flat.push(sc); } return flat; }
      return slice.map(x => x[0]);
    },
    async ping() { return 'PONG'; },

    /** 导出全部数据为可 JSON 序列化结构（供快照使用） */
    _export() {
      const out = {};
      for (const [k, e] of data) {
        if (!shouldSnapshot(k)) continue;
        let v = e.v;
        if (e.type === 's') v = [...e.v];
        else if (e.type === 'z') {
          const o = {};
          for (const [mk, mv] of e.v) o[mk] = mv;
          v = o;
        }
        out[k] = { type: e.type, v, exp: e.exp ?? null, t: Date.now() };
      }
      return out;
    },

    /** 统计信息（供健康检查/调试） */
    _stats() {
      let kv = 0, h = 0, l = 0, s = 0, z = 0, counter = 0;
      for (const e of data) {
        switch (e.type) {
          case 'kv': kv++; break;
          case 'h': h++; break;
          case 'l': l++; break;
          case 's': s++; break;
          case 'z': z++; break;
          case 'counter': counter++; break;
        }
      }
      return { total: data.size, kv, hash: h, list: l, set: s, zset: z, counter, snapshotPath: SNAPSHOT_PATH };
    }
  };

  return store;
}

/* ---------------- 单例初始化 ---------------- */
let _rawDb = null;
let _initPromise = null;

async function init() {
  const restored = tryRestoreSnapshot();
  if (restored) {
    console.info('[storage] restored', Object.keys(restored).length, 'entries from snapshot');
  } else {
    console.info('[storage] no snapshot found, fresh start');
  }
  _rawDb = memoryStore(restored);
  return _rawDb;
}

/** 获取存储实例（懒初始化，进程内单例） */
async function getDb() {
  if (_rawDb) return _rawDb;
  if (!_initPromise) _initPromise = init().catch(e => { _initPromise = null; throw e; });
  _rawDb = await _initPromise;
  return _rawDb;
}

function mode() {
  return 'memory';
}

/** SET NX EX：幂等键 / 分布式锁 / 一次性标记 */
async function setNxEx(key, value, exSeconds) {
  const db = await getDb();
  try {
    const raw = await db.set(key, value, { ex: exSeconds, nx: true });
    return raw !== null && raw !== undefined;
  } catch (e) {
    // 内存实现本身支持 NX，此分支仅为防御
    const existed = await db.get(key);
    if (existed !== null && existed !== undefined) return false;
    await db.set(key, value, { ex: exSeconds });
    return true;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 分布式锁：单进程内是真实互斥；多实例场景下仅为文档意图——
 * 内存存储无法跨实例共享锁，但 setNxEx 仍能在各实例内防止并发覆盖。
 */
async function withLock(key, ttlSeconds, fn, maxWaitMs = 4000) {
  const db = await getDb();
  const lockKey = K.lock(key);
  const token = 't' + Date.now() + Math.random();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const got = await setNxEx(lockKey, token, ttlSeconds);
    if (got) {
      try {
        return await fn(db);
      } finally {
        try { await db.del(lockKey); } catch { /* 释放失败由 TTL 兜底 */ }
      }
    }
    await sleep(40);
  }
  throw new ApiError(429, 42901, '系统繁忙，请稍后重试');
}

/** 暴露给测试/调试用，生产请勿调用 */
function resetForTest() {
  _rawDb = null;
  _initPromise = null;
  try { fs.unlinkSync(SNAPSHOT_PATH); } catch { /* ignore */ }
}

module.exports = { getDb, mode, K, dateStr, setNxEx, withLock, memoryStore, resetForTest };
