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
const blobSnapshot = require('./blob-snapshot');

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

/** 行式结构 → 内存 Map（L3 Blob 快照 / 统一导出格式的恢复路径） */
function restoreRows(map, rows) {
  map.clear();
  const t = Date.now();
  const live = (exp) => !exp || exp > t;
  for (const r of rows.kv || []) {
    if (live(r.exp)) map.set(r.key, { type: 'kv', v: r.val, exp: r.exp ?? null });
  }
  for (const r of rows.hashes || []) {
    if (!live(r.exp)) continue;
    let e = map.get(r.key);
    if (!e || e.type !== 'h') { e = { type: 'h', v: {}, exp: r.exp ?? null }; map.set(r.key, e); }
    let v; try { v = JSON.parse(r.val); } catch { v = r.val; }
    e.v[r.field] = v;
  }
  for (const r of rows.lists || []) {
    if (!live(r.exp)) continue;
    let e = map.get(r.key);
    if (!e || e.type !== 'l') { e = { type: 'l', v: [], exp: r.exp ?? null }; map.set(r.key, e); }
    e.v[r.pos] = r.val;
  }
  for (const r of rows.sets || []) {
    if (!live(r.exp)) continue;
    let e = map.get(r.key);
    if (!e || e.type !== 's') { e = { type: 's', v: new Set(), exp: r.exp ?? null }; map.set(r.key, e); }
    e.v.add(r.member);
  }
  for (const r of rows.zsets || []) {
    if (!live(r.exp)) continue;
    let e = map.get(r.key);
    if (!e || e.type !== 'z') { e = { type: 'z', v: new Map(), exp: r.exp ?? null }; map.set(r.key, e); }
    e.v.set(r.member, Number(r.score));
  }
  // 压缩 list 稀疏位
  for (const e of map.values()) {
    if (e.type === 'l' && Array.isArray(e.v)) e.v = e.v.filter(x => x !== undefined);
  }
  return map.size;
}

/** 旧版对象格式快照（/tmp 快照历史格式）→ 内存 Map */
function restoreLegacy(map, obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && 't' in v && 'v' in v && 'type' in v) {
      const entry = { type: v.type, v: v.v, exp: v.exp ?? null };
      if (entry.exp && entry.exp <= Date.now()) continue;
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
      map.set(k, entry);
    }
  }
  return map.size;
}

function memoryStore(initialData) {
  const data = new Map();

  /* 合并元数据（仅 L3 快照启用时有意义）：key 写入时间戳 + 键/成员删除墓碑。
     多实例并发上传/同步时用于按键级 LWW 合并与删除防复活。 */
  const meta = { keyTs: new Map(), tombK: new Map(), tombM: new Map() };
  const wt = (k) => { if (k != null) meta.keyTs.set(k, Date.now()); };
  const wdel = (k) => { const t = Date.now(); meta.keyTs.set(k, t); meta.tombK.set(k, t); };
  const wrem = (k, m) => {
    const t = Date.now();
    meta.keyTs.set(k, t);
    let mm = meta.tombM.get(k);
    if (!mm) { mm = new Map(); meta.tombM.set(k, mm); }
    for (const x of Array.isArray(m) ? m : [m]) mm.set(String(x), t);
  };

  if (initialData) {
    if (Array.isArray(initialData.kv)) restoreRows(data, initialData);
    else restoreLegacy(data, initialData);
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
      wt(k); writeHook(k);
      return 'OK';
    },
    async del(...keys) { let n = 0; for (const k of keys) { if (data.delete(k)) n++; wdel(k); } writeHook(keys[0]); return n; },
    async incr(k) { const e = ensure(k, 'counter'); e.v = Number(e.v || 0) + 1; wt(k); writeHook(k); return e.v; },
    async expire(k, sec) { if (alive(k)) { entry(k).exp = Date.now() + sec * 1000; wt(k); writeHook(k); return 1; } return 0; },
    async hset(k, obj) { const e = ensure(k, 'h'); Object.assign(e.v, obj); wt(k); writeHook(k); return Object.keys(obj).length; },
    async hgetall(k) { if (!alive(k)) return null; return { ...entry(k).v }; },
    async lpush(k, v) { const e = ensure(k, 'l'); e.v.unshift(v); wt(k); writeHook(k); return e.v.length; },
    async rpush(k, v) { const e = ensure(k, 'l'); e.v.push(v); wt(k); writeHook(k); return e.v.length; },
    async lrange(k, start, stop) { if (!alive(k)) return []; const a = entry(k).v; const s = start < 0 ? Math.max(a.length + start, 0) : start; const end = stop < 0 ? a.length + stop + 1 : stop + 1; return a.slice(s, end); },
    async ltrim(k, start, stop) { if (alive(k)) { const a = entry(k).v; entry(k).v = a.slice(start, stop < 0 ? a.length + stop + 1 : stop + 1); wt(k); writeHook(k); } return 'OK'; },
    async sadd(k, m) { const e = ensure(k, 's'); const add = !e.v.has(m); e.v.add(m); wt(k); writeHook(k); return add ? 1 : 0; },
    async srem(k, m) { const e = data.get(k); if (!e) return 0; const had = e.v.has(m); e.v.delete(m); if (had) { wrem(k, m); writeHook(k); } return had ? 1 : 0; },
    async smembers(k) { return alive(k) ? [...entry(k).v] : []; },
    async sismember(k, m) { return alive(k) && entry(k).v.has(m) ? 1 : 0; },
    async zadd(k, score, member) { const e = ensure(k, 'z'); const isNew = !e.v.has(String(member)); e.v.set(String(member), Number(score)); wt(k); writeHook(k); return isNew ? 1 : 0; },
    async zrem(k, member) { const e = data.get(k); if (!e) return 0; const had = e.v.has(String(member)); e.v.delete(String(member)); if (had) { wrem(k, member); writeHook(k); } return had ? 1 : 0; },
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

    /** 导出全部数据为行式结构（与 sqlite._export / L3 Blob 快照统一格式） */
    _export() {
      const rows = { kv: [], hashes: [], lists: [], sets: [], zsets: [] };
      for (const [k, e] of data) {
        if (!shouldSnapshot(k)) continue;
        if (e.exp && e.exp <= Date.now()) continue;
        const exp = e.exp ?? null;
        switch (e.type) {
          case 'kv': rows.kv.push({ key: k, val: typeof e.v === 'string' ? e.v : JSON.stringify(e.v), exp }); break;
          case 'counter': rows.kv.push({ key: k, val: String(e.v), exp }); break;
          case 'h':
            for (const [f, v] of Object.entries(e.v)) rows.hashes.push({ key: k, field: f, val: JSON.stringify(v), exp });
            break;
          case 'l':
            e.v.forEach((v, i) => rows.lists.push({ key: k, pos: i, val: typeof v === 'string' ? v : JSON.stringify(v), exp }));
            break;
          case 's':
            for (const m of e.v) rows.sets.push({ key: k, member: String(m), exp });
            break;
          case 'z':
            for (const [m, sc] of e.v) rows.zsets.push({ key: k, member: m, score: sc, exp });
            break;
        }
      }
      return rows;
    },

    /** 从行式结构恢复（事务级全量替换；用于 L3 Blob 快照冷启动引导）；元数据一并重置 */
    restore(rows) {
      meta.keyTs.clear(); meta.tombK.clear(); meta.tombM.clear();
      return restoreRows(data, rows);
    },

    /** 导出合并元数据：键级写入时间戳 + 键/成员删除墓碑（供 L3 快照合并上传） */
    _mergeMeta() {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const [k, v] of meta.tombK) if (v < cutoff) meta.tombK.delete(k);
      for (const [k, mm] of meta.tombM) {
        for (const [m, v] of mm) if (v < cutoff) mm.delete(m);
        if (!mm.size) meta.tombM.delete(k);
      }
      const toObj = (m) => Object.fromEntries(m);
      const tombM = {};
      for (const [k, mm] of meta.tombM) tombM[k] = Object.fromEntries(mm);
      return { keyTs: toObj(meta.keyTs), tombK: toObj(meta.tombK), tombM };
    },

    /** 回写合并元数据（取最大时间戳，单调推进）：上传合并/远端同步后保持收敛基准 */
    _applyMergeMeta(m = {}) {
      for (const [k, v] of Object.entries(m.keyTs || {})) {
        const t = Number(v) || 0;
        meta.keyTs.set(k, Math.max(meta.keyTs.get(k) || 0, t));
      }
      for (const [k, v] of Object.entries(m.tombK || {})) {
        const t = Number(v) || 0;
        meta.keyTs.set(k, Math.max(meta.keyTs.get(k) || 0, t));
        meta.tombK.set(k, Math.max(meta.tombK.get(k) || 0, t));
      }
      for (const [k, mm] of Object.entries(m.tombM || {})) {
        if (!mm || typeof mm !== 'object') continue;
        let cur = meta.tombM.get(k);
        if (!cur) { cur = new Map(); meta.tombM.set(k, cur); }
        for (const [mem, v] of Object.entries(mm)) cur.set(mem, Math.max(cur.get(mem) || 0, Number(v) || 0));
      }
    },

    /**
     * 增量并入远端快照行（温实例远端同步 / 多实例收敛）：
     * 远端独有 key/成员并入本地；kv/哈希整键冲突按 keyTs LWW（键删除时间也计入，删除事件可阻止旧数据复活）。
     * 不清空本地数据（同步实现，与并发写无竞态）。返回并入的行数。
     */
    mergeRows(rows, remoteKeyTs = {}) {
      let n = 0;
      const now = Date.now();
      const live = (exp) => !exp || exp > now;
      const rts = (k) => Number(remoteKeyTs[k]) || 0;
      const lts = (k) => Math.max(meta.keyTs.get(k) || 0, meta.tombK.get(k) || 0);

      for (const r of rows.kv || []) {
        if (!live(r.exp) || !shouldSnapshot(r.key)) continue;
        if (rts(r.key) <= lts(r.key)) continue; // 本地更新或本地已删除（更晚）→ 不并入
        const cur = data.get(r.key);
        if (cur && cur.type !== 'kv' && cur.type !== 'counter') continue; // 类型冲突以本地为准
        data.set(r.key, { type: 'kv', v: r.val, exp: r.exp ?? null });
        meta.keyTs.set(r.key, rts(r.key));
        n++;
      }

      /* hashes：整键 LWW（按 field 分组重组） */
      const hashGroups = new Map();
      for (const r of rows.hashes || []) {
        if (!live(r.exp) || !shouldSnapshot(r.key)) continue;
        let g = hashGroups.get(r.key);
        if (!g) { g = { exp: r.exp ?? null, fields: {} }; hashGroups.set(r.key, g); }
        g.fields[r.field] = r.val;
      }
      for (const [k, g] of hashGroups) {
        if (rts(k) <= lts(k)) continue;
        const cur = data.get(k);
        if (cur && cur.type !== 'h') continue;
        const fields = {};
        for (const [f, val] of Object.entries(g.fields)) {
          try { fields[f] = JSON.parse(val); } catch { fields[f] = val; }
        }
        data.set(k, { type: 'h', v: fields, exp: g.exp });
        meta.keyTs.set(k, rts(k));
        n++;
      }

      /* lists：追加远端独有成员（导出已字符串化，与本地原始值统一转字符串比较） */
      const listGroups = new Map();
      for (const r of rows.lists || []) {
        if (!live(r.exp) || !shouldSnapshot(r.key)) continue;
        let g = listGroups.get(r.key);
        if (!g) { g = { exp: r.exp ?? null, items: [] }; listGroups.set(r.key, g); }
        g.items[r.pos] = r.val;
      }
      for (const [k, g] of listGroups) {
        const cur = data.get(k);
        if (!cur || cur.type !== 'l') continue; // 本地无该 list 时不整键创建（列表以本地写入为准）
        const norm = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
        const have = new Set(cur.v.map(norm));
        for (const v of g.items) {
          if (v === undefined || have.has(v)) continue;
          cur.v.push(v);
          have.add(v);
          n++;
        }
      }

      /* sets / zsets：成员并集（zset 分数取大）；远端成员若被本地墓碑屏蔽则不并入 */
      const setGroups = new Map();
      for (const r of rows.sets || []) {
        if (!live(r.exp) || !shouldSnapshot(r.key)) continue;
        let g = setGroups.get(r.key);
        if (!g) { g = new Set(); setGroups.set(r.key, g); }
        g.add(r.member);
      }
      for (const [k, g] of setGroups) {
        const cur = data.get(k);
        if (!cur || cur.type !== 's') continue;
        const tm = meta.tombM.get(k);
        for (const m of g) {
          if (cur.v.has(m)) continue;
          if (tm && tm.has(m) && tm.get(m) >= rts(k)) continue; // 本地删除晚于远端写入 → 不复活
          cur.v.add(m);
          n++;
        }
      }
      const zsetGroups = new Map();
      for (const r of rows.zsets || []) {
        if (!live(r.exp) || !shouldSnapshot(r.key)) continue;
        let g = zsetGroups.get(r.key);
        if (!g) { g = new Map(); zsetGroups.set(r.key, g); }
        const s = Number(r.score) || 0;
        const prev = g.get(r.member);
        if (prev === undefined || s > prev) g.set(r.member, s);
      }
      for (const [k, g] of zsetGroups) {
        const cur = data.get(k);
        if (!cur || cur.type !== 'z') continue;
        const tm = meta.tombM.get(k);
        for (const [m, s] of g) {
          const prev = cur.v.get(m);
          if (prev !== undefined) { if (s > prev) cur.v.set(m, s); continue; }
          if (tm && tm.has(m) && tm.get(m) >= rts(k)) continue; // 本地删除晚于远端写入 → 不复活
          cur.v.set(m, s);
          n++;
        }
      }

      return n;
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
let _mode = 'memory';
let _sqlitePath = null;
let _initPromise = null;

/** SQLite 落盘路径候选：env 指定 → 项目 data/ → 系统临时目录（Vercel 只读 FS 自动落到这里） */
function sqliteCandidates() {
  const list = [];
  if (process.env.SQLITE_PATH) list.push(process.env.SQLITE_PATH);
  list.push(path.join(process.cwd(), 'data', 'flwb.db'));
  list.push(path.join(os.tmpdir(), 'flwb.db'));
  return list;
}

/** 依序尝试打开 SQLite；全部失败返回 null（调用方降级内存） */
function tryOpenSqlite() {
  try {
    const sqlite = require('./sqlite');
    for (const p of sqliteCandidates()) {
      try {
        const store = sqlite.open(p, { skipPrefixes: SNAPSHOT_SKIP_PREFIXES });
        _sqlitePath = p;
        return store;
      } catch (e) {
        console.warn('[storage] sqlite open failed at', p, '-', e.message);
      }
    }
  } catch (e) {
    console.warn('[storage] node:sqlite unavailable, fallback to memory:', e.message);
  }
  return null;
}

/* ---------------- L3 写钩子：写入型操作成功后调度 Blob 快照上传 ---------------- */
const L3_WRITE_METHODS = new Set(['set', 'del', 'incr', 'expire', 'hset', 'lpush', 'rpush', 'ltrim', 'sadd', 'srem', 'zadd', 'zrem']);

function withL3Hook(store) {
  if (!blobSnapshot.enabled()) return store;
  return new Proxy(store, {
    get(t, prop, recv) {
      if (!L3_WRITE_METHODS.has(prop)) return Reflect.get(t, prop, recv);
      const orig = t[prop];
      return async (...args) => {
        const r = await orig.apply(t, args);
        _lastLocalWriteTs = Date.now(); // 记录最新本地写事件，供温实例远端同步比较
        try { blobSnapshot.scheduleUpload(t); } catch { /* 快照失败不影响业务 */ }
        return r;
      };
    }
  });
}

/* ---------------- 温实例远端同步：让长期存活的实例从 Blob 收敛其他实例的写入 ---------------- */
const REMOTE_SYNC_INTERVAL_MS = 60000;
let _lastRemoteSyncAt = 0;
let _syncingRemote = false;
let _lastLocalWriteTs = Date.now();

/**
 * 温实例远端同步（由请求路径低频触发，内部 60s 节流，不阻塞不抛错）：
 * 将远端快照【增量合并】进本地内存——远端独有 key/成员并入（其他实例的新注册患者等），
 * 冲突按键级时间戳 LWW，本地删除事件（墓碑）阻止旧数据复活。
 * 旧版"远端更新才整库覆盖"策略有两大缺陷，均已废弃：
 *   1) 本实例在远端快照后写过任何数据（登录日志/审计/限流）即永久跳过同步 → 永远看不到新患者；
 *   2) 整库覆盖会丢掉同步窗口内的本地并发写。
 */
async function maybeSyncRemote() {
  if (!blobSnapshot.enabled()) return;
  const nowMs = Date.now();
  if (_syncingRemote || nowMs - _lastRemoteSyncAt < REMOTE_SYNC_INTERVAL_MS) return;
  _lastRemoteSyncAt = nowMs; // 节流窗口内只尝试一次
  _syncingRemote = true;
  try {
    const payload = await blobSnapshot.download();
    if (!payload || !payload.data) return;
    const remoteTs = Date.parse(payload.updatedAt || '') || 0;
    const db = await getDb();
    if (typeof db.mergeRows !== 'function') return; // sqlite 驱动无多实例问题，不支持增量合并
    const n = db.mergeRows(payload.data, (payload.meta && payload.meta.keyTs) || {});
    // 远端墓碑并入本地（其他实例的删除事件在本实例生效，并随下次上传继续传播）
    if (db._applyMergeMeta) {
      db._applyMergeMeta({
        tombK: (payload.meta && payload.meta.tombK) || {},
        tombM: (payload.meta && payload.meta.tombM) || {}
      });
    }
    _lastLocalWriteTs = Math.max(_lastLocalWriteTs, remoteTs);
    if (n > 0) console.info('[storage] warm instance merged', n, 'rows from Blob snapshot (updatedAt:', payload.updatedAt + ')');
  } catch (e) {
    console.warn('[storage] remote sync failed:', (e && e.message) || e);
  } finally {
    _syncingRemote = false;
  }
}

async function init() {
  const driver = (process.env.STORAGE_DRIVER || 'auto').toLowerCase();
  let store = null;

  /* 驱动选择：auto/sqlite → 优先 SQLite（真实数据库文件）；memory → 强制内存 */
  if (driver !== 'memory') {
    store = tryOpenSqlite();
    if (store) {
      _mode = 'sqlite';
      console.info('[storage] driver=sqlite, db path:', _sqlitePath);
    } else if (driver === 'sqlite') {
      console.warn('[storage] STORAGE_DRIVER=sqlite but unavailable, falling back to memory');
    }
  }

  /* 内存模式（Vercel 兜底 / STORAGE_DRIVER=memory）：带同实例快照恢复 */
  if (!store) {
    _mode = 'memory';
    const restored = tryRestoreSnapshot();
    if (restored) {
      console.info('[storage] memory mode, restored', Object.keys(restored).length, 'entries from snapshot');
    } else {
      console.info('[storage] memory mode, no snapshot, fresh start');
    }
    store = memoryStore(restored);
  }

  _rawDb = store;

  /* L3 远端快照（Vercel Blob）：仅当本地为全新空库时用云端快照引导，避免覆盖更新的本地数据 */
  if (blobSnapshot.enabled()) {
    try {
      if (store._stats().total === 0) {
        const payload = await blobSnapshot.download();
        if (payload) {
          const n = store.restore(payload.data);
          // 恢复合并元数据（键级时间戳/墓碑）：后续温实例增量合并与合并上传据此判断新旧
          if (store._applyMergeMeta && payload.meta) store._applyMergeMeta(payload.meta);
          // 冷启动引导后以远端时间为本地基准，温实例同步据此判断是否需要再次收敛
          _lastLocalWriteTs = Date.parse(payload.updatedAt || '') || _lastLocalWriteTs;
          console.info('[storage] restored', n, 'rows from Blob snapshot (updatedAt:', payload.updatedAt + ')');
        } else {
          console.info('[storage] no remote Blob snapshot, starting fresh');
        }
      } else {
        console.info('[storage] local data present, skip Blob restore (will refresh remote later)');
      }
    } catch (e) {
      console.warn('[storage] blob snapshot init failed:', e.message);
    }
  }

  _rawDb = withL3Hook(store);
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
  return _mode;
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

/** 暴露给测试/调试用，生产请勿调用：关闭并删除所有候选路径的 SQLite 文件与内存快照，重置单例 */
function resetForTest() {
  if (_rawDb && typeof _rawDb.close === 'function') {
    try { _rawDb.close(); } catch { /* ignore */ }
  }
  _rawDb = null;
  _initPromise = null;
  blobSnapshot.resetForTest();
  // 关键：本进程可能尚未初始化（_sqlitePath 为 null），必须遍历全部候选路径清理，
  // 否则上一进程 process.exit() 强杀留下的 WAL 数据会导致跨运行状态残留
  for (const p of sqliteCandidates()) {
    for (const f of [p, p + '-wal', p + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
  _sqlitePath = null;
  try { fs.unlinkSync(SNAPSHOT_PATH); } catch { /* ignore */ }
  // 重置温实例远端同步状态，保证测试确定性
  _lastRemoteSyncAt = 0;
  _syncingRemote = false;
  _lastLocalWriteTs = Date.now();
}

/**
 * 强制远端收敛（无视 60s 节流，带重入保护，不抛错）：
 * 登录/注册等关键读路径的兜底——实例内存缺少刚在其他实例注册的用户/患者数据时，
 * 先同步远端快照再判定，避免把"实例不收敛"误判成"尚未注册/账号不存在"。
 * 返回并入的行数（0 表示无远端数据或未启用）。
 */
async function forceSyncRemote() {
  if (!blobSnapshot.enabled() || _syncingRemote) return 0;
  _syncingRemote = true;
  try {
    const payload = await blobSnapshot.download();
    if (!payload || !payload.data) return 0;
    const db = await getDb();
    if (typeof db.mergeRows !== 'function') return 0;
    const n = db.mergeRows(payload.data, (payload.meta && payload.meta.keyTs) || {});
    if (db._applyMergeMeta) {
      db._applyMergeMeta({
        tombK: (payload.meta && payload.meta.tombK) || {},
        tombM: (payload.meta && payload.meta.tombM) || {}
      });
    }
    _lastRemoteSyncAt = Date.now();
    const remoteTs = Date.parse(payload.updatedAt || '') || 0;
    _lastLocalWriteTs = Math.max(_lastLocalWriteTs, remoteTs);
    if (n > 0) console.info('[storage] force-synced', n, 'rows from Blob snapshot (updatedAt:', payload.updatedAt + ')');
    return n;
  } catch {
    return 0;
  } finally {
    _syncingRemote = false;
  }
}

module.exports = { getDb, mode, K, dateStr, setNxEx, withLock, memoryStore, maybeSyncRemote, forceSyncRemote, resetForTest };
