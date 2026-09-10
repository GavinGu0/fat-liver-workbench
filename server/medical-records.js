'use strict';
/**
 * 脂肪肝专病建档（信息化平台 · 模块2 / 结构化电子病历）
 * GET  ?patientId= 查看专病档案（医护/本人）
 * POST upsert 建档（仅主管医生）：全字段校验 + BMI 自动计算 + 风险分层（评分模型）
 *      同步回写患者档案（risk / nextFollowupDate 按风险周期），高风险自动生成 MDT 预警
 */
const { defineHandler } = require('./_lib/handler');
const { getDb, K, dateStr } = require('./_lib/storage');
const { requireDoctorOwn, requirePatientRead } = require('./_lib/patient-access');
const { updatePatient, addArchiveEntry, audit, track } = require('./_lib/services');
const { parse, medicalRecordSchema } = require('./_lib/validate');
const { calcBmi, riskStratify, suggestFollowupDate, MEDICAL_RECORD_KEYS, LAB_FIELDS } = require('@flwb/shared');
const { raiseAlert } = require('./_lib/clinic');
const { ApiError } = require('./_lib/response');

module.exports = defineHandler({
  auth: 'staff_or_self',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, query, body, user }) => {
    const db = await getDb();

    /* ---------- GET：查看专病档案 ---------- */
    if (req.method === 'GET') {
      const pid = query.patientId;
      if (!pid) throw new ApiError(422, 42201, '缺少 patientId 参数');
      const p = await requirePatientRead(user, pid);
      const raw = await db.get(K.medrec(pid));
      let record = null;
      if (raw) {
        try { record = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { record = null; }
      }
      // 自动分层建议（供医生参考）
      const suggestion = riskStratify({ ...p, ...(record || {}) });
      return { record, suggestion, patient: { id: p.id, name: p.name, gender: p.gender, age: p.age, height: p.height, weight: p.weight, bmi: p.bmi, risk: p.risk, phone: p.phone, docId: p.docId, nextFollowupDate: p.nextFollowupDate || null } };
    }

    /* ---------- POST：建档 / 更新 ---------- */
    const input = parse(medicalRecordSchema, body);
    const pid = input.patientId;
    await requireDoctorOwn(user, pid);

    const prevRaw = await db.get(K.medrec(pid));
    let prev = null;
    if (prevRaw) {
      try {
        prev = typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw;
        if (input.version != null && Number(prev.version) !== Number(input.version)) {
          throw new ApiError(409, 40903, '档案已被他人修改，请刷新后重试');
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        prev = null;
      }
    }

    // 组装档案（白名单字段），BMI 自动计算
    const record = { patientId: pid, createdBy: user.uid, createdByName: user.name, createdAt: prev ? prev.createdAt : Date.now(), updatedAt: Date.now(), version: prev ? (Number(prev.version) || 0) + 1 : 1 };
    for (const key of MEDICAL_RECORD_KEYS) {
      if (input[key] !== undefined) record[key] = input[key];
    }
    record.bmi = calcBmi(input.weight, input.height) ?? (prev && prev.bmi) ?? null;

    // 风险分层：模型评分 + 医生确认（最终以医生选择为准，评分与依据自动附注）
    const strat = riskStratify({ ...record, gender: input.gender });
    record.riskLevel = input.riskLevel;
    record.riskScore = strat.score;
    record.riskModelReasons = strat.reasons;
    record.riskStratifiedAt = Date.now();
    record.riskStratifiedBy = user.name;

    await db.set(K.medrec(pid), JSON.stringify(record));

    // 回写患者档案：风险等级同步；未设置随访日期时按风险周期自动生成（低6-12/中3-6/高1-3月）
    let followupAutoSet = false;
    const oldDate = (await (async () => { const p = await db.get(K.patient(pid)); try { return p ? (typeof p === 'string' ? JSON.parse(p) : p).nextFollowupDate : null; } catch { return null; } })()) || null;
    const updated = await updatePatient(pid, (p) => {
      p.risk = record.riskLevel;
      p.medicalRecordId = pid;
      p.archivedAt = Date.now();
      if (!p.nextFollowupDate) {
        p.nextFollowupDate = suggestFollowupDate(record.riskLevel, dateStr());
        followupAutoSet = true;
      }
      if (!p.mainDiagnosis) p.mainDiagnosis = '脂肪肝（专病建档）';
    }, null);
    await (async () => { // 同步 due 集合：先移旧再入新（覆盖逾期重排场景）
      if (updated.nextFollowupDate && updated.nextFollowupDate !== oldDate) {
        if (oldDate) await db.srem(K.followupDue(oldDate), pid);
        await db.sadd(K.followupDue(updated.nextFollowupDate), pid);
      }
    })();

    // 高风险 → MDT 预警（信息化平台模块3：高风险患者弹窗提醒多学科会诊）
    if (record.riskLevel === 'high') {
      await raiseAlert({
        docId: updated.docId,
        patientId: pid,
        patientName: updated.name,
        level: 'high',
        type: 'high_risk_no_mdt',
        title: `高风险患者建议 MDT 会诊：${updated.name}`,
        content: `专病建档风险分层为高危（评分 ${record.riskScore}）。建议发起营养科/内分泌科多学科会诊。依据：${(record.riskReason || strat.reasons.join('；')).slice(0, 150)}`,
        link: `/patients/${pid}`
      });
    }

    await addArchiveEntry(pid, {
      kind: 'archive', type: 'medical_record',
      title: `脂肪肝专病建档（v${record.version}）`,
      summary: `风险分层：${record.riskLevel === 'high' ? '高' : record.riskLevel === 'mid' ? '中' : '低'}风险（评分${record.riskScore}）；建档医生：${user.name}`,
      by: user.name
    });
    await audit('medical.record.save', { operator: user.uid, patient_id: pid, risk: record.riskLevel, version: record.version });
    await track('medical_record_save', { doc_id: user.uid, patient_id: pid, risk: record.riskLevel });

    return {
      record,
      version: record.version,
      patientRisk: updated.risk,
      nextFollowupDate: updated.nextFollowupDate,
      followupAutoSet,
      modelSuggestion: { risk: strat.risk, score: strat.score, reasons: strat.reasons },
      labFieldKeys: LAB_FIELDS.map(f => f.key)
    };
  }
});
