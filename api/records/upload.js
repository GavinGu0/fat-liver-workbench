'use strict';
/**
 * 图片上传（饮食照片）：base64 dataUrl 传输（Serverless 友好，免 multipart 依赖）
 * - 已配置 Vercel Blob：写入 Blob，返回持久 URL
 * - 未配置：≤200KB 以 dataUrl 形式经 KV 兜底（7 天有效），超限拒绝
 */
const { defineHandler } = require('../_lib/handler');
const { ApiError } = require('../_lib/response');
const { blobConfigured, putBlob, putImageFallback } = require('../_lib/blob');
const { parse, uploadSchema } = require('../_lib/validate');
const { randomUUID } = require('node:crypto');

const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const MAX_BYTES = 5 * 1024 * 1024;

module.exports = defineHandler({
  auth: 'any',
  limit: { scope: 'upload', max: 20, windowSec: 60, byUser: true },
  fn: async ({ body }) => {
    const input = parse(uploadSchema, body);
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(input.dataUrl);
    if (!m) throw new ApiError(422, 42200, '图片格式错误，仅支持 jpg/png');

    const contentType = m[1].toLowerCase();
    const ext = ALLOWED[contentType];
    if (!ext) throw new ApiError(422, 42200, '图片格式错误，仅支持 jpg/png');

    const size = Math.floor(m[2].length * 0.75);
    if (size > MAX_BYTES) throw new ApiError(422, 42200, '图片不能超过5MB，请压缩后重试');

    const buffer = Buffer.from(m[2], 'base64');

    if (blobConfigured()) {
      const url = await putBlob(`uploads/${randomUUID()}.${ext}`, buffer, contentType);
      if (url) return { url, ephemeral: false, size };
    }
    const fb = await putImageFallback(input.dataUrl);
    if (fb) return { url: fb.url, ephemeral: true, size, notice: '未配置 Blob 存储，图片 7 天后失效（演示模式）' };
    throw new ApiError(422, 42200, '图片过大且未配置 Blob 存储，请压缩至 200KB 以内');
  }
});
