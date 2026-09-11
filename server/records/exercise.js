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

    return { id: record.id, ts: record.ts };
  }
});
