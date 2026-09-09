'use strict';
/**
 * MDT 多学科协作（PRD 3.1.2）：
 * GET  会诊列表（本人患者）
 * POST action = initiate 发起 | feedback 专家反馈 | archive 归档（结论写入健康档案）
 */
const { randomUUID } = require('node:crypto');
const { defineHandler } = require('../../_lib/handler');
const { getDb, K } = require('../../_lib/storage');
const { requireDoctorOwn } = require('../../_lib/patient-access');
const { updatePatient, addArchiveEntry, audit, track, getConfig } = require('../../_lib/services');
const { mdtSchema } = require('../../_lib/validate');
const { ApiError } = require('../../_lib/response');
const { MDT_STATUS_LABELS } = require('@flwb/shared');

const zparse = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, params, body, query, user }) => {
    const pid = params.id;
    const db = await getDb();

    if (req.method === 'GET') {
      await requireDoctorOwn(user, pid);
      const ids = await db.zrevrange(K.mdtIdx(user.uid), 0, -1);
      const items = await Promise.all(ids.map(async id => zparse(await db.get(K.mdt(id)))));
      return { items: items.filter(x => x && x.patientId === pid).sort((a, b) => b.createdAt - a.createdAt) };
    }

    const action = (body && body.action) || 'initiate';

    if (action === 'initiate') {
      const p = await requireDoctorOwn(user, pid);
      const input = body; // 结构校验
      if (!input || !Array.isArray(input.specialists) || !input.specialists.length) {
        throw new ApiError(422, 42200, '请至少选择一位会诊专家');
      }
      if (!input.reason || String(input.reason).trim().length < 5) {
        throw new ApiError(422, 42200, '请填写会诊理由（至少5个字）');
      }
      const experts = await getConfig('experts', []);
      const specialistList = input.specialists.slice(0, 5).map(s => {
        const e = experts.find(x => x.id === s.expertId) || {};
        return { expertId: s.expertId, dept: e.dept || s.dept || '', expert: e.name || s.expert || '', opinion: null, opinionAt: null };
      });
      const mdt = {
        id: 'mdt_' + randomUUID().replace(/-/g, '').slice(0, 12),
        patientId: pid,
        patientName: p.name,
        docId: user.uid,
        docName: user.name,
        reason: String(input.reason).slice(0, 500),
        specialists: specialistList,
        status: 'pending',
        conclusion: null,
        createdAt: Date.now()
      };
      await db.set(K.mdt(mdt.id), JSON.stringify(mdt));
      await db.zadd(K.mdtIdx(user.uid), mdt.createdAt, mdt.id);
      await track('mdt_initiate', { doc_id: user.uid, patient_id: pid });
      await audit('mdt.initiate', { operator: user.uid, patient_id: pid, mdtId: mdt.id });
      return mdt;
    }

    const mdtId = body && body.mdtId;
    if (!mdtId) throw new ApiError(422, 42200, '缺少 mdtId');
    const mdt = zparse(await db.get(K.mdt(mdtId)));
    if (!mdt) throw new ApiError(404, 40400, '会诊单不存在');
    if (mdt.docId !== user.uid) throw new ApiError(403, 40300, '仅限发起医生操作该会诊');
    await requireDoctorOwn(user, mdt.patientId);

    if (action === 'feedback') {
      if (mdt.status === 'done') throw new ApiError(409, 40902, '会诊已归档，无法继续反馈');
      const { dept, expert, opinion } = body;
      if (!opinion || String(opinion).trim().length < 2) throw new ApiError(422, 42200, '请填写专家意见');
      mdt.specialists.push({
        expertId: 'custom', dept: dept || '', expert: expert || '外请专家',
        opinion: String(opinion).slice(0, 1000), opinionAt: Date.now()
      });
      mdt.status = 'feedback';
      await db.set(K.mdt(mdtId), JSON.stringify(mdt));
      await audit('mdt.feedback', { operator: user.uid, mdtId });
      return mdt;
    }

    if (action === 'archive') {
      const conclusion = body.conclusion && String(body.conclusion).trim();
      if (!conclusion) throw new ApiError(422, 42200, '请填写会诊结论');
      mdt.conclusion = String(conclusion).slice(0, 1000);
      mdt.status = 'done';
      mdt.archivedAt = Date.now();
      await db.set(K.mdt(mdtId), JSON.stringify(mdt));
      await addArchiveEntry(mdt.patientId, {
        kind: 'mdt',
        title: `MDT会诊结论（${mdt.specialists.map(s => s.dept).filter(Boolean).join('/') || '多学科'}）`,
        summary: mdt.conclusion,
        by: user.name
      });
      await audit('mdt.archive', { operator: user.uid, mdtId });
      return mdt;
    }

    throw new ApiError(422, 42200, `未知操作: ${action}`);
  }
});
