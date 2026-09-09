'use strict';
/** 评估报告详情（医护可看，患者时间轴内展示摘要） */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { ApiError } = require('../../_lib/response');
const { getPatient } = require('../../_lib/services');
const { requirePatientRead } = require('../../_lib/patient-access');

module.exports = defineHandler({
  auth: 'staff_or_self',
  fn: async ({ params, user }) => {
    const db = await getDb();
    const raw = await db.get(K.report(params.id));
    if (!raw) throw new ApiError(404, 40400, '报告不存在');
    const report = typeof raw === 'string' ? JSON.parse(raw) : raw;
    await requirePatientRead(user, report.patientId);
    return report;
  }
});
