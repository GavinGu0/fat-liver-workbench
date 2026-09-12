'use strict';
/**
 * 通知发送服务层：统一多渠道消息发送 + 状态跟踪 + 日志 + 失败重试 + 管理员告警
 *
 * 设计（弥补无数据库事务短板，KV 实现）：
 * - 发送明细 notify:item:{id}（KV 单条，含 status/重试计数/错误信息）
 * - 按日日志 notify:log:{date}（List，供医护端查询）
 * - 重试队列 notify:retry:queue（ZSet，score = 下次重试时间戳）
 * - 站内信渠道直接落库（必然成功）；短信渠道预留 SMS_KEY，未配置记为 skipped
 * - 最终失败（超过重试上限）→ raiseAlert 管理员告警 + 主管医生站内信
 */
const { randomUUID } = require('node:crypto');
const { getDb, K, dateStr } = require('./storage');
const { pushMsg } = require('./services');
const { raiseAlert } = require('./clinic');
const logger = require('./logger');

const MAX_RETRY = 3;                 // 立即重试 + 队列重试总上限
const RETRY_BACKOFF_MS = [30 * 1000, 5 * 60 * 1000, 30 * 60 * 1000]; // 30s / 5min / 30min
const DAY = 86400000;
const LOG_KEEP_DAYS = 30;

/** 上海时区日期 */
function todayStr() { return dateStr(); }

/**
 * 发送一条带跟踪的通知（随访提醒等业务入口统一调用）
 * @param {object} opts
 * @param {string} opts.userId 接收用户 uid（患者账号）
 * @param {string} opts.patientId 患者档案 id
 * @param {string} opts.patientName 患者姓名（日志展示）
 * @param {string} opts.docId 主管医生 uid（失败告警接收人）
 * @param {string} opts.bizType 业务类型：followup_remind / followup_pre_remind / education ...
 * @param {object} opts.msg pushMsg 消息体 { type, title, content, from, payload }
 * @param {string[]} [opts.channels] 渠道，默认 ['inapp']；['inapp','sms'] 时短信未配置记 skipped
 * @returns {Promise<{notifyId:string, status:string, mid:string|null}>}
 */
async function sendReminder(opts) {
  const { userId, patientId, patientName, docId, bizType, msg, channels = ['inapp'] } = opts;
  if (!userId) return { notifyId: null, status: 'skipped', mid: null, reason: '用户未绑定账号' };

  const db = await getDb();
  const notifyId = 'ntf_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const log = {
    id: notifyId,
    bizType,
    patientId: patientId || null,
    patientName: patientName || '',
    toUserId: userId,
    docId: docId || null,
    channels,
    status: 'pending',            // pending | sent | partial | failed | skipped | retrying
    detail: {},                   // channel -> { status, mid?, error?, ts }
    msgSnapshot: msg,             // 消息快照（手动重发 / 排查依据）
    retryCount: 0,
    error: null,
    createdAt: Date.now(),
    sentAt: null
  };

  for (const ch of channels) {
    try {
      if (ch === 'inapp') {
        const mid = await pushMsg(userId, msg);
        log.detail.inapp = { status: mid ? 'sent' : 'failed', mid: mid || null, ts: Date.now() };
      } else if (ch === 'sms') {
        if (process.env.SMS_KEY) {
          // 生产短信通道预留（阿里云/腾讯云），接入后替换
          log.detail.sms = { status: 'failed', error: '短信服务商调用未实现', ts: Date.now() };
        } else {
          log.detail.sms = { status: 'skipped', error: '短信服务未配置（SMS_KEY），仅站内信送达', ts: Date.now() };
        }
      } else {
        log.detail[ch] = { status: 'skipped', error: `未知渠道 ${ch}`, ts: Date.now() };
      }
    } catch (e) {
      log.detail[ch] = { status: 'failed', error: e.message, ts: Date.now() };
    }
  }

  log.status = summarizeStatus(log.detail);
  log.error = firstError(log.detail);
  log.sentAt = log.status === 'sent' ? Date.now() : null;

  await persistLog(db, log);
  await scheduleRetryIfNeeded(db, log, opts);
  return { notifyId, status: log.status, mid: (log.detail.inapp && log.detail.inapp.mid) || null };
}

/** 汇总渠道状态 → 单条状态 */
function summarizeStatus(detail) {
  const arr = Object.values(detail);
  if (arr.some(d => d.status === 'failed')) {
    return arr.every(d => d.status === 'failed') ? 'failed' : 'partial';
  }
  if (arr.some(d => d.status === 'sent')) return arr.every(d => d.status === 'sent') ? 'sent' : 'partial';
  return 'skipped';
}

function firstError(detail) {
  for (const d of Object.values(detail)) {
    if (d.status === 'failed' && d.error) return d.error;
  }
  return null;
}

/** 落库：单条明细 + 按日日志（保留30天） */
async function persistLog(db, log) {
  try {
    await db.set(K.notifyItem(log.id), JSON.stringify(log), { ex: LOG_KEEP_DAYS * 2 });
    await db.lpush(K.notifyLog(todayStr()), JSON.stringify({ id: log.id, ts: log.createdAt, bizType: log.bizType, patientId: log.patientId, patientName: log.patientName, status: log.status }));
    await db.ltrim(K.notifyLog(todayStr()), 0, 999);
  } catch (e) {
    logger.warn('notify.persist.fail', { id: log.id, err: e.message });
  }
}

/** 失败且未超重试上限 → 入重试队列（ZSet，score=下次重试时间） */
async function scheduleRetryIfNeeded(db, log, originOpts) {
  if (log.status !== 'failed' && log.status !== 'partial') return;
  if (log.retryCount >= MAX_RETRY) {
    await alertFinalFailure(log, originOpts);
    return;
  }
  const delay = RETRY_BACKOFF_MS[Math.min(log.retryCount, RETRY_BACKOFF_MS.length - 1)];
  await db.zadd(K.notifyRetry, Date.now() + delay, JSON.stringify({ id: log.id, opts: compactOpts(originOpts) }));
}

function compactOpts(o) {
  return {
    userId: o.userId, patientId: o.patientId, patientName: o.patientName,
    docId: o.docId, bizType: o.bizType, msg: o.msg, channels: o.channels
  };
}

/** 超过重试上限的最终失败 → 管理员（主管医生）告警 + 站内信 */
async function alertFinalFailure(log, opts) {
  const docId = (opts && opts.docId) || log.docId;
  const name = (opts && opts.patientName) || log.patientName || log.patientId || '';
  try {
    if (docId) {
      await raiseAlert({
        docId,
        patientId: log.patientId,
        patientName: name,
        level: 'high',
        type: 'notify_send_failed',
        title: `提醒发送失败（已重试${log.retryCount}次）：${name}`,
        content: `患者 ${name} 的【${log.bizType}】提醒经 ${log.retryCount} 次重试后仍发送失败。错误：${log.error || '未知'}。请电话联系患者或核查患者账号状态。`,
        link: '/followup'
      });
      await pushMsg(docId, {
        type: 'notify_fail_alert',
        title: '提醒发送失败告警',
        content: `<p>患者 <b>${name}</b> 的提醒消息重试 ${log.retryCount} 次后仍失败（${log.error || '未知错误'}），请改用电话随访。</p>`,
        from: '通知服务'
      });
    }
    logger.error('notify.final-fail', { id: log.id, bizType: log.bizType, patientId: log.patientId, error: log.error });
  } catch (e) {
    logger.warn('notify.alert.fail', { id: log.id, err: e.message });
  }
}

/**
 * 处理重试队列（由 cron 每次调度时调用）：到期项重发，成功更新状态，超限告警
 * @returns {Promise<{retried:number, ok:number, fail:number}>}
 */
async function processRetryQueue() {
  const db = await getDb();
  const nowTs = Date.now();
  const due = await db.zrangebyscore(K.notifyRetry, 0, nowTs, { limit: { offset: 0, count: 50 } });
  let retried = 0, ok = 0, fail = 0;

  for (const raw of due) {
    let task = null;
    try { task = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { task = null; }
    await db.zrem(K.notifyRetry, raw);
    if (!task || !task.id || !task.opts) continue;

    const itemRaw = await db.get(K.notifyItem(task.id));
    if (!itemRaw) continue; // 明细已过期，放弃
    let log = null;
    try { log = typeof itemRaw === 'string' ? JSON.parse(itemRaw) : itemRaw; } catch { continue; }

    log.retryCount = (log.retryCount || 0) + 1;
    log.status = 'retrying';
    retried++;

    // 重发站内信渠道（仅重试失败渠道）
    let success = true;
    const errors = [];
    for (const ch of log.channels || ['inapp']) {
      const d = log.detail[ch];
      if (!d || d.status === 'sent' || d.status === 'skipped') continue;
      try {
        if (ch === 'inapp') {
          const mid = await pushMsg(task.opts.userId, task.opts.msg);
          log.detail[ch] = { status: mid ? 'sent' : 'failed', mid: mid || null, ts: Date.now() };
          if (!mid) { success = false; errors.push('站内信写入失败'); }
        } else if (ch === 'sms') {
          log.detail[ch] = { status: process.env.SMS_KEY ? 'failed' : 'skipped', error: process.env.SMS_KEY ? '短信服务商调用未实现' : '短信服务未配置', ts: Date.now() };
          if (process.env.SMS_KEY) { success = false; errors.push('短信发送失败'); }
        }
      } catch (e) {
        success = false;
        errors.push(e.message);
        log.detail[ch] = { status: 'failed', error: e.message, ts: Date.now() };
      }
    }

    if (success) {
      log.status = 'sent';
      log.sentAt = Date.now();
      log.error = null;
      ok++;
    } else if (log.retryCount >= MAX_RETRY) {
      log.status = 'failed';
      log.error = errors.join('；') || '重试仍失败';
      fail++;
      await alertFinalFailure(log, task.opts);
    } else {
      log.status = 'partial';
      log.error = errors.join('；') || null;
      const delay = RETRY_BACKOFF_MS[Math.min(log.retryCount, RETRY_BACKOFF_MS.length - 1)];
      await db.zadd(K.notifyRetry, Date.now() + delay, JSON.stringify(task));
    }

    await db.set(K.notifyItem(log.id), JSON.stringify(log), { ex: LOG_KEEP_DAYS * 2 });
    await updateDailyLogStatus(db, log);
  }

  if (retried) logger.info('notify.retry.processed', { retried, ok, fail });
  return { retried, ok, fail };
}

/** 更新按日日志中对应条目的状态（重建头部1000条） */
async function updateDailyLogStatus(db, log) {
  try {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(log.createdAt));
    const key = K.notifyLog(day);
    const arr = await db.lrange(key, 0, 999);
    const items = arr.map(x => {
      try {
        const o = typeof x === 'string' ? JSON.parse(x) : x;
        return o && o.id === log.id ? JSON.stringify({ ...o, status: log.status, retried: log.retryCount }) : x;
      } catch { return x; }
    });
    await db.del(key);
    for (const it of items.reverse()) await db.rpush(key, it);
    await db.ltrim(key, 0, 999);
  } catch (e) {
    logger.warn('notify.daily-log.update.fail', { id: log.id, err: e.message });
  }
}

/**
 * 查询发送日志（医护端）
 * @param {{date?:string, status?:string, page?:number, size?:number}} q
 */
async function listNotifyLogs(q = {}) {
  const db = await getDb();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : todayStr();
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(q.size, 10) || 20));

  const arr = (await db.lrange(K.notifyLog(date), 0, 999)).map(x => {
    try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; }
  }).filter(Boolean);

  const items = q.status ? arr.filter(x => x.status === q.status) : arr;
  const stats = {
    total: arr.length,
    sent: arr.filter(x => x.status === 'sent').length,
    failed: arr.filter(x => x.status === 'failed' || x.status === 'partial').length,
    skipped: arr.filter(x => x.status === 'skipped').length,
    pending: arr.filter(x => x.status === 'pending' || x.status === 'retrying').length
  };

  return { date, stats, page, size, total: items.length, items: items.slice((page - 1) * size, page * size) };
}

/** 单条明细（含各渠道状态与错误信息） */
async function getNotifyItem(id) {
  const db = await getDb();
  const raw = await db.get(K.notifyItem(id));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

/** 手动重发一条失败通知（医护端补救入口） */
async function resendNotify(id) {
  const db = await getDb();
  const raw = await db.get(K.notifyItem(id));
  if (!raw) return null;
  let log = null;
  try { log = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }

  const r = await sendReminder({
    userId: log.toUserId,
    patientId: log.patientId,
    patientName: log.patientName,
    docId: log.docId,
    bizType: log.bizType + '_resend',
    msg: log.msgSnapshot || null
  }).catch(() => null);

  // 标记原记录已人工重发
  if (r && r.notifyId) {
    log.manualResentAt = Date.now();
    log.manualResendId = r.notifyId;
    await db.set(K.notifyItem(log.id), JSON.stringify(log), { ex: LOG_KEEP_DAYS * 2 });
  }
  return r;
}

module.exports = {
  sendReminder,
  processRetryQueue,
  listNotifyLogs,
  getNotifyItem,
  resendNotify,
  MAX_RETRY
};
