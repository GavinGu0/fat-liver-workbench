'use strict';
/**
 * 一键发送随访提醒给患者（站内信；预留短信通道 SMS_KEY）
 * 批量：逐个校验仅主管医生可操作，未注册账号的患者计入 skipped
 */
const { defineHandler } = require('../_lib/handler');
const { requireDoctorOwn } = require('../_lib/patient-access');
const { pushMsg, audit, track } = require('../_lib/services');
const { parse, followupRemindSchema } = require('../_lib/validate');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 20, windowSec: 60, byUser: true },
  fn: async ({ body, user }) => {
    const input = parse(followupRemindSchema, body);
    const sent = [];
    const skipped = [];

    for (const pid of input.patientIds) {
      const p = await requireDoctorOwn(user, pid);
      if (!p.userId) {
        skipped.push({ patientId: pid, name: p.name, reason: '患者未绑定小程序账号，无法接收站内提醒' });
        continue;
      }
      await pushMsg(p.userId, {
        type: 'followup_remind',
        title: '随访提醒',
        content: `<p><b>${user.name}</b> 医生提醒您：您的随访日期为 <b>${p.nextFollowupDate || '待定'}</b>，请按时记录饮食、运动并保持随访指标更新，如有不适请及时就诊。</p>`,
        from: user.name,
        payload: { patientId: pid, date: p.nextFollowupDate || null }
      });
      sent.push({ patientId: pid, name: p.name, nextFollowupDate: p.nextFollowupDate || null });
    }

    await audit('followup.remind', { operator: user.uid, sent: sent.length, skipped: skipped.length });
    await track('followup_remind', { doc_id: user.uid, sent: sent.length });
    return { sent: sent.length, items: sent, skipped };
  }
});
