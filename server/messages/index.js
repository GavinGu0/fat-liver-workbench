'use strict';
/**
 * 消息中心（三端共用）：
 * GET  消息列表 + 未读数 + 患者端随访弹窗标识（PRD 3.1.3）
 *      查询参数：read=all|unread|read（已读/未读筛选，默认 all）
 *                date=YYYY-MM-DD（按上海时区日期筛选）
 *                before=时间戳（分页游标：取该时刻之前的更早消息）
 *                limit=条数（默认 50，最大 200）
 * 列表项：{mid, type, title, content(html), from, ts, read}（新→旧排序）
 */
const { defineHandler } = require('../_lib/handler');
const { getPatient } = require('../_lib/services');
const { dateStr } = require('../_lib/storage');

/** 消息时间戳 → 上海时区日期字符串（与 dateStr 同规则，用于按日筛选） */
const dateStrAt = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(ts));

module.exports = defineHandler({
  auth: 'any',
  fn: async ({ user, query }) => {
    const { listMsgs, unreadCount } = require('../_lib/services');

    /* 全量拉取（lpush 已 ltrim 封顶 200 条），筛选与分页在内存完成 */
    const all = await listMsgs(user.uid, 200);
    const unread = await unreadCount(user.uid);

    const readFilter = query.read === 'unread' || query.read === 'read' ? query.read : 'all';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(query.date || '')) ? String(query.date) : '';
    const before = query.before ? Number(query.before) : 0;
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

    let items = all;
    if (readFilter === 'unread') items = items.filter(m => !m.read);
    else if (readFilter === 'read') items = items.filter(m => m.read);
    if (date) items = items.filter(m => dateStrAt(m.ts) === date);
    if (before > 0) items = items.filter(m => m.ts < before);
    items = items.slice(0, limit);

    const nextBefore = items.length === limit ? items[items.length - 1].ts : null;

    let followupToday = null;
    if (user.role === 'patient' && user.patientId) {
      const p = await getPatient(user.patientId);
      if (p && p.nextFollowupDate === dateStr()) {
        followupToday = { date: p.nextFollowupDate, note: p.followupNote || '' };
      }
    }
    return { items, unread, nextBefore, followupToday };
  }
});
