'use strict';
/** 患者详情（全景视图基础）：基本信息 + 复诊计划 + 各类数据计数 */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { requirePatientRead } = require('../../_lib/patient-access');
const { track } = require('../../_lib/services');

module.exports = defineHandler({
  auth: 'staff_or_self',
  fn: async ({ params, user }) => {
    const pid = params.id;
    const p = await requirePatientRead(user, pid);
    const db = await getDb();

    // 埋点：医生查看患者详情（PRD 第6节）
    if (user.role === 'doctor') await track('doctor_view_detail', { doc_id: user.uid, patient_id: pid });

    const [revisitRaw, archiveRaw, vitCnt] = await Promise.all([
      db.get(K.revisit(pid)),
      db.lrange(K.archive(pid), 0, 49),
      db.zcard(K.vitals(pid))
    ]);

    let revisit = null;
    try { revisit = revisitRaw ? JSON.parse(typeof revisitRaw === 'string' ? revisitRaw : revisitRaw) : null; } catch { revisit = null; }

    const dietList = await db.lrange(K.diet(pid), 0, -1);
    const exList = await db.lrange(K.exercise(pid), 0, -1);

    return {
      profile: { ...p, passwordHash: undefined },
      revisit,
      archive: archiveRaw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean),
      counts: {
        diet: dietList.length,
        exercise: exList.length,
        vitals: Number(vitCnt) || 0
      }
    };
  }
});
