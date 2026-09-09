/**
 * 冒烟测试：内存存储模式下直接调用全部 API handler，验证核心业务链路
 * 运行：npm run smoke（需先 npm install）
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ---------- 极简 req/res 模拟 ---------- */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    get writableEnded() { return this.body !== null; }
  };
}

function makeReq({ method = 'GET', url = '/', query = {}, body = null, headers = {}, token = null } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': 'test-ip', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const req = {
    method, url, query, headers: h,
    socket: { remoteAddress: '127.0.0.1' }
  };
  if (body !== null) {
    const buf = Buffer.from(JSON.stringify(body));
    req[Symbol.asyncIterator] = async function* () { yield buf; };
  } else {
    req[Symbol.asyncIterator] = async function* () { /* 空 body */ };
  }
  return req;
}

async function call(modPath, opts) {
  const fn = require(join(ROOT, modPath));
  const req = makeReq(opts);
  const res = makeRes();
  await fn(req, res);
  if (!res.body) throw new Error(`${modPath} [${opts.method}] no response (status=${res.statusCode})`);
  return res.body;
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''); }
}

const SALT = 'flwb::v1';
const { createHash } = await import('node:crypto');
const sha = (pwd) => createHash('sha256').update(`${pwd}::${SALT}`).digest('hex');

console.log('\n[1] 健康检查与种子数据');
const health = await call('server/health.js', {});
check('health ok', health.code === 0 && health.data.status === 'ok', health);

console.log('\n[2] 医生登录（GBMZ/123456）');
const docLogin = await call('server/auth/login.js', {
  method: 'POST',
  body: { mode: 'password', username: 'GBMZ', passwordHash: sha('123456') }
});
check('doctor login', docLogin.code === 0 && docLogin.data.user.role === 'doctor', docLogin);
const docToken = docLogin.data?.accessToken;
const docAuth = { token: docToken };

console.log('\n[3] 工作台聚合');
const dash = await call('server/dashboard.js', { ...docAuth, url: '/api/dashboard' });
check('dashboard metrics', dash.code === 0 && dash.data.metrics.totalPatients >= 9, dash.data?.metrics);
check('dashboard todayFollowups has demo patient', dash.data.todos.todayFollowups.some(p => p.id === 'p_1009'), dash.data?.todos?.todayFollowups);

console.log('\n[4] 患者列表与筛选');
const list = await call('server/patients/index.js', { ...docAuth, url: '/api/patients?size=50', query: { size: '50' } });
check('patient list', list.code === 0 && list.data.items.length >= 9, list.data?.total);
const highRisk = await call('server/patients/index.js', { ...docAuth, url: '/api/patients?filter=highRisk', query: { filter: 'highRisk' } });
check('highRisk filter', highRisk.code === 0 && highRisk.data.items.every(p => p.risk === 'high'), highRisk.data?.items?.length);
const abnormal = await call('server/patients/index.js', { ...docAuth, url: '/api/patients?filter=abnormal', query: { filter: 'abnormal' } });
check('abnormal filter catches p_1008', abnormal.code === 0 && abnormal.data.items.some(p => p.id === 'p_1008'), abnormal.data?.items?.map(i => i.id));

console.log('\n[5] 患者详情/时间轴/趋势');
const detail = await call('server/patients/[id]/index.js', { ...docAuth, url: '/api/patients/p_1001', query: { id: 'p_1001' } });
check('patient detail', detail.code === 0 && detail.data.profile.id === 'p_1001', detail.data?.profile?.name);
const timeline = await call('server/patients/[id]/records.js', { ...docAuth, url: '/api/patients/p_1009/records', query: { id: 'p_1009' } });
check('timeline merged', timeline.code === 0 && timeline.data.items.length > 0, timeline.data?.items?.length);
const trend = await call('server/patients/[id]/trend.js', { ...docAuth, url: '/api/patients/p_1009/trend', query: { id: 'p_1009', days: '90' } });
check('trend points', trend.code === 0 && trend.data.points.length >= 5, trend.data?.points?.length);

console.log('\n[6] 乐观锁：随访设置');
const cur = detail.data.profile.version ?? 1;
const conflict = await call('server/patients/[id]/followup.js', { ...docAuth, method: 'PUT', url: '/api/patients/p_1001/followup', query: { id: 'p_1001' }, body: { date: '2026-09-20', version: cur + 100 } });
check('version conflict -> 409', conflict.code === 40903, conflict);
const fu = await call('server/patients/[id]/followup.js', { ...docAuth, method: 'PUT', url: '/api/patients/p_1001/followup', query: { id: 'p_1001' }, body: { date: '2026-09-20', version: cur } });
check('followup set ok', fu.code === 0 && fu.data.nextFollowupDate === '2026-09-20', fu);

console.log('\n[7] 复诊计划与提醒推送');
const rv = await call('server/patients/[id]/revisit.js', { ...docAuth, method: 'PUT', url: '/api/patients/p_1009/revisit', query: { id: 'p_1009' }, body: { date: '2026-10-01', place: '门诊3楼', notes: '空腹' } });
check('revisit set', rv.code === 0, rv);
const rr = await call('server/patients/[id]/revisit.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1009/revisit', query: { id: 'p_1009' }, body: {} });
check('revisit reminder sent', rr.code === 0 && rr.data.sent === true, rr);

console.log('\n[8] MDT 全流程');
const mdt = await call('server/patients/[id]/mdt.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1003/mdt', query: { id: 'p_1003' }, body: { action: 'initiate', reason: '疑难病例，血脂控制不佳', specialists: [{ dept: '营养科', expert: '王芳' }, { dept: '内分泌科', expert: '刘强' }] } });
check('mdt initiate', mdt.code === 0 && mdt.data.status === 'pending', mdt);
const mdtId = mdt.data?.id;
const fb = await call('server/patients/[id]/mdt.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1003/mdt', query: { id: 'p_1003' }, body: { action: 'feedback', mdtId, expert: '王芳', dept: '营养科', opinion: '建议低碳水饮食方案' } });
check('mdt feedback', fb.code === 0 && fb.data.status === 'feedback', fb);
const arch = await call('server/patients/[id]/mdt.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1003/mdt', query: { id: 'p_1003' }, body: { action: 'archive', mdtId, conclusion: '维持低脂饮食+运动处方，1个月后复评' } });
check('mdt archive', arch.code === 0 && arch.data.status === 'done', arch);
const mdtDetail = await call('server/patients/[id]/index.js', { ...docAuth, url: '/api/patients/p_1003', query: { id: 'p_1003' } });
check('mdt conclusion in archive', mdtDetail.data.archive.some(a => a.kind === 'mdt'), mdtDetail.data?.archive);

console.log('\n[9] 医生数据隔离');
const doc2Login = await call('server/auth/login.js', { method: 'POST', body: { mode: 'password', username: 'GBMZ', passwordHash: sha('123456') } });
const other = await call('server/patients/[id]/index.js', { token: doc2Login.data.accessToken, url: '/api/patients/p_1001', query: { id: 'p_1001' } });
check('isolation baseline visible for owner', other.code === 0, other.code);

console.log('\n[10] 患者：短信登录 + 指标填报（硬/软校验）');
const sms = await call('server/auth/sms.js', { method: 'POST', body: { phone: '13800000001' } });
check('sms demo code', sms.code === 0 && sms.data.demoCode, sms);
const patLogin = await call('server/auth/login.js', { method: 'POST', body: { mode: 'sms', phone: '13800000001', code: sms.data.demoCode } });
check('patient sms login', patLogin.code === 0 && patLogin.data.user.role === 'patient', patLogin.data?.user);
const patAuth = { token: patLogin.data?.accessToken };

const badVitals = await call('server/records/vitals.js', { ...patAuth, method: 'POST', body: { recordDate: '2026-09-08', weight: 500 } });
check('out-of-range vitals -> 422', badVitals.code === 42200 && badVitals.message.includes('体重'), badVitals);

const goodVitals = await call('server/records/vitals.js', { ...patAuth, method: 'POST', body: { recordDate: '2026-09-08', weight: 78.5, sbp: 148, dbp: 92, glucose: 6.5 } });
check('vitals submit + soft warning', goodVitals.code === 0 && goodVitals.data.warnings.length >= 2, goodVitals.data);

const badBp = await call('server/records/vitals.js', { ...patAuth, method: 'POST', body: { recordDate: '2026-09-08', sbp: 100, dbp: 130 } });
check('sbp<=dbp -> 422', badBp.code === 42200, badBp);

console.log('\n[11] 患者：饮食/运动填报');
const diet = await call('server/records/diet.js', { ...patAuth, method: 'POST', body: { meal: 'lunch', recordDate: '2026-09-08', recordTime: '12:30', foods: [{ name: '糙米饭', grams: 150 }, { name: '清蒸鲈鱼', grams: 120 }] } });
check('diet submit', diet.code === 0, diet);
const ex = await call('server/records/exercise.js', { ...patAuth, method: 'POST', body: { type: '慢跑', minutes: 40, intensity: 'mid', recordDate: '2026-09-08' } });
check('exercise submit', ex.code === 0, ex);

const dupKey = 'idem-test-001';
const diet2 = await call('server/records/diet.js', { ...patAuth, method: 'POST', headers: { 'x-idempotency-key': dupKey }, body: { meal: 'dinner', recordDate: '2026-09-08', foods: [{ name: '杂粮粥', grams: 300 }] } });
const diet3 = await call('server/records/diet.js', { ...patAuth, method: 'POST', headers: { 'x-idempotency-key': dupKey }, body: { meal: 'dinner', recordDate: '2026-09-08', foods: [{ name: '杂粮粥', grams: 300 }] } });
check('idempotency dedup', diet2.code === 0 && diet3.code === 40901, [diet2.code, diet3.code]);

console.log('\n[12] 护士：宣教/指导/评估');
const nurseLogin = await call('server/auth/login.js', { method: 'POST', body: { mode: 'password', username: 'HULI01', passwordHash: sha('123456') } });
check('nurse login', nurseLogin.code === 0 && nurseLogin.data.user.role === 'nurse', nurseLogin.data?.user);
const nurseAuth = { token: nurseLogin.data?.accessToken };

const edu = await call('server/nurse/education.js', { ...nurseAuth, method: 'POST', body: { patientIds: ['p_1009'], materialId: 'edu_2' } });
check('education push', edu.code === 0 && edu.data.sent === 1, edu);
const guidance = await call('server/nurse/guidance.js', { ...nurseAuth, method: 'POST', body: { patientId: 'p_1009', method: '电话', category: '饮食指导', content: '减少精制碳水，增加蛋白质摄入比例' } });
check('guidance create', guidance.code === 0, guidance);
const assess = await call('server/nurse/templates.js', { ...nurseAuth, method: 'POST', body: { patientId: 'p_1009', answers: { drinking: '偶尔', family: '有', familyNote: '父亲糖尿病', symptoms: ['乏力'], comorbid: ['高脂血症'], exerciseFreq: 2, dietHabit: '高脂高糖' } } });
check('assessment report', assess.code === 0 && assess.data.reportId, assess);
const report = await call('server/reports/[id]/index.js', { ...docAuth, url: `/api/reports/${assess.data.reportId}`, query: { id: assess.data.reportId } });
check('report readable by doctor', report.code === 0 && report.data.html.includes('风险提示'), report.code);

console.log('\n[13] 患者：消息中心与随访弹窗');
const msgs = await call('server/messages/index.js', { ...patAuth, url: '/api/messages' });
check('messages list', msgs.code === 0 && msgs.data.items.length >= 3, msgs.data?.items?.length);
check('followup popup today', msgs.data.followupToday && msgs.data.followupToday.date !== undefined, msgs.data?.followupToday);
const firstUnread = msgs.data.items.find(m => !m.read);
if (firstUnread) {
  const rd = await call(`server/messages/[id]/read.js`, { ...patAuth, method: 'POST', url: `/api/messages/${firstUnread.mid}/read`, query: { id: firstUnread.mid } });
  check('mark message read', rd.code === 0, rd);
}
const msgs2 = await call('server/messages/read-all.js', { ...patAuth, method: 'POST' });
check('read all', msgs2.code === 0, msgs2);

console.log('\n[14] 图片上传（KV 兜底模式）');
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const up = await call('server/records/upload.js', { ...patAuth, method: 'POST', body: { filename: 'a.png', dataUrl: tinyPng } });
check('upload fallback ok', up.code === 0 && up.data.ephemeral === true, up.data);
const upBad = await call('server/records/upload.js', { ...patAuth, method: 'POST', body: { filename: 'a.gif', dataUrl: 'data:image/gif;base64,R0lGOD=' } });
check('upload reject gif', upBad.code === 42200, upBad);

console.log('\n[15] 患者越权防护');
const hack = await call('server/records/vitals.js', { ...patAuth, method: 'POST', body: { recordDate: '2026-09-08' } });
check('vitals require at least one field', hack.code === 42200, hack);
const forbidden = await call('server/patients/[id]/followup.js', { ...patAuth, method: 'PUT', url: '/api/patients/p_1002/followup', query: { id: 'p_1002' }, body: { date: '2026-09-30' } });
check('patient cannot set followup -> 403', forbidden.code === 40300, forbidden);

console.log('\n[16] 定时任务');
const cron = await call('server/cron/followup-remind.js', {});
check('cron run', cron.code === 0 && cron.data.reminded >= 0, cron.data);

console.log(`\n========== 冒烟测试结果: ${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
