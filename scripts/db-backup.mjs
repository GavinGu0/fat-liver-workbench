/**
 * SQLite 数据库备份 / 恢复工具（零依赖，文件级拷贝，含 WAL 检查点）
 *
 * 用法：
 *   node scripts/db-backup.mjs backup            # 备份到 data/backups/flwb-<时间戳>.db（自动保留最近 10 份）
 *   node scripts/db-backup.mjs backup ./my.db    # 备份到指定路径
 *   node scripts/db-backup.mjs restore <file>    # 从指定备份恢复到主库
 *   node scripts/db-backup.mjs list              # 列出现有备份
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_PATH = process.env.SQLITE_PATH || path.join(ROOT, 'data', 'flwb.db');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const KEEP = 10;

function mustExist(p) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 文件不存在: ${p}`);
    process.exit(1);
  }
}

/** WAL 检查点：把 -wal/-shm 内容合并进主库文件，保证拷贝出的备份完整 */
function checkpoint() {
  try {
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (e) {
    console.warn('⚠ checkpoint 失败（数据库可能正被使用）:', e.message);
  }
}

function backup(destArg) {
  mustExist(DB_PATH);
  checkpoint();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.resolve(destArg || path.join(BACKUP_DIR, `flwb-${stamp}.db`));
  fs.copyFileSync(DB_PATH, dest);
  // 附带 JSON 可读快照（可选）
  try {
    const db = new DatabaseSync(dest);
    const dump = { exportedAt: new Date().toISOString() };
    for (const t of ['kv', 'hashes', 'lists', 'sets', 'zsets']) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
    db.close();
    fs.writeFileSync(dest.replace(/\.db$/, '.json'), JSON.stringify(dump));
  } catch { /* JSON 侧导出失败不影响 .db 备份 */ }
  console.log(`✓ 备份完成: ${dest}`);
  prune();
}

function restore(srcArg) {
  if (!srcArg) { console.error('用法: node scripts/db-backup.mjs restore <备份文件>'); process.exit(1); }
  const src = path.resolve(srcArg);
  mustExist(src);
  if (fs.existsSync(DB_PATH)) {
    console.log(`⚠ 将覆盖现有数据库: ${DB_PATH}`);
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(src, DB_PATH);
  console.log(`✓ 恢复完成: ${src} → ${DB_PATH}`);
}

function list() {
  if (!fs.existsSync(BACKUP_DIR)) { console.log('（暂无备份）'); return; }
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
  if (!files.length) { console.log('（暂无备份）'); return; }
  for (const f of files) {
    const st = fs.statSync(path.join(BACKUP_DIR, f));
    console.log(`${f}  ${(st.size / 1024).toFixed(1)} KB  ${st.mtime.toISOString()}`);
  }
}

function prune() {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
  for (const f of files.slice(KEEP)) {
    fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    fs.rmSync(path.join(BACKUP_DIR, f.replace(/\.db$/, '.json')), { force: true });
    console.log(`- 清理过期备份: ${f}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'backup') backup(arg);
else if (cmd === 'restore') restore(arg);
else if (cmd === 'list') list();
else {
  console.log('用法: node scripts/db-backup.mjs <backup|restore|list> [路径]');
  process.exit(1);
}
