'use strict';
/** 自填数据时间轴（全景视图数据流）：饮食/运动/指标/指导/宣教/评估/检验 合并分页 */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { requirePatientRead } = require('../../_lib/patient-access');

const ALL_TYPES = ['diet', 'exercise', 'vitals', 'guidance', 'education', 'assessment', 'labs'];

async function safeList(arr) {
  return (arr || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
}

module.exports = defineHandler({
  auth: 'staff_or_self',
  fn: async ({ params, query, user }) => {
    const pid = params.id;
    await requirePatientRead(user, pid);
    const db = await getDb();

    const types = (query.types ? String(query.types).split(',') : ALL_TYPES).filter(t => ALL_TYPES.includes(t));
    const before = query.before ? Number(query.before) : Date.now() + 1;
    const limit = Math.min(60, Math.max(1, Number(query.limit) || 20));

    const buckets = [];
    if (types.includes('diet')) buckets.push(...(await safeList(await db.lrange(K.diet(pid), 0, -1))).map(x => ({ ...x, type: 'diet' })));
    if (types.includes('exercise')) buckets.push(...(await safeList(await db.lrange(K.exercise(pid), 0, -1))).map(x => ({ ...x, type: 'exercise', exType: x.type })));
    if (types.includes('vitals')) {
      const arr = await db.zrangebyscore(K.vitals(pid), 0, Number.MAX_SAFE_INTEGER);
      buckets.push(...(await safeList(arr)).map(x => ({ ...x, type: 'vitals' })));
    }
    if (types.includes('guidance')) buckets.push(...(await safeList(await db.lrange(K.guidance(pid), 0, -1))).map(x => ({ ...x, type: 'guidance' })));
    if (types.includes('education')) buckets.push(...(await safeList(await db.lrange(K.eduLog(pid), 0, -1))).map(x => ({ ...x, type: 'education' })));
    if (types.includes('assessment')) {
      const reportIds = await db.zrevrange(K.reportIdxPatient(pid), 0, -1);
      const reports = await Promise.all(reportIds.map(rid => db.get(K.report(rid))));
      buckets.push(...(await safeList(reports)).map(r => ({
        type: 'assessment', ts: r.createdAt, reportId: r.id, title: r.templateName || '专病评估报告', nurseName: r.nurseName, summary: r.summary
      })));
    }
    if (types.includes('labs')) {
      const arr = await db.zrangebyscore(K.labs(pid), 0, Number.MAX_SAFE_INTEGER);
      buckets.push(...(await safeList(arr)).map(x => ({ ...x, type: 'labs' })));
    }

    const merged = buckets
      .filter(x => x.ts && x.ts < before)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);

    const nextBefore = merged.length === limit ? merged[merged.length - 1].ts : null;
    return { items: merged, nextBefore };
  }
});
