'use strict';
/**
 * 健康宣教推送（医护端通用，PRD 3.1.1 / 信息化平台 医护端模块）
 * GET  素材列表（固定 + 已启用自定义模板统一合并）+ 我的推送历史
 * POST {patientIds, materialId, note?} 向指定患者/患者群推送宣教素材
 *      推送走统一模板接口：固定模板与自定义模板同构校验，发送记录 notify 日志
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { getPatient, pushMsg, track, audit, getConfig } = require('../_lib/services');
const { sendReminder } = require('../_lib/notify');
const { parse, educationPushSchema } = require('../_lib/validate');
const { ApiError } = require('../_lib/response');
const { DEFAULT_CONFIGS } = require('../_lib/seed');

const zparse = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

/** 统一模板源：固定模板 + 已启用自定义模板（同一调用接口） */
async function mergedMaterials(db) {
  const custom = await getConfig('customMaterials', []);
  const customOn = (Array.isArray(custom) ? custom : []).filter(m => m && m.enabled !== false);
  return [...DEFAULT_CONFIGS.materials, ...customOn];
}

module.exports = defineHandler({
  auth: 'staff',
  limit: { scope: 'push', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, body, user }) => {
    const db = await getDb();

    if (req.method === 'GET') {
      const materials = await mergedMaterials(db);
      const logIds = await db.zrevrange(K.eduLog('idx_staff_' + user.uid), 0, -1);
      const history = (await Promise.all(logIds.map(async id => zparse(await db.get(K.eduLog(id)))))).filter(Boolean);
      return { materials, history: history.slice(0, 50) };
    }

    const input = parse(educationPushSchema, body);
    const materials = await mergedMaterials(db);
    const material = materials.find(m => m.id === input.materialId);
    if (!material) throw new ApiError(404, 40400, '宣教素材不存在（可能已被禁用或删除，请刷新素材列表）');

    let sent = 0;
    const skipped = [];
    for (const pid of input.patientIds.slice(0, 50)) {
      const p = await getPatient(pid);
      if (!p) { skipped.push(pid); continue; }
      const logId = 'edu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (p.userId) {
        // 推送走 notify 统一通道（记录发送日志，失败自动重试）
        const r = await sendReminder({
          userId: p.userId, patientId: pid, patientName: p.name, docId: p.docId || user.uid,
          bizType: 'education_push',
          channels: ['inapp'],
          msg: {
            type: 'education',
            title: `健康宣教：${material.title}`,
            content: material.html + (input.note ? `<p class="note">医护留言：${input.note}</p>` : ''),
            from: user.name,
            payload: { materialId: material.id }
          }
        });
        if (r.status === 'sent') sent++;
      } else {
        skipped.push(pid);
      }
      const log = { id: logId, ts: Date.now(), patientId: pid, patientName: p.name, materialId: material.id, materialTitle: material.title, staffName: user.name, staffRole: user.role, pushed: !!p.userId };
      await db.lpush(K.eduLog(pid), JSON.stringify(log));
      await db.ltrim(K.eduLog(pid), 0, 199);
      await db.set(K.eduLog(logId), JSON.stringify(log));
      await db.zadd(K.eduLog('idx_staff_' + user.uid), log.ts, logId);
    }

    await track('education_push', { staff_id: user.uid, role: user.role, count: sent });
    await audit('education.push', { operator: user.uid, sent, skipped: skipped.length });
    return { sent, skipped };
  }
});
