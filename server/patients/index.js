'use strict';
/**
 * 患者列表：医生（本人管理）/护士（全量只读）
 * 支持关键字、风险等级、快捷筛选（高风险/近30天未随访/数据异常）、分页
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K, dateStr } = require('../_lib/storage');
const { requireRole } = require('../_lib/auth');
const { getPatient } = require('../_lib/services');
const { ADVISORY } = require('@flwb/shared');

const DAY = 86400000;

function matchKeyword(p, kw) {
  if (!kw) return true;
  const s = String(kw).trim().toLowerCase();
  return [p.name, p.phone, p.mainDiagnosis, p.id].filter(Boolean).some(v => String(v).toLowerCase().includes(s));
}

function isAbnormal(v) {
  if (!v) return false;
  return (v.sbp != null && v.sbp >= ADVISORY.sbp.threshold)
    || (v.dbp != null && v.dbp >= ADVISORY.dbp.threshold)
    || (v.glucose != null && v.glucose >= ADVISORY.glucose.threshold)
    || (v.bmi != null && v.bmi >= ADVISORY.bmi.threshold);
}

async function latestVitals(db, pid) {
  const arr = await db.zrevrange(K.vitals(pid), 0, 0);
  if (!arr.length) return null;
  try { return JSON.parse(typeof arr[0] === 'string' ? arr[0] : arr[0]); } catch { return null; }
}

module.exports = defineHandler({
  auth: 'staff',
  fn: async ({ query, user }) => {
    requireRole(user, 'staff');
    const db = await getDb();

    // 医生数据隔离：仅取本人管理患者（ZSet member=pid, score=lastActivityAt）
    const pids = user.role === 'doctor'
      ? await db.zrevrange(K.docPatients(user.uid), 0, -1)
      : await db.zrevrange(K.allPatients, 0, -1);

    const patients = await Promise.all(pids.map(pid => getPatient(pid)));
    let list = patients.filter(Boolean);

    const now = Date.now();
    const enriched = await Promise.all(list.map(async (p) => {
      const vitals = await latestVitals(db, p.id);
      const filled7d = await db.zcount(K.vitals(p.id), now - 7 * DAY, Number.MAX_SAFE_INTEGER).catch(() => 0);
      return {
        id: p.id,
        name: p.name,
        gender: p.gender,
        age: p.age,
        risk: p.risk,
        bmi: p.bmi,
        lastWeight: p.lastWeight,
        phone: p.phone,
        mainDiagnosis: p.mainDiagnosis,
        nextFollowupDate: p.nextFollowupDate,
        lastFollowupAt: p.lastFollowupAt,
        lastActivityAt: p.lastActivityAt,
        createdAt: p.createdAt,
        filled7d: Number(filled7d) > 0,
        abnormal: isAbnormal(vitals),
        latestVitals: vitals
          ? { ts: vitals.ts, weight: vitals.weight, sbp: vitals.sbp, dbp: vitals.dbp, glucose: vitals.glucose }
          : null
      };
    }));

    let items = enriched;
    if (query.keyword) items = items.filter(p => matchKeyword(p, query.keyword));
    if (query.risk) items = items.filter(p => p.risk === query.risk);
    if (query.filter === 'highRisk') items = items.filter(p => p.risk === 'high');
    if (query.filter === 'notFollowed') {
      items = items.filter(p => !p.lastFollowupAt || p.lastFollowupAt < now - 30 * DAY);
    }
    if (query.filter === 'abnormal') items = items.filter(p => p.abnormal);
    if (query.filter === 'notFilled7d') items = items.filter(p => !p.filled7d);

    items.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(query.size, 10) || 20));
    const total = items.length;
    const paged = items.slice((page - 1) * size, page * size);

    return { total, page, size, today: dateStr(), items: paged };
  }
});
