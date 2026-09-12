'use strict';
/**
 * 登录安全：登录日志 + 失败计数 + 账号锁定 + 异常统计
 * 策略：按登录标识（用户名/手机号小写归一）计数，15 分钟窗口内连续失败 5 次 → 锁定账号 15 分钟；
 *       日志按日存储（login:log:${date}，保留 500 条），供医护端查询与异常登录检测（失败集中、多账号同 IP）。
 * 自助解锁路径：短信验证码登录不受密码锁定影响；重置密码成功立即解锁。
 */
const { getDb, K, dateStr } = require('./storage');
const { ApiError } = require('./response');
const logger = require('./logger');

const MAX_FAIL = 5;          // 窗口内最大失败次数
const FAIL_WINDOW_SEC = 900; // 失败计数窗口（15 分钟）
const LOCK_SEC = 900;        // 账号锁定时长（15 分钟）
const LOCK_MIN = Math.round(LOCK_SEC / 60);
const LOG_KEEP = 499;        // 每日日志保留条数

/** 提取客户端元信息（IP / UA 截断） */
function clientMeta(req) {
  const h = (req && req.headers) || {};
  const xf = h['x-forwarded-for'];
  const ip = (typeof xf === 'string' ? xf.split(',')[0].trim() : '') || (req && req.socket && req.socket.remoteAddress) || '';
  const ua = String(h['user-agent'] || '').slice(0, 120);
  return { ip, ua };
}

/** 写入一条登录日志（成功/失败/锁定/重置 全量记录） */
async function recordLogin(db, entry) {
  try {
    const item = JSON.stringify({ ts: Date.now(), ...entry });
    const key = K.loginLog(dateStr());
    await db.lpush(key, item);
    await db.ltrim(key, 0, LOG_KEEP);
  } catch (e) {
    logger.warn('login.log.fail', { err: e.message });
  }
}

/** 锁定状态：{ locked, remainSec } */
async function getLock(db, key) {
  if (!key) return { locked: false, remainSec: 0 };
  const until = await db.get(K.loginLock(key));
  if (!until) return { locked: false, remainSec: 0 };
  const remainSec = Math.max(0, Math.ceil((Number(until) - Date.now()) / 1000));
  return remainSec > 0 ? { locked: true, remainSec } : { locked: false, remainSec: 0 };
}

/** 已锁定则抛错（含剩余时长与自助解锁指引） */
async function assertNotLocked(db, key) {
  const { locked, remainSec } = await getLock(db, key);
  if (locked) {
    const min = Math.max(1, Math.ceil(remainSec / 60));
    throw new ApiError(429, 40103,
      `失败次数过多，账号已临时锁定（约剩 ${min} 分钟）。您可改用短信验证码登录，或通过手机验证码重置密码立即解锁`);
  }
}

/**
 * 登记一次失败：返回 { count, locked, justLocked }
 * 达到 MAX_FAIL 时锁定账号并输出告警日志（供平台侧告警接入）
 */
async function registerFailure(db, key, { uid, account, ip } = {}) {
  const n = await db.incr(K.loginFail(key));
  if (n === 1) await db.expire(K.loginFail(key), FAIL_WINDOW_SEC);
  if (n >= MAX_FAIL) {
    await db.set(K.loginLock(key), String(Date.now() + LOCK_SEC * 1000), { ex: LOCK_SEC });
    await db.del(K.loginFail(key));
    logger.warn('login.lock', { uid: uid || '', account: account || '', ip: ip || '', fails: n });
    return { count: n, locked: true, justLocked: true };
  }
  return { count: n, locked: false, justLocked: false };
}

/** 登录成功：清除失败计数 */
async function clearFailures(db, key) {
  if (key) await db.del(K.loginFail(key));
}

/** 解锁（重置密码成功 / 管理员处理时调用）：清锁定标记与失败计数 */
async function unlock(db, key) {
  if (!key) return;
  await db.del(K.loginLock(key));
  await db.del(K.loginFail(key));
}

/* ---------------- 登录日志查询（医护端） ---------------- */

/** 展示层脱敏：手机号保留前3后4，其余账号保留前2后2 */
function maskAccount(acc) {
  const s = String(acc || '');
  if (!s) return '';
  if (/^1\d{10}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(7);
  if (s.length >= 6) return s.slice(0, 2) + '***' + s.slice(-2);
  return s;
}

/**
 * 查询登录日志：按日 + 状态筛选，附带异常统计
 * 异常检测口径：失败集中账号（疑似暴力破解）、多账号同 IP（疑似撞库）
 */
async function listLoginLogs(query = {}) {
  const db = await getDb();
  let date = String(query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = dateStr();

  const raw = await db.lrange(K.loginLog(date), 0, LOG_KEEP);
  const items = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);

  const status = String(query.status || '');
  const filtered = status ? items.filter((i) => i.status === status) : items;

  const stats = { total: items.length, success: 0, fail: 0, lock: 0, reset: 0, distinctIps: 0, topFailed: [], multiAccountIps: [] };
  const failByAccount = new Map();
  const ipAccounts = new Map();
  for (const i of items) {
    if (i.status === 'success') stats.success++;
    else if (i.status === 'fail') stats.fail++;
    else if (i.status === 'lock') stats.lock++;
    else if (i.status === 'reset') stats.reset++;
    if (i.status === 'fail' && i.account) failByAccount.set(i.account, (failByAccount.get(i.account) || 0) + 1);
    if (i.ip) {
      if (!ipAccounts.has(i.ip)) ipAccounts.set(i.ip, new Set());
      if (i.account) ipAccounts.get(i.ip).add(i.account);
    }
  }
  stats.topFailed = [...failByAccount.entries()]
    .map(([account, count]) => ({ account: maskAccount(account), count }))
    .sort((a, b) => b.count - a.count).slice(0, 5);
  stats.multiAccountIps = [...ipAccounts.entries()]
    .filter(([, s]) => s.size >= 3)
    .map(([ip, s]) => ({ ip, accounts: [...s].map(maskAccount) })).slice(0, 5);
  stats.distinctIps = ipAccounts.size;

  return { date, items: filtered.map((i) => ({ ...i, account: maskAccount(i.account) })), stats };
}

module.exports = {
  MAX_FAIL, FAIL_WINDOW_SEC, LOCK_SEC, LOCK_MIN,
  clientMeta, recordLogin, getLock, assertNotLocked,
  registerFailure, clearFailures, unlock,
  listLoginLogs, maskAccount
};
