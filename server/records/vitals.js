'use strict';
/**
 * 患者填报：随访指标（体重/腹围/血压/血糖）
 * 硬校验：医学合理范围外直接 422 拒绝；软校验：超出建议阈值仍入库但返回 warning（PRD 3.3 校验规则）
 * 服务端自动计算 BMI；异常数据写入医生端快捷筛选
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { updatePatient, track, audit, pushMsg } = require('../_lib/services');
const { parse, vitalsSchema } = require('../_lib/validate');
const { calcBmi, checkAdvisory } = require('@flwb/shared');
const { ApiError } = require('../_lib/response');

module.exports = defineHandler({
  auth: 'patient',
  limit: { scope: 'submit', max: 30, windowSec: 60, byUser: true },
  fn: async ({ body, user }) => {
    const input = parse(vitalsSchema, body);

    if (input.sbp != null && input.dbp != null && Number(input.sbp) <= Number(input.dbp)) {
      throw new ApiError(422, 42200, '收缩压应大于舒张压');
    }

    const db = await getDb();
    const profile = await db.get(K.patient(user.patientId));
    const p = profile ? JSON.parse(typeof profile === 'string' ? profile : profile) : {};

    const bmi = (input.weight != null && (p.height || input.height))
      ? Number(calcBmi(Number(input.weight), Number(p.height || input.height)).toFixed(1))
      : null;

    const record = {
      id: 'vit_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      patientId: user.patientId,
      recordDate: input.recordDate,
      weight: input.weight ?? null,
      waist: input.waist ?? null,
      sbp: input.sbp ?? null,
      dbp: input.dbp ?? null,
      glucose: input.glucose ?? null,
      bmi
    };

    await db.zadd(K.vitals(user.patientId), record.ts, JSON.stringify(record));
    await updatePatient(user.patientId, (doc) => {
      if (record.weight != null) { doc.weight = record.weight; doc.lastWeight = record.weight; }
      if (record.bmi != null) doc.bmi = record.bmi;
      doc.lastActivityAt = Date.now();
    }, null);

    await track('data_submit', { data_type: 'vitals', user_id: user.uid });
    await audit('record.vitals', { uid: user.uid, patient_id: user.patientId });

    const warnings = checkAdvisory({ ...record });

    /* 推送主管医生：患者完成随访指标填报（站内信，点击跳转患者详情） */
    const parts = [];
    if (record.weight != null) parts.push(`体重 ${record.weight}kg`);
    if (record.bmi != null) parts.push(`BMI ${record.bmi}`);
    if (record.waist != null) parts.push(`腰围 ${record.waist}cm`);
    if (record.sbp != null && record.dbp != null) parts.push(`血压 ${record.sbp}/${record.dbp}`);
    else if (record.sbp != null) parts.push(`收缩压 ${record.sbp}`);
    else if (record.dbp != null) parts.push(`舒张压 ${record.dbp}`);
    if (record.glucose != null) parts.push(`血糖 ${record.glucose}`);
    await pushMsg(p.docId, {
      type: 'patient_submit',
      title: `📊 ${p.name || '患者'} 提交了随访指标${warnings.length ? '（含异常值）' : ''}`,
      content: `<p>${parts.join(' · ') || '无有效指标'}</p>${warnings.length ? '<p style="color:#f56c6c">⚠️ 部分指标超出建议范围，请及时关注并给出指导。</p>' : ''}`,
      from: p.name || '患者',
      link: `/patients/${user.patientId}`
    });

    return { id: record.id, ts: record.ts, bmi: record.bmi, warnings };
  }
});
