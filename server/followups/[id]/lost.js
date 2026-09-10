'use strict';
/** 标记失访（仅主管医生）：记录失访原因，移出随访到期集合（质控失访率统计依据 lostAt） */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { requireDoctorOwn } = require('../../_lib/patient-access');
const { updatePatient, addArchiveEntry, audit } = require('../../_lib/services');
const { parse, followupLostSchema } = require('../../_lib/validate');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ params, body, user }) => {
    const pid = params.id;
    const p = await requireDoctorOwn(user, pid);
    const input = parse(followupLostSchema, body);
    const db = await getDb();

    const updated = await updatePatient(pid, (doc) => {
      doc.lostAt = Date.now();
      doc.lostReason = input.reason;
    }, null);
    if (p.nextFollowupDate) await db.srem(K.followupDue(p.nextFollowupDate), pid);

    await addArchiveEntry(pid, {
      kind: 'archive', type: 'followup',
      title: '患者标记失访',
      summary: `失访原因：${input.reason}；操作医生：${user.name}`,
      by: user.name
    });
    await audit('followup.lost', { operator: user.uid, patient_id: pid, reason: input.reason });
    return { patientId: pid, lostAt: updated.lostAt, lostReason: updated.lostReason };
  }
});
