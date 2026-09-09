'use strict';
/** 医生视角 MDT 全量列表（工作台/会诊页） */
const { defineHandler } = require('../_lib/handler');
const { getDb, K } = require('../_lib/storage');

const zparse = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

module.exports = defineHandler({
  auth: 'staff',
  fn: async ({ user }) => {
    const db = await getDb();
    const ids = await db.zrevrange(K.mdtIdx(user.uid), 0, -1);
    const items = (await Promise.all(ids.map(async id => zparse(await db.get(K.mdt(id))))))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
    return { items };
  }
});
