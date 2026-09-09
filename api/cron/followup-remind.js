'use strict';
/**
 * 每日定时任务（Vercel Cron，北京时间 09:00 = UTC 01:00）：
 * 1. 随访提醒：扫描当日应随访患者 → 未提醒则推送消息
 * 2. 数据快照：患者档案 + 近期记录打包备份（Blob 优先，KV 兜底）
 * 3. 过期清理：已过期随访集合清理
 * 安全：配置 CRON_SECRET 后强制校验 Authorization: Bearer
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K, dateStr } = require('../_lib/storage');
const { getPatient, pushMsg, audit } = require('../_lib/services');
const { putJson, blobConfigured } = require('../_lib/blob');
const { ApiError } = require('../_lib/response');
const logger = require('../_lib/logger');

const DAY = 86400000;

module.exports = defineHandler({
  auth: 'public',
  fn: async ({ req }) => {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${secret}`) throw new ApiError(401, 40100, 'Cron 鉴权失败');
    }

    const db = await getDb();
    const today = dateStr();
    const result = { date: today, reminded: 0, cleaned: 0, backup: null };

    // 1) 随访提醒：今日应随访
    const dueIds = await db.smembers(K.followupDue(today));
    for (const pid of dueIds || []) {
      const p = await getPatient(pid);
      if (!p) { await db.srem(K.followupDue(today), pid); result.cleaned++; continue; }
      if (p.reminderSentOn === today) continue;
      if (p.userId) {
        await pushMsg(p.userId, {
          type: 'followup_remind',
          title: '今日随访提醒',
          content: `<p>医生为您安排了今日随访，请记得记录<b>饮食、运动和随访指标</b>，保持数据连续性。</p>`,
          from: '管理系统',
          payload: { patientId: pid }
        });
        result.reminded++;
      }
      // 档案级防重标记（即使无账号也标记，避免重复扫描）
      await db.set(K.flag(`reminded_${pid}_${today}`), '1', { ex: 2 * DAY });
      // 将防重标记写入档案（轻量直写，避免锁开销）
      try {
        const raw = await db.get(K.patient(pid));
        if (raw) {
          const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
          doc.reminderSentOn = today;
          await db.set(K.patient(pid), JSON.stringify(doc));
        }
      } catch { /* 非关键路径 */ }
    }

    // 2) 过期随访集合清理（近7天已过期的 due set）
    for (let i = 1; i <= 7; i++) {
      const d = dateStr(-i);
      const members = await db.smembers(K.followupDue(d));
      for (const pid of members || []) {
        const p = await getPatient(pid);
        if (!p || p.nextFollowupDate !== d) {
          await db.srem(K.followupDue(d), pid);
          result.cleaned++;
        }
      }
    }

    // 3) 数据快照备份
    try {
      const ids = await db.zrange(K.allPatients, 0, -1);
      const snapshot = { date: today, patients: [] };
      for (const pid of ids) {
        const p = await getPatient(pid);
        if (!p) continue;
        snapshot.patients.push({
          profile: p,
          vitalsCount: Number(await db.zcard(K.vitals(pid))) || 0
        });
      }
      snapshot.totals = { patients: snapshot.patients.length, storage: 'kv' };
      if (blobConfigured()) {
        const url = await putJson(`backups/${today}.json`, snapshot);
        result.backup = { type: 'blob', url };
      } else {
        await db.set(K.backup(today), JSON.stringify(snapshot), { ex: 30 * DAY });
        result.backup = { type: 'kv', ttlDays: 30 };
      }
    } catch (e) {
      logger.warn('cron.backup.fail', { message: e.message });
    }

    await audit('cron.daily', { ...result });
    logger.info('cron.daily.done', { ...result });
    return result;
  }
});
