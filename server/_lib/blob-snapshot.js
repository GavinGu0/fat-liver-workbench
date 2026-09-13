'use strict';
/**
 * L3 云端快照（Vercel Blob）— 无外部数据库条件下的跨实例/跨回收数据恢复点
 *
 * 架构位置：L1 内存（热读写）→ L2 /tmp 快照·SQLite（实例级）→ L3 Blob JSON（全局恢复点）
 *
 * 机制：
 *   - 下载：实例冷启动且本地为空库时，拉取 snapshot.json 引导恢复（含 seed flag，不会重复播种）
 *   - 上传：写入操作经 8s 防抖 + 最小间隔节流（默认 30min）后全量上传；
 *           Vercel Cron 每日强制兜底一次
 *   - 格式：{updatedAt, data:{kv[],hashes[],lists[],sets[],zsets[]}}（与 memoryStore/sqlite._export 统一）
 *
 * 额度适配：put 为 Blob 高级操作（Hobby 免费 2000 次/月），30min 节流 ≈ 上限 1440 次/月；
 *          快照体量 <1MB，存储/传输额度（1GB/10GB 每月）余量充足。
 * 安全：患者 PII 采用 private 访问（SDK 版本不支持时降级 public 并告警）。
 * 降级：未配置 BLOB_READ_WRITE_TOKEN 或 STORAGE_BLOB_SNAPSHOT!=true 时整体禁用，零开销零影响。
 */
const SNAPSHOT_KEY = 'storage/snapshot.json';
const DEBOUNCE_MS = 8000;

let _timer = null;
let _uploading = false;
let _lastOkAt = null;
let _lastBytes = 0;
let _lastError = null;
let _lastOkTs = 0;

function minIntervalMs() {
  return (Number(process.env.STORAGE_BLOB_MIN_INTERVAL_SEC) || 1800) * 1000;
}

function enabled() {
  if (process.env.STORAGE_BLOB_SNAPSHOT === 'false') return false; // 显式关闭优先
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;            // 未配置 Blob store
  // Vercel 运行时（自动注入 VERCEL=1）默认启用，防止本地开发误传快照污染云端恢复点；
  // 本地需显式 STORAGE_BLOB_SNAPSHOT=true 才启用（用于联调）
  return process.env.VERCEL === '1' || process.env.STORAGE_BLOB_SNAPSHOT === 'true';
}

async function putSnapshot(body) {
  const { put } = await import('@vercel/blob');
  // 私有 store 需显式 access:'private'（服务端校验必传）；固定路径覆盖
  await put(SNAPSHOT_KEY, body, { access: 'private', contentType: 'application/json', addRandomSuffix: false });
}

/** 强制上传（无视节流；供 Cron 每日兜底调用） */
async function uploadNow(db) {
  if (!enabled()) return { skipped: true, reason: 'disabled' };
  if (_uploading) return { skipped: true, reason: 'in-flight' };
  _uploading = true;
  try {
    const data = db._export();
    const body = JSON.stringify({ updatedAt: new Date().toISOString(), data });
    await putSnapshot(body);
    _lastOkAt = new Date().toISOString();
    _lastBytes = Buffer.byteLength(body);
    _lastOkTs = Date.now();
    _lastError = null;
    console.info('[blob-snapshot] uploaded', _lastBytes, 'bytes');
    return { ok: true, bytes: _lastBytes };
  } catch (e) {
    _lastError = e.message;
    console.warn('[blob-snapshot] upload failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    _uploading = false;
  }
}

/** 防抖 + 节流调度（由 storage.js 的 L3 写钩子触发） */
function scheduleUpload(db) {
  if (!enabled() || _timer || _uploading) return;
  _timer = setTimeout(async () => {
    _timer = null;
    const wait = _lastOkTs + minIntervalMs() - Date.now();
    if (wait > 0) {
      _timer = setTimeout(async () => { _timer = null; await uploadNow(db); }, wait);
      if (_timer.unref) _timer.unref();
      return;
    }
    await uploadNow(db);
  }, DEBOUNCE_MS);
  if (_timer.unref) _timer.unref();
}

/** 冷启动引导：下载远端快照；无快照/失败返回 null（调用方走种子兜底） */
async function download() {
  if (!enabled()) return null;
  try {
    const { get } = await import('@vercel/blob');
    const res = await get(SNAPSHOT_KEY);
    const payload = JSON.parse(await res.text());
    if (payload && payload.data && Array.isArray(payload.data.kv)) return payload;
    return null;
  } catch (e) {
    if (/not found/i.test(String((e && e.message) || e))) {
      console.debug('[blob-snapshot] no remote snapshot yet');
      return null;
    }
    console.warn('[blob-snapshot] download failed:', (e && e.message) || e);
    return null;
  }
}

function status() {
  return {
    enabled: enabled(),
    lastUploadedAt: _lastOkAt,
    lastBytes: _lastBytes,
    lastError: _lastError,
    minIntervalSec: minIntervalMs() / 1000
  };
}

function resetForTest() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _uploading = false;
  _lastOkAt = null;
  _lastBytes = 0;
  _lastError = null;
  _lastOkTs = 0;
}

module.exports = { enabled, uploadNow, scheduleUpload, download, status, resetForTest };
