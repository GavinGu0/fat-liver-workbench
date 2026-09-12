'use strict';
/**
 * 一键发送随访提醒给患者（站内信 + 预留短信通道）
 * 批量：逐个校验仅主管医生可操作，未注册账号的患者计入 skipped
 * 发送全程记录 notify 日志（成功/失败/重试状态可查，失败自动进入重试队列）
 */
const { defineHandler } = require('../_lib/handler');
const { requireDoctorOwn } = require('../_lib/patient-access');
const { audit, track } = require('../_lib/services');
const { sendReminder } = require('../_lib/notify');
const { parse, followupRemindSchema } = require('../_lib/validate');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 20, windowSec: 60, byUser: true },
  fn: async ({ body, user }) => {
    const input = parse(followupRemindSchema, body);
    const sent = [];
    const skipped = [];
    const failed = [];

    for (const pid of input.patientIds) {
      const p = await requireDoctorOwn(user, pid);
      if (!p.userId) {
        skipped.push({ patientId: pid, name: p.name, reason: '患者未绑定小程序账号，无法接收站内提醒，建议电话随访' });
        continue;
      }
      const r = await sendReminder({
        userId: p.userId, patientId: pid, patientName: p.name, docId: user.uid,
        bizType: 'followup_remind_manual',
        channels: ['inapp'],
        msg: {
          type: 'followup_remind',
          title: '随访提醒',
          content: `<p><b>${user.name}</b> 医生提醒您：您的随访日期为 <b>${p.nextFollowupDate || '待定'}</b>，请按时记录饮食、运动并保持随访指标更新，如有不适请及时就诊。</p>`,
          from: user.name,
          payload: { patientId: pid, date: p.nextFollowupDate || null }
        }
      });
      if (r.status === 'sent') {
        sent.push({ patientId: pid, name: p.name, nextFollowupDate: p.nextFollowupDate || null, notifyId: r.notifyId });
      } else {
        failed.push({ patientId: pid, name: p.name, reason: r.reason || '发送失败，已进入自动重试队列', notifyId: r.notifyId });
      }
    }

    await audit('followup.remind', { operator: user.uid, sent: sent.length, failed: failed.length, skipped: skipped.length });
    await track('followup_remind', { doc_id: user.uid, sent: sent.length });
    return { sent: sent.length, items: sent, failed, skipped };
  }
});
