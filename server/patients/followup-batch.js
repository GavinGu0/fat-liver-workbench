'use strict';
/** 批量设置随访日期（PRD 3.1.2 批量设置随访） */
const { defineHandler } = require('../_lib/handler');
const { getDb, K, withLock } = require('../_lib/storage');
const { requireDoctorOwn } = require('../_lib/patient-access');
const { updatePatient, audit } = require('../_lib/services');
const { parse, batchFollowupSchema } = require('../_lib/validate');
const { ApiError } = require('../_lib/response');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ body, user }) => {
    const input = parse(batchFollowupSchema, body);
    const results = [];

    for (const pid of input.patientIds) {
      const p = await requireDoctorOwn(user, pid);
      const oldDate = p.nextFollowupDate;
      const updated = await updatePatient(pid, (doc) => {
        doc.nextFollowupDate = input.date;
        doc.followupNote = input.note || '';
      }, null);
      await withLock(`followup:${pid}`, 5, async (db) => {
        if (oldDate) await db.srem(K.followupDue(oldDate), pid);
        await db.sadd(K.followupDue(input.date), pid);
      });
      results.push({ patientId: pid, name: updated.name, date: input.date });
    }

    await audit('followup.batchSet', { operator: user.uid, count: results.length, date: input.date });
    return { updated: results.length, date: input.date, items: results };
  }
});
