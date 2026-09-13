/** 验证 SQLite 落盘：表行数 + 示例患者（read-only inspection） */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 与 storage.js sqliteCandidates 一致：env 指定 → 项目 data/ → 系统临时目录 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const candidates = [
  ...(process.env.SQLITE_PATH ? [process.env.SQLITE_PATH] : []),
  path.join(process.cwd(), 'data', 'flwb.db'),
  path.join(os.tmpdir(), 'flwb.db')
];
const dbPath = candidates.find(p => fs.existsSync(p));
if (!dbPath) {
  console.error('✗ 未找到数据库文件，已尝试:\n' + candidates.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('数据库文件:', dbPath, '\n');

const d = new DatabaseSync(dbPath);
for (const t of ['kv', 'hashes', 'lists', 'sets', 'zsets']) {
  console.log(t.padEnd(7), d.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c, 'rows');
}
const row = d.prepare("SELECT val FROM kv WHERE key = 'patient:p_1001'").get();
const p = JSON.parse(row.val);
console.log('示例患者 p_1001:', p.name, '/ 风险:', p.risk, '/ 版本:', p.version);
d.close();
