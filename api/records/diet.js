'use strict';
/** 患者填报：饮食记录（多食物+拍照），幂等键防重复提交，30次/分钟限流 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { updatePatient, track, audit } = require('../_lib/services');
const { parse, dietSchema } = require('../_lib/validate');
const { requireRole } = require('../_lib/auth');

module.exports = defineHandler({
  auth: 'patient',
  limit: { scope: 'submit', max: 30, windowSec: 60, byUser: true },
  fn: async ({ body, user }) => {
    const input = parse(dietSchema, body);
    const db = await getDb();

    const record = {
      id: 'diet_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      patientId: user.patientId,
      meal: input.meal,
      recordDate: input.recordDate,
      recordTime: input.recordTime || null,
      foods: input.foods,
      photoUrl: input.photoUrl || null,
      note: input.note || ''
    };

    await db.lpush(K.diet(user.patientId), JSON.stringify(record));
    await db.ltrim(K.diet(user.patientId), 0, 499);
    await updatePatient(user.patientId, (p) => { p.lastActivityAt = Date.now(); }, null);

    await track('data_submit', { data_type: 'diet', user_id: user.uid });
    await audit('record.diet', { uid: user.uid, patient_id: user.patientId });

    return { id: record.id, ts: record.ts };
  }
});
