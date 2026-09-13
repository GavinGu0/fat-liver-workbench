'use strict';
/** 运行环境健康检查 */
const { defineHandler } = require('./_lib/handler');
const { getDb, mode } = require('./_lib/storage');
const { blobConfigured } = require('./_lib/blob');
const blobSnapshot = require('./_lib/blob-snapshot');
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
    const storageMode = mode();

    return {
      status: 'ok',
      time: new Date().toISOString(),
      storage: storageMode,
      storageNote: storageMode === 'sqlite'
        ? 'SQLite 文件持久化（本地真实落盘；Vercel 上落实例临时目录，实例回收后重置）'
        : '演示模式 · 数据存于进程内存，实例重启后重置',
      stats,
      blob: blobConfigured(),
      edgeConfig: !!process.env.EDGE_CONFIG,
      l3Snapshot: blobSnapshot.status(),
      docs: process.env.ENABLE_API_DOCS === 'true' || process.env.NODE_ENV !== 'production',
      auth,
      configKeys: Object.keys(DEFAULT_CONFIGS)
    };
  }
});
