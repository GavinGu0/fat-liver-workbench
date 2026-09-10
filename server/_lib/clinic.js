'use strict';
/**
 * 专病临床领域服务：预警生成、筛查案例管理（供多个 handler 复用）
 * 预警模型：alert 文档 + alert:index:uid ZSet（score=ts）+ alert:unread 计数
 * 筛查模型：screen 文档 + doc 索引 ZSet + pid 索引（同一患者仅一条未处理案例）
 */
const { randomUUID } = require('node:crypto');
const { getDb, K, dateStr } = require('./storage');
const logger = require('./logger');

/* ---------------- 预警提醒 ---------------- */
/**
 * 生成一条预警（幂等：同一 patient+type 未处理时升级而不重复创建）
 * @param {object} opts { docId, patientId, patientName, level, type, title, content, link }
 * @returns {Promise<string>} alertId
 */
async function raiseAlert(opts) {
  const db = await getDb();
  const { docId, patientId, type } = opts;
  if (!docId || !patientId || !type) return null;

  // 幂等：该患者同类型存在未处理预警 → 更新内容与时间（升级重提醒）
  const existIds = await db.zrevrange(K.alertIdx(docId), 0, -1);
  for (const id of existIds.slice(0, 50)) {
    const raw = await db.get(K.alert(id));
    if (!raw) continue;
    try {
      const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (a.patientId === patientId && a.type === type && a.status === 'open') {
        a.title = opts.title || a.title;
        a.content = opts.content || a.content;
        a.level = opts.level || a.level;
        a.ts = Date.now();
        a.count = (a.count || 1) + 1;
        await db.set(K.alert(id), JSON.stringify(a));
        await db.zadd(K.alertIdx(docId), a.ts, id);
        return id;
      }
    } catch { continue; }
  }

  const id = 'al_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const alert = {
    id,
    docId,
    patientId,
    patientName: opts.patientName || '',
    level: opts.level || 'mid',          // high | mid | low
    type,
    title: opts.title || '风险提醒',
    content: opts.content || '',
    link: opts.link || null,
    status: 'open',                       // open | handled
    handlerNote: null,
    handledBy: null,
    handledAt: null,
    ts: Date.now(),
    count: 1
  };
  await db.set(K.alert(id), JSON.stringify(alert));
  await db.zadd(K.alertIdx(docId), alert.ts, id);
  await db.incr(K.alertUnread(docId));
  logger.info('alert.raise', { docId, patientId, type, level: alert.level });
  return id;
}

async function listAlerts(docId, { level, status, limit = 50 } = {}) {
  const db = await getDb();
  const ids = await db.zrevrange(K.alertIdx(docId), 0, limit * 3 - 1);
  const items = [];
  let openCount = 0, highOpen = 0;
  for (const id of ids) {
    const raw = await db.get(K.alert(id));
    if (!raw) continue;
    try {
      const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (level && a.level !== level) continue;
      if (a.status === 'open') { openCount++; if (a.level === 'high') highOpen++; }
      if (status && a.status !== status) continue;
      items.push(a);
      if (items.length >= limit) break;
    } catch { continue; }
  }
  const unread = Number(await db.get(K.alertUnread(docId))) || 0;
  return { items, unread, counts: { open: openCount, highOpen } };
}

/** 标记单条预警已处理 */
async function handleAlert(docId, alertId, { note, handlerName } = {}) {
  const db = await getDb();
  const raw = await db.get(K.alert(alertId));
  if (!raw) return null;
  const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (a.docId !== docId) return null; // 数据隔离
  if (a.status !== 'handled') {
    a.status = 'handled';
    a.handlerNote = note || '';
    a.handledBy = handlerName || '';
    a.handledAt = Date.now();
    await db.set(K.alert(alertId), JSON.stringify(a));
    const unread = Number(await db.get(K.alertUnread(docId))) || 0;
    await db.set(K.alertUnread(docId), Math.max(0, unread - 1));
  }
  return a;
}

/** 全部已读（预警） */
async function readAllAlerts(docId) {
  const db = await getDb();
  await db.set(K.alertUnread(docId), 0);
  const ids = await db.zrevrange(K.alertIdx(docId), 0, -1);
  for (const id of ids.slice(0, 100)) {
    const raw = await db.get(K.alert(id));
    if (!raw) continue;
    try {
      const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (a.status === 'open') { a.status = 'handled'; a.handlerNote = a.handlerNote || '（批量已读）'; a.handledAt = Date.now(); await db.set(K.alert(id), JSON.stringify(a)); }
    } catch { continue; }
  }
  return true;
}

/* ---------------- 筛查案例 ---------------- */
/**
 * 创建/更新筛查案例（同一患者仅保留一条 open 案例）
 * @returns {{ id: string, created: boolean, case: object }}
 */
async function upsertScreeningCase({ patient, source, hits, triggerNote }) {
  const db = await getDb();
  const docId = patient.docId;

  // 已有 open 案例 → 追加证据
  const openId = await db.get(K.screeningPid(patient.id) + ':open');
  if (openId) {
    const raw = await db.get(K.screening(openId));
    if (raw) {
      const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
      c.evidence = mergeEvidence(c.evidence, hits, source, triggerNote);
      c.ts = Date.now();
      c.suggestedRisk = suggestRiskOf(c.evidence, patient);
      await db.set(K.screening(openId), JSON.stringify(c));
      await db.zadd(K.screeningIdx(docId), c.ts, openId);
      await db.zadd(K.screeningAll, c.ts, openId);
      return { id: openId, created: false, case: c };
    }
  }

  const id = 'sc_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const record = {
    id,
    patientId: patient.id,
    patientName: patient.name,
    phone: patient.phone || '',
    docId,
    source,                                  // lis | pacs | manual | scan
    evidence: mergeEvidence([], hits, source, triggerNote),
    suggestedRisk: suggestRiskOf(hits, patient),
    status: 'pending',                       // pending | accepted | rejected
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    ts: Date.now()
  };
  await db.set(K.screening(id), JSON.stringify(record));
  await db.zadd(K.screeningIdx(docId), record.ts, id);
  await db.zadd(K.screeningAll, record.ts, id);
  await db.set(K.screeningPid(patient.id) + ':open', id);
  return { id, created: true, case: record };
}

function mergeEvidence(existing = [], hits = [], source, triggerNote) {
  const out = [...existing];
  for (const h of hits || []) {
    out.push({ rule: h.rule, detail: h.detail, source: h.source || source, ts: Date.now() });
  }
  if (triggerNote) out.push({ rule: '触发说明', detail: String(triggerNote).slice(0, 200), source, ts: Date.now() });
  return out.slice(-20);
}

/** 由筛查证据粗估建议风险等级 */
function suggestRiskOf(hits = [], patient = {}) {
  const srcs = new Set((hits || []).map(h => h.source));
  if (srcs.has('pacs')) {
    const usHit = (hits || []).find(h => h.source === 'pacs');
    if (usHit && /重度/.test(usHit.rule + (usHit.detail || ''))) return 'high';
    if (usHit && /中度/.test(usHit.rule + (usHit.detail || ''))) return 'mid';
  }
  const obesity = (hits || []).some(h => String(h.rule).includes('28'));
  const labHits = (hits || []).filter(h => h.source === 'lis').length;
  if (obesity && labHits >= 1) return 'high';
  if (labHits >= 2 || obesity) return 'mid';
  return (patient.risk === 'high') ? 'high' : 'mid';
}

async function getScreeningCase(id) {
  const db = await getDb();
  const raw = await db.get(K.screening(id));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

/** 最新检验记录（用于扫描） */
async function latestLabs(db, pid) {
  const arr = await db.zrevrange(K.labs(pid), 0, 0);
  if (!arr.length) return null;
  try { return JSON.parse(typeof arr[0] === 'string' ? arr[0] : arr[0]); } catch { return null; }
}

module.exports = {
  raiseAlert,
  listAlerts,
  handleAlert,
  readAllAlerts,
  upsertScreeningCase,
  getScreeningCase,
  latestLabs,
  todayStr: () => dateStr()
};
