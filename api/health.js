'use strict';
/** 运行环境健康检查：存储模式 / Blob / Edge Config / 演示账号自检 */
const { defineHandler } = require('./_lib/handler');
const { mode } = require('./_lib/storage');
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
    return {
      status: 'ok',
      time: new Date().toISOString(),
      storage: mode(), // memory = 演示模式（数据不持久），redis = 已接入 KV
      blob: blobConfigured(),
      edgeConfig: !!process.env.EDGE_CONFIG,
      docs: process.env.ENABLE_API_DOCS === 'true' || process.env.NODE_ENV !== 'production',
      auth,
      configKeys: Object.keys(DEFAULT_CONFIGS)
    };
  }
});
