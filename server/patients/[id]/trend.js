'use strict';
/** 趋势分析：体重/BMI/血压/血糖/腹围 + 医生录入的肝功能指标（PRD 3.1.2 趋势分析Tab） */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { requirePatientRead } = require('../../_lib/patient-access');
const { LAB_FIELDS } = require('@flwb/shared');

const DAY = 86400000;

function seriesOf(points) {
  const out = [];
  for (const p of points) {
    out.push({
      ts: p.ts,
      weight: p.weight ?? null,
      bmi: p.bmi ?? null,
      waist: p.waist ?? null,
      sbp: p.sbp ?? null,
      dbp: p.dbp ?? null,
      glucose: p.glucose ?? null
    });
  }
  return out;
}

function labSeries(points) {
  return points.map(p => {
    const out = { ts: p.ts };
    for (const f of LAB_FIELDS) out[f.key] = p[f.key] ?? null;
    return out;
  });
}

module.exports = defineHandler({
  auth: 'staff_or_self',
  fn: async ({ params, query, user }) => {
    const pid = params.id;
    await requirePatientRead(user, pid);
    const db = await getDb();

    const days = Math.min(365, Math.max(7, Number(query.days) || 90));
    const from = Date.now() - days * DAY;

    const [vitalsRaw, labsRaw] = await Promise.all([
      db.zrangebyscore(K.vitals(pid), from, Number.MAX_SAFE_INTEGER),
      db.zrangebyscore(K.labs(pid), from, Number.MAX_SAFE_INTEGER)
    ]);

    const toObj = (arr) => (arr || []).map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
    const vitals = toObj(vitalsRaw).sort((a, b) => a.ts - b.ts);
    const labs = toObj(labsRaw).sort((a, b) => a.ts - b.ts);

    return {
      days,
      points: seriesOf(vitals),
      labs: labSeries(labs),
      counts: { vitals: vitals.length, labs: labs.length }
    };
  }
});
