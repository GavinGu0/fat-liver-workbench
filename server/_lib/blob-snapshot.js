'use strict';
/**
 * L3 云端快照（Vercel Blob）— 无外部数据库条件下的跨实例/跨回收数据恢复点
 *
 * 架构位置：L1 内存（热读写）→ L2 /tmp 快照·SQLite（实例级）→ L3 Blob JSON（全局恢复点）
 *
 * 机制：
 *   - 下载：实例冷启动且本地为空库时，拉取 snapshot.json 引导恢复（含 seed flag，不会重复播种）
 *   - 上传：写入操作经 8s 防抖 + 最小间隔节流（默认 30min）后全量上传；
 *           Vercel Cron 每日强制兜底一次
 *   - 格式：{updatedAt, data:{kv[],hashes[],lists[],sets[],zsets[]}}（与 memoryStore/sqlite._export 统一）
 *
 * 额度适配：put 为 Blob 高级操作（Hobby 免费 2000 次/月），30min 节流 ≈ 上限 1440 次/月；
 *          快照体量 <1MB，存储/传输额度（1GB/10GB 每月）余量充足。
 * 安全：患者 PII 采用 private 访问（SDK 版本不支持时降级 public 并告警）。
 * 降级：未配置 BLOB_READ_WRITE_TOKEN 或 STORAGE_BLOB_SNAPSHOT!=true 时整体禁用，零开销零影响。
 */
const SNAPSHOT_KEY = 'storage/snapshot.json';
const DEBOUNCE_MS = 8000;
const FORCE_DEBOUNCE_MS = 1500;
/** 墓碑（删除记录）保留时长：超过后允许远端旧数据复活（正常在分钟级收敛，24h 足够安全） */
const TOMBSTONE_TTL_MS = 24 * 3600 * 1000;

let _timer = null;
let _uploading = false;
let _lastOkAt = null;
let _lastBytes = 0;
let _lastError = null;
let _lastOkTs = 0;

function minIntervalMs() {
  return (Number(process.env.STORAGE_BLOB_MIN_INTERVAL_SEC) || 1800) * 1000;
}

function enabled() {
  if (process.env.STORAGE_BLOB_SNAPSHOT === 'false') return false; // 显式关闭优先
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;            // 未配置 Blob store
  // Vercel 运行时（自动注入 VERCEL=1）默认启用，防止本地开发误传快照污染云端恢复点；
  // 本地需显式 STORAGE_BLOB_SNAPSHOT=true 才启用（用于联调）
  return process.env.VERCEL === '1' || process.env.STORAGE_BLOB_SNAPSHOT === 'true';
}

/* ==================== 多实例快照合并 ==================== */

function emptyMeta() {
  return { keyTs: {}, tombK: {}, tombM: {} };
}

function normMeta(meta) {
  return {
    keyTs: (meta && meta.keyTs) || {},
    tombK: (meta && meta.tombK) || {},
    tombM: (meta && meta.tombM) || {}
  };
}

/** 行式 rows → 索引（kv/hash 整键，list 有序成员，set/zset 成员集合），便于按 key 合并 */
function indexRows(rows) {
  const idx = { kv: new Map(), hashes: new Map(), lists: new Map(), sets: new Map(), zsets: new Map() };
  for (const r of rows.kv || []) if (!idx.kv.has(r.key)) idx.kv.set(r.key, r);
  for (const r of rows.hashes || []) {
    let g = idx.hashes.get(r.key);
    if (!g) { g = { key: r.key, exp: r.exp ?? null, fields: {} }; idx.hashes.set(r.key, g); }
    g.fields[r.field] = r.val;
  }
  for (const r of rows.lists || []) {
    let g = idx.lists.get(r.key);
    if (!g) { g = { key: r.key, exp: r.exp ?? null, items: [] }; idx.lists.set(r.key, g); }
    g.items[r.pos] = r.val;
  }
  for (const r of rows.sets || []) {
    let g = idx.sets.get(r.key);
    if (!g) { g = { key: r.key, exp: r.exp ?? null, members: new Set() }; idx.sets.set(r.key, g); }
    g.members.add(r.member);
  }
  for (const r of rows.zsets || []) {
    let g = idx.zsets.get(r.key);
    if (!g) { g = { key: r.key, exp: r.exp ?? null, members: new Map() }; idx.zsets.set(r.key, g); }
    const s = Number(r.score) || 0;
    const prev = g.members.get(r.member);
    if (prev === undefined || s > prev) g.members.set(r.member, s);
  }
  return idx;
}

/**
 * 合并两份快照载荷（多实例并发上传互相覆盖的根因修复）：
 * - kv / hashes：整键按 keyTs LWW（键删除时间也计入 keyTs，删除即一次"更新"）
 * - lists：本地顺序优先，追加远端独有成员（按成员字符串去重）
 * - sets / zsets：成员并集（zset 分数取较大值）；成员级墓碑屏蔽远端独有成员复活
 * - 墓碑（tombK/tombM）：并集取最大时间戳，超 TTL 清理；被墓碑屏蔽的独有键不进合并结果
 * 返回 { data, meta }，meta 含合并后的 keyTs/tombK/tombM（调用方应回写本地以保持收敛基准）。
 */
function mergePayloads(local, remote) {
  const L = indexRows((local && local.data) || {});
  const R = remote && remote.data ? indexRows(remote.data) : null;
  const lm = normMeta(local && local.meta);
  const rm = normMeta(remote && remote.meta);
  const now = Date.now();

  /* 元数据合并：keyTs 取最大；墓碑并集取最大 + TTL 清理 */
  const keyTs = { ...rm.keyTs };
  for (const [k, v] of Object.entries(lm.keyTs)) keyTs[k] = Math.max(keyTs[k] || 0, Number(v) || 0);
  const tombK = {};
  for (const src of [rm.tombK, lm.tombK]) {
    for (const [k, v] of Object.entries(src)) tombK[k] = Math.max(tombK[k] || 0, Number(v) || 0);
  }
  const tombM = {};
  for (const src of [rm.tombM, lm.tombM]) {
    for (const [k, mm] of Object.entries(src)) {
      if (!mm || typeof mm !== 'object') continue;
      tombM[k] = tombM[k] || {};
      for (const [m, v] of Object.entries(mm)) tombM[k][m] = Math.max(tombM[k][m] || 0, Number(v) || 0);
    }
  }

  const data = { kv: [], hashes: [], lists: [], sets: [], zsets: [] };

  /* kv：整键 LWW；独有键被墓碑屏蔽时不输出 */
  for (const k of new Set([...L.kv.keys(), ...(R ? R.kv.keys() : [])])) {
    const a = L.kv.get(k), b = R && R.kv.get(k);
    const tsA = lm.keyTs[k] || 0, tsB = rm.keyTs[k] || 0, tomb = tombK[k] || 0;
    let pick = null;
    if (a && b) pick = tsB > tsA ? b : a;
    else if (a) pick = tomb > tsA ? null : a;
    else pick = tomb > tsB ? null : b;
    if (pick) data.kv.push({ key: k, val: pick.val, exp: pick.exp ?? null });
  }

  /* hashes：整键 LWW（field 级冲突在演示场景可忽略） */
  for (const k of new Set([...L.hashes.keys(), ...(R ? R.hashes.keys() : [])])) {
    const a = L.hashes.get(k), b = R && R.hashes.get(k);
    const tsA = lm.keyTs[k] || 0, tsB = rm.keyTs[k] || 0, tomb = tombK[k] || 0;
    let pick = a && b ? (tsB > tsA ? b : a) : (a || b);
    if (pick) {
      const ts = pick === b ? tsB : tsA;
      if (tomb > ts) pick = null;
    }
    if (pick) for (const [f, v] of Object.entries(pick.fields)) data.hashes.push({ key: k, field: f, val: v, exp: pick.exp ?? null });
  }

  /* lists：本地顺序优先 + 远端独有成员追加（导出格式已字符串化，按成员字符串去重） */
  for (const k of new Set([...L.lists.keys(), ...(R ? R.lists.keys() : [])])) {
    const a = L.lists.get(k), b = R && R.lists.get(k);
    if (!a && !b) continue;
    const exp = (a || b).exp ?? null;
    if (!a) {
      // 本地整键不存在：若本地删除时间（墓碑）晚于远端写入 → 阻止复活
      if ((tombK[k] || 0) > (rm.keyTs[k] || 0)) continue;
    }
    const items = [];
    const seen = new Set();
    for (const g of [a, b]) {
      if (!g) continue;
      for (const v of g.items) {
        if (v === undefined || seen.has(v)) continue;
        seen.add(v);
        items.push(v);
      }
    }
    items.forEach((v, i) => data.lists.push({ key: k, pos: i, val: v, exp }));
  }

  /* sets：成员并集；远端独有成员被成员墓碑屏蔽（本地已删除）时不并入 */
  for (const k of new Set([...L.sets.keys(), ...(R ? R.sets.keys() : [])])) {
    const a = L.sets.get(k), b = R && R.sets.get(k);
    if (!a && !b) continue;
    const exp = (a || b).exp ?? null;
    if (!a && (tombK[k] || 0) > (rm.keyTs[k] || 0)) continue; // 本地整键已删除且晚于远端写入
    const tm = tombM[k] || {};
    if (a) for (const m of a.members) data.sets.push({ key: k, member: m, exp });
    if (b) for (const m of b.members) {
      if (a && a.members.has(m)) continue;
      if (tm[m] && !a) continue; // 本地已删除该成员（墓碑更新）→ 阻止远端复活
      data.sets.push({ key: k, member: m, exp });
    }
  }

  /* zsets：成员并集（分数取大）；成员墓碑规则同 sets */
  for (const k of new Set([...L.zsets.keys(), ...(R ? R.zsets.keys() : [])])) {
    const a = L.zsets.get(k), b = R && R.zsets.get(k);
    if (!a && !b) continue;
    const exp = (a || b).exp ?? null;
    if (!a && (tombK[k] || 0) > (rm.keyTs[k] || 0)) continue; // 本地整键已删除且晚于远端写入
    const tm = tombM[k] || {};
    const merged = new Map();
    if (a) for (const [m, s] of a.members) merged.set(m, s);
    if (b) {
      for (const [m, s] of b.members) {
        if (merged.has(m)) { merged.set(m, Math.max(merged.get(m), s)); continue; }
        if (tm[m] && !a) continue; // 本地已删除该成员 → 阻止远端复活
        merged.set(m, s);
      }
    }
    for (const [m, s] of merged) data.zsets.push({ key: k, member: m, score: s, exp });
  }

  /* 墓碑 TTL 清理（收敛完成后释放，防止元数据无界增长） */
  const cutoff = now - TOMBSTONE_TTL_MS;
  for (const k of Object.keys(tombK)) if (tombK[k] < cutoff) delete tombK[k];
  for (const k of Object.keys(tombM)) {
    for (const m of Object.keys(tombM[k])) if (tombM[k][m] < cutoff) delete tombM[k][m];
    if (!Object.keys(tombM[k]).length) delete tombM[k];
  }

  return { data, meta: { keyTs, tombK, tombM } };
}

async function putSnapshot(body) {
  const { put } = await import('@vercel/blob');
  // 私有 store 需显式 access:'private'（服务端校验必传）；固定路径覆盖写入
  // @vercel/blob 2.8：addRandomSuffix 默认 false → 固定路径二次 put 必须显式 allowOverwrite
  await put(SNAPSHOT_KEY, body, { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
}

/** 拉取远端快照（不吞错误：供 uploadNow 区分"无快照"与"读取失败"，失败时禁止上传防覆盖） */
async function fetchRemote() {
  try {
    const { get } = await import('@vercel/blob');
    // @vercel/blob 2.8：get(pathname) 返回 { statusCode, stream, blob }；404 返回 null
    // useCache:false 旁路 CDN 缓存——快照是强一致恢复点，覆盖写后必须立即可读到最新版本
    const res = await get(SNAPSHOT_KEY, { access: 'private', useCache: false });
    if (!res || res.statusCode === 404) return null; // 仓库中尚无快照 ≠ 读取失败，置 null 允许首传
    const text = typeof res.text === 'function'
      ? await res.text()
      : await new Response(res.stream).text();
    const payload = JSON.parse(text);
    if (payload && payload.data && Array.isArray(payload.data.kv)) return payload;
    return null;
  } catch (e) {
    /* 兼容旧 SDK 的 not found 语义：空仓库允许首传；其余错误抛出防覆盖 */
    if (/not found/i.test(String((e && e.message) || e))) return null;
    throw e;
  }
}

/** 强制上传（无视节流；供 Cron 每日兜底调用）。
 *  上传前先合并远端快照：旧实例（缺少其他实例新写入，如新注册患者）直接全量覆盖上传
 *  会把远端新数据抹掉——这是多实例"计数 2 / 列表 1"与患者永久消失的根因。 */
async function uploadNow(db) {
  if (!enabled()) return { skipped: true, reason: 'disabled' };
  if (_uploading) return { skipped: true, reason: 'in-flight' };
  _uploading = true;
  try {
    let remote = null;
    try {
      remote = await fetchRemote();
    } catch (e) {
      // 远端可读但读取失败 → 放弃本次上传，防止用本地不完整状态覆盖云端
      console.warn('[blob-snapshot] skip upload, remote unreadable:', e.message);
      return { skipped: true, reason: 'remote-unreadable' };
    }
    const local = { data: db._export(), meta: db._mergeMeta ? db._mergeMeta() : emptyMeta() };
    const merged = mergePayloads(local, remote);
    const body = JSON.stringify({ updatedAt: new Date().toISOString(), ...merged });
    await putSnapshot(body);
    // 合并元数据回写本地：墓碑/时间戳基准收敛，避免重复并入与无界增长
    if (db._applyMergeMeta) db._applyMergeMeta(merged.meta);
    _lastOkAt = new Date().toISOString();
    _lastBytes = Buffer.byteLength(body);
    _lastOkTs = Date.now();
    _lastError = null;
    console.info('[blob-snapshot] uploaded', _lastBytes, 'bytes (merged with remote)');
    return { ok: true, bytes: _lastBytes };
  } catch (e) {
    _lastError = e.message;
    console.warn('[blob-snapshot] upload failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    _uploading = false;
  }
}

/** 防抖 + 节流调度（由 storage.js 的 L3 写钩子触发）
 *  opts.force=true：绕过最小间隔节流（用于注册/播种/清理等关键写事件，尽快让其他实例收敛）；
 *  force 仍保留短防抖（1.5s）合并突发写，避免同一请求内的多次写触发多次上传 */
function scheduleUpload(db, opts = {}) {
  if (!enabled() || _uploading) return;
  const force = !!opts.force;
  if (_timer) {
    if (!force) return; // 已有挂起调度，无需重复
    clearTimeout(_timer); _timer = null; // force：重置为更快的上传
  }
  _timer = setTimeout(async () => {
    _timer = null;
    if (!force) {
      const wait = _lastOkTs + minIntervalMs() - Date.now();
      if (wait > 0) {
        _timer = setTimeout(async () => { _timer = null; await uploadNow(db); }, wait);
        if (_timer.unref) _timer.unref();
        return;
      }
    }
    await uploadNow(db);
  }, force ? FORCE_DEBOUNCE_MS : DEBOUNCE_MS);
  if (_timer.unref) _timer.unref();
}

/** 关键写路径同步冲刷：取消挂起防抖，等待在飞上传结束后立即上传当前本地状态。
 *  Vercel lambda 响应返回后即冻结，防抖定时器不保证执行——注册/建档等"写后立即
 *  跨实例读"场景必须等待式上传，否则其他实例 forceSync 拉到的仍是旧快照。 */
async function flushUpload(db) {
  if (!enabled()) return { skipped: true, reason: 'disabled' };
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const deadline = Date.now() + 5000;
  while (_uploading && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (_uploading) return { skipped: true, reason: 'in-flight-timeout' };
  return await uploadNow(db);
}

/** 冷启动引导：下载远端快照；无快照/失败返回 null（调用方走种子兜底） */
async function download() {
  if (!enabled()) return null;
  try {
    return await fetchRemote();
  } catch (e) {
    if (/not found/i.test(String((e && e.message) || e))) {
      console.debug('[blob-snapshot] no remote snapshot yet');
      return null;
    }
    console.warn('[blob-snapshot] download failed:', (e && e.message) || e);
    return null;
  }
}

function status() {
  return {
    enabled: enabled(),
    lastUploadedAt: _lastOkAt,
    lastBytes: _lastBytes,
    lastError: _lastError,
    minIntervalSec: minIntervalMs() / 1000
  };
}

function resetForTest() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _uploading = false;
  _lastOkAt = null;
  _lastBytes = 0;
  _lastError = null;
  _lastOkTs = 0;
}

module.exports = { enabled, uploadNow, flushUpload, scheduleUpload, download, mergePayloads, emptyMeta, status, resetForTest };
