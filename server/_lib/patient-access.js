'use strict';
/** 患者数据访问守卫：医生数据隔离（docId 强制匹配）、护士只读全量、患者仅本人 */
const { ApiError } = require('./response');
const { getPatient } = require('./services');

/** 患者不存在统一错误（含引导信息，避免"档案不存在"歧义） */
function patientNotFound(patientId) {
  return new ApiError(404, 40400,
    `患者档案不存在（ID: ${String(patientId || '').slice(0, 16)}）。该患者可能尚未建档或已被删除，请返回「专病建档」页完成一站式建档后再操作`);
}

/**
 * 读取访问：doctor 仅限本人管理患者；nurse 全量只读；patient 仅本人
 */
async function requirePatientRead(user, patientId) {
  const p = await getPatient(patientId);
  if (!p) throw patientNotFound(patientId);
  if (user.role === 'doctor' && p.docId !== user.uid) {
    throw new ApiError(403, 40300, '无权查看该患者（仅限本人管理患者）');
  }
  if (user.role === 'patient') {
    const self = p.userId === user.uid || p.id === user.patientId;
    if (!self) throw new ApiError(403, 40300, '无权查看该患者');
  }
  return p;
}

/** 写访问：仅患者的主管医生 */
async function requireDoctorOwn(user, patientId) {
  const p = await getPatient(patientId);
  if (!p) throw patientNotFound(patientId);
  if (user.role !== 'doctor' || p.docId !== user.uid) {
    throw new ApiError(403, 40300, '仅限患者的主管医生操作');
  }
  return p;
}

module.exports = { requirePatientRead, requireDoctorOwn };
