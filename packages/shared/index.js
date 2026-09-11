'use strict';
/**
 * @flwb/shared — 前后端共享常量与医学数值校验规则
 * 单一数据源：前端表单提示、服务端 zod 校验均引用本包，保证契约一致。
 * UMD 双模式：CJS require（Serverless API）与 ESM import（Vite 前端）共用本文件。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const api = factory();
    module.exports = api;
    root.FLWB_SHARED = api; // 同时挂载，供 Node ESM 场景直读
  } else {
    root.FLWB_SHARED = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * 辅助检查（检验）字段定义 —— 单一数据源（结构化电子病历「六、辅助检查」）。
   * min/max 为医学合理范围（硬校验，超出即阻断提交）；
   * ref 为参考范围 [下限, 上限]，用于异常标记（超出参考范围不阻断，仅红标提示）。
   * group 用于前端分组渲染（肝功能/血糖/血脂/其他）。
   */
  const LAB_FIELDS = [
    { key: 'alt', label: 'ALT', fullName: '丙氨酸氨基转移酶', unit: 'U/L', group: '肝功能', min: 0, max: 5000, ref: [7, 40] },
    { key: 'ast', label: 'AST', fullName: '天冬氨酸氨基转移酶', unit: 'U/L', group: '肝功能', min: 0, max: 5000, ref: [13, 40] },
    { key: 'ggt', label: 'GGT', fullName: 'γ-谷氨酰转移酶', unit: 'U/L', group: '肝功能', min: 0, max: 5000, ref: [7, 50] },
    { key: 'alp', label: 'ALP', fullName: '碱性磷酸酶', unit: 'U/L', group: '肝功能', min: 0, max: 3000, ref: [35, 100] },
    { key: 'tbil', label: '总胆红素', fullName: '总胆红素', unit: 'μmol/L', group: '肝功能', min: 0, max: 500, ref: [3.4, 17.1] },
    { key: 'alb', label: '白蛋白', fullName: '白蛋白', unit: 'g/L', group: '肝功能', min: 0, max: 100, ref: [40, 55] },
    { key: 'fpg', label: '空腹血糖', fullName: '空腹血糖', unit: 'mmol/L', group: '血糖', min: 1, max: 40, ref: [3.9, 6.1] },
    { key: 'hba1c', label: '糖化血红蛋白', fullName: '糖化血红蛋白', unit: '%', group: '血糖', min: 3, max: 20, ref: [4.0, 6.0] },
    { key: 'tg', label: '甘油三酯', fullName: '甘油三酯', unit: 'mmol/L', group: '血脂', min: 0, max: 100, ref: [0.45, 1.7] },
    { key: 'tc', label: '总胆固醇', fullName: '总胆固醇', unit: 'mmol/L', group: '血脂', min: 0, max: 30, ref: [2.8, 5.2] },
    { key: 'ldl', label: 'LDL-C', fullName: '低密度脂蛋白胆固醇', unit: 'mmol/L', group: '血脂', min: 0, max: 30, ref: [0, 3.4] },
    { key: 'hdl', label: 'HDL-C', fullName: '高密度脂蛋白胆固醇', unit: 'mmol/L', group: '血脂', min: 0, max: 10, ref: [1.0, 1.6] },
    { key: 'ua', label: '尿酸', fullName: '尿酸', unit: 'μmol/L', group: '其他', min: 0, max: 2000, ref: [155, 428] },
    { key: 'plt', label: '血小板', fullName: '血小板计数', unit: '×10⁹/L', group: '其他', min: 0, max: 3000, ref: [125, 350] }
  ];
  const LAB_FIELDS_BY_KEY = Object.fromEntries(LAB_FIELDS.map(f => [f.key, f]));

  /** 医学合理范围（硬校验：超出即阻断提交）。检验部分 min/max 由 LAB_FIELDS 派生，保证单一数据源。 */
  const MED_RANGES = {
    weight: { min: 20, max: 300, unit: 'kg', label: '体重' },
    height: { min: 50, max: 250, unit: 'cm', label: '身高' },
    waist: { min: 30, max: 200, unit: 'cm', label: '腹围' },
    sbp: { min: 50, max: 300, unit: 'mmHg', label: '收缩压' },
    dbp: { min: 30, max: 200, unit: 'mmHg', label: '舒张压' },
    glucose: { min: 1, max: 40, unit: 'mmol/L', label: '空腹血糖' }
  };
  for (const f of LAB_FIELDS) {
    MED_RANGES[f.key] = { min: f.min, max: f.max, unit: f.unit, label: f.label };
  }

  /** 检验记录异常项：返回超出参考范围的字段 key 列表（前后端共用） */
  function labAbnormalKeys(record) {
    const out = [];
    for (const f of LAB_FIELDS) {
      const v = record[f.key];
      if (v === null || v === undefined || v === '') continue;
      const [lo, hi] = f.ref;
      if (Number(v) < lo || Number(v) > hi) out.push(f.key);
    }
    return out;
  }

  /** 建议关注阈值（软提醒：数据仍入库，仅提示医生/患者注意） */
  const ADVISORY = {
    sbp: { threshold: 140, label: '收缩压偏高' },
    dbp: { threshold: 90, label: '舒张压偏高' },
    glucose: { threshold: 6.1, label: '空腹血糖偏高' },
    bmi: { threshold: 28, label: 'BMI 达到肥胖标准' }
  };

  const ROLES = { PATIENT: 'patient', DOCTOR: 'doctor', NURSE: 'nurse' };
  const RISK_LEVELS = [
    { value: 'high', label: '高风险', color: '#f56c6c' },
    { value: 'mid', label: '中风险', color: '#e6a23c' },
    { value: 'low', label: '低风险', color: '#67c23a' }
  ];
  const RISK_LABELS = { high: '高风险', mid: '中风险', low: '低风险' };

  const MEALS = [
    { value: 'breakfast', label: '早餐' },
    { value: 'lunch', label: '午餐' },
    { value: 'dinner', label: '晚餐' },
    { value: 'snack', label: '加餐' }
  ];
  const MEAL_LABELS = Object.fromEntries(MEALS.map(m => [m.value, m.label]));

  const EXERCISE_TYPES = ['散步', '慢跑', '游泳', '骑行', '瑜伽', '力量训练', '球类运动', '其他'];
  const INTENSITIES = [
    { value: 'low', label: '低强度' },
    { value: 'mid', label: '中强度' },
    { value: 'high', label: '高强度' }
  ];
  const INTENSITY_LABELS = Object.fromEntries(INTENSITIES.map(i => [i.value, i.label]));

  const GUIDANCE_METHODS = ['电话', '面谈', '微信'];
  const GUIDANCE_CATEGORIES = ['饮食指导', '运动指导', '用药提醒', '心理支持', '复查督促'];
  const MDT_DEPTS = ['营养科', '内分泌科', '消化内科', '心内科', '康复科'];
  const MDT_STATUS = { PENDING: 'pending', FEEDBACK: 'feedback', DONE: 'done' };
  const MDT_STATUS_LABELS = { pending: '待专家反馈', feedback: '已反馈待归档', done: '已归档' };

  const MESSAGE_TYPES = {
    REVISIT: 'revisit_reminder',
    EDUCATION: 'education',
    FOLLOWUP: 'followup_remind'
  };

  /** 前端密码传输盐：sha256(password + '::' + CLIENT_SALT) 后传输，服务端再 bcrypt 存储 */
  const CLIENT_SALT = 'flwb::v1';

  function calcBmi(weightKg, heightCm) {
    if (!weightKg || !heightCm) return null;
    const h = heightCm / 100;
    return Math.round((weightKg / (h * h)) * 10) / 10;
  }

  /* ==================== 身份证 & 年龄工具（专病建档共用，前后端一致） ==================== */
  const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const ID_CARD_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

  /**
   * 身份证号校验：15 位（一代证）仅格式校验；18 位校验出生日期合法性 + GB11643 校验码
   * @returns {{ ok: boolean, msg: string }}
   */
  function validateIdCard(id) {
    const s = String(id || '').trim().toUpperCase();
    if (!/^\d{15}$/.test(s) && !/^\d{17}[\dX]$/.test(s)) return { ok: false, msg: '身份证号应为15或18位' };
    if (s.length === 15) return { ok: true, msg: '' };
    const y = Number(s.slice(6, 10)), m = Number(s.slice(10, 12)), d = Number(s.slice(12, 14));
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (y < 1900 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || dt.getTime() > Date.now()) {
      return { ok: false, msg: '身份证出生日期不合法' };
    }
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += Number(s[i]) * ID_CARD_WEIGHTS[i];
    if (ID_CARD_CHECK_CODES[sum % 11] !== s[17]) return { ok: false, msg: '身份证校验码不正确，请核对' };
    return { ok: true, msg: '' };
  }

  /** 从合法身份证解析出生日期（YYYY-MM-DD）与性别（male/female），不合法返回 null */
  function parseIdCard(id) {
    const s = String(id || '').trim().toUpperCase();
    if (!validateIdCard(s).ok) return null;
    if (s.length === 15) {
      return { birthDate: `19${s.slice(6, 8)}-${s.slice(8, 10)}-${s.slice(10, 12)}`, gender: Number(s[14]) % 2 === 1 ? 'male' : 'female' };
    }
    return { birthDate: `${s.slice(6, 10)}-${s.slice(10, 12)}-${s.slice(12, 14)}`, gender: Number(s[16]) % 2 === 1 ? 'male' : 'female' };
  }

  /** 按出生日期（YYYY-MM-DD）计算周岁（上海时区），不合法返回 null */
  function calcAge(birthDate) {
    if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
    const today = todayOfStr();
    let age = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
    if (today.slice(5) < birthDate.slice(5)) age -= 1; // MM-DD 未到生日减一
    return age >= 0 && age < 150 ? age : null;
  }

  /* ==================== 脂肪肝专病建档（结构化电子病历 · 单一数据源） ==================== */
  /** 选项枚举（信息化平台文档「脂肪肝患者结构化电子病历」） */
  const INSURANCE_TYPES = ['职工医保', '居民医保', '自费', '其他'];
  const SMOKING_HISTORY = ['从不', '已戒烟', '吸烟中'];
  const DRINKING_HISTORY = ['从不', '偶尔', '经常', '每日'];
  const DIET_HABITS = ['高脂', '高糖', '高碳水', '均衡', '其他'];
  const ACTIVITY_LEVELS = ['久坐', '轻度', '中度', '重度'];
  const YES_NO = ['是', '否'];
  const DISCOVERY_TYPES = ['有症状就诊', '无症状/体检发现'];
  const GENDER_OPTIONS = [
    { value: 'male', label: '男' },
    { value: 'female', label: '女' }
  ];

  /**
   * 专病建档表单定义：section → fields。
   * type: text|number|date|select|textarea|yesno|bp（收缩压/舒张压成对）
   * required: 服务端硬校验；-medical 专用，不影响患者端
   */
  const MEDICAL_RECORD_SECTIONS = [
    { key: 'basic', title: '一、患者基本信息', fields: [
      { key: 'name', label: '姓名', type: 'text', required: true, maxLen: 20 },
      { key: 'gender', label: '性别', type: 'select', options: GENDER_OPTIONS.map(g => g.value), optionLabels: GENDER_OPTIONS.map(g => g.label), required: true },
      { key: 'birthDate', label: '出生日期', type: 'date' },
      { key: 'idCard', label: '身份证号', type: 'text', maxLen: 18 },
      { key: 'phone', label: '联系电话', type: 'text', maxLen: 11 },
      { key: 'visitNumber', label: '门诊号', type: 'text', maxLen: 40 },
      { key: 'inpatientNumber', label: '住院号', type: 'text', maxLen: 40 },
      { key: 'visitDate', label: '就诊日期', type: 'date' },
      { key: 'visitDept', label: '就诊科室', type: 'text', maxLen: 30 },
      { key: 'insuranceType', label: '医保类型', type: 'select', options: INSURANCE_TYPES }
    ] },
    { key: 'screening', title: '二、筛查与风险评估', fields: [
      { key: 'height', label: '身高(cm)', type: 'number', range: 'height' },
      { key: 'weight', label: '体重(kg)', type: 'number', range: 'weight' },
      { key: 'bmi', label: 'BMI(kg/m²)', type: 'number', auto: true },
      { key: 'waist', label: '腰围(cm)', type: 'number', range: 'waist' },
      { key: 'sbp', label: '收缩压(mmHg)', type: 'number', range: 'sbp' },
      { key: 'dbp', label: '舒张压(mmHg)', type: 'number', range: 'dbp' },
      { key: 'smokingHistory', label: '吸烟史', type: 'select', options: SMOKING_HISTORY },
      { key: 'drinkingHistory', label: '饮酒史', type: 'select', options: DRINKING_HISTORY },
      { key: 'weeklyAlcoholGrams', label: '饮酒量(g/周)', type: 'number', min: 0, max: 5000 },
      { key: 'dietHabit', label: '饮食习惯', type: 'select', options: DIET_HABITS },
      { key: 'activityLevel', label: '体力活动情况', type: 'select', options: ACTIVITY_LEVELS }
    ] },
    { key: 'history', title: '三、主诉与现病史', fields: [
      { key: 'chiefComplaint', label: '主诉', type: 'textarea', maxLen: 200 },
      { key: 'presentIllness', label: '现病史（起病时间、诱因、主要症状、诊疗经过）', type: 'textarea', maxLen: 1000 },
      { key: 'discoveryType', label: '发现途径', type: 'select', options: DISCOVERY_TYPES }
    ] },
    { key: 'past', title: '四、既往史与合并症', fields: [
      { key: 't2dm', label: '2型糖尿病', type: 'yesno' },
      { key: 'hypertension', label: '高血压', type: 'yesno' },
      { key: 'dyslipidemia', label: '血脂异常', type: 'yesno' },
      { key: 'hyperuricemia', label: '高尿酸血症', type: 'yesno' },
      { key: 'metabolicSyndrome', label: '代谢综合征', type: 'yesno' },
      { key: 'cvd', label: '心血管疾病', type: 'yesno' },
      { key: 'otherChronic', label: '其他慢性病', type: 'text', maxLen: 200 },
      { key: 'medicationHistory', label: '用药史（降糖/降压/降脂等）', type: 'textarea', maxLen: 300 }
    ] },
    { key: 'physical', title: '五、体格检查', fields: [
      { key: 'skinSigns', label: '皮肤表现（蜘蛛痣、肝掌等）', type: 'textarea', maxLen: 300 },
      { key: 'abdominalExam', label: '腹部查体（肝脾触诊等）', type: 'textarea', maxLen: 300 }
    ] },
    { key: 'auxiliary', title: '六、辅助检查', fields: [
      { key: 'ultrasound', label: '肝脏超声', type: 'select', options: ['无异常', '轻度脂肪肝', '中度脂肪肝', '重度脂肪肝'] },
      { key: 'fibroScanCap', label: 'FibroScan CAP(dB/m)', type: 'number', min: 100, max: 400 },
      { key: 'fibroScanE', label: 'FibroScan 肝脏硬度值 E(kPa)', type: 'number', min: 1, max: 75 },
      { key: 'labExamDate', label: '检验检查日期', type: 'date' },
      ...LAB_FIELDS.map(f => ({ key: f.key, label: `${f.label}(${f.unit})`, type: 'number', range: f.key, group: f.group }))
    ] },
    { key: 'assessment', title: '七、分层风险评估与干预方案', fields: [
      { key: 'riskLevel', label: '风险分层（低/中/高风险）', type: 'select', options: ['low', 'mid', 'high'], optionLabels: ['低风险', '中风险', '高风险'], required: true },
      { key: 'riskReason', label: '分层依据/理由', type: 'textarea', maxLen: 500 },
      { key: 'interventionDiet', label: '干预方案-饮食', type: 'textarea', maxLen: 300 },
      { key: 'interventionExercise', label: '干预方案-运动', type: 'textarea', maxLen: 300 },
      { key: 'weightGoal', label: '减重目标(kg)', type: 'number', min: 0, max: 100 },
      { key: 'interventionMedication', label: '干预方案-药物', type: 'textarea', maxLen: 300 },
      { key: 'revisitPlan', label: '复查计划', type: 'textarea', maxLen: 300 },
      { key: 'nursingProblems', label: '护理评估-专科护理问题', type: 'textarea', maxLen: 500 },
      { key: 'healthEducation', label: '护理评估-健康宣教记录', type: 'textarea', maxLen: 500 }
    ] }
  ];

  /** 建档字段 key 白名单（服务端存储过滤） */
  const MEDICAL_RECORD_KEYS = MEDICAL_RECORD_SECTIONS.flatMap(s => s.fields.map(f => f.key));

  /**
   * 档案完整度评估（专病建档「建档待完善」判定，前后端共用）：
   * 关键信息或检验任一缺失 → 待完善。缺失项分组返回，供列表 tooltip 与保存提示。
   * @param {object|null} record 专病病历（未建档传 null → 视为不适用，complete=false 且 missing 为空）
   * @returns {{ complete: boolean, missing: Array<{ key: string, label: string }> }}
   */
  function recordCompleteness(record) {
    if (!record) return { complete: false, missing: [] };
    const has = (v) => v !== null && v !== undefined && v !== '';
    const RULES = [
      { key: 'bmi', label: '身高/体重（BMI）', ok: has(record.bmi) },
      { key: 'ultrasound', label: '肝脏超声', ok: has(record.ultrasound) },
      { key: 'liverLabs', label: '肝功能（ALT/AST/GGT 任一）', ok: has(record.alt) || has(record.ast) || has(record.ggt) },
      { key: 'glucoseLabs', label: '血糖（空腹血糖/糖化血红蛋白 任一）', ok: has(record.fpg) || has(record.hba1c) },
      { key: 'tg', label: '甘油三酯', ok: has(record.tg) }
    ];
    const missing = RULES.filter(r => !r.ok).map(({ key, label }) => ({ key, label }));
    return { complete: missing.length === 0, missing };
  }

  /* ==================== 筛查识别规则（信息化平台 · 模块1） ==================== */
  /** LIS 检验指标阈值规则（超出即触发筛查） */
  const SCREENING_LAB_RULES = [
    { key: 'alt', label: 'ALT', op: '>', threshold: 40 },
    { key: 'ast', label: 'AST', op: '>', threshold: 40 },
    { key: 'ggt', label: 'GGT', op: '>', threshold: 50 },
    { key: 'tg', label: '甘油三酯', op: '>=', threshold: 1.7 }
  ];
  /** BMI 阈值规则 */
  const SCREENING_BMI_RULES = [
    { key: 'bmi', label: 'BMI超重', op: '>=', threshold: 24 },
    { key: 'bmi', label: 'BMI肥胖', op: '>=', threshold: 28 }
  ];
  /** PACS 超声报告关键词规则 */
  const SCREENING_ULTRASOUND_KEYWORDS = ['脂肪肝', '肝脏脂肪变性', 'MASLD'];

  /**
   * 规则引擎：评估单份「检验/超声/基础数据」命中情况
   * @returns {{ hits: Array<{rule:string,detail:string,source:'lis'|'pacs'|'bmi'}>, positive: boolean }}
   */
  function evaluateScreening(input) {
    const hits = [];
    for (const r of SCREENING_LAB_RULES) {
      const v = input[r.key];
      if (v != null && Number(v) >= r.threshold) {
        hits.push({ rule: `${r.label}${r.op}${r.threshold}`, detail: `${r.label}=${v}${r.op}${r.threshold}`, source: 'lis' });
      }
    }
    const bmi = input.bmi ?? calcBmi(input.weight, input.height);
    if (bmi != null && Number(bmi) >= 28) {
      hits.push({ rule: 'BMI>=28（肥胖）', detail: `BMI=${bmi} 达肥胖标准`, source: 'bmi' });
    } else if (bmi != null && Number(bmi) >= 24) {
      hits.push({ rule: 'BMI>=24（超重）', detail: `BMI=${bmi} 达超重标准`, source: 'bmi' });
    }
    const text = String(input.ultrasoundText || input.ultrasound || '');
    for (const kw of SCREENING_ULTRASOUND_KEYWORDS) {
      if (text.includes(kw)) {
        hits.push({ rule: `超声关键词「${kw}」`, detail: `超声报告命中关键词「${kw}」`, source: 'pacs' });
        break;
      }
    }
    return { hits, positive: hits.length > 0 };
  }

  /* ==================== 风险分层（信息化平台 · 模块2） ==================== */
  /**
   * 综合风险分层：按代谢/肝酶/影像/合并症加权评分
   * @param {object} rec 建档记录（含 bmi、labs、合并症、超声等）
   * @returns {{ risk: 'low'|'mid'|'high', score: number, reasons: string[] }}
   */
  function riskStratify(rec = {}) {
    let score = 0;
    const reasons = [];
    const num = (v) => (v == null || v === '' ? null : Number(v));

    const bmi = num(rec.bmi ?? calcBmi(rec.weight, rec.height));
    if (bmi != null) {
      if (bmi >= 28) { score += 2; reasons.push(`BMI ${bmi}（肥胖）+2`); }
      else if (bmi >= 24) { score += 1; reasons.push(`BMI ${bmi}（超重）+1`); }
    }
    const waist = num(rec.waist);
    if (waist != null && ((rec.gender === 'male' && waist >= 90) || (rec.gender === 'female' && waist >= 85))) {
      score += 1; reasons.push(`腰围 ${waist}cm（中心性肥胖）+1`);
    }
    const enzyme = [];
    for (const k of ['alt', 'ast', 'ggt']) {
      const v = num(rec[k]);
      const f = LAB_FIELDS_BY_KEY[k];
      if (v != null && f && v > f.ref[1]) enzyme.push(`${f.label} ${v}↑`);
    }
    if (enzyme.length >= 2) { score += 2; reasons.push(`肝酶多项异常（${enzyme.join('、')}）+2`); }
    else if (enzyme.length === 1) { score += 1; reasons.push(`肝酶异常（${enzyme[0]}）+1`); }

    const fpg = num(rec.fpg); const hba1c = num(rec.hba1c);
    if ((fpg != null && fpg >= 6.1) || (hba1c != null && hba1c >= 6.0)) {
      score += 1; reasons.push(`血糖代谢异常（${fpg != null && fpg >= 6.1 ? `FPG ${fpg}` : `HbA1c ${hba1c}%`}）+1`);
    }
    const tg = num(rec.tg);
    if (tg != null && tg >= 1.7) { score += 1; reasons.push(`甘油三酯 ${tg}≥1.7 +1`); }

    const comorbid = [];
    for (const [k, label] of [['t2dm', '2型糖尿病'], ['hypertension', '高血压'], ['dyslipidemia', '血脂异常'], ['metabolicSyndrome', '代谢综合征']]) {
      if (rec[k] === '是') comorbid.push(label);
    }
    if (comorbid.length >= 2) { score += 2; reasons.push(`合并症≥2（${comorbid.join('、')}）+2`); }
    else if (comorbid.length === 1) { score += 1; reasons.push(`合并 ${comorbid[0]} +1`); }

    const us = rec.ultrasound || '';
    if (us.includes('重度')) { score += 3; reasons.push('超声示重度脂肪肝 +3'); }
    else if (us.includes('中度')) { score += 2; reasons.push('超声示中度脂肪肝 +2'); }
    else if (us.includes('轻度')) { score += 1; reasons.push('超声示轻度脂肪肝 +1'); }
    const fibroE = num(rec.fibroScanE);
    if (fibroE != null && fibroE >= 8) { score += 2; reasons.push(`FibroScan E ${fibroE}kPa≥8 +2`); }

    const risk = score >= 5 ? 'high' : score >= 3 ? 'mid' : 'low';
    return { risk, score, reasons };
  }

  /* ==================== 随访周期（信息化平台 · 模块4） ==================== */
  /** 按风险等级随访周期（月）：低 6-12 / 中 3-6 / 高 1-3 */
  const FOLLOWUP_CYCLES = { low: [6, 12], mid: [3, 6], high: [1, 3] };

  /** 按风险建议下次随访日期（取周期下限） */
  function suggestFollowupDate(risk, fromDateStr) {
    const base = fromDateStr || todayOfStr();
    const [minM] = FOLLOWUP_CYCLES[risk] || FOLLOWUP_CYCLES.mid;
    const d = new Date(base + 'T00:00:00+08:00');
    d.setMonth(d.getMonth() + minM);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function todayOfStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  }

  /** 随访计划状态判定 */
  const FOLLOWUP_STATUS = {
    LOST: 'lost', OVERDUE: 'overdue', TODAY: 'today', SOON_3D: 'soon3d', SCHEDULED: 'scheduled'
  };
  const FOLLOWUP_STATUS_LABELS = { lost: '已失访', overdue: '已逾期', today: '今日随访', soon3d: '3日内', scheduled: '已预约' };

  /**
   * 计算随访状态（按上海时区日期字符串比较）
   * @returns {{ status: string, daysLeft: number }} daysLeft = 距随访日天数（负数为已逾期）
   */
  function followupStatusOf(nextDate, todayStr, lostAt) {
    if (lostAt) return { status: FOLLOWUP_STATUS.LOST, daysLeft: null };
    if (!nextDate) return { status: null, daysLeft: null };
    const daysLeft = Math.round((new Date(nextDate + 'T00:00:00+08:00') - new Date(todayStr + 'T00:00:00+08:00')) / 86400000);
    if (daysLeft < 0) return { status: FOLLOWUP_STATUS.OVERDUE, daysLeft };
    if (daysLeft === 0) return { status: FOLLOWUP_STATUS.TODAY, daysLeft };
    if (daysLeft <= 3) return { status: FOLLOWUP_STATUS.SOON_3D, daysLeft };
    return { status: FOLLOWUP_STATUS.SCHEDULED, daysLeft };
  }

  /* ==================== 预警分级 ==================== */
  const ALERT_LEVELS = [
    { value: 'high', label: '高危', color: '#f56c6c' },
    { value: 'mid', label: '中危', color: '#e6a23c' },
    { value: 'low', label: '低危', color: '#e6a23c' }
  ];
  const ALERT_TYPES = {
    LAB_ABNORMAL: 'lab_abnormal',
    SCREENING_POSITIVE: 'screening_positive',
    HIGH_RISK_NO_MDT: 'high_risk_no_mdt',
    FOLLOWUP_OVERDUE: 'followup_overdue',
    VITALS_ABNORMAL: 'vitals_abnormal'
  };
  const ALERT_TYPE_LABELS = {
    lab_abnormal: '检验异常', screening_positive: '筛查阳性', high_risk_no_mdt: '高风险未会诊',
    followup_overdue: '随访逾期', vitals_abnormal: '指标异常'
  };

  /** 硬校验单个指标 @returns {{ ok: boolean, msg?: string }} */
  function checkMedicalRange(key, value) {
    const r = MED_RANGES[key];
    if (!r || value === null || value === undefined || value === '') return { ok: true };
    const v = Number(value);
    if (Number.isNaN(v)) return { ok: false, msg: `${r.label}必须为数字` };
    if (v < r.min || v > r.max) return { ok: false, msg: `${r.label}超出合理范围(${r.min}-${r.max}${r.unit})` };
    return { ok: true };
  }

  /** 软提醒（返回异常提示数组） */
  function checkAdvisory(vitals) {
    const warns = [];
    if (vitals.sbp != null && Number(vitals.sbp) >= ADVISORY.sbp.threshold) warns.push(ADVISORY.sbp.label);
    if (vitals.dbp != null && Number(vitals.dbp) >= ADVISORY.dbp.threshold) warns.push(ADVISORY.dbp.label);
    if (vitals.glucose != null && Number(vitals.glucose) >= ADVISORY.glucose.threshold) warns.push(ADVISORY.glucose.label);
    if (vitals.bmi != null && Number(vitals.bmi) >= ADVISORY.bmi.threshold) warns.push(ADVISORY.bmi.label);
    return warns;
  }

  return {
    MED_RANGES,
    LAB_FIELDS,
    LAB_FIELDS_BY_KEY,
    labAbnormalKeys,
    ADVISORY,
    ROLES,
    RISK_LEVELS,
    RISK_LABELS,
    MEALS,
    MEAL_LABELS,
    EXERCISE_TYPES,
    INTENSITIES,
    INTENSITY_LABELS,
    GUIDANCE_METHODS,
    GUIDANCE_CATEGORIES,
    MDT_DEPTS,
    MDT_STATUS,
    MDT_STATUS_LABELS,
    MESSAGE_TYPES,
    CLIENT_SALT,
    calcBmi,
    validateIdCard,
    parseIdCard,
    calcAge,
    checkMedicalRange,
    checkAdvisory,
    /* 专病建档 */
    INSURANCE_TYPES,
    SMOKING_HISTORY,
    DRINKING_HISTORY,
    DIET_HABITS,
    ACTIVITY_LEVELS,
    YES_NO,
    DISCOVERY_TYPES,
    GENDER_OPTIONS,
    MEDICAL_RECORD_SECTIONS,
    MEDICAL_RECORD_KEYS,
    recordCompleteness,
    /* 筛查识别 */
    SCREENING_LAB_RULES,
    SCREENING_BMI_RULES,
    SCREENING_ULTRASOUND_KEYWORDS,
    evaluateScreening,
    /* 风险分层 */
    riskStratify,
    /* 随访管理 */
    FOLLOWUP_CYCLES,
    suggestFollowupDate,
    FOLLOWUP_STATUS,
    FOLLOWUP_STATUS_LABELS,
    followupStatusOf,
    /* 预警 */
    ALERT_LEVELS,
    ALERT_TYPES,
    ALERT_TYPE_LABELS
  };
});
