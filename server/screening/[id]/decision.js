'use strict';
/**
 * 筛查案例决策：纳入管理（同步患者风险 + 自动排随访）/ 排除
 * 仅患者主管医生可操作（数据隔离由 requireDoctorOwn 保证）
 */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K, dateStr } = require('../../_lib/storage');
const { requireDoctorOwn } = require('../../_lib/patient-access');
const { updatePatient, addArchiveEntry, audit, track } = require('../../_lib/services');
const { parse, screeningDecisionSchema } = require('../../_lib/validate');
const { getScreeningCase } = require('../../_lib/clinic');
const { suggestFollowupDate } = require('@flwb/shared');
const { ApiError } = require('../../_lib/response');

module.exports = defineHandler({
  auth: 'doctor',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ params, body, user }) => {
    const c = await getScreeningCase(params.id);
    if (!c) throw new ApiError(404, 40400, '筛查案例不存在');
    await requireDoctorOwn(user, c.patientId); // 数据隔离 + 仅主管医生
    if (c.status !== 'pending') throw new ApiError(409, 40902, '该案例已处理，请刷新列表');

    const input = parse(screeningDecisionSchema, body);
    const db = await getDb();

    c.status = input.decision === 'accept' ? 'accepted' : 'rejected';
    c.decisionNote = input.reason;
    c.decidedBy = user.name;
    c.decidedAt = Date.now();
    await db.set(K.screening(c.id), JSON.stringify(c));

    let riskApplied = null;
    let nextFollowupDate = null;
    let followupAutoSet = false;

    if (input.decision === 'accept') {
      const risk = input.risk || c.suggestedRisk || 'mid';
      riskApplied = risk;
      const oldDate = (await (async () => {
        const raw = await db.get(K.patient(c.patientId));
        try { return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw).nextFollowupDate : null; } catch { return null; }
      })()) || null;
      const updated = await updatePatient(c.patientId, (doc) => {
        doc.risk = risk;
        doc.screeningId = c.id;
        if (!doc.mainDiagnosis) doc.mainDiagnosis = '脂肪肝（筛查纳入）';
        // 纳入管理即开启新管理周期：无日期或已逾期 → 按风险周期重排
        if (!doc.nextFollowupDate || doc.nextFollowupDate < dateStr()) {
          doc.nextFollowupDate = suggestFollowupDate(risk, dateStr());
          followupAutoSet = true;
        }
      }, null);
      nextFollowupDate = updated.nextFollowupDate;
      await (async () => { // due 集合同步：先移旧再入新（覆盖逾期重排场景）
        if (nextFollowupDate && nextFollowupDate !== oldDate) {
          if (oldDate) await db.srem(K.followupDue(oldDate), c.patientId);
          await db.sadd(K.followupDue(nextFollowupDate), c.patientId);
        }
      })();
      await addArchiveEntry(c.patientId, {
        kind: 'archive', type: 'screening',
        title: '筛查阳性病例纳入管理',
        summary: `建议风险分层：${risk === 'high' ? '高' : risk === 'mid' ? '中' : '低'}；处理说明：${input.reason}；决策医生：${user.name}`,
        by: user.name
      });
    } else {
      await addArchiveEntry(c.patientId, {
        kind: 'archive', type: 'screening',
        title: '筛查病例排除',
        summary: `排除理由：${input.reason}；决策医生：${user.name}`,
        by: user.name
      });
    }

    await audit('screening.decision', { operator: user.uid, patient_id: c.patientId, decision: input.decision, risk: riskApplied });
    await track('screening_decision', { doc_id: user.uid, patient_id: c.patientId, decision: input.decision });

    return { id: c.id, status: c.status, riskApplied, nextFollowupDate, followupAutoSet };
  }
});
