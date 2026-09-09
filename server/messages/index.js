'use strict';
/**
 * 消息中心（三端共用）：
 * GET  消息列表（前50条）+ 未读数 + 患者端随访弹窗标识（PRD 3.1.3）
 * 列表项：{mid, type, title, content(html), from, ts, read}
 */
const { defineHandler } = require('../_lib/handler');
const { getPatient } = require('../_lib/services');
const { dateStr } = require('../_lib/storage');

module.exports = defineHandler({
  auth: 'any',
  fn: async ({ user }) => {
    const { listMsgs, unreadCount } = require('../_lib/services');
    const items = await listMsgs(user.uid, 50);
    const unread = await unreadCount(user.uid);

    let followupToday = null;
    if (user.role === 'patient' && user.patientId) {
      const p = await getPatient(user.patientId);
      if (p && p.nextFollowupDate === dateStr()) {
        followupToday = { date: p.nextFollowupDate, note: p.followupNote || '' };
      }
    }
    return { items, unread, followupToday };
  }
});
