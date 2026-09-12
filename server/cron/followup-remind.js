'use strict';
/**
 * 每日定时任务（Vercel Cron，北京时间 09:00 = UTC 01:00）：
 * 1. 随访提醒：扫描当日应随访患者 → 未提醒则推送消息（带发送日志/状态跟踪/失败重试）
 * 2. 重试队列：处理到期失败通知的自动重发（超过上限触发管理员告警）
 * 3. 数据快照：患者档案 + 近期记录打包备份（Blob 优先，KV 兜底）
 * 4. 过期清理：已过期随访集合清理
 * 安全：配置 CRON_SECRET 后强制校验 Authorization: Bearer
 */
const { defineHandler } = require('../_lib/handler');
const { getDb, K, dateStr } = require('../_lib/storage');
const { getPatient, pushMsg, audit } = require('../_lib/services');
const { sendReminder, processRetryQueue } = require('../_lib/notify');
const { raiseAlert } = require('../_lib/clinic');
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
    const result = { date: today, reminded: 0, remindFailed: 0, preReminded: 0, overdueAlerts: 0, cleaned: 0, retry: null, backup: null };

    // 0) 3日后随访预提醒：医生端弹窗数据源 + 医患双方站内信
    const in3 = dateStr(3);
    for (const pid of (await db.smembers(K.followupDue(in3))) || []) {
      const p = await getPatient(pid);
      if (!p || p.nextFollowupDate !== in3) continue;
      if (p.docId) {
        await pushMsg(p.docId, {
          type: 'followup_pre_remind',
          title: '随访提醒（3日后）',
          content: `<p>患者 <b>${p.name}</b> 预约于 ${in3} 随访（${p.nextFollowupDate === in3 ? '距今3天' : ''}），请提前准备随访计划，或一键发送提醒给患者。</p>`,
          from: '随访管理',
          payload: { patientId: pid, date: in3 }
        });
        result.preReminded++;
      }
      if (p.userId) {
        await sendReminder({
          userId: p.userId, patientId: pid, patientName: p.name, docId: p.docId,
          bizType: 'followup_pre_remind',
          channels: ['inapp'],
          msg: {
            type: 'followup_pre_remind',
            title: '随访即将开始',
            content: `<p>您预约的随访将于 <b>3天后（${in3}）</b> 进行，请保持规律记录饮食与运动数据。</p>`,
            from: '管理系统',
            payload: { patientId: pid, date: in3 }
          }
        });
      }
    }

    // 0.5) 逾期随访 → 医生预警（raiseAlert 幂等：同一患者同类型未处理时升级不重复）
    for (let i = 1; i <= 7; i++) {
      const d = dateStr(-i);
      for (const pid of (await db.smembers(K.followupDue(d))) || []) {
        const p = await getPatient(pid);
        if (!p || p.nextFollowupDate !== d || !p.docId) continue;
        await raiseAlert({
          docId: p.docId, patientId: pid, patientName: p.name,
          level: i >= 7 ? 'high' : 'mid',
          type: 'followup_overdue',
          title: `随访逾期：${p.name}`,
          content: `患者 ${p.name} 的随访（原定 ${d}）已逾期 ${i} 天，请尽快电话随访或标记失访。`,
          link: `/followup`
        });
        result.overdueAlerts++;
      }
    }

    // 1) 随访提醒：今日应随访（带发送日志跟踪；未绑定账号患者记录 skipped 便于医护排查）
    const dueIds = await db.smembers(K.followupDue(today));
    for (const pid of dueIds || []) {
      const p = await getPatient(pid);
      if (!p) { await db.srem(K.followupDue(today), pid); result.cleaned++; continue; }
      if (p.reminderSentOn === today) continue;
      const r = await sendReminder({
        userId: p.userId, patientId: pid, patientName: p.name, docId: p.docId,
        bizType: 'followup_remind',
        channels: ['inapp', 'sms'],
        msg: {
          type: 'followup_remind',
          title: '今日随访提醒',
          content: `<p>医生为您安排了今日随访，请记得记录<b>饮食、运动和随访指标</b>，保持数据连续性。</p>`,
          from: '管理系统',
          payload: { patientId: pid }
        }
      });
      if (r.status === 'sent') result.reminded++;
      else if (r.status === 'failed' || r.status === 'partial') result.remindFailed++;
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

    // 1.5) 通知重试队列：到期失败项自动重发（超限自动触发管理员告警）
    try {
      result.retry = await processRetryQueue();
    } catch (e) {
      logger.warn('cron.notify-retry.fail', { message: e.message });
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
