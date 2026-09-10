'use strict';
/**
 * 随访管理（信息化平台 · 模块4）
 * GET ?patientId= 该患者随访执行记录（医护/本人）
 *     否则随访计划列表：followupStatusOf 计算 overdue/today/soon3d/scheduled/lost/none + 统计
 *     支持 status/keyword 筛选（医生数据隔离，护士全量只读）
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K, dateStr } = require('../_lib/storage');
const { requireRole } = require('../_lib/auth');
const { getPatient } = require('../_lib/services');
const { requirePatientRead } = require('../_lib/patient-access');
const { followupStatusOf, FOLLOWUP_STATUS_LABELS } = require('@flwb/shared');

const STATUS_VALUES = ['lost', 'overdue', 'today', 'soon3d', 'scheduled', 'none'];

module.exports = defineHandler({
  auth: 'staff',
  fn: async ({ query, user }) => {
    requireRole(user, 'staff');
    const db = await getDb();

    /* ---------- 患者随访执行记录 ---------- */
    if (query.patientId) {
      await requirePatientRead(user, query.patientId);
      const arr = await db.lrange(K.followupRec(query.patientId), 0, 49);
      const records = arr.map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
      return { patientId: query.patientId, records };
    }

    /* ---------- 随访计划列表 ---------- */
    const pids = user.role === 'doctor'
      ? await db.zrevrange(K.docPatients(user.uid), 0, -1)
      : await db.zrevrange(K.allPatients, 0, -1);
    const patients = (await Promise.all(pids.map(pid => getPatient(pid)))).filter(Boolean);
    const today = dateStr();

    let items = patients.map(p => {
      const st = followupStatusOf(p.nextFollowupDate, today, p.lostAt);
      return {
        patientId: p.id,
        name: p.name,
        gender: p.gender,
        age: p.age,
        phone: p.phone,
        risk: p.risk,
        nextFollowupDate: p.nextFollowupDate || null,
        daysLeft: st.daysLeft,
        status: st.status || 'none',
        statusLabel: st.status ? FOLLOWUP_STATUS_LABELS[st.status] : '未安排',
        lastFollowupAt: p.lastFollowupAt || null,
        lastFollowupMethod: p.lastFollowupMethod || null,
        lastFollowupSummary: p.lastFollowupSummary || null,
        followupNote: p.followupNote || '',
        lostAt: p.lostAt || null,
        lostReason: p.lostReason || null
      };
    });

    if (query.status && STATUS_VALUES.includes(query.status)) {
      items = items.filter(x => x.status === query.status);
    }
    if (query.keyword) {
      const kw = String(query.keyword).trim().toLowerCase();
      items = items.filter(x => [x.name, x.phone, x.patientId].filter(Boolean).some(v => String(v).toLowerCase().includes(kw)));
    }
    items.sort((a, b) => {
      // 逾期 > 今日 > 3日内 > 已预约 > 未安排 > 已失访；同状态按日期升序
      const order = { overdue: 0, today: 1, soon3d: 2, scheduled: 3, none: 4, lost: 5 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return String(a.nextFollowupDate || '9999').localeCompare(String(b.nextFollowupDate || '9999'));
    });

    const stats = {
      total: items.length,
      overdue: items.filter(x => x.status === 'overdue').length,
      today: items.filter(x => x.status === 'today').length,
      soon3d: items.filter(x => x.status === 'soon3d').length,
      scheduled: items.filter(x => x.status === 'scheduled').length,
      none: items.filter(x => x.status === 'none').length,
      lost: items.filter(x => x.status === 'lost').length
    };
    return { today, items, stats };
  }
});
