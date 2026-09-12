'use strict';
/** zod 全量白名单校验 + 医学范围校验映射为 422 */
const { z } = require('zod');
const { ApiError } = require('./response');
const {
  MEALS, EXERCISE_TYPES, INTENSITIES, GUIDANCE_METHODS, GUIDANCE_CATEGORIES, MED_RANGES, LAB_FIELDS,
  INSURANCE_TYPES, SMOKING_HISTORY, DRINKING_HISTORY, DIET_HABITS, ACTIVITY_LEVELS, YES_NO, DISCOVERY_TYPES,
  validateIdCard
} = require('@flwb/shared');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:mm');

const numInRange = (key) => {
  const r = MED_RANGES[key];
  return z.number({ invalid_type_error: `${r.label}必须为数字` })
    .min(r.min, `${r.label}超出合理范围(${r.min}-${r.max}${r.unit})`)
    .max(r.max, `${r.label}超出合理范围(${r.min}-${r.max}${r.unit})`);
};

const dietSchema = z.object({
  meal: z.enum(MEALS.map(m => m.value), { errorMap: () => ({ message: '用餐时段不合法' }) }),
  recordDate: dateStr,
  recordTime: timeStr.optional(),
  foods: z.array(z.object({
    name: z.string().trim().min(1, '食物名称不能为空').max(50),
    grams: z.number({ invalid_type_error: '估算量必须为数字' }).min(1, '估算量至少1克').max(5000, '估算量不能超过5000克')
  })).min(1, '至少记录一种食物').max(20),
  photoUrl: z.string().max(1024 * 1024).optional().nullable(),
  note: z.string().max(200).optional().nullable()
});

const exerciseSchema = z.object({
  type: z.string().refine(v => EXERCISE_TYPES.includes(v), '运动类型不合法'),
  recordDate: dateStr,
  recordTime: timeStr.optional(),
  minutes: z.number({ invalid_type_error: '时长必须为数字' }).int('时长必须为整数').min(1, '时长至少1分钟').max(600, '单次时长不能超过600分钟'),
  intensity: z.enum(INTENSITIES.map(i => i.value), { errorMap: () => ({ message: '强度不合法' }) }),
  note: z.string().max(200).optional().nullable()
});

const vitalsSchema = z.object({
  recordDate: dateStr,
  weight: numInRange('weight').optional().nullable(),
  height: numInRange('height').optional().nullable(),
  waist: numInRange('waist').optional().nullable(),
  sbp: numInRange('sbp').optional().nullable(),
  dbp: numInRange('dbp').optional().nullable(),
  glucose: numInRange('glucose').optional().nullable()
}).superRefine((val, ctx) => {
  const hasAny = ['weight', 'height', 'waist', 'sbp', 'dbp', 'glucose'].some(k => val[k] !== null && val[k] !== undefined);
  if (!hasAny) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少填写一项指标' });
  if (val.sbp != null && val.dbp != null && Number(val.sbp) <= Number(val.dbp)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '收缩压应大于舒张压' });
  }
});

/**
 * 辅助检查（检验）录入：14项检验指标（LAB_FIELDS 派生）+ 检查日期 + 备注。
 * superRefine 保证至少填写一项；各指标硬校验医学合理范围（MED_RANGES）。
 */
const labsShape = { examDate: dateStr, note: z.string().max(200).optional().nullable() };
for (const f of LAB_FIELDS) {
  labsShape[f.key] = numInRange(f.key).optional().nullable();
}
const labsSchema = z.object(labsShape).superRefine((val, ctx) => {
  const hasAny = LAB_FIELDS.some(f => val[f.key] !== null && val[f.key] !== undefined);
  if (!hasAny) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少填写一项检验指标' });
});

const followupSchema = z.object({
  date: dateStr,
  note: z.string().max(200).optional().nullable(),
  version: z.number().int().optional()
});

const batchFollowupSchema = z.object({
  patientIds: z.array(z.string()).min(1, '请选择患者').max(100),
  date: dateStr,
  note: z.string().max(200).optional().nullable()
});

const revisitSchema = z.object({
  date: dateStr,
  place: z.string().trim().min(1, '请填写复诊地点').max(100),
  notes: z.string().max(300).optional().nullable(),
  version: z.number().int().optional()
});

const mdtInitiateSchema = z.object({
  action: z.literal('initiate'),
  reason: z.string().trim().min(5, '会诊理由至少5个字').max(500),
  specialists: z.array(z.object({
    dept: z.string().min(1).max(20),
    expert: z.string().min(1).max(30)
  })).min(1, '请至少邀请一位专家').max(5)
});
const mdtFeedbackSchema = z.object({
  action: z.literal('feedback'),
  mdtId: z.string().min(1),
  dept: z.string().min(1).max(20),
  expert: z.string().min(1).max(30),
  opinion: z.string().trim().min(5, '反馈意见至少5个字').max(2000)
});
const mdtArchiveSchema = z.object({
  action: z.literal('archive'),
  mdtId: z.string().min(1),
  conclusion: z.string().trim().min(5, '会诊结论至少5个字').max(2000)
});
const mdtSchema = z.discriminatedUnion('action', [mdtInitiateSchema, mdtFeedbackSchema, mdtArchiveSchema]);

const educationPushSchema = z.object({
  patientIds: z.array(z.string()).min(1, '请选择患者').max(50),
  materialId: z.string().min(1, '请选择宣教素材'),
  note: z.string().max(200).optional().nullable()
});

const guidanceSchema = z.object({
  patientId: z.string().min(1, '请选择患者'),
  method: z.enum(GUIDANCE_METHODS, { errorMap: () => ({ message: '指导方式不合法' }) }),
  category: z.enum(GUIDANCE_CATEGORIES, { errorMap: () => ({ message: '指导分类不合法' }) }),
  content: z.string().trim().min(5, '指导内容至少5个字').max(1000),
  feedback: z.string().max(500).optional().nullable()
});

const assessmentSubmitSchema = z.object({
  patientId: z.string().min(1, '请选择患者'),
  templateId: z.string().min(1).optional(),
  answers: z.record(z.any())
});

const uploadSchema = z.object({
  filename: z.string().min(1).max(200),
  dataUrl: z.string().min(20).max(7 * 1024 * 1024, '文件过大（最大5MB）')
});

const loginSchema = z.object({
  mode: z.enum(['password', 'sms', 'register']),
  username: z.string().max(50).optional(),
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确').optional(),
  passwordHash: z.string().min(32).max(128).optional(),
  code: z.string().min(4).max(6).optional(),
  profile: z.object({
    name: z.string().trim().min(1, '请填写姓名').max(20),
    gender: z.enum(['male', 'female']),
    age: z.number({ invalid_type_error: '年龄必须为数字' }).int().min(1).max(120),
    height: numInRange('height'),
    weight: numInRange('weight')
  }).optional()
});

const smsSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确')
});

/** 密码重置：手机号 + 短信验证码 + 新密码（前端 sha256 后传输，服务端 bcrypt 落库） */
const resetPasswordSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确'),
  code: z.string().min(4, '验证码格式不正确').max(6),
  newPasswordHash: z.string().min(32, '新密码不合法').max(128)
});

/* ==================== 医生端扩展：专病建档 / 筛查 / 预警 / 随访 / 质控 ==================== */
/** 身份证：空值放行；填写时 15/18 位格式 + 18 位出生日期与 GB11643 校验码实校验 */
const idCardField = z.string().trim().transform(v => v.toUpperCase())
  .refine(v => v === '' || validateIdCard(v).ok, v => ({ message: validateIdCard(v).msg || '身份证号格式不正确' }))
  .optional().nullable();
const strMax = (n) => z.string().trim().max(n, `内容不能超过${n}字`).optional().nullable();

/** 脂肪肝专病建档（结构化电子病历 全字段） */
const medicalRecordSchema = z.object({
  patientId: z.string().min(1, '请选择患者'),
  version: z.number().int().optional().nullable(),
  /* 一、患者基本信息 */
  name: z.string().trim().min(1, '姓名不能为空').max(20),
  gender: z.enum(['male', 'female'], { errorMap: () => ({ message: '性别不合法' }) }),
  birthDate: dateStr.optional().nullable(),
  idCard: idCardField,
  phone: z.string().regex(/^1\d{10}$/, '联系电话格式不正确').optional().nullable().or(z.literal('')),
  visitNumber: strMax(40),
  inpatientNumber: strMax(40),
  visitDate: dateStr.optional().nullable(),
  visitDept: strMax(30),
  insuranceType: z.enum(INSURANCE_TYPES).optional().nullable(),
  /* 二、筛查与风险评估 */
  height: numInRange('height').optional().nullable(),
  weight: numInRange('weight').optional().nullable(),
  waist: numInRange('waist').optional().nullable(),
  sbp: numInRange('sbp').optional().nullable(),
  dbp: numInRange('dbp').optional().nullable(),
  smokingHistory: z.enum(SMOKING_HISTORY).optional().nullable(),
  drinkingHistory: z.enum(DRINKING_HISTORY).optional().nullable(),
  weeklyAlcoholGrams: z.number().min(0).max(5000).optional().nullable(),
  dietHabit: z.enum(DIET_HABITS).optional().nullable(),
  activityLevel: z.enum(ACTIVITY_LEVELS).optional().nullable(),
  /* 三、主诉与现病史 */
  chiefComplaint: strMax(200),
  presentIllness: strMax(1000),
  discoveryType: z.enum(DISCOVERY_TYPES).optional().nullable(),
  /* 四、既往史与合并症（是/否） */
  t2dm: z.enum(YES_NO).optional().nullable(),
  hypertension: z.enum(YES_NO).optional().nullable(),
  dyslipidemia: z.enum(YES_NO).optional().nullable(),
  hyperuricemia: z.enum(YES_NO).optional().nullable(),
  metabolicSyndrome: z.enum(YES_NO).optional().nullable(),
  cvd: z.enum(YES_NO).optional().nullable(),
  otherChronic: strMax(200),
  medicationHistory: strMax(300),
  /* 五、体格检查 */
  skinSigns: strMax(300),
  abdominalExam: strMax(300),
  /* 六、辅助检查（超声/FibroScan + 14 项检验） */
  ultrasound: z.enum(['无异常', '轻度脂肪肝', '中度脂肪肝', '重度脂肪肝']).optional().nullable(),
  fibroScanCap: z.number().min(100, 'CAP超出合理范围(100-400)').max(400, 'CAP超出合理范围(100-400)').optional().nullable(),
  fibroScanE: z.number().min(1, 'E值超出合理范围(1-75)').max(75, 'E值超出合理范围(1-75)').optional().nullable(),
  labExamDate: dateStr.optional().nullable(),
  /* 七、分层风险评估与干预方案 */
  riskLevel: z.enum(['low', 'mid', 'high'], { errorMap: () => ({ message: '请选择风险分层' }) }),
  riskReason: strMax(500),
  interventionDiet: strMax(300),
  interventionExercise: strMax(300),
  weightGoal: z.number().min(0).max(100).optional().nullable(),
  interventionMedication: strMax(300),
  revisitPlan: strMax(300),
  nursingProblems: strMax(500),
  healthEducation: strMax(500)
});
// 14 项检验指标（LAB_FIELDS 派生，硬校验医学合理范围）
for (const f of LAB_FIELDS) {
  medicalRecordSchema.shape[f.key] = numInRange(f.key).optional().nullable();
}

/**
 * 一站式建档（参考专病平台「新建档案」）：medicalRecordSchema 去除 patientId/version，
 * 附加患者登录账号开通字段；出生日期必填（用于计算年龄建档）。
 */
const registryCreateSchema = medicalRecordSchema
  .omit({ patientId: true, version: true, gender: true })
  .extend({
    /** 性别可省略：校验码已验证的身份证号可解析出性别（由 superRefine 保证二者必有其一） */
    gender: z.enum(['male', 'female'], { errorMap: () => ({ message: '性别不合法' }) }).optional().nullable(),
    username: z.string().trim().min(3, '登录用户名至少3位').max(30, '登录用户名最多30位')
      .regex(/^[A-Za-z0-9_@.]+$/, '用户名仅支持字母、数字、下划线、@ 和 .'),
    initialPasswordHash: z.string().min(32, '初始密码不合法').max(128, '初始密码不合法')
  })
  .superRefine((val, ctx) => {
    if (!val.birthDate) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '请填写出生日期（建档需据此计算年龄）' });
    if (!val.gender && !validateIdCard(val.idCard || '').ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gender'], message: '请选择性别（未填写时需提供可解析性别的身份证号）' });
    }
  });

const screeningRunSchema = z.object({ action: z.literal('run') });

const screeningManualSchema = z.object({
  action: z.literal('manual'),
  patientId: z.string().min(1, '请选择患者'),
  source: z.enum(['lis', 'pacs', 'manual']).default('manual'),
  ultrasoundText: z.string().max(500).optional().nullable(),
  note: z.string().max(200).optional().nullable()
});

const screeningSchema = z.discriminatedUnion('action', [screeningRunSchema, screeningManualSchema]);

const screeningDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  reason: z.string().trim().min(2, '请填写处理说明（纳入依据或排除理由）').max(300),
  risk: z.enum(['low', 'mid', 'high']).optional()
});

const alertsQuerySchema = z.object({
  level: z.enum(['high', 'mid', 'low']).optional(),
  status: z.enum(['open', 'handled']).optional()
});

const alertHandleSchema = z.object({
  note: z.string().trim().max(300).optional().nullable()
});

const followupExecuteSchema = z.object({
  method: z.enum(['电话', '微信', '门诊', '住院'], { errorMap: () => ({ message: '随访方式不合法' }) }),
  outcome: z.string().trim().min(1, '请填写随访结果').max(200),
  conclusion: z.string().trim().max(500).optional().nullable(),
  nextDate: dateStr.optional().nullable()
});

const followupLostSchema = z.object({
  reason: z.string().trim().min(2, '请填写失访原因').max(200)
});

const followupRemindSchema = z.object({
  patientIds: z.array(z.string()).min(1, '请选择患者').max(50)
});

/* ==================== 宣教模板管理（自定义素材 CRUD / 版本 / 启停） ==================== */
const MATERIAL_CATEGORIES = ['饮食宣教', '运动指导', '戒酒限酒', '用药安全', '复查随访', '心理调适', '其他'];

const materialCreateSchema = z.object({
  title: z.string().trim().min(2, '模板标题至少2个字').max(50, '模板标题最多50字'),
  summary: z.string().trim().max(100, '摘要最多100字').optional().default(''),
  html: z.string().min(5, '模板内容至少5个字符').max(30000, '模板内容过大'),
  category: z.string().trim().max(20).optional().default('其他'),
  tags: z.array(z.string().trim().min(1).max(12, '单个标签最多12字')).max(6, '最多6个标签').optional().default([])
});

const materialUpdateSchema = materialCreateSchema.extend({
  id: z.string().min(3).max(64),
  action: z.literal('toggle').optional()   // toggle = 启用/禁用切换
});

const materialDeleteSchema = z.object({
  id: z.string().min(3).max(64)
});

/** 执行校验，失败抛 422（医学校验不通过） */
function parse(schema, data) {
  const r = schema.safeParse(data || {});
  if (!r.success) {
    const first = r.error.issues && r.error.issues[0];
    throw new ApiError(422, 42200, first ? first.message : '参数校验不通过');
  }
  return r.data;
}

module.exports = {
  parse,
  dietSchema,
  exerciseSchema,
  vitalsSchema,
  labsSchema,
  followupSchema,
  batchFollowupSchema,
  revisitSchema,
  mdtSchema,
  educationPushSchema,
  guidanceSchema,
  assessmentSubmitSchema,
  uploadSchema,
  loginSchema,
  smsSchema,
  resetPasswordSchema,
  /* 医生端扩展 */
  medicalRecordSchema,
  registryCreateSchema,
  screeningSchema,
  screeningDecisionSchema,
  alertsQuerySchema,
  alertHandleSchema,
  followupExecuteSchema,
  followupLostSchema,
  followupRemindSchema,
  /* 宣教模板管理 */
  MATERIAL_CATEGORIES,
  materialCreateSchema,
  materialUpdateSchema,
  materialDeleteSchema
};
