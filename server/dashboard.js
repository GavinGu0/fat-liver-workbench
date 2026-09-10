'use strict';
/**
 * 工作台聚合（PRD 3.1.2）：核心指标 + 待办任务 + 快捷筛选 + 智能提醒（30s 轮询）
 * 医生：管理患者总数/本周新增/7日填报率 + 今日随访/3日内随访/复诊队列/进行中MDT
 * 护士：患者总数 + 今日宣教/指导统计
 */
const { defineHandler } = require('./_lib/handler');
const { getDb, K, dateStr } = require('./_lib/storage');
const { getPatient } = require('./_lib/services');
const { listAlerts } = require('./_lib/clinic');
const { ADVISORY, followupStatusOf } = require('@flwb/shared');

const DAY = 86400000;

function latestVitalsOf(arr) {
  for (const x of arr || []) {
    try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { continue; }
  }
  return null;
}

function isAbnormal(v) {
  if (!v) return false;
  return (v.sbp != null && v.sbp >= ADVISORY.sbp.threshold)
    || (v.dbp != null && v.dbp >= ADVISORY.dbp.threshold)
    || (v.glucose != null && v.glucose >= ADVISORY.glucose.threshold)
    || (v.bmi != null && v.bmi >= ADVISORY.bmi.threshold);
}

module.exports = defineHandler({
  auth: 'staff',
  fn: async ({ user }) => {
    const db = await getDb();
    const today = dateStr();

    if (user.role === 'nurse') {
      const total = await db.zcard(K.allPatients);
      return {
        role: 'nurse',
        metrics: {
          totalPatients: Number(total) || 0,
          todayEdu: 0,
          todayGuidance: 0
        },
        todos: { todayFollowups: [], soonFollowups: [], revisitQueue: [], mdtPending: [] },
        quick: { highRisk: [], notFollowed: [], abnormal: [] },
        today
      };
    }

    const ids = await db.zrevrange(K.docPatients(user.uid), 0, -1);
    const patients = (await Promise.all(ids.map(pid => getPatient(pid)))).filter(Boolean);

    const now = Date.now();
    const weekAgo = now - 7 * DAY;
    const weekStartTs = now - 7 * DAY;
    const createdAtWeek = patients.filter(p => p.createdAt >= now - 7 * DAY).length;

    const enriched = await Promise.all(patients.map(async (p) => {
      const [vitalsDesc, revisitRaw] = await Promise.all([
        db.zrevrange(K.vitals(p.id), 0, 9),
        db.get(K.revisit(p.id))
      ]);
      const latest = latestVitalsOf(vitalsDesc);
      let filled7d = 0;
      try { filled7d = Number(await db.zcount(K.vitals(p.id), weekStartTs, Number.MAX_SAFE_INTEGER)) || 0; } catch { filled7d = 0; }
      let revisit = null;
      try { revisit = revisitRaw ? (typeof revisitRaw === 'string' ? JSON.parse(revisitRaw) : revisitRaw) : null; } catch { revisit = null; }
      return { p, latest, filled7d, revisit };
    }));

    const lite = (p) => ({ id: p.id, name: p.name, risk: p.risk, age: p.age, nextFollowupDate: p.nextFollowupDate || null });

    const todayFollowups = enriched.filter(x => x.p.nextFollowupDate === today).map(x => lite(x.p));
    const soonFollowups = enriched
      .filter(x => x.p.nextFollowupDate && x.p.nextFollowupDate !== today)
      .filter(x => { const d = new Date(x.p.nextFollowupDate + 'T00:00:00+08:00').getTime(); return d > now && d <= now + 3 * DAY; })
      .map(x => lite(x.p));

    const revisitQueue = enriched
      .filter(x => x.revisit && x.revisit.date)
      .filter(x => new Date(x.revisit.date + 'T23:59:59+08:00').getTime() >= now)
      .filter(x => new Date(x.revisit.date + 'T00:00:00+08:00').getTime() <= now + 7 * DAY)
      .map(x => ({ id: x.p.id, name: x.p.name, date: x.revisit.date, place: x.revisit.place }));

    const mdtIds = await db.zrevrange(K.mdtIdx(user.uid), 0, -1);
    const mdts = (await Promise.all(mdtIds.map(async id => {
      const raw = await db.get(K.mdt(id));
      try { return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { return null; }
    }))).filter(Boolean);
    const mdtPending = mdts.filter(m => m.status !== 'done').map(m => ({ id: m.id, patientId: m.patientId, patientName: m.patientName, reason: m.reason, status: m.status, createdAt: m.createdAt }));

    const highRisk = patients.filter(p => p.risk === 'high').map(lite);
    const notFollowed = patients.filter(p => !p.lastFollowupAt || p.lastFollowupAt < now - 30 * DAY).map(lite);
    const abnormal = enriched.filter(x => isAbnormal(x.latest)).map(x => ({
      ...lite(x.p),
      abnormal: {
        sbp: x.latest.sbp, dbp: x.latest.dbp, glucose: x.latest.glucose, bmi: x.latest.bmi
      }
    }));

    // 预警提醒 + 筛查待处理（工作台红点/弹窗数据源）
    const alerts = await listAlerts(user.uid, { status: 'open', limit: 5 });
    const scIds = await db.zrevrange(K.screeningIdx(user.uid), 0, 99);
    let screeningPending = 0;
    for (const id of scIds) {
      try {
        const raw = await db.get(K.screening(id));
        const c = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        if (c && c.status === 'pending') screeningPending++;
      } catch { continue; }
    }

    // 质控摘要：建档 / 失访 / 高风险占比（与 /quality 同口径的轻量版）
    const lostCount = patients.filter(p => p.lostAt).length;
    const archivedCount = patients.filter(p => p.archivedAt || p.medicalRecordId).length;

    // 随访弹窗数据源：今日 + 3日内 + 逾期（含剩余天数）
    const followupPopup = enriched
      .map(x => {
        const st = followupStatusOf(x.p.nextFollowupDate, today, x.p.lostAt);
        return { ...lite(x.p), status: st.status, daysLeft: st.daysLeft };
      })
      .filter(x => ['overdue', 'today', 'soon3d'].includes(x.status))
      .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99));

    const filledCount = enriched.filter(x => x.filled7d > 0).length;
    const fillRate = patients.length ? Math.round((filledCount / patients.length) * 100) : 0;

    return {
      role: 'doctor',
      metrics: {
        totalPatients: patients.length,
        newThisWeek: createdAtWeek,
        fillRate,
        pendingMdt: mdtPending.length,
        archived: archivedCount,
        lost: lostCount,
        highRisk: highRisk.length,
        screeningPending,
        alertsOpen: (alerts.counts && alerts.counts.open) || 0,
        alertsUnread: alerts.unread || 0
      },
      todos: { todayFollowups, soonFollowups, overdueFollowups: followupPopup.filter(x => x.status === 'overdue'), revisitQueue, mdtPending },
      quick: { highRisk, notFollowed, abnormal },
      alerts: {
        unread: alerts.unread || 0,
        openCount: (alerts.counts && alerts.counts.open) || 0,
        items: (alerts.items || []).slice(0, 5).map(a => ({ id: a.id, level: a.level, type: a.type, title: a.title, content: a.content, patientId: a.patientId, patientName: a.patientName, ts: a.ts, count: a.count }))
      },
      followupPopup,
      today
    };
  }
});
