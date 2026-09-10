'use strict';
/**
 * 数据筛查识别（信息化平台 · 模块1）
 * GET  筛查案例列表（医护可见；医生数据隔离；status/keyword 筛选 + 统计）
 * POST action=run    自动筛查：扫描本人管理患者的检验/BMI/超声，规则引擎命中即生成案例并预警
 *      action=manual 手工登记：录入超声描述/备注，命中规则或带说明时生成案例
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { getPatient, audit, track } = require('../_lib/services');
const { requireDoctorOwn } = require('../_lib/patient-access');
const { parse, screeningSchema } = require('../_lib/validate');
const { evaluateScreening, calcBmi } = require('@flwb/shared');
const { upsertScreeningCase, latestLabs, getScreeningCase, raiseAlert } = require('../_lib/clinic');
const { ApiError } = require('../_lib/response');

/** 读取患者专病档案中的超声结论（供规则引擎扫描） */
async function medrecUltrasound(db, pid) {
  try {
    const raw = await db.get(K.medrec(pid));
    if (!raw) return null;
    const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return rec.ultrasound || null;
  } catch { return null; }
}

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'write', max: 20, windowSec: 60, byUser: true },
  fn: async ({ req, query, body, user }) => {
    const db = await getDb();

    /* ---------- GET：筛查案例列表 ---------- */
    if (req.method === 'GET') {
      const ids = user.role === 'doctor'
        ? await db.zrevrange(K.screeningIdx(user.uid), 0, -1)
        : await db.zrevrange(K.screeningAll, 0, -1);

      const items = [];
      for (const id of ids.slice(0, 300)) {
        const c = await getScreeningCase(id);
        if (!c) continue;
        if (query.status && c.status !== query.status) continue;
        if (query.keyword) {
          const kw = String(query.keyword).trim().toLowerCase();
          const hit = [c.patientName, c.phone, c.id].filter(Boolean).some(v => String(v).toLowerCase().includes(kw));
          if (!hit) continue;
        }
        items.push(c);
      }

      const stats = {
        total: items.length,
        pending: items.filter(c => c.status === 'pending').length,
        accepted: items.filter(c => c.status === 'accepted').length,
        rejected: items.filter(c => c.status === 'rejected').length,
        highRisk: items.filter(c => c.suggestedRisk === 'high').length
      };
      return { items: items.slice(0, 100), stats };
    }

    /* ---------- POST：run 自动筛查 / manual 手工登记 ---------- */
    const input = parse(screeningSchema, body);

    if (input.action === 'run') {
      if (user.role !== 'doctor') throw new ApiError(403, 40300, '仅医生可执行自动筛查');
      const pids = await db.zrevrange(K.docPatients(user.uid), 0, 199);
      let scanned = 0, newCases = 0, updatedCases = 0;

      for (const pid of pids) {
        const p = await getPatient(pid);
        if (!p) continue;
        scanned++;
        const labs = (await latestLabs(db, pid)) || {};
        const ultrasoundText = await medrecUltrasound(db, pid);
        const { hits, positive } = evaluateScreening({
          ...labs,
          weight: p.weight, height: p.height,
          bmi: p.bmi ?? calcBmi(p.weight, p.height),
          ultrasoundText
        });
        if (!positive) continue;
        const r = await upsertScreeningCase({ patient: p, source: 'scan', hits, triggerNote: '自动筛查（检验/体格/影像规则命中）' });
        if (r.created) {
          newCases++;
          // 筛查阳性 → 预警提醒（信息化平台模块3：筛查阳性病例通知主管医生）
          await raiseAlert({
            docId: p.docId, patientId: pid, patientName: p.name,
            level: r.case.suggestedRisk === 'high' ? 'high' : 'mid',
            type: 'screening_positive',
            title: `筛查阳性：${p.name}`,
            content: `自动筛查命中 ${hits.length} 项规则，建议风险：${r.case.suggestedRisk === 'high' ? '高' : r.case.suggestedRisk === 'mid' ? '中' : '低'}。请及时复核并纳入管理。`,
            link: `/screening`
          });
        } else updatedCases++;
      }

      await audit('screening.run', { operator: user.uid, scanned, newCases, updatedCases });
      await track('screening_run', { doc_id: user.uid, scanned, newCases });
      return { scanned, newCases, updatedCases };
    }

    /* manual 手工登记 */
    const p = await requireDoctorOwn(user, input.patientId);
    const labs = (await latestLabs(db, p.id)) || {};
    const { hits, positive } = evaluateScreening({
      ...labs,
      weight: p.weight, height: p.height,
      bmi: p.bmi ?? calcBmi(p.weight, p.height),
      ultrasoundText: input.ultrasoundText
    });
    if (!positive && !input.note) {
      throw new ApiError(422, 42200, '未命中筛查规则：请填写超声描述或备注说明登记依据');
    }
    const r = await upsertScreeningCase({ patient: p, source: input.source, hits, triggerNote: input.note || '手工登记' });
    if (r.created) {
      await raiseAlert({
        docId: p.docId, patientId: p.id, patientName: p.name,
        level: r.case.suggestedRisk === 'high' ? 'high' : 'mid',
        type: 'screening_positive',
        title: `筛查登记：${p.name}`,
        content: `${user.name} 手工登记筛查案例${hits.length ? `，命中 ${hits.length} 项规则` : ''}，建议风险：${r.case.suggestedRisk === 'high' ? '高' : r.case.suggestedRisk === 'mid' ? '中' : '低'}。`,
        link: `/screening`
      });
    }
    await audit('screening.manual', { operator: user.uid, patient_id: p.id, hits: hits.length, created: r.created });
    return { created: r.created, case: r.case };
  }
});
