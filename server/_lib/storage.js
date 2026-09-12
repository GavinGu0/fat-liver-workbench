'use strict';
/**
 * Storage Adapter — 无数据库存储层
 * 优先使用 Vercel KV / Upstash Redis（REST 协议，与 Serverless 天然契合）；
 * 未配置环境变量时自动降级为实例内存存储（演示模式，数据不跨实例持久）。
 * 业务层只依赖本模块暴露的接口，未来迁移数据库零业务改动。
 */
const { ApiError } = require('./response');

/* ---------------- Key 设计（与技术方案 3.2 一致） ---------------- */
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
  /* 通知发送日志（随访提醒等多渠道消息跟踪）：按日列表 + 单条明细 + 重试队列 */
  notifyLog: (date) => `notify:log:${date}`,
  notifyItem: (id) => `notify:item:${id}`,
  notifyRetry: 'notify:retry:queue',
  /* 登录安全：日志（按日）+ 失败计数 + 锁定标记 */
  loginLog: (date) => `login:log:${date}`,
  loginFail: (key) => `login:fail:${key}`,
  loginLock: (key) => `login:lock:${key}`,
  loginIpUser: (ip) => `login:ip-user:${ip}`,
  /* 患者唯一标识索引（身份证/手机号 → patientId，建档与注册双向匹配） */
  patientIdxIdCard: (id) => `patient:index:idcard:${String(id).toUpperCase()}`,
  patientIdxPhone: (p) => `patient:index:phone:${p}`
};

/** 以上海时区计算 yyyy-MM-dd（服务运行于 UTC，业务日期必须按本地时区取） */
function dateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
}

/* ---------------- 内存实现（演示模式兜底） ---------------- */
function memoryStore() {
  const data = new Map();
  const entry = (k) => data.get(k);
  const alive = (k) => {
    const e = data.get(k);
    if (!e) return false;
    if (e.exp && e.exp <= Date.now()) { data.delete(k); return false; }
    return true;
  };
  const ensure = (k, type) => {
    if (!alive(k)) data.set(k, { type, v: type === 'z' ? new Map() : type === 's' ? new Set() : type === 'l' ? [] : type === 'h' ? {} : 0 });
    return data.get(k);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  return {
    async get(k) { if (!alive(k)) return null; const e = entry(k); return e.type === 'kv' ? e.v : e.type === 'h' ? { ...e.v } : null; },
    async set(k, v, opts = {}) {
      if (opts.nx && alive(k)) return null; // NX 语义：已存在则返回 null
      data.set(k, { type: 'kv', v, exp: opts.ex ? Date.now() + opts.ex * 1000 : null });
      return 'OK';
    },
    async del(...keys) { let n = 0; for (const k of keys) { if (data.delete(k)) n++; } return n; },
    async incr(k) { const e = ensure(k, 'counter'); e.v = Number(e.v || 0) + 1; return e.v; },
    async expire(k, sec) { if (alive(k)) { entry(k).exp = Date.now() + sec * 1000; return 1; } return 0; },
    async hset(k, obj) { const e = ensure(k, 'h'); Object.assign(e.v, obj); return Object.keys(obj).length; },
    async hgetall(k) { if (!alive(k)) return null; return { ...entry(k).v }; },
    async lpush(k, v) { const e = ensure(k, 'l'); e.v.unshift(v); return e.v.length; },
    async rpush(k, v) { const e = ensure(k, 'l'); e.v.push(v); return e.v.length; },
    async lrange(k, start, stop) { if (!alive(k)) return []; const a = entry(k).v; const s = start < 0 ? Math.max(a.length + start, 0) : start; const end = stop < 0 ? a.length + stop + 1 : stop + 1; return a.slice(s, end); },
    async ltrim(k, start, stop) { if (alive(k)) { const a = entry(k).v; entry(k).v = a.slice(start, stop < 0 ? a.length + stop + 1 : stop + 1); } return 'OK'; },
    async sadd(k, m) { const e = ensure(k, 's'); const add = !e.v.has(m); e.v.add(m); return add ? 1 : 0; },
    async srem(k, m) { const e = data.get(k); if (!e) return 0; const had = e.v.has(m); e.v.delete(m); return had ? 1 : 0; },
    async smembers(k) { return alive(k) ? [...entry(k).v] : []; },
    async sismember(k, m) { return alive(k) && entry(k).v.has(m) ? 1 : 0; },
    async zadd(k, score, member) { const e = ensure(k, 'z'); const isNew = !e.v.has(String(member)); e.v.set(String(member), Number(score)); return isNew ? 1 : 0; },
    async zrem(k, member) { const e = data.get(k); if (!e) return 0; const had = e.v.has(String(member)); e.v.delete(String(member)); return had ? 1 : 0; },
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
    async ping() { return 'PONG'; }
  };
}

/* ---------------- Redis 实现（Upstash REST / Vercel KV 环境变量） ---------------- */
function wrapRedis(client) {
  return {
    async get(k) { return client.get(k); },
    async set(k, v, opts = {}) {
      const o = {};
      if (opts.ex) o.ex = opts.ex;
      return client.set(k, v, o);
    },
    async del(...keys) { return client.del(...keys); },
    async incr(k) { return client.incr(k); },
    async expire(k, sec) { return client.expire(k, sec); },
    async hset(k, obj) { return client.hset(k, obj); },
    async hgetall(k) { return client.hgetall(k); },
    async lpush(k, v) { return client.lpush(k, v); },
    async rpush(k, v) { return client.rpush(k, v); },
    async lrange(k, s, e) { return client.lrange(k, s, e); },
    async ltrim(k, s, e) { return client.ltrim(k, s, e); },
    async sadd(k, m) { return client.sadd(k, m); },
    async srem(k, m) { return client.srem(k, m); },
    async smembers(k) { return client.smembers(k); },
    async sismember(k, m) { return client.sismember(k, m); },
    async zadd(k, score, member) { return client.zadd(k, { score, member }); },
    async zrem(k, member) { return client.zrem(k, member); },
    async zcard(k) { return client.zcard(k); },
    async zscore(k, member) { return client.zscore(k, member); },
    async zcount(k, min, max) { return client.zcount(k, min, max); },
    async zrevrange(k, start, stop, opts = {}) { return client.zrevrange(k, start, stop, { withScores: !!opts.withScores }); },
    async zrangebyscore(k, min, max, opts = {}) {
      const o = { withScores: !!opts.withScores };
      if (opts.limit) o.limit = { offset: opts.limit.offset || 0, count: opts.limit.count };
      return client.zrangebyscore(k, min, max, o);
    },
    async ping() { return client.ping(); }
  };
}

let _client = null;
let _mode = 'memory';
let _initPromise = null;

async function init() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      const { Redis } = await import('@upstash/redis');
      const client = new Redis({ url, token, automaticDeserialization: false });
      await client.ping();
      _mode = 'redis';
      return wrapRedis(client);
    } catch (e) {
      console.error('[storage] Redis init failed, fallback to memory:', e.message);
    }
  }
  _mode = 'memory';
  return memoryStore();
}

/** 获取存储实例（懒初始化，进程内单例） */
async function getDb() {
  if (_client) return _client;
  if (!_initPromise) _initPromise = init().catch(e => { _initPromise = null; throw e; });
  _client = await _initPromise;
  return _client;
}

function mode() {
  return _mode;
}

/** SET NX EX：幂等键 / 分布式锁 / 一次性标记 */
async function setNxEx(key, value, exSeconds) {
  const db = await getDb();
  try {
    const raw = await db.set(key, value, { ex: exSeconds, nx: true });
    return raw !== null && raw !== undefined;
  } catch (e) {
    // 部分客户端不支持 set nx，退化为 get-then-set（演示模式可接受）
    const existed = await db.get(key);
    if (existed !== null && existed !== undefined) return false;
    await db.set(key, value, { ex: exSeconds });
    return true;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 分布式锁：SET NX EX 抢锁 → 业务执行 → 释放；防止 REST Redis 无 WATCH/MULTI 场景下的并发覆盖 */
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

module.exports = { getDb, mode, K, dateStr, setNxEx, withLock, memoryStore };
