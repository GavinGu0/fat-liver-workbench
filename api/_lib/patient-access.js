'use strict';
/** 患者数据访问守卫：医生数据隔离（docId 强制匹配）、护士只读全量、患者仅本人 */
const { ApiError } = require('./response');
const { getPatient } = require('./services');

/**
 * 读取访问：doctor 仅限本人管理患者；nurse 全量只读；patient 仅本人
 */
async function requirePatientRead(user, patientId) {
  const p = await getPatient(patientId);
  if (!p) throw new ApiError(404, 40400, '患者不存在');
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
  if (!p) throw new ApiError(404, 40400, '患者不存在');
  if (user.role !== 'doctor' || p.docId !== user.uid) {
    throw new ApiError(403, 40300, '仅限患者的主管医生操作');
  }
  return p;
}

module.exports = { requirePatientRead, requireDoctorOwn };
