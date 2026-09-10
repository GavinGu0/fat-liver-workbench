'use strict';
const { defineHandler } = require('./_lib/handler');
/** OpenAPI 3.0 规范（核心接口）。Swagger UI 见 /api/docs */
const spec = {
  openapi: '3.0.3',
  info: {
    title: '脂肪肝专病管理工作台 API',
    version: '1.0.0',
    description: 'Vercel Serverless + 无数据库（KV/Blob/EdgeConfig）。统一响应：{code, message, data, requestId}，code=0 成功。鉴权：Authorization: Bearer <accessToken>'
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'auth' }, { name: 'doctor' }, { name: 'nurse' }, { name: 'patient' }, { name: 'common' }
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Resp: { type: 'object', properties: { code: { type: 'integer' }, message: { type: 'string' }, data: {}, requestId: { type: 'string' } } },
      LoginResp: { type: 'object', properties: { user: { type: 'object' }, accessToken: { type: 'string' }, refreshToken: { type: 'string' }, expiresIn: { type: 'integer' } } }
    }
  },
  paths: {
    '/auth/login': {
      post: {
        tags: ['auth'], summary: '登录/注册（password|sms|register 三模式）',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { mode: { type: 'string', enum: ['password', 'sms', 'register'] }, username: { type: 'string' }, phone: { type: 'string' }, passwordHash: { type: 'string', description: 'sha256(password::flwb::v1)' }, code: { type: 'string' }, profile: { type: 'object' } } } } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResp' } } } } }
      }
    },
    '/auth/sms': { post: { tags: ['auth'], summary: '发送短信验证码（未配置 SMS_KEY 时返回 demoCode）', responses: { '200': { description: 'ok' } } } },
    '/auth/refresh': { post: { tags: ['auth'], summary: '刷新令牌（Refresh Token 轮换）', responses: { '200': { description: 'ok' } } } },
    '/auth/logout': { post: { tags: ['auth'], summary: '退出并吊销 Refresh Token', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/dashboard': { get: { tags: ['doctor'], summary: '工作台聚合：指标+待办+快捷筛选+智能提醒', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/patients': { get: { tags: ['doctor'], summary: '患者列表（隔离：医生仅本人管理；keyword/risk/filter/page/size）', security: [{ bearerAuth: [] }], parameters: [{ name: 'keyword', in: 'query', schema: { type: 'string' } }, { name: 'risk', in: 'query', schema: { type: 'string', enum: ['high', 'mid', 'low'] } }, { name: 'filter', in: 'query', schema: { type: 'string', enum: ['highRisk', 'notFollowed', 'abnormal', 'notFilled7d'] } }], responses: { '200': { description: 'ok' } } } },
    '/patients/followup-batch': { post: { tags: ['doctor'], summary: '批量设置随访日期', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/patients/{id}': { get: { tags: ['doctor'], summary: '患者详情（全景视图；医生/护士/本人）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    '/patients/{id}/records': { get: { tags: ['doctor'], summary: '自填数据时间轴（合并分页）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'types', in: 'query', schema: { type: 'string' } }, { name: 'before', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'ok' } } } },
    '/patients/{id}/trend': { get: { tags: ['doctor'], summary: '趋势分析：体重/BMI/血压/血糖/腹围 + 肝功能', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'days', in: 'query', schema: { type: 'integer', default: 90 } }], responses: { '200': { description: 'ok' } } } },
    '/patients/{id}/labs': { get: { tags: ['doctor'], summary: '辅助检查（检验）记录（14项，含参考范围异常标记）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } }, post: { tags: ['doctor'], summary: '录入辅助检查（检验）14项（仅主管医生）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/patients/{id}/followup': { put: { tags: ['doctor'], summary: '设置随访日期（乐观锁 version）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' }, '409': { description: '版本冲突' } } } },
    '/patients/{id}/revisit': { put: { tags: ['doctor'], summary: '设置复诊计划', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } }, post: { tags: ['doctor'], summary: '发送复诊提醒', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/patients/{id}/mdt': { get: { tags: ['doctor'], summary: '患者MDT列表', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } }, post: { tags: ['doctor'], summary: 'MDT：initiate|feedback|archive', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    '/mdt': { get: { tags: ['doctor'], summary: '医生全量MDT列表', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/medical-records': {
      get: { tags: ['doctor'], summary: '专病档案查看（?patientId=，含模型风险分层建议）', security: [{ bearerAuth: [] }], parameters: [{ name: 'patientId', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } },
      post: { tags: ['doctor'], summary: '脂肪肝专病建档/更新（全字段校验+BMI自动计算+风险分层+随访周期自动排期，高危自动 MDT 预警）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' }, '409': { description: '档案版本冲突' } } }
    },
    '/screening': {
      get: { tags: ['doctor'], summary: '筛查案例列表（status/keyword 筛选+统计）', security: [{ bearerAuth: [] }], parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'accepted', 'rejected'] } }, { name: 'keyword', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } },
      post: { tags: ['doctor'], summary: '筛查执行：action=run 自动扫描（检验/BMI/超声规则引擎）| action=manual 手工登记', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } }
    },
    '/screening/{id}/decision': { post: { tags: ['doctor'], summary: '筛查决策：accept 纳入管理（同步风险+自动排随访）/ reject 排除', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' }, '409': { description: '案例已处理' } } } },
    '/alerts': { get: { tags: ['doctor'], summary: '预警提醒列表（level/status 筛选+未读数+统计）', security: [{ bearerAuth: [] }], parameters: [{ name: 'level', in: 'query', schema: { type: 'string', enum: ['high', 'mid', 'low'] } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'handled'] } }], responses: { '200': { description: 'ok' } } } },
    '/alerts/{id}/handle': { post: { tags: ['doctor'], summary: '处理预警（标记已处理+备注）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    '/alerts/read-all': { post: { tags: ['doctor'], summary: '预警一键全部已读', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/followups': {
      get: { tags: ['doctor'], summary: '随访计划列表（overdue/today/soon3d/scheduled/none/lost 状态+统计）；?patientId= 返回随访执行记录', security: [{ bearerAuth: [] }], parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['lost', 'overdue', 'today', 'soon3d', 'scheduled', 'none'] } }, { name: 'keyword', in: 'query', schema: { type: 'string' } }, { name: 'patientId', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } }
    },
    '/followups/{id}/execute': { post: { tags: ['doctor'], summary: '随访执行：登记方式/结果/结论，自动排下次随访（风险周期）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    '/followups/{id}/lost': { post: { tags: ['doctor'], summary: '标记失访（原因必填，移出随访到期集合）', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    '/followups/remind': { post: { tags: ['doctor'], summary: '一键发送随访提醒给患者（批量站内信）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/quality': { get: { tags: ['doctor'], summary: '质量看板：随访率/失访率/建档率/高风险占比/复查完成率 + 分布 + 趋势（days/risk 筛选）', security: [{ bearerAuth: [] }], parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30, enum: [7, 30, 90, 180] } }, { name: 'risk', in: 'query', schema: { type: 'string', enum: ['high', 'mid', 'low'] } }], responses: { '200': { description: 'ok' } } } },
    '/records/diet': { post: { tags: ['patient'], summary: '填报饮食记录（幂等键 X-Idempotency-Key）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/records/exercise': { post: { tags: ['patient'], summary: '填报运动记录', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/records/vitals': { post: { tags: ['patient'], summary: '填报随访指标（医学范围硬校验+阈值软提醒）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' }, '422': { description: '超出医学合理范围' } } } },
    '/records/upload': { post: { tags: ['patient'], summary: '上传图片（dataUrl；Blob 或 KV 兜底）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/messages': { get: { tags: ['common'], summary: '消息中心 + 未读数 + 患者随访弹窗标识', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/messages/{id}/read': { post: { tags: ['common'], summary: '标记已读', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    '/messages/read-all': { post: { tags: ['common'], summary: '全部已读', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/nurse/education': { get: { tags: ['nurse', 'doctor'], summary: '宣教素材+推送历史（医护通用）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } }, post: { tags: ['nurse', 'doctor'], summary: '批量推送宣教（医护通用）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/nurse/guidance': { get: { tags: ['nurse'], summary: '指导记录（按患者或护士）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } }, post: { tags: ['nurse'], summary: '创建个案指导', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/nurse/templates': { get: { tags: ['nurse'], summary: '评估模板+历史', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } }, post: { tags: ['nurse'], summary: '提交评估生成报告', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/reports/{id}': { get: { tags: ['nurse'], summary: '评估报告详情', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    '/config': { get: { tags: ['common'], summary: '全局配置（专家库/素材/模板/校验范围）', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } },
    '/health': { get: { tags: ['common'], summary: '健康检查（存储模式/组件状态）', responses: { '200': { description: 'ok' } } } },
    '/cron/followup-remind': { get: { tags: ['common'], summary: '每日定时：随访提醒+快照备份+过期清理', responses: { '200': { description: 'ok' } } } }
  }
};

module.exports = defineHandler({
  auth: 'public',
  fn: async () => spec
});
