'use strict';
/**
 * 复诊管理：
 * PUT  设置复诊计划（时间/地点/注意事项）
 * POST 发送复诊提醒 → 消息中心（PRD 3.1.2）
 */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { requireDoctorOwn } = require('../../_lib/patient-access');
const { updatePatient, pushMsg, audit } = require('../../_lib/services');
const { parse, revisitSchema } = require('../../_lib/validate');
const { ApiError } = require('../../_lib/response');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, params, body, user }) => {
    const pid = params.id;
    const db = await getDb();
    const p = await requireDoctorOwn(user, pid);

    if (req.method === 'PUT') {
      const input = parse(revisitSchema, body);
      const updated = await updatePatient(pid, (doc) => {
        doc.nextRevisitAt = input.date;
      }, null);
      const plan = { date: input.date, place: input.place, notes: input.notes || '', setBy: user.name, setAt: Date.now() };
      await db.set(K.revisit(pid), JSON.stringify(plan));
      await audit('revisit.set', { operator: user.uid, patient_id: pid, date: input.date });
      return { ...plan, version: updated.version };
    }

    // POST 发送提醒
    const raw = await db.get(K.revisit(pid));
    if (!raw) throw new ApiError(404, 40400, '请先设置复诊计划');
    const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (!p.userId) throw new ApiError(409, 40902, '该患者尚未注册小程序账号，无法推送提醒');
    await pushMsg(p.userId, {
      type: 'revisit_reminder',
      title: '复诊提醒',
      content: `<p>您的医生为您安排了复诊：</p><p><b>时间：</b>${plan.date}</p><p><b>地点：</b>${plan.place}</p><p><b>注意：</b>${plan.notes || '无'}</p>`,
      from: user.name,
      payload: { date: plan.date, place: plan.place, notes: plan.notes }
    });
    await audit('revisit.remind', { operator: user.uid, patient_id: pid });
    return { sent: true };
  }
});
