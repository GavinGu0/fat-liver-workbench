'use strict';
/** 护理端 · 个案指导记录：创建 + 查询（按患者/按护士） */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');
const { getPatient, pushMsg, track, audit } = require('../_lib/services');
const { parse, guidanceSchema } = require('../_lib/validate');

const zparse = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

module.exports = defineHandler({
  auth: 'nurse',
  limit: { scope: 'write', max: 30, windowSec: 60, byUser: true },
  fn: async ({ req, body, query, user }) => {
    const db = await getDb();

    if (req.method === 'GET') {
      if (query.patientId) {
        const arr = await db.lrange(K.guidance(query.patientId), 0, 49);
        return { items: (await Promise.all(arr.map(async x => zparse(x)))).filter(Boolean) };
      }
      const ids = await db.zrevrange(K.guidanceIdx(user.uid), 0, 49);
      const items = (await Promise.all(ids.map(async id => zparse(await db.get(K.guidance('one_' + id)))))).filter(Boolean);
      return { items };
    }

    const input = parse(guidanceSchema, body);
    const p = await getPatient(input.patientId);
    if (!p) throw new ApiError(404, 40400, '患者不存在');

    const record = {
      id: 'gd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      patientId: input.patientId,
      patientName: p.name,
      method: input.method,
      category: input.category,
      content: input.content,
      feedback: input.feedback || '',
      nurseId: user.uid,
      nurseName: user.name
    };

    await db.lpush(K.guidance(input.patientId), JSON.stringify(record));
    await db.ltrim(K.guidance(input.patientId), 0, 199);
    await db.set(K.guidance('one_' + record.id), JSON.stringify(record));
    await db.zadd(K.guidanceIdx(user.uid), record.ts, record.id);

    // 指导同步推送给患者（有账号时）
    if (p.userId) {
      await pushMsg(p.userId, {
        type: 'guidance',
        title: `个案指导：${input.category}`,
        content: `<p><b>指导方式：</b>${input.method}</p><p>${String(input.content).replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p>`,
        from: user.name,
        payload: { guidanceId: record.id }
      });
    }

    await track('guidance_create', { nurse_id: user.uid, patient_id: input.patientId });
    await audit('guidance.create', { operator: user.uid, patient_id: input.patientId });
    return record;
  }
});
