'use strict';
/**
 * 质量管理与数据分析看板（信息化平台 · 模块5）
 * GET ?days=30&risk=high|mid|low
 * 指标：随访率 / 失访率 / 建档率 / 高风险人群占比 / 复查完成率 + 状态/风险分布 + 趋势（按天）
 * 口径（统计窗口 = 近 days 天）：
 *  - 随访率   = 窗口内执行过随访的人数 / 应随访人数（计划在窗口内到期 ∪ 窗口内已执行）
 *  - 失访率   = 失访人数 / 在管人数
 *  - 建档率   = 已完成专病建档人数 / 在管人数
 *  - 高风险占比 = 高风险人数 / 在管人数
 *  - 复查完成率 = 建档患者中窗口内有辅助检查（检验）记录的人数 / 建档人数
 */
const { defineHandler } = require('./_lib/handler');
const { getDb, K, dateStr } = require('./_lib/storage');
const { requireRole } = require('./_lib/auth');
const { getPatient } = require('./_lib/services');
const { followupStatusOf, FOLLOWUP_STATUS_LABELS } = require('@flwb/shared');

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const rateOf = (num, den) => ({ num, den, rate: pct(num, den) });

module.exports = defineHandler({
  auth: 'staff',
  fn: async ({ query, user }) => {
    requireRole(user, 'staff');
    const db = await getDb();

    const days = Math.min(180, Math.max(7, parseInt(query.days, 10) || 30));
    const today = dateStr();
    const fromTs = Date.now() - days * 86400000;

    // 医生数据隔离；risk 可选筛选统计人群
    const pids = user.role === 'doctor'
      ? await db.zrevrange(K.docPatients(user.uid), 0, -1)
      : await db.zrevrange(K.allPatients, 0, -1);
    let patients = (await Promise.all(pids.map(pid => getPatient(pid)))).filter(Boolean);
    if (query.risk && ['high', 'mid', 'low'].includes(query.risk)) {
      patients = patients.filter(p => p.risk === query.risk);
    }

    const riskDist = { high: 0, mid: 0, low: 0, unknown: 0 };
    const statusDist = { overdue: 0, today: 0, soon3d: 0, scheduled: 0, none: 0, lost: 0 };
    const trend = {}; // dateStr -> { archived, followups, lost, screenings }

    let lostCount = 0, archivedCount = 0, revisitDone = 0;
    const dueInWindow = new Set();   // 应随访（计划日期在窗口内）
    const doneInWindow = new Set();  // 已随访（窗口内执行过）
    const dueToday = dateStr();

    for (const p of patients) {
      // 风险分布
      if (p.risk && riskDist[p.risk] !== undefined) riskDist[p.risk]++; else riskDist.unknown++;
      // 失访
      if (p.lostAt) lostCount++;
      // 随访状态分布
      const st = followupStatusOf(p.nextFollowupDate, dueToday, p.lostAt);
      statusDist[st.status || 'none']++;
      // 应随访：未失访且计划日期落在窗口内
      if (!p.lostAt && p.nextFollowupDate && p.nextFollowupDate >= dateStr(-days) && p.nextFollowupDate <= dueToday) {
        dueInWindow.add(p.id);
      }
      // 随访执行记录
      const recs = (await db.lrange(K.followupRec(p.id), 0, 99))
        .map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } })
        .filter(Boolean);
      for (const r of recs) {
        if (r.ts >= fromTs) {
          doneInWindow.add(p.id);
          const d = dateStrOf(r.ts);
          bucket(trend, d).followups++;
        }
        if (r.dueDate && r.dueDate >= dateStr(-days) && r.dueDate <= dueToday) dueInWindow.add(p.id);
      }
      // 建档
      if (p.archivedAt || p.medicalRecordId) {
        archivedCount++;
        const raw = await db.get(K.medrec(p.id));
        const createdTs = (() => { try { const r = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; return r && r.createdAt; } catch { return null; } })();
        if (createdTs && createdTs >= fromTs) bucket(trend, dateStrOf(createdTs)).archived++;
      }
      // 复查（窗口内检验记录）
      const labCount = await db.zcount(K.labs(p.id), fromTs, Number.MAX_SAFE_INTEGER).catch(() => 0);
      if ((p.archivedAt || p.medicalRecordId) && Number(labCount) > 0) revisitDone++;
      // 失访趋势
      if (p.lostAt && p.lostAt >= fromTs) bucket(trend, dateStrOf(p.lostAt)).lost++;
    }

    // 筛查趋势（按医生索引）
    const scIds = user.role === 'doctor'
      ? await db.zrevrange(K.screeningIdx(user.uid), 0, -1)
      : await db.zrevrange(K.screeningAll, 0, -1);
    let screeningTotal = 0, screeningPending = 0;
    for (const id of scIds.slice(0, 300)) {
      try {
        const raw = await db.get(K.screening(id));
        if (!raw) continue;
        const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
        screeningTotal++;
        if (c.status === 'pending') screeningPending++;
        if (c.ts >= fromTs) bucket(trend, dateStrOf(c.ts)).screenings++;
      } catch { continue; }
    }

    // 高风险占比应基于全量人群（不受建档限制）
    const highRiskTotal = patients.filter(p => p.risk === 'high').length;

    const metrics = {
      followupRate: rateOf(doneInWindow.size, new Set([...dueInWindow, ...doneInWindow]).size),
      lostRate: rateOf(lostCount, patients.length),
      archiveRate: rateOf(archivedCount, patients.length),
      highRiskRatio: rateOf(highRiskTotal, patients.length),
      revisitRate: rateOf(revisitDone, archivedCount)
    };

    // 补齐趋势日期轴（含 0 值）
    const trendArr = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dateStr(-i);
      trendArr.push({ date: d, archived: 0, followups: 0, lost: 0, screenings: 0, ...(trend[d] || {}) });
    }

    return {
      window: { days, from: dateStr(-days), to: today },
      cohort: { total: patients.length, riskFilter: query.risk || null },
      metrics,
      statusDist: Object.fromEntries(Object.entries(statusDist).map(([k, v]) => [k, { count: v, label: k === 'none' ? '未安排' : FOLLOWUP_STATUS_LABELS[k] }])),
      riskDist,
      screening: { total: screeningTotal, pending: screeningPending },
      trend: trendArr
    };
  }
});

function bucket(map, d) {
  if (!map[d]) map[d] = { archived: 0, followups: 0, lost: 0, screenings: 0 };
  return map[d];
}

/** ts → 上海时区 yyyy-MM-dd */
function dateStrOf(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(ts));
}
