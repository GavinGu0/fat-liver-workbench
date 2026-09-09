'use strict';
/** 患者填报：运动记录 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { updatePatient, track, audit } = require('../_lib/services');
const { parse, exerciseSchema } = require('../_lib/validate');

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
    await updatePatient(user.patientId, (p) => { p.lastActivityAt = Date.now(); }, null);

    await track('data_submit', { data_type: 'exercise', user_id: user.uid });
    await audit('record.exercise', { uid: user.uid, patient_id: user.patientId });

    return { id: record.id, ts: record.ts };
  }
});
