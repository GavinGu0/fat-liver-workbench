'use strict';
/**
 * 护理端 · 标准化评估（PRD 3.1.1）：
 * GET  模板定义 + 我的评估历史
 * POST 提交评估 → 生成结构化报告（自动报告生成）→ 存 Blob 归档（可选）→ 患者时间轴可见
 */
const { randomUUID } = require('node:crypto');
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { getPatient, track, audit, getConfig } = require('../_lib/services');
const { putJson, blobConfigured } = require('../_lib/blob');
const { parse, assessmentSubmitSchema } = require('../_lib/validate');
const { ApiError } = require('../_lib/response');
const { DEFAULT_CONFIGS } = require('../_lib/seed');

const zparse = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

function buildReportHtml(template, answers, patient, nurseName) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = (template.fields || []).map(f => {
    let v = answers[f.key];
    if (Array.isArray(v)) v = v.length ? v.join('、') : '无';
    if (v == null || v === '') v = '未填写';
    return `<tr><td style="padding:6px 10px;border:1px solid #e4e7ed;background:#fafafa;width:160px">${esc(f.label)}</td><td style="padding:6px 10px;border:1px solid #e4e7ed">${esc(v)}</td></tr>`;
  }).join('');
  const risks = [];
  if (answers.drinking === '每日' || answers.drinking === '经常') risks.push('酒精性肝损伤风险');
  if (Array.isArray(answers.comorbid) && answers.comorbid.includes('2型糖尿病')) risks.push('糖尿病合并脂肪肝，需联合管理');
  if (answers.dietHabit === '高脂高糖') risks.push('饮食结构不合理');
  if (Number(answers.exerciseFreq) === 0) risks.push('缺乏运动');
  return `
  <div class="report">
    <h3 style="margin:0 0 4px">${esc(template.name)}</h3>
    <p style="color:#909399;font-size:12px;margin:0 0 12px">患者：${esc(patient.name)} ｜ 评估人：${esc(nurseName)} ｜ ${new Date().toLocaleString('zh-CN')}</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px">${rows}</table>
    <h4 style="margin:14px 0 6px">风险提示</h4>
    <p style="margin:0;font-size:13px;color:#b45309">${risks.length ? esc(risks.join('；')) : '暂未发现明显风险点，继续保持'}</p>
  </div>`;
}

module.exports = defineHandler({
  auth: 'nurse',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, body, user }) => {
    const db = await getDb();

    if (req.method === 'GET') {
      const template = await getConfig('assessmentTemplate', DEFAULT_CONFIGS.assessmentTemplate);
      const ids = await db.zrevrange(K.reportIdxNurse(user.uid), 0, 49);
      const history = (await Promise.all(ids.map(async id => zparse(await db.get(K.report(id)))))).filter(Boolean);
      return { template, history, blobEnabled: blobConfigured() };
    }

    const input = parse(assessmentSubmitSchema, body);
    const p = await getPatient(input.patientId);
    if (!p) throw new ApiError(404, 40400, '患者不存在');
    const template = await getConfig('assessmentTemplate', DEFAULT_CONFIGS.assessmentTemplate);

    const answers = {};
    for (const [k, v] of Object.entries(input.answers || {})) {
      if (v == null) continue;
      if (typeof v === 'string') answers[k] = v.slice(0, 500);
      else if (typeof v === 'number') answers[k] = v;
      else if (Array.isArray(v)) answers[k] = v.map(x => String(x).slice(0, 100)).slice(0, 20);
    }

    const html = buildReportHtml(template, answers, p, user.name);
    const risks = [];
    if (answers.drinking === '每日' || answers.drinking === '经常') risks.push('酒精性肝损伤风险');
    if (Array.isArray(answers.comorbid) && answers.comorbid.includes('2型糖尿病')) risks.push('糖尿病合并脂肪肝');
    if (answers.dietHabit === '高脂高糖') risks.push('饮食结构不合理');

    const report = {
      id: 'rpt_' + randomUUID().replace(/-/g, '').slice(0, 12),
      templateId: template.id,
      templateName: template.name,
      patientId: input.patientId,
      patientName: p.name,
      nurseId: user.uid,
      nurseName: user.name,
      answers,
      html,
      summary: risks.length ? risks.join('；') : '未见明显风险',
      createdAt: Date.now()
    };

    await db.set(K.report(report.id), JSON.stringify(report));
    await db.zadd(K.reportIdxPatient(input.patientId), report.createdAt, report.id);
    await db.zadd(K.reportIdxNurse(user.uid), report.createdAt, report.id);

    // Blob 归档（可选，未配置自动跳过）
    const blobUrl = await putJson(`reports/${report.id}.json`, report);

    await track('assessment_submit', { nurse_id: user.uid, patient_id: input.patientId });
    await audit('assessment.submit', { operator: user.uid, patient_id: input.patientId, reportId: report.id });
    return { reportId: report.id, summary: report.summary, createdAt: report.createdAt, blobUrl };
  }
});
