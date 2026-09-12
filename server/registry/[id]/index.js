'use strict';
/**
 * 专病建档 · 删除建档记录
 * DELETE /api/registry/[patientId]  仅主管医生可删除本人的患者建档记录（安全删除）
 *
 * 删除语义（安全删除：不破坏患者基础数据）：
 * - 删除专病病历（medrec），列表状态回到「待建档」，可重新建档
 * - 同步回收建档衍生状态：archivedAt / medicalRecordId 置空，取消按风险周期自动排期的随访
 * - 保留患者档案、登录账号及院外日常记录（饮食/运动/指标/检验/随访记录），保证数据可追溯
 * - 全程审计日志 + 行为埋点
 */
const { defineHandler } = require('../../_lib/handler');
const { getDb, K, dateStr } = require('../../_lib/storage');
const { requireDoctorOwn } = require('../../_lib/patient-access');
const { updatePatient, addArchiveEntry, audit, track } = require('../../_lib/services');
const { ApiError } = require('../../_lib/response');
const logger = require('../../_lib/logger');

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'write', max: 10, windowSec: 60, byUser: true },
  fn: async ({ params, user }) => {
    if (user.role !== 'doctor') throw new ApiError(403, 40300, '仅医生可删除建档记录');
    const pid = params.id;
    // 权限守卫：仅患者的主管医生（404/403 在此抛出）
    const patient = await requireDoctorOwn(user, pid);
    const db = await getDb();

    const raw = await db.get(K.medrec(pid));
    if (!raw) throw new ApiError(404, 40404, '该患者尚未建档，无需删除');
    let record = null;
    try { record = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { record = null; }

    /* 1. 删除专病病历 */
    await db.del(K.medrec(pid));

    /* 2. 回收建档衍生状态：档案状态回到「待建档」，取消自动排期的随访 */
    const oldDate = patient.nextFollowupDate || null;
    await updatePatient(pid, (p) => {
      p.archivedAt = null;
      delete p.medicalRecordId;
      p.nextFollowupDate = null;
      p.mainDiagnosis = p.mainDiagnosis === '脂肪肝（专病建档）' ? '' : p.mainDiagnosis;
    }, null);
    if (oldDate) await db.srem(K.followupDue(oldDate), pid);

    /* 3. 档案轨迹 + 审计 + 埋点 */
    await addArchiveEntry(pid, {
      kind: 'archive', type: 'medical_record',
      title: '脂肪肝专病建档记录已删除',
      summary: `删除建档版本 v${record && record.version ? record.version : '-'}；建档医生：${user.name}；患者回到待建档状态`,
      by: user.name
    });
    await audit('registry.delete', { operator: user.uid, patient_id: pid, version: record ? record.version : null });
    await track('registry_delete', { doc_id: user.uid, patient_id: pid });
    logger.info('registry.delete', { patientId: pid, docId: user.uid });

    return {
      patientId: pid,
      patientName: patient.name,
      deleted: true,
      deletedVersion: record ? record.version : null,
      deletedAt: dateStr(),
      followupCancelled: !!oldDate,
      cancelledFollowupDate: oldDate
    };
  }
});
