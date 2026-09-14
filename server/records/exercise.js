'use strict';
/** 患者填报：运动记录 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { updatePatient, track, audit, pushMsg } = require('../_lib/services');
const { parse, exerciseSchema } = require('../_lib/validate');
const { INTENSITY_LABELS } = require('@flwb/shared');

module.exports = defineHandler({
  auth: 'patient',
  limit: { scope: 'submit', max: 30, windowSec: 60, byUser: true },
  fn: async ({ body, user }) => {
    const input = parse(exerciseSchema, body);

    const record = {
      id: 'ex_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      patientId: user.patientId,
      type: input.type,
      minutes: input.minutes,
      intensity: input.intensity,
      recordDate: input.recordDate,
      note: input.note || ''
    };

    const db = await getDb();
    await db.lpush(K.exercise(user.patientId), JSON.stringify(record));
    await db.ltrim(K.exercise(user.patientId), 0, 499);

    /* 写入后读回验证 */
    const verify = await db.lrange(K.exercise(user.patientId), 0, 0);
    if (verify.length) {
      const latest = JSON.parse(verify[0]);
      if (latest.id !== record.id) {
        console.error('[storage.verify] exercise write verify FAIL id mismatch:', { expect: record.id, got: latest.id });
        throw new ApiError(500, 50010, '数据写入确认失败，请稍后重试');
      }
    }

    const p = await updatePatient(user.patientId, (doc) => { doc.lastActivityAt = Date.now(); }, null);

    await track('data_submit', { data_type: 'exercise', user_id: user.uid });
    await audit('record.exercise', { uid: user.uid, patient_id: user.patientId });

    /* 推送主管医生：患者完成运动记录 */
    await pushMsg(p && p.docId, {
      type: 'patient_submit',
      title: `🏃 ${p.name || '患者'} 完成运动记录`,
      content: `<p>${input.type} ${input.minutes} 分钟（${INTENSITY_LABELS[input.intensity] || input.intensity}）</p>`,
      from: p.name || '患者',
      link: `/patients/${user.patientId}`
    });

    /* 患者填报是关键写事件：强制上传快照（1.5s 内），医生端实例 60s 内收敛可见 */
    try { require('../_lib/blob-snapshot').scheduleUpload(db, { force: true }); } catch { /* ignore */ }

    return { id: record.id, ts: record.ts };
  }
});
