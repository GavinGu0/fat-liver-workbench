'use strict';
/** 设置随访日期（乐观锁：version 不匹配返回 40903） */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K, withLock } = require('../../_lib/storage');
const { requireDoctorOwn } = require('../../_lib/patient-access');
const { updatePatient, audit } = require('../../_lib/services');
const { parse, followupSchema } = require('../../_lib/validate');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ params, body, user }) => {
    const pid = params.id;
    await requireDoctorOwn(user, pid);
    const input = parse(followupSchema, body);

    let oldDate = null;
    const updated = await updatePatient(pid, (p) => {
      oldDate = p.nextFollowupDate || null;
      p.nextFollowupDate = input.date;
      p.followupNote = input.note || '';
    }, input.version ?? null);

    await withLock(`followup:${pid}`, 5, async (db) => {
      if (oldDate) await db.srem(K.followupDue(oldDate), pid);
      await db.sadd(K.followupDue(input.date), pid);
    });

    await audit('followup.set', { operator: user.uid, patient_id: pid, date: input.date });
    return { id: pid, nextFollowupDate: updated.nextFollowupDate, version: updated.version };
  }
});
