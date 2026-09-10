'use strict';
/**
 * 演示数据播种（幂等）：确保一键部署后系统开箱可用
 * - 演示账号：医生 GBMZ / 护士 HULI01 / 患者 13800000001，密码均 123456
 * - 9 名模拟患者 + 近 30 天填报数据 + 消息/随访/MDT 样例
 * - Redis 模式下仅播种一次；内存模式每个实例播种一次
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
  { id: 'p_1001', name: '刘志强', gender: 'male', age: 45, height: 175, weight: 82, risk: 'high', daysAgo: 40, dx: '非酒精性脂肪性肝病（重度）', cc: '乏力、肝区不适2月', ph: '高血压5年，规律服用氨氯地平', followupOffset: 0, lastFollowupDaysAgo: 5 },
  { id: 'p_1002', name: '陈静', gender: 'female', age: 38, height: 162, weight: 68, risk: 'mid', daysAgo: 35, dx: '非酒精性脂肪性肝病（中度）', cc: '体检发现转氨酶升高1月', ph: '高脂血症2年', followupOffset: 2, lastFollowupDaysAgo: 12 },
  { id: 'p_1003', name: '王建国', gender: 'male', age: 52, height: 170, weight: 85, risk: 'high', daysAgo: 33, dx: '脂肪性肝炎', cc: '右上腹胀痛伴纳差1月', ph: '2型糖尿病8年', followupOffset: null, lastFollowupDaysAgo: 40 },
  { id: 'p_1004', name: '李秀英', gender: 'female', age: 60, height: 158, weight: 64, risk: 'mid', daysAgo: 25, dx: '非酒精性脂肪性肝病（中度）', cc: '体检发现脂肪肝', ph: '高血压10年', followupOffset: 14, lastFollowupDaysAgo: 20 },
  { id: 'p_1005', name: '张伟', gender: 'male', age: 33, height: 178, weight: 90, risk: 'low', daysAgo: 21, dx: '单纯性脂肪肝（轻度）', cc: '超声提示脂肪肝，无症状', ph: '无特殊', followupOffset: -10, lastFollowupDaysAgo: 45 },
  { id: 'p_1006', name: '赵丽', gender: 'female', age: 29, height: 165, weight: 58, risk: 'low', daysAgo: 18, dx: '单纯性脂肪肝（轻度）', cc: '体检发现脂肪肝', ph: '无特殊', followupOffset: 30, lastFollowupDaysAgo: null },
  { id: 'p_1007', name: '孙明', gender: 'male', age: 47, height: 172, weight: 78, risk: 'mid', daysAgo: 12, dx: '非酒精性脂肪性肝病（中度）', cc: '肝功能异常复查', ph: '高脂血症3年', followupOffset: 7, lastFollowupDaysAgo: 12 },
  { id: 'p_1008', name: '周涛', gender: 'male', age: 41, height: 180, weight: 95, risk: 'high', daysAgo: 6, dx: '脂肪性肝炎伴代谢综合征', cc: '乏力、转氨酶显著升高', ph: '2型糖尿病3年，高血压2年', followupOffset: 3, lastFollowupDaysAgo: null },
  { id: 'p_1009', name: '王小明', gender: 'male', age: 42, height: 170, weight: 78, risk: 'mid', daysAgo: 3, dx: '非酒精性脂肪性肝病（中度）', cc: '体检发现脂肪肝2年', ph: '无特殊', followupOffset: 0, lastFollowupDaysAgo: 8, hasAccount: true }
];

const VITALS_PIDS = ['p_1001', 'p_1002', 'p_1003', 'p_1005', 'p_1008', 'p_1009'];
const VITALS_DAYS = [28, 24, 20, 16, 12, 9, 6, 3, 1];

function buildVitals(pid, daysAgo, idx) {
  const base = {
    p_1001: { w: 84.5, sbp: 132, dbp: 86, glu: 5.6 },
    p_1002: { w: 69.5, sbp: 124, dbp: 80, glu: 5.2 },
    p_1003: { w: 87, sbp: 138, dbp: 88, glu: 7.2 },
    p_1005: { w: 92, sbp: 126, dbp: 82, glu: 5.8 },
    p_1008: { w: 96.5, sbp: 148, dbp: 95, glu: 8.4 },
    p_1009: { w: 79, sbp: 128, dbp: 82, glu: 6.0 }
  }[pid];
  const drop = idx * 0.25;
  const isLast = daysAgo === 1;
  const sbpAdj = isLast && pid === 'p_1008' ? 8 : (idx % 3) - 1;
  return {
    recordDate: dateStr(-daysAgo),
    weight: Math.round((base.w - drop) * 10) / 10,
    sbp: base.sbp + sbpAdj,
    dbp: base.dbp + (isLast && pid === 'p_1008' ? 3 : (idx % 2)),
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

  // 复诊计划：p_1007（+5天，已发送提醒）、p_1002（+3天）
  const plan1 = { patientId: 'p_1007', date: dateStr(5), place: '门诊楼3楼 肝病科诊室2', notes: '携带近1个月肝功能化验单', setAt: now() - 2 * DAY };
  const plan2 = { patientId: 'p_1002', date: dateStr(3), place: '门诊楼3楼 肝病科诊室1', notes: '空腹前来复查血脂', setAt: now() - 1 * DAY };
  await db.set(K.revisit('p_1007'), JSON.stringify(plan1));
  await db.set(K.revisit('p_1002'), JSON.stringify(plan2));

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
  // 指导记录
  const g1 = { id: 'g_' + randomUUID().slice(0, 8), patientId: 'p_1001', nurseId: 'u_nurse_01', nurseName: '李静', method: '电话', category: '饮食指导', content: '患者当前体重82kg，BMI 26.8。已告知每日主食减半、戒含糖饮料，两周后电话随访体重变化。', feedback: '患者表示理解并能执行', ts: now() - 4 * DAY };
  const g2 = { id: 'g_' + randomUUID().slice(0, 8), patientId: 'p_1003', nurseId: 'u_nurse_01', nurseName: '李静', method: '微信', category: '运动指导', content: '结合患者糖尿病史，制定餐后快走30分钟方案，每周5次，避免空腹运动。', feedback: '', ts: now() - 2 * DAY };
  await db.lpush(K.guidance('p_1001'), JSON.stringify(g1));
  await db.lpush(K.guidance('p_1003'), JSON.stringify(g2));
  await db.set(K.guidance('one_' + g1.id), JSON.stringify(g1));
  await db.set(K.guidance('one_' + g2.id), JSON.stringify(g2));
  await db.zadd(K.guidanceIdx('u_nurse_01'), g2.ts, g2.id);
  await db.zadd(K.guidanceIdx('u_nurse_01'), g1.ts, g1.id);

  // 宣教记录
  await db.lpush(K.eduLog('p_1009'), JSON.stringify({ materialId: 'edu_1', title: '脂肪肝饮食十大原则', nurseName: '李静', ts: now() - 3 * DAY }));

  // MDT 已归档样例（p_1003）
  const mdt = {
    id: 'mdt_' + randomUUID().slice(0, 10),
    patientId: 'p_1003',
    patientName: '王建国',
    docId,
    docName: '郭明泽',
    reason: '脂肪性肝炎合并2型糖尿病，血糖控制不佳，肝功能持续异常，需营养科与内分泌科协同制定干预方案。',
    specialists: [{ dept: '营养科', expert: '王芳' }, { dept: '内分泌科', expert: '刘强' }],
    feedbacks: [
      { dept: '营养科', expert: '王芳', opinion: '建议低碳水化合物饮食模式，每日热量摄入减少500kcal，补充维生素E。', ts: now() - 18 * DAY },
      { dept: '内分泌科', expert: '刘强', opinion: '调整二甲双胍剂量至0.5g tid，联用SGLT-2抑制剂，2周后复查血糖谱。', ts: now() - 17 * DAY }
    ],
    conclusion: '同意调整降糖方案并启动低碳水饮食干预，4周后评估肝功能与糖化血红蛋白，必要时考虑保肝药物治疗。',
    status: 'done',
    createdAt: now() - 20 * DAY
  };
  await db.set(K.mdt(mdt.id), JSON.stringify(mdt));
  await db.zadd(K.mdtIdx(docId), mdt.createdAt, mdt.id);
  await db.lpush(K.archive('p_1003'), JSON.stringify({
    id: 'ar_seed_mdt', type: 'mdt', title: 'MDT会诊结论', summary: mdt.conclusion, ts: now() - 16 * DAY
  }));

  // 评估报告样例（p_1002）
  const report = {
    id: 'rpt_' + randomUUID().slice(0, 10),
    patientId: 'p_1002',
    patientName: '陈静',
    templateId: 'tpl_fld',
    templateName: '脂肪肝标准评估模板',
    nurseId: 'u_nurse_01',
    nurseName: '李静',
    answers: { drinking: '偶尔', family: '有', familyNote: '父亲脂肪肝', symptoms: ['乏力'], comorbid: ['高脂血症'], exerciseFreq: 2, dietHabit: '高脂高糖', note: '' },
    createdAt: now() - 6 * DAY
  };
  await db.set(K.report(report.id), JSON.stringify(report));
  await db.zadd(K.reportIdxPatient('p_1002'), report.createdAt, report.id);
  await db.zadd(K.reportIdxNurse('u_nurse_01'), report.createdAt, report.id);
}

async function seedConfigs(db) {
  for (const [key, value] of Object.entries(DEFAULT_CONFIGS)) {
    const existing = await db.get(K.config(key));
    if (!existing) await db.set(K.config(key), JSON.stringify(value));
  }
}

/* ==================== v2：医生端临床演示数据（专病建档/筛查/预警/随访执行/检验） ==================== */

/** 演示专病档案配置（pid → 差异字段） */
const MEDREC_SEEDS = {
  p_1001: {
    ultrasound: '重度脂肪肝', fibroScanCap: 320, fibroScanE: 9.2, waist: 98, sbp: 134, dbp: 86,
    alt: 86, ast: 62, ggt: 95, tg: 2.8, fpg: 5.9,
    t2dm: '否', hypertension: '是', dyslipidemia: '是', hyperuricemia: '否', metabolicSyndrome: '是', cvd: '否',
    dietHabit: '高脂', activityLevel: '久坐', smokingHistory: '已戒烟', drinkingHistory: '偶尔', weeklyAlcoholGrams: 20,
    chiefComplaint: '乏力、肝区不适2月', presentIllness: '2月前无明显诱因出现乏力伴肝区隐痛，体检超声示重度脂肪肝，肝功能异常。'
  },
  p_1002: {
    ultrasound: '中度脂肪肝', fibroScanCap: 285, fibroScanE: 7.1, waist: 86, sbp: 124, dbp: 80,
    alt: 68, ast: 45, ggt: 62, tg: 2.1, fpg: 5.3,
    t2dm: '否', hypertension: '否', dyslipidemia: '是', hyperuricemia: '否', metabolicSyndrome: '否', cvd: '否',
    dietHabit: '高糖', activityLevel: '轻度', smokingHistory: '从不', drinkingHistory: '从不', weeklyAlcoholGrams: 0,
    chiefComplaint: '体检发现转氨酶升高1月', presentIllness: '1月前体检发现ALT升高，超声示中度脂肪肝，无特殊不适。'
  },
  p_1005: {
    ultrasound: '轻度脂肪肝', fibroScanCap: 245, fibroScanE: 5.2, waist: 95, sbp: 126, dbp: 82,
    alt: 38, ast: 30, ggt: 42, tg: 1.6, fpg: 5.1,
    t2dm: '否', hypertension: '否', dyslipidemia: '否', hyperuricemia: '否', metabolicSyndrome: '否', cvd: '否',
    dietHabit: '高脂', activityLevel: '久坐', smokingHistory: '吸烟中', drinkingHistory: '经常', weeklyAlcoholGrams: 140,
    chiefComplaint: '超声提示脂肪肝，无症状', presentIllness: '单位体检超声示轻度脂肪肝，肝功能正常，无不适。'
  }
};

const RISK_LABELS = { high: '高', mid: '中', low: '低' };
const YN = (v) => (v ? '是' : '否');

async function seedClinicalV2(db, docId) {
  const flagKey = K.flag('seeded_v2');
  try { if (await db.get(flagKey)) return; } catch { /* ignore */ }
  const docName = '郭明泽';

  await withLock('seed_v2', 30, async () => {
    if (await db.get(flagKey)) return;

    /* 1) 专病建档：p_1001（高）/ p_1002（中）/ p_1005（低） */
    for (const [pid, extra] of Object.entries(MEDREC_SEEDS)) {
      const s = PATIENT_SEEDS.find(x => x.id === pid);
      const bmi = calcBmi(s.weight, s.height);
      const rec = {
        patientId: pid, createdBy: docId, createdByName: docName,
        createdAt: now() - (s.daysAgo - 1) * DAY, updatedAt: now() - (s.daysAgo - 1) * DAY, version: 1,
        name: s.name, gender: s.gender, birthDate: null, idCard: '', phone: '',
        visitNumber: 'V2026' + String(1000 + Math.abs(hashStr(pid)) % 8999), visitDate: dateStr(-(s.daysAgo - 1)), visitDept: '肝病科', insuranceType: '职工医保',
        height: s.height, weight: s.weight, waist: extra.waist, sbp: extra.sbp, dbp: extra.dbp,
        smokingHistory: extra.smokingHistory, drinkingHistory: extra.drinkingHistory, weeklyAlcoholGrams: extra.weeklyAlcoholGrams,
        dietHabit: extra.dietHabit, activityLevel: extra.activityLevel,
        chiefComplaint: extra.chiefComplaint, presentIllness: extra.presentIllness, discoveryType: '无症状/体检发现',
        t2dm: YN(extra.t2dm === '是'), hypertension: YN(extra.hypertension === '是'), dyslipidemia: YN(extra.dyslipidemia === '是'),
        hyperuricemia: YN(extra.hyperuricemia === '是'), metabolicSyndrome: YN(extra.metabolicSyndrome === '是'), cvd: YN(extra.cvd === '是'),
        otherChronic: '', medicationHistory: s.ph, skinSigns: '', abdominalExam: '腹软，无压痛，肝脾肋下未及',
        ultrasound: extra.ultrasound, fibroScanCap: extra.fibroScanCap, fibroScanE: extra.fibroScanE,
        riskLevel: s.risk, riskReason: '', interventionDiet: '控制总热量，戒含糖饮料，主食粗细搭配', interventionExercise: '每周5次中等强度有氧运动，每次30-60分钟',
        weightGoal: Math.round((s.weight * 0.9) * 10) / 10, interventionMedication: '', revisitPlan: '', nursingProblems: '', healthEducation: '已宣教脂肪肝饮食十大原则与运动处方',
        bmi
      };
      for (const f of LAB_FIELDS) rec[f.key] = extra[f.key] ?? null;
      const strat = riskStratify(rec);
      rec.riskScore = strat.score;
      rec.riskModelReasons = strat.reasons;
      rec.riskStratifiedAt = rec.createdAt;
      rec.riskStratifiedBy = docName;
      rec.riskReason = `模型评分 ${strat.score} 分（${strat.risk === 'high' ? '高' : strat.risk === 'mid' ? '中' : '低'}危）：${strat.reasons.slice(0, 3).join('；')}`;

      await db.set(K.medrec(pid), JSON.stringify(rec));
      const praw = await db.get(K.patient(pid));
      if (praw) {
        const p = typeof praw === 'string' ? JSON.parse(praw) : praw;
        p.archivedAt = rec.createdAt;
        p.medicalRecordId = pid;
        p.mainDiagnosis = p.mainDiagnosis || '脂肪肝（专病建档）';
        await db.set(K.patient(pid), JSON.stringify(p));
      }
      await db.lpush(K.archive(pid), JSON.stringify({
        id: 'ar_seed_mr_' + pid, ts: rec.createdAt, kind: 'archive', type: 'medical_record',
        title: `脂肪肝专病建档（v1）`, summary: `风险分层：${RISK_LABELS[s.risk]}风险（评分${strat.score}）；建档医生：${docName}`, by: docName
      }));
    }

    /* 2) 检验记录（含异常值 → 驱动筛查/复查统计） */
    const LAB_SEEDS = [
      { pid: 'p_1001', daysAgo: 30, vals: { alt: 92, ast: 66, ggt: 102, tg: 3.0, fpg: 5.8, hdl: 0.9 } },
      { pid: 'p_1001', daysAgo: 8, vals: { alt: 86, ast: 62, ggt: 95, tg: 2.8, fpg: 5.9, hdl: 0.92 } },
      { pid: 'p_1002', daysAgo: 25, vals: { alt: 74, ast: 48, ggt: 66, tg: 2.3, fpg: 5.2 } },
      { pid: 'p_1003', daysAgo: 20, vals: { alt: 118, ast: 90, ggt: 128, tg: 3.4, fpg: 7.6, hba1c: 8.2 } },
      { pid: 'p_1008', daysAgo: 5, vals: { alt: 156, ast: 132, ggt: 180, tg: 4.6, fpg: 9.1, hba1c: 9.4 } },
      { pid: 'p_1009', daysAgo: 10, vals: { alt: 58, ast: 42, ggt: 55, tg: 1.9, fpg: 6.2 } }
    ];
    for (const x of LAB_SEEDS) {
      const record = {
        id: 'lab_seed_' + x.pid + '_' + x.daysAgo, ts: now() - x.daysAgo * DAY + 9 * 3600 * 1000,
        examDate: dateStr(-x.daysAgo), note: '', by: docName
      };
      for (const f of LAB_FIELDS) record[f.key] = x.vals[f.key] ?? null;
      record.abnormal = labAbnormalKeys(record);
      await db.zadd(K.labs(x.pid), record.ts, JSON.stringify(record));
    }

    /* 3) 筛查案例：p_1005 待处理（BMI超重+超声）/ p_1008 待处理（检验+肥胖）/ p_1003 已纳入 */
    const SC_SEEDS = [
      {
        id: 'sc_seed_1005', pid: 'p_1005', status: 'pending', source: 'scan', daysAgo: 2, suggestedRisk: 'mid',
        evidence: [
          { rule: 'BMI>=24（超重）', detail: `BMI=${calcBmi(90, 178)} 达超重标准`, source: 'bmi', ts: now() - 2 * DAY },
          { rule: '超声关键词「脂肪肝」', detail: '超声报告命中关键词「脂肪肝」', source: 'pacs', ts: now() - 2 * DAY }
        ]
      },
      {
        id: 'sc_seed_1008', pid: 'p_1008', status: 'pending', source: 'lis', daysAgo: 1, suggestedRisk: 'high',
        evidence: [
          { rule: 'ALT>40', detail: 'ALT=156>40', source: 'lis', ts: now() - 1 * DAY },
          { rule: 'AST>40', detail: 'AST=132>40', source: 'lis', ts: now() - 1 * DAY },
          { rule: 'BMI>=28（肥胖）', detail: `BMI=${calcBmi(95, 180)} 达肥胖标准`, source: 'bmi', ts: now() - 1 * DAY }
        ]
      },
      {
        id: 'sc_seed_1003', pid: 'p_1003', status: 'accepted', source: 'scan', daysAgo: 15, suggestedRisk: 'high',
        decisionNote: '脂肪性肝炎合并2型糖尿病，纳入强化管理', decidedBy: docName,
        evidence: [
          { rule: 'ALT>40', detail: 'ALT=118>40', source: 'lis', ts: now() - 15 * DAY },
          { rule: 'BMI>=28（肥胖）', detail: `BMI=${calcBmi(85, 170)} 达肥胖标准`, source: 'bmi', ts: now() - 15 * DAY }
        ]
      }
    ];
    for (const c of SC_SEEDS) {
      const s = PATIENT_SEEDS.find(x => x.id === c.pid);
      const doc = {
        id: c.id, patientId: c.pid, patientName: s.name, phone: '', docId,
        source: c.source, evidence: c.evidence, suggestedRisk: c.suggestedRisk,
        status: c.status, decisionNote: c.decisionNote || null,
        decidedBy: c.decidedBy || null, decidedAt: c.status === 'accepted' ? now() - (c.daysAgo - 1) * DAY : null,
        ts: now() - c.daysAgo * DAY
      };
      await db.set(K.screening(c.id), JSON.stringify(doc));
      await db.zadd(K.screeningIdx(docId), doc.ts, c.id);
      await db.zadd(K.screeningAll, doc.ts, c.id);
      if (c.status === 'pending') await db.set(K.screeningPid(c.pid) + ':open', c.id);
    }

    /* 4) 预警提醒：2条未处理 + 1条已处理 */
    const ALERT_SEEDS = [
      {
        id: 'al_seed_1', pid: 'p_1008', level: 'high', type: 'lab_abnormal', daysAgo: 1, status: 'open',
        title: '检验异常筛查阳性：周涛', content: '新检验记录命中 3 项筛查规则（ALT>40、AST>40、GGT>50），建议复核纳入管理。', link: '/screening'
      },
      {
        id: 'al_seed_2', pid: 'p_1005', level: 'mid', type: 'followup_overdue', daysAgo: 1, status: 'open',
        title: '随访逾期：张伟', content: '患者 张伟 的随访（原定 ' + dateStr(-10) + '）已逾期，请尽快电话随访或标记失访。', link: '/followup'
      },
      {
        id: 'al_seed_3', pid: 'p_1001', level: 'high', type: 'high_risk_no_mdt', daysAgo: 6, status: 'handled',
        title: '高风险患者建议 MDT 会诊：刘志强', content: '专病建档风险分层为高危。建议发起营养科/内分泌科多学科会诊。',
        link: '/patients/p_1001', handlerNote: '已电话联系患者，下周安排 MDT', handledBy: docName
      }
    ];
    for (const a of ALERT_SEEDS) {
      const s = PATIENT_SEEDS.find(x => x.id === a.pid);
      const doc = {
        id: a.id, docId, patientId: a.pid, patientName: s.name, level: a.level, type: a.type,
        title: a.title, content: a.content, link: a.link, status: a.status,
        handlerNote: a.handlerNote || null, handledBy: a.handledBy || null,
        handledAt: a.status === 'handled' ? now() - (a.daysAgo - 1) * DAY : null,
        ts: now() - a.daysAgo * DAY, count: 1
      };
      await db.set(K.alert(a.id), JSON.stringify(doc));
      await db.zadd(K.alertIdx(docId), doc.ts, a.id);
    }
    await db.set(K.alertUnread(docId), ALERT_SEEDS.filter(a => a.status === 'open').length);

    /* 5) 随访执行记录：p_1001（5天前）/ p_1002（12天前） */
    const FU_SEEDS = [
      { pid: 'p_1001', daysAgo: 5, dueDaysAgo: 35, method: '门诊', outcome: '体重82kg（-2.5kg），血压达标，已调整饮食方案', conclusion: '继续当前干预，1个月后复查肝功能', nextOffset: 1 },
      { pid: 'p_1002', daysAgo: 12, dueDaysAgo: 23, method: '电话', outcome: '自述执行饮食运动方案良好，体重68kg（-1kg）', conclusion: '3个月后复查血脂与肝脏超声', nextOffset: 2 }
    ];
    for (const f of FU_SEEDS) {
      const rec = {
        id: 'fu_seed_' + f.pid, ts: now() - f.daysAgo * DAY, dueDate: dateStr(-f.dueDaysAgo),
        method: f.method, outcome: f.outcome, conclusion: f.conclusion, nextDate: dateStr(f.nextOffset), by: docName
      };
      await db.lpush(K.followupRec(f.pid), JSON.stringify(rec));
    }

    await setNxEx(flagKey, '1', 365 * 24 * 3600);
    logger.info('seed.v2.done', { medrecs: Object.keys(MEDREC_SEEDS).length, screenings: SC_SEEDS.length, alerts: ALERT_SEEDS.length });
  }, 15000).catch(e => {
    if (String(e.message).includes('繁忙')) return; // 其他实例正在播种
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

  /* v1 基础数据（账号/患者/记录），未播种时执行 */
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
        logger.info('seed.done', { patients: PATIENT_SEEDS.length });
      }, 15000);
    } catch (e) {
      if (String(e.message).includes('繁忙')) return; // 其他实例正在播种
      throw e;
    }
  }

  /* v2 医生端临床演示数据（独立幂等；老数据也补充播种） */
  await seedClinicalV2(db, docId);
}

module.exports = { ensureSeed, DEFAULT_CONFIGS };
