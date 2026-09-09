'use strict';
/**
 * 领域服务层：患者档案、消息推送、审计、埋点、全局配置
 * 乐观锁 + 分布式锁弥补无数据库事务短板；key 前缀隔离三端共库。
 */
const { randomUUID } = require('node:crypto');
const { ApiError } = require('./response');
const { getDb, K, dateStr, withLock } = require('./storage');
const { putJson, blobConfigured } = require('./blob');
const logger = require('./logger');

/* ---------------- 患者档案 ---------------- */
async function getPatient(patientId) {
  const db = await getDb();
  const raw = await db.get(K.patient(patientId));
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * 乐观锁更新患者档案（version 不匹配抛 409）
 * @param {(p: object) => void} mutator 就地修改档案
 */
async function updatePatient(patientId, mutator, expectVersion) {
  return withLock(`patient:${patientId}`, 5, async (db) => {
    const raw = await db.get(K.patient(patientId));
    if (!raw) throw new ApiError(404, 40400, '患者不存在');
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (expectVersion !== undefined && expectVersion !== null && Number(p.version) !== Number(expectVersion)) {
      throw new ApiError(409, 40903, '数据已被他人修改，请刷新后重试');
    }
    mutator(p);
    p.version = (Number(p.version) || 0) + 1;
    p.lastActivityAt = Date.now();
    await db.set(K.patient(patientId), JSON.stringify(p));
    await db.zadd(K.docPatients(p.docId), p.lastActivityAt, p.id);
    await db.zadd(K.allPatients, p.lastActivityAt, p.id);
    return p;
  });
}

async function addArchiveEntry(patientId, entry) {
  const db = await getDb();
  await db.lpush(K.archive(patientId), JSON.stringify({ id: 'ar_' + randomUUID().slice(0, 12), ts: Date.now(), ...entry }));
  await db.ltrim(K.archive(patientId), 0, 99);
}

/* ---------------- 消息推送（站内信，患者/医护共用） ---------------- */
async function pushMsg(userId, msg) {
  if (!userId) return;
  const db = await getDb();
  const item = JSON.stringify({
    mid: 'm_' + randomUUID().replace(/-/g, '').slice(0, 16),
    ts: Date.now(),
    read: false,
    ...msg
  });
  await db.lpush(K.msg(userId), item);
  await db.ltrim(K.msg(userId), 0, 199);
  await db.incr(K.msgUnread(userId));
  logger.info('msg.push', { to: userId, type: msg.type, title: msg.title });
}

async function listMsgs(userId, limit = 50) {
  const db = await getDb();
  const arr = await db.lrange(K.msg(userId), 0, limit - 1);
  return arr.map(x => {
    try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; }
  }).filter(Boolean);
}

async function markMsgRead(userId, mid) {
  const db = await getDb();
  const arr = await db.lrange(K.msg(userId), 0, -1);
  let changed = false;
  const items = arr.map(x => {
    try {
      const o = typeof x === 'string' ? JSON.parse(x) : x;
      if (o && o.mid === mid && !o.read) { o.read = true; changed = true; return JSON.stringify(o); }
      return typeof x === 'string' ? x : JSON.stringify(x);
    } catch { return typeof x === 'string' ? x : JSON.stringify(x); }
  });
  if (changed) {
    await db.del(K.msg(userId));
    for (const it of items.reverse()) await db.rpush(K.msg(userId), it); // lrange 为新→旧，rpush 还原顺序
    await db.ltrim(K.msg(userId), 0, 199);
  }
  return changed;
}

async function markAllMsgsRead(userId) {
  const db = await getDb();
  const arr = await db.lrange(K.msg(userId), 0, -1);
  const items = arr.map(x => {
    try { const o = typeof x === 'string' ? JSON.parse(x) : x; o.read = true; return JSON.stringify(o); }
    catch { return typeof x === 'string' ? x : JSON.stringify(x); }
  });
  await db.del(K.msg(userId), K.msgUnread(userId));
  for (const it of items.reverse()) await db.rpush(K.msg(userId), it);
  await db.ltrim(K.msg(userId), 0, 199);
}

async function unreadCount(userId) {
  const db = await getDb();
  const n = await db.get(K.msgUnread(userId));
  return Number(n) || 0;
}

/* ---------------- 埋点（PRD 第6节） ---------------- */
async function track(event, data = {}) {
  try {
    const db = await getDb();
    const key = K.track(dateStr());
    await db.lpush(key, JSON.stringify({ event, ts: Date.now(), ...data }));
    await db.ltrim(key, 0, 999);
  } catch (e) {
    logger.warn('track.fail', { event, err: e.message });
  }
}

/* ---------------- 审计：KV 明细（当月）+ Blob 月度归档（可追溯） ---------------- */
async function audit(action, entry = {}) {
  try {
    const db = await getDb();
    const month = dateStr().slice(0, 7);
    const item = JSON.stringify({ ts: Date.now(), action, ...entry });
    await db.lpush(K.audit(month), item);
    await db.ltrim(K.audit(month), 0, 999);
    if (blobConfigured()) {
      const existing = await db.lrange(K.audit(month), 0, 999);
      await putJson(`audits/${month}.json`, existing.map(x => { try { return JSON.parse(x); } catch { return x; } }));
    }
  } catch (e) {
    logger.warn('audit.fail', { action, err: e.message });
  }
}

/* ---------------- 全局配置（Edge Config → KV → 内置默认） ---------------- */
async function getConfig(key, fallback = []) {
  const db = await getDb();
  try {
    if (process.env.EDGE_CONFIG) {
      const ec = await import('@vercel/edge-config');
      const v = await (ec.default || ec).get(`flwb_${key}`);
      if (v) return v;
    }
  } catch { /* Edge Config 不可用时降级 */ }
  try {
    const raw = await db.get(K.config(key));
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { /* ignore */ }
  return fallback;
}

async function setConfig(key, value) {
  const db = await getDb();
  await db.set(K.config(key), JSON.stringify(value));
}

module.exports = {
  getPatient,
  updatePatient,
  addArchiveEntry,
  pushMsg,
  listMsgs,
  markMsgRead,
  markAllMsgsRead,
  unreadCount,
  track,
  audit,
  getConfig,
  setConfig
};
