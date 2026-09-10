'use strict';
/**
 * 随访执行（仅主管医生）：登记随访方式/结果/结论，自动排下次随访（入参 nextDate 优先，
 * 否则按风险周期 suggestFollowupDate），同步 due 集合、档案时间线与失访状态清除。
 */
const { randomUUID } = require('node:crypto');
const { defineHandler } = require('../../_lib/handler');
const { getDb, K, dateStr } = require('../../_lib/storage');
const { requireDoctorOwn } = require('../../_lib/patient-access');
const { updatePatient, addArchiveEntry, audit, track } = require('../../_lib/services');
const { parse, followupExecuteSchema } = require('../../_lib/validate');
const { suggestFollowupDate } = require('@flwb/shared');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 60, windowSec: 60, byUser: true },
  fn: async ({ params, body, user }) => {
    const pid = params.id;
    const p = await requireDoctorOwn(user, pid);
    const input = parse(followupExecuteSchema, body);
    const db = await getDb();
    const today = dateStr();

    const dueDate = p.nextFollowupDate || null;
    const nextDate = input.nextDate || suggestFollowupDate(p.risk || 'mid', today);

    const record = {
      id: 'fu_' + randomUUID().replace(/-/g, '').slice(0, 12),
      ts: Date.now(),
      dueDate,
      method: input.method,
      outcome: input.outcome,
      conclusion: input.conclusion || null,
      nextDate,
      by: user.name
    };
    await db.lpush(K.followupRec(pid), JSON.stringify(record));
    await db.ltrim(K.followupRec(pid), 0, 99);

    const updated = await updatePatient(pid, (doc) => {
      doc.lastFollowupAt = Date.now();
      doc.lastFollowupMethod = input.method;
      doc.lastFollowupSummary = input.outcome;
      doc.nextFollowupDate = nextDate;
      doc.followupNote = '';
      doc.reminderSentOn = null;
      if (doc.lostAt) { doc.lostAt = null; doc.lostReason = null; } // 失访后重新取得联系 → 重新纳入
    }, null);

    await (async () => { // 同步 due 集合
      if (dueDate) await db.srem(K.followupDue(dueDate), pid);
      await db.sadd(K.followupDue(nextDate), pid);
    })();

    await addArchiveEntry(pid, {
      kind: 'archive', type: 'followup',
      title: `随访执行（${input.method}${dueDate ? '，原定 ' + dueDate : ''}）`,
      summary: `结果：${input.outcome}${input.conclusion ? '；结论：' + input.conclusion : ''}；下次随访：${nextDate}`,
      by: user.name
    });
    await audit('followup.execute', { operator: user.uid, patient_id: pid, method: input.method, nextDate });
    await track('followup_execute', { doc_id: user.uid, patient_id: pid, method: input.method });

    return { record, nextFollowupDate: nextDate, risk: updated.risk };
  }
});
