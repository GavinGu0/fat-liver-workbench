'use strict';
/**
 * 护理端 · 宣教推送：向指定患者批量推送宣教素材（PRD 3.1.1）
 * GET  素材列表 + 我的推送历史
 * POST {patientIds, materialId, note?}
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { getPatient, pushMsg, track, audit, getConfig } = require('../_lib/services');
const { parse, educationPushSchema } = require('../_lib/validate');
const { ApiError } = require('../_lib/response');
const { DEFAULT_CONFIGS } = require('../_lib/seed');

const zparse = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

module.exports = defineHandler({
  auth: 'nurse',
  limit: { scope: 'push', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, body, user }) => {
    const db = await getDb();

    if (req.method === 'GET') {
      const materials = await getConfig('materials', DEFAULT_CONFIGS.materials);
      const logIds = await db.zrevrange(K.eduLog('idx_nurse_' + user.uid), 0, -1);
      const history = (await Promise.all(logIds.map(async id => zparse(await db.get(K.eduLog(id)))))).filter(Boolean);
      return { materials, history: history.slice(0, 50) };
    }

    const input = parse(educationPushSchema, body);
    const materials = await getConfig('materials', DEFAULT_CONFIGS.materials);
    const material = materials.find(m => m.id === input.materialId);
    if (!material) throw new ApiError(404, 40400, '宣教素材不存在');

    let sent = 0;
    const skipped = [];
    for (const pid of input.patientIds.slice(0, 50)) {
      const p = await getPatient(pid);
      if (!p) { skipped.push(pid); continue; }
      const logId = 'edu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (p.userId) {
        await pushMsg(p.userId, {
          type: 'education',
          title: `健康宣教：${material.title}`,
          content: material.html + (input.note ? `<p class="note">护士留言：${input.note}</p>` : ''),
          from: user.name,
          payload: { materialId: material.id }
        });
        sent++;
      } else {
        skipped.push(pid);
      }
      const log = { id: logId, ts: Date.now(), patientId: pid, patientName: p.name, materialId: material.id, materialTitle: material.title, nurseName: user.name, pushed: !!p.userId };
      await db.lpush(K.eduLog(pid), JSON.stringify(log));
      await db.ltrim(K.eduLog(pid), 0, 199);
      await db.set(K.eduLog(logId), JSON.stringify(log));
      await db.zadd(K.eduLog('idx_nurse_' + user.uid), log.ts, logId);
    }

    await track('education_push', { nurse_id: user.uid, count: sent });
    await audit('education.push', { operator: user.uid, sent, skipped: skipped.length });
    return { sent, skipped };
  }
});
