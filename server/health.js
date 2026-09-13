'use strict';
/** 运行环境健康检查 */
const { defineHandler } = require('./_lib/handler');
const { getDb } = require('./_lib/storage');
const { blobConfigured } = require('./_lib/blob');
const { DEFAULT_CONFIGS } = require('./_lib/seed');
const { verifyAccess, getBearerToken } = require('./_lib/auth');

module.exports = defineHandler({
  auth: 'public',
  fn: async ({ req }) => {
    let auth = null;
    const token = getBearerToken(req);
    if (token) {
      try { auth = verifyAccess(token); } catch { auth = { invalid: true }; }
    }

    const db = await getDb();
    const stats = db._stats ? db._stats() : null;

    return {
      status: 'ok',
      time: new Date().toISOString(),
      storage: 'memory',
      storageNote: '演示模式 · 数据存于进程内存，实例重启后重置',
      stats,
      blob: blobConfigured(),
      edgeConfig: !!process.env.EDGE_CONFIG,
      docs: process.env.ENABLE_API_DOCS === 'true' || process.env.NODE_ENV !== 'production',
      auth,
      configKeys: Object.keys(DEFAULT_CONFIGS)
    };
  }
});
