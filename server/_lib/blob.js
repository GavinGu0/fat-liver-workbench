'use strict';
/** Vercel Blob 适配：饮食照片、评估报告/审计/备份归档。未配置 Token 时优雅降级（返回 null） */
const { randomUUID } = require('node:crypto');
const { getDb, K } = require('./storage');

function blobConfigured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function putBlob(pathname, body, contentType) {
  if (!blobConfigured()) return null;
  try {
    const { put } = await import('@vercel/blob');
    // 私有 store 需显式 access:'private'（服务端校验必传）
    // @vercel/blob 2.8：addRandomSuffix 默认 false → 固定路径（审计/备份归档）重复写入需显式 allowOverwrite
    const res = await put(pathname, body, { access: 'private', contentType, allowOverwrite: true });
    return res && res.url ? res.url : null;
  } catch (e) {
    console.error('[blob] put failed:', e.message);
    return null;
  }
}

async function putJson(key, data) {
  if (!blobConfigured()) return null;
  return putBlob(key, JSON.stringify(data), 'application/json');
}

/**
 * 无 Blob 时的 KV 图片兜底：存储 dataUrl（限 200KB），7 天过期
 * @returns {Promise<{url:string, ephemeral:boolean}>}
 */
async function putImageFallback(dataUrl) {
  const size = Math.floor(dataUrl.length * 0.75);
  if (size > 200 * 1024) return null;
  const db = await getDb();
  const id = randomUUID().replace(/-/g, '').slice(0, 24);
  await db.set(K.img(id), dataUrl, { ex: 7 * 24 * 3600 });
  return { url: dataUrl, ephemeral: true };
}

module.exports = { blobConfigured, putBlob, putJson, putImageFallback };
