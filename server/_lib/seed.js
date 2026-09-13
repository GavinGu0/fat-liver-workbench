'use strict';
/**
 * 演示数据播种（幂等）：确保一键部署后系统开箱可用
 * - 演示账号：医生 GBMZ / 护士 HULI01 / 患者 13800000001，密码均 123456
 * - 仅 1 名示例患者（p_1009 王小明，绑定患者演示账号）+ 近 30 天填报数据 + 消息/随访样例
 * - 每个实例首次请求时播种一次（幂等，flag 守护）
 * - 旧版本多患者演示数据由 cleanupLegacyDemoPatients 一次性清理（seeded_v3 flag 守护）
 */
const { randomUUID } = require('node:crypto');
const { getDb, K, dateStr, setNxEx, withLock } = require('./storage');
const { clientHashOf, hashPassword } = require('./auth');
const { calcBmi, riskStratify, LAB_FIELDS, labAbnormalKeys } = require('@flwb/shared');
const logger = require('./logger');

const DAY = 86400000;
const now = () => Date.now();

const DEFAULT_CONFIGS = {
  materials: [
    {
      id: 'edu_1',
      title: '脂肪肝饮食十大原则',
      summary: '适用于所有脂肪肝患者的日常饮食宣教',
      html: '<h3>脂肪肝饮食十大原则</h3><ol><li>控制总热量，每餐七分饱</li><li>主食粗细搭配，用全谷物替代1/3精米白面</li><li>限糖：少喝含糖饮料、果汁，警惕果糖</li><li>优选优质蛋白：鱼虾、鸡胸肉、豆制品</li><li>多吃蔬菜，每天500g以上</li><li>水果适量，每天200-350g，避免高糖水果过量</li><li>严格限酒，最好戒酒</li><li>少油炸、少烧烤，烹调以蒸煮炖为主</li><li>规律进餐，晚餐不过晚不过量</li><li>足量饮水，每天1500-1700ml</li></ol><p>坚持记录饮食，医生可基于数据为您调整方案。</p>'
    },
    {
      id: 'edu_2',
      title: '脂肪肝运动处方指南',
      summary: '中等强度有氧运动为主的运动干预方案',
      html: '<h3>脂肪肝运动处方</h3><p><b>频率：</b>每周至少5次</p><p><b>强度：</b>中等强度（运动时能说话但不能唱歌）</p><p><b>时间：</b>每次30-60分钟</p><p><b>方式：</b>快走、慢跑、游泳、骑行等有氧运动为主，每周可加2次抗阻训练。</p><p><b>提示：</b>减重的关键在于坚持，每周减重0.5-1kg为宜，切忌快速减重。</p>'
    },
    {
      id: 'edu_3',
      title: '酒精性肝病健康宣教',
      summary: '饮酒与肝损伤的关系及戒酒指导',
      html: '<h3>酒精与您的肝脏</h3><p>长期饮酒可导致酒精性脂肪肝→酒精性肝炎→肝硬化。对于脂肪肝患者，任何剂量的酒精都会加重肝损伤。</p><p><b>戒酒小贴士：</b></p><ul><li>设定明确的戒酒日期并告知家人</li><li>避免饮酒社交场合，以茶代酒</li><li>出现手抖、心慌等戒断反应请及时就医</li></ul>'
    }
  ],
  assessmentTemplate: {
    id: 'tpl_fld',
    name: '脂肪肝标准评估模板',
    version: 'V1.0',
    fields: [
      { key: 'drinking', label: '饮酒史', type: 'radio', options: ['无', '偶尔', '经常', '每日'] },
      { key: 'family', label: '家族史', type: 'radio', options: ['无', '有'] },
      { key: 'familyNote', label: '家族史说明', type: 'text', showIf: { key: 'family', eq: '有' } },
      { key: 'symptoms', label: '症状', type: 'checkbox', options: ['乏力', '右上腹胀痛', '纳差', '无'] },
      { key: 'comorbid', label: '合并症', type: 'checkbox', options: ['2型糖尿病', '高血压', '高脂血症', '无'] },
      { key: 'exerciseFreq', label: '每周运动次数（次/周）', type: 'number' },
      { key: 'dietHabit', label: '饮食习惯', type: 'radio', options: ['高脂高糖', '正常均衡', '清淡'] },
      { key: 'note', label: '备注', type: 'textarea' }
    ]
  },
  experts: [
    { id: 'e1', dept: '营养科', name: '王芳' },
    { id: 'e2', dept: '内分泌科', name: '刘强' },
    { id: 'e3', dept: '消化内科', name: '陈伟' },
    { id: 'e4', dept: '心内科', name: '赵磊' },
    { id: 'e5', dept: '康复科', name: '钱进' }
  ]
};

const PATIENT_SEEDS = [
  { id: 'p_1009', name: '王小明', gender: 'male', age: 42, height: 170, weight: 78, risk: 'mid', daysAgo: 3, dx: '非酒精性脂肪性肝病（中度）', cc: '体检发现脂肪肝2年', ph: '无特殊', followupOffset: 0, lastFollowupDaysAgo: 8, hasAccount: true }
];

/** 旧版本演示数据（v1/v2 多患者演示）的示例患者 ID，播种后一次性清理 */
const LEGACY_PIDS = ['p_1001', 'p_1002', 'p_1003', 'p_1004', 'p_1005', 'p_1006', 'p_1007', 'p_1008'];

const VITALS_PIDS = ['p_1009'];
const VITALS_DAYS = [28, 24, 20, 16, 12, 9, 6, 3, 1];

function buildVitals(pid, daysAgo, idx) {
  const base = {
    p_1009: { w: 79, sbp: 128, dbp: 82, glu: 6.0 }
  }[pid];
  const drop = idx * 0.25;
  const sbpAdj = (idx % 3) - 1;
  return {
    recordDate: dateStr(-daysAgo),
    weight: Math.round((base.w - drop) * 10) / 10,
    sbp: base.sbp + sbpAdj,
    dbp: base.dbp + (idx % 2),
    glucose: Math.round((base.glu - idx * 0.08) * 10) / 10,
    waist: null,
    height: null
  };
}

async function seedUsers(db, docId) {
  const clientHash = clientHashOf('123456');
  const passwordHash = await hashPassword(clientHash);
  const users = [
    { id: docId, username: 'GBMZ', phone: '', role: 'doctor', name: '郭明泽', title: '主任医师', dept: '肝病科', patientId: '' },
    { id: 'u_nurse_01', username: 'HULI01', phone: '', role: 'nurse', name: '李静', title: '主管护师', dept: '肝病科', patientId: '' },
    { id: 'u_p_1009', username: '13800000001', phone: '13800000001', role: 'patient', name: '王小明', title: '', dept: '', patientId: 'p_1009' }
  ];
  for (const u of users) {
    await db.hset(K.user(u.id), { ...u, passwordHash, createdAt: String(now()) });
    if (u.username) await db.set(K.usernameIdx(u.username), u.id);
    if (u.phone) await db.set(K.phoneIdx(u.phone), u.id);
  }
}

async function seedPatients(db, docId) {
  for (const s of PATIENT_SEEDS) {
    const bmi = calcBmi(s.weight, s.height);
    const p = {
      id: s.id,
      userId: s.hasAccount ? 'u_p_1009' : null,
      name: s.name,
      gender: s.gender,
      age: s.age,
      height: s.height,
      weight: s.weight,
      bmi,
      risk: s.risk,
      phone: s.hasAccount ? '13800000001' : '13' + String(800000000 + Math.abs(hashStr(s.id)) % 99999999),
      docId,
      nurseId: 'u_nurse_01',
      mainDiagnosis: s.dx,
      chiefComplaint: s.cc,
      pastHistory: s.ph,
      nextFollowupDate: s.followupOffset === null ? null : dateStr(s.followupOffset),
      lastFollowupAt: s.lastFollowupDaysAgo === null ? null : now() - s.lastFollowupDaysAgo * DAY,
      createdAt: now() - s.daysAgo * DAY,
      lastActivityAt: now() - s.daysAgo * DAY + 3600 * 1000,
      lastWeight: s.weight,
      version: 1
    };
    await db.set(K.patient(s.id), JSON.stringify(p));
    await db.zadd(K.docPatients(docId), p.lastActivityAt, s.id);
    await db.zadd(K.allPatients, p.lastActivityAt, s.id);
    await db.zadd(K.patientCreated(docId), p.createdAt, s.id);
  }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

async function seedRecords(db) {
  for (const pid of VITALS_PIDS) {
    VITALS_DAYS.forEach((d, idx) => {
      const v = buildVitals(pid, d, idx);
      const bmi = calcBmi(v.weight, PATIENT_SEEDS.find(p => p.id === pid).height);
      db.ts = now() - d * DAY;
      const record = {
        ...v,
        bmi,
        ts: now() - d * DAY + 8 * 3600 * 1000,
        patientId: pid,
        source: 'seed'
      };
      // 同步写入（种子阶段顺序执行）
      (async () => {
        await db.zadd(K.vitals(pid), record.ts, JSON.stringify(record));
      })();
    });
  }

  const diet = {
    patientId: 'p_1009',
    meal: 'lunch',
    recordDate: dateStr(0),
    recordTime: '12:20',
    foods: [{ name: '糙米饭', grams: 150 }, { name: '清蒸鲈鱼', grams: 120 }, { name: '西兰花', grams: 200 }],
    photoUrl: null,
    note: '少油少盐',
    ts: now() - 3 * 3600 * 1000,
    source: 'seed'
  };
  await db.lpush(K.diet('p_1009'), JSON.stringify(diet));

  const exercise = {
    patientId: 'p_1009',
    type: '快走',
    recordDate: dateStr(0),
    recordTime: '19:00',
    minutes: 40,
    intensity: 'mid',
    note: '',
    ts: now() - 1 * 3600 * 1000,
    source: 'seed'
  };
  await db.lpush(K.exercise('p_1009'), JSON.stringify(exercise));
}

async function seedMessagesAndPlans(db) {
  const today = dateStr(0);
  await db.set(K.followupDue(today), 'set-placeholder'); // 确保 key 存在语义（实际成员见下）
  await db.del(K.followupDue(today));
  for (const s of PATIENT_SEEDS) {
    if (s.followupOffset === 0) await db.sadd(K.followupDue(today), s.id);
  }

  // 复诊计划：p_1009（+3天）
  const plan1 = { patientId: 'p_1009', date: dateStr(3), place: '门诊楼3楼 肝病科诊室2', notes: '携带近1个月肝功能化验单', setAt: now() - 2 * DAY };
  await db.set(K.revisit('p_1009'), JSON.stringify(plan1));

  // 消息（患者端演示账号）
  await db.lpush(K.msg('u_p_1009'), JSON.stringify({
    mid: 'm_seed_edu', type: 'education', title: '【健康宣教】脂肪肝饮食十大原则',
    content: DEFAULT_CONFIGS.materials[0].html, ts: now() - 3 * DAY, read: false, from: '护士 李静'
  }));
  await db.lpush(K.msg('u_p_1009'), JSON.stringify({
    mid: 'm_seed_revisit', type: 'revisit_reminder', title: '复诊提醒',
    content: '您有一条复诊安排：请于 ' + plan1.date.replace('-', '年').replace('-', '月') + '日 前往 ' + plan1.place + ' 复诊。',
    payload: { patientId: 'p_1009' },
    ts: now() - 2 * DAY, read: false, from: '医生 郭明泽'
  }));
  await db.set(K.msgUnread('u_p_1009'), 2);
}

async function seedClinical(db, docId) {
  // 指导记录（示例患者 1 条，供护理模块演示）
  const g1 = { id: 'g_' + randomUUID().slice(0, 8), patientId: 'p_1009', nurseId: 'u_nurse_01', nurseName: '李静', method: '电话', category: '饮食指导', content: '患者当前体重78kg，BMI 27.0。已告知控制主食、戒含糖饮料，两周后电话随访体重变化。', feedback: '患者表示理解并能执行', ts: now() - 4 * DAY };
  await db.lpush(K.guidance('p_1009'), JSON.stringify(g1));
  await db.set(K.guidance('one_' + g1.id), JSON.stringify(g1));
  await db.zadd(K.guidanceIdx('u_nurse_01'), g1.ts, g1.id);

  // 宣教记录
  await db.lpush(K.eduLog('p_1009'), JSON.stringify({ materialId: 'edu_1', title: '脂肪肝饮食十大原则', nurseName: '李静', ts: now() - 3 * DAY }));
}

async function seedConfigs(db) {
  for (const [key, value] of Object.entries(DEFAULT_CONFIGS)) {
    const existing = await db.get(K.config(key));
    if (!existing) await db.set(K.config(key), JSON.stringify(value));
  }
}

/* ==================== v2：示例患者补充临床数据（检验/随访执行） ==================== */

async function seedClinicalV2(db, docId) {
  const flagKey = K.flag('seeded_v2');
  try { if (await db.get(flagKey)) return; } catch { /* ignore */ }
  const docName = '郭明泽';

  await withLock('seed_v2', 30, async () => {
    if (await db.get(flagKey)) return;

    /* 1) 检验记录（含异常值 → 驱动筛查/复查统计演示） */
    const record = {
      id: 'lab_seed_p_1009', ts: now() - 10 * DAY + 9 * 3600 * 1000,
      examDate: dateStr(-10), note: '', by: docName
    };
    for (const f of LAB_FIELDS) record[f.key] = { alt: 58, ast: 42, ggt: 55, tg: 1.9, fpg: 6.2 }[f.key] ?? null;
    record.abnormal = labAbnormalKeys(record);
    await db.zadd(K.labs('p_1009'), record.ts, JSON.stringify(record));

    /* 2) 随访执行记录（示例患者 1 条） */
    const rec = {
      id: 'fu_seed_p_1009', ts: now() - 5 * DAY, dueDate: dateStr(-13),
      method: '门诊', outcome: '体重78kg（-1kg），血压达标，已调整饮食方案', conclusion: '继续当前干预，1个月后复查肝功能', nextDate: dateStr(1), by: docName
    };
    await db.lpush(K.followupRec('p_1009'), JSON.stringify(rec));

    await setNxEx(flagKey, '1', 365 * 24 * 3600);
    logger.info('seed.v2.done', { labs: 1, followupRecs: 1 });
  }, 15000).catch(e => {
    if (String(e.message).includes('繁忙')) return; // 其他实例正在播种
    throw e;
  });
}

/* ==================== 旧版演示数据一次性清理（多患者示例 → 单示例） ==================== */

/**
 * 清理旧版本播种的 8 名示例患者（p_1001~p_1008）及其全部关联数据：
 * 患者档案/索引/体征/检验/专病病历/指导/档案动态/复诊计划/随访记录/筛查案例/预警/评估报告/MDT。
 * 真实注册患者（p_<uuid>）不受影响。seeded_v3 flag 守护，仅执行一次。
 */
async function cleanupLegacyDemoPatients(db) {
  const flagKey = K.flag('seeded_v3_cleanup');
  try { if (await db.get(flagKey)) return; } catch { /* ignore */ }

  await withLock('seed_v3_cleanup', 60, async () => {
    if (await db.get(flagKey)) return;

    const legacy = new Set(LEGACY_PIDS);
    let removed = 0;

    /* 1) 患者维度直接删除的 key */
    for (const pid of LEGACY_PIDS) {
      await db.del(
        K.patient(pid), K.vitals(pid), K.labs(pid), K.medrec(pid),
        K.guidance(pid), K.eduLog(pid), K.archive(pid), K.revisit(pid), K.followupRec(pid),
        K.screeningPid(pid) + ':open', K.reportIdxPatient(pid)
      );
      removed++;
    }

    /* 2) 患者索引（docPatients / allPatients / patientCreated）与唯一标识索引 */
    const rows = db._export();
    const delKeys = new Set();
    for (const r of rows.zsets) {
      if (legacy.has(r.member) && /^(patient:index:doc:|patient:index:all$|patient:created:doc:)/.test(r.key)) {
        await db.zrem(r.key, r.member);
      }
    }
    for (const r of rows.kv) {
      if (/^patient:index:(phone|idcard):/.test(r.key) && legacy.has(r.val)) delKeys.add(r.key);
    }

    /* 3) 筛查案例 / 预警 / 评估报告 / MDT：按文档 patientId 归属清理 */
    const DOC_PREFIX_ZREMS = [
      { prefix: 'screen:', zremKeys: [K.screeningIdx('u_doc_gbmz'), K.screeningAll] },
      { prefix: 'alert:', zremKeys: [K.alertIdx('u_doc_gbmz')] },
      { prefix: 'report:', zremKeys: [] },
      { prefix: 'mdt:', zremKeys: [K.mdtIdx('u_doc_gbmz')] }
    ];
    for (const { prefix, zremKeys } of DOC_PREFIX_ZREMS) {
      for (const r of rows.kv) {
        if (!r.key.startsWith(prefix)) continue;
        let doc = null;
        try { doc = JSON.parse(r.val); } catch { continue; }
        if (!doc || !legacy.has(doc.patientId)) continue;
        delKeys.add(r.key);
        for (const zk of zremKeys) await db.zrem(zk, r.key.slice(prefix.length));
        if (prefix === 'screen:' && doc.status === 'pending') await db.del(K.screeningPid(doc.patientId) + ':open');
        if (prefix === 'report:') { await db.zrem(K.reportIdxNurse(doc.nurseId || 'u_nurse_01'), r.key.slice(prefix.length)); }
      }
    }

    /* 4) 指导索引（按指导 id）与随访到期集合（followup:due:*） */
    for (const r of rows.kv) {
      if (r.key.startsWith('guidance:one_')) {
        let g = null; try { g = JSON.parse(r.val); } catch { continue; }
        if (g && legacy.has(g.patientId)) {
          delKeys.add(r.key);
          await db.zrem(K.guidanceIdx(g.nurseId || 'u_nurse_01'), r.key.slice('guidance:one_'.length));
        }
      }
    }
    for (const r of rows.sets) {
      if (r.key.startsWith('followup:due:') && legacy.has(r.member)) await db.srem(r.key, r.member);
    }

    /* 5) 预警未读计数重算 */
    const alertRows = [];
    for (const r of rows.kv) {
      if (!r.key.startsWith('alert:')) continue;
      let doc = null; try { doc = JSON.parse(r.val); } catch { continue; }
      if (doc && !legacy.has(doc.patientId)) alertRows.push(doc);
    }
    await db.set(K.alertUnread('u_doc_gbmz'), alertRows.filter(a => a.status === 'open').length);

    if (delKeys.size) await db.del(...delKeys);

    await setNxEx(flagKey, '1', 365 * 24 * 3600);
    logger.info('seed.v3.cleanup', { legacyPatients: removed });
    // 清理是一次重要写事件：立即上传云端快照，让其他实例尽快收敛
    try { require('./blob-snapshot').scheduleUpload(db, { force: true }); } catch { /* ignore */ }
  }, 20000).catch(e => {
    if (String(e.message).includes('繁忙')) return;
    throw e;
  });
}

let _seedPromise = null;

/** 每个 API 请求都会调用；首次执行播种，之后进程内直接返回 */
function ensureSeed() {
  if (!_seedPromise) {
    _seedPromise = runSeed().catch(e => {
      _seedPromise = null; // 失败允许重试
      logger.error('seed.fail', { message: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' | ') });
      throw e;
    });
  }
  return _seedPromise;
}

async function runSeed() {
  const db = await getDb();
  const docId = 'u_doc_gbmz';

  /* v1 基础数据（账号/示例患者/记录），未播种时执行 */
  const v1Flag = K.flag('seeded_v1');
  let v1Done = null;
  try { v1Done = await db.get(v1Flag); } catch { /* ignore */ }
  if (!v1Done) {
    try {
      await withLock('seed', 30, async () => {
        const done = await db.get(v1Flag);
        if (done) return;
        await seedConfigs(db);
        await seedUsers(db, docId);
        await seedPatients(db, docId);
        await seedRecords(db);
        await seedMessagesAndPlans(db);
        await seedClinical(db, docId);
        await setNxEx(v1Flag, '1', 365 * 24 * 3600);
        // 全新库无旧数据可清理，直接置 v3 flag，跳过清理步骤
        await setNxEx(K.flag('seeded_v3_cleanup'), '1', 365 * 24 * 3600);
        logger.info('seed.done', { patients: PATIENT_SEEDS.length });
        // 播种是一次重要写事件：立即上传云端快照，缩短其他实例的冷启动窗口
        try { require('./blob-snapshot').scheduleUpload(db, { force: true }); } catch { /* ignore */ }
      }, 15000);
    } catch (e) {
      if (String(e.message).includes('繁忙')) return; // 其他实例正在播种
      throw e;
    }
  } else {
    /* 老数据库（旧版多患者演示数据）→ 一次性清理多余示例 */
    await cleanupLegacyDemoPatients(db);
  }

  /* v2 示例患者补充临床数据（独立幂等；老数据也补充播种） */
  await seedClinicalV2(db, docId);
}

module.exports = { ensureSeed, DEFAULT_CONFIGS };
