'use strict';
/**
 * 辅助检查（检验）指标（结构化电子病历「六、辅助检查」）：
 * GET 查询（医护/本人）；POST 录入（仅主管医生），供趋势分析Tab展示。
 * 录入数据按 LAB_FIELDS 14 项检验指标转存，超出参考范围自动标记 abnormal（不阻断，仅红标）。
 */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { requireDoctorOwn, requirePatientRead } = require('../../_lib/patient-access');
const { updatePatient, audit } = require('../../_lib/services');
const { parse, labsSchema } = require('../../_lib/validate');
const { LAB_FIELDS, labAbnormalKeys } = require('@flwb/shared');

module.exports = defineHandler({
  auth: 'staff_or_self',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, params, body, user }) => {
    const pid = params.id;
    const db = await getDb();

    if (req.method === 'GET') {
      await requirePatientRead(user, pid);
      const arr = await db.zrangebyscore(K.labs(pid), 0, Number.MAX_SAFE_INTEGER);
      const items = (arr || [])
        .map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 50);
      return { items };
    }

    // POST 录入
    await requireDoctorOwn(user, pid);
    const input = parse(labsSchema, body);
    const record = {
      id: 'lab_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      examDate: input.examDate,
      note: input.note || null,
      by: user.name
    };
    for (const f of LAB_FIELDS) {
      record[f.key] = input[f.key] ?? null;
    }
    record.abnormal = labAbnormalKeys(record);

    await db.zadd(K.labs(pid), record.ts, JSON.stringify(record));
    await updatePatient(pid, (p) => { p.lastActivityAt = Date.now(); }, null);
    await audit('labs.create', { operator: user.uid, patient_id: pid, abnormal: record.abnormal });
    return record;
  }
});
