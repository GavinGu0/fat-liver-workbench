'use strict';
/**
 * 当前登录用户信息（GET /api/v1/auth/me）
 * 患者端个人资料页数据源：会话基础信息 + 健康档案聚合（性别/年龄/身高体重BMI/手机号/
 * 风险分层/主管医生/诊断/随访安排）。医护角色返回账号基础信息。
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { getPatient } = require('../_lib/services');

module.exports = defineHandler({
  auth: 'any',
  fn: async ({ user }) => {
    const db = await getDb();
    const u = await db.hgetall(K.user(user.uid));
    const base = {
      uid: user.uid,
      role: user.role,
      name: (u && u.name) || user.name,
      title: (u && u.title) || '',
      dept: (u && u.dept) || '',
      patientId: (u && u.patientId) || user.patientId || null,
      username: (u && u.username) || '',
      phone: (u && u.phone) || '',
      createdAt: (u && u.createdAt) || null
    };

    if (base.role !== 'patient' || !base.patientId) return base;

    const p = await getPatient(base.patientId);
    if (!p) return base;

    let docName = '';
    if (p.docId) {
      try {
        const doc = await db.hgetall(K.user(p.docId));
        if (doc && doc.name) docName = `${doc.name}${doc.title ? ' ' + doc.title : ''}`;
      } catch { /* 非关键展示字段 */ }
    }

    return {
      ...base,
      profile: {
        id: p.id,
        name: p.name,
        gender: p.gender || null,
        age: p.age ?? null,
        height: p.height ?? null,
        weight: p.weight ?? null,
        bmi: p.bmi ?? null,
        risk: p.risk || null,
        phone: p.phone || base.phone || '',
        mainDiagnosis: p.mainDiagnosis || '',
        chiefComplaint: p.chiefComplaint || '',
        nextFollowupDate: p.nextFollowupDate || null,
        lastFollowupAt: p.lastFollowupAt || null,
        createdAt: p.createdAt || null,
        docName
      }
    };
  }
});
