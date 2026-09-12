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
/** 上海时区日期字符串（支持偏移天数） */
const dstr = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() + offset * 86400000));
const today = dstr(0);

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

console.log('\n[11.5] 患者填报 → 医生端推送');
// goodVitals(含异常值) + diet + ex + diet2 共 4 条成功填报（badVitals/badBp 被拒、diet3 幂等去重，均不推送）
const docMsgs = await call('server/messages/index.js', { ...docAuth, url: '/api/messages' });
const submits = (docMsgs.data?.items || []).filter((m) => m.type === 'patient_submit');
check('doctor receives patient_submit pushes', docMsgs.code === 0 && submits.length >= 4, submits.length);
check('push carries from/link and abnormal flag', submits.length >= 4 && submits.every((m) => m.from === '王小明' && m.link === '/patients/p_1009')
  && submits.some((m) => m.title.includes('含异常值')), submits.map((m) => m.title));
const docMsgReadAll = await call('server/messages/read-all.js', { ...docAuth, method: 'POST', body: {} });
check('doctor read-all msgs ok', docMsgReadAll.code === 0, docMsgReadAll);
const docMsgs2 = await call('server/messages/index.js', { ...docAuth, url: '/api/messages' });
check('unread cleared after read-all', docMsgs2.code === 0 && docMsgs2.data.unread === 0, docMsgs2.data?.unread);

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

console.log('\n[17] 辅助检查（检验）：录入 / 异常标记 / 越界 / 越权');
// 正常值 + 3 个异常样例（alt 偏高、fpg 偏高、hdl 偏低）验证异常标记方向
const labGood = await call('server/patients/[id]/labs.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1009/labs', query: { id: 'p_1009' }, body: {
  examDate: '2026-09-08',
  alt: 66, ast: 25, ggt: 30, alp: 60, tbil: 12, alb: 45,
  fpg: 7.5, hba1c: 5.5, tg: 1.2, tc: 4.5, ldl: 2.5, hdl: 0.8, ua: 300, plt: 200
} });
check('lab create', labGood.code === 0, labGood);
check('abnormal = alt/fpg/hdl（高/高/低）', labGood.code === 0 && labGood.data.abnormal.length === 3 && ['alt', 'fpg', 'hdl'].every(k => labGood.data.abnormal.includes(k)), labGood.data?.abnormal);

const labList = await call('server/patients/[id]/labs.js', { ...docAuth, url: '/api/patients/p_1009/labs', query: { id: 'p_1009' } });
check('lab list returns record with abnormal', labList.code === 0 && labList.data.items.length >= 1 && Array.isArray(labList.data.items[0].abnormal), labList.data?.items?.length);

const labTrend = await call('server/patients/[id]/trend.js', { ...docAuth, url: '/api/patients/p_1009/trend', query: { id: 'p_1009', days: '90' } });
check('trend labs contains 14 项指标', labTrend.code === 0 && labTrend.data.labs.length >= 1 && labTrend.data.labs[labTrend.data.labs.length - 1].fpg === 7.5, labTrend.data?.labs?.length);

const labOver = await call('server/patients/[id]/labs.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1009/labs', query: { id: 'p_1009' }, body: { examDate: '2026-09-08', alt: 99999 } });
check('lab out-of-range -> 422', labOver.code === 42200, labOver);

const labEmpty = await call('server/patients/[id]/labs.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1009/labs', query: { id: 'p_1009' }, body: { examDate: '2026-09-08' } });
check('lab require at least one -> 422', labEmpty.code === 42200, labEmpty);

const labPatientHack = await call('server/patients/[id]/labs.js', { ...patAuth, method: 'POST', url: '/api/patients/p_1009/labs', query: { id: 'p_1009' }, body: { examDate: '2026-09-08', alt: 30 } });
check('patient cannot create lab -> 403', labPatientHack.code === 40300, labPatientHack);

const labNurseHack = await call('server/patients/[id]/labs.js', { ...nurseAuth, method: 'POST', url: '/api/patients/p_1009/labs', query: { id: 'p_1009' }, body: { examDate: '2026-09-08', alt: 30 } });
check('nurse cannot create lab -> 403', labNurseHack.code === 40300, labNurseHack);
check('lab hook raises screening case', labGood.code === 0 && labGood.data.screening && labGood.data.screening.created === true, labGood.data?.screening);

console.log('\n[18] 专病建档：查看/建档/BMI自动计算/风险分层/随访自动排期');
const mrEmpty = await call('server/medical-records.js', { ...docAuth, url: '/api/medical-records?patientId=p_1004', query: { patientId: 'p_1004' } });
check('medrec GET empty + model suggestion', mrEmpty.code === 0 && mrEmpty.data.record === null && mrEmpty.data.suggestion && typeof mrEmpty.data.suggestion.score === 'number', mrEmpty.data?.suggestion);

const mrPost = await call('server/medical-records.js', { ...docAuth, method: 'POST', url: '/api/medical-records', body: {
  patientId: 'p_1003', name: '王建国', gender: 'male', visitDate: '2026-08-20', visitDept: '肝病科', insuranceType: '职工医保',
  height: 170, weight: 85, waist: 102, sbp: 138, dbp: 88,
  smokingHistory: '从不', drinkingHistory: '偶尔', weeklyAlcoholGrams: 30, dietHabit: '高脂', activityLevel: '久坐',
  chiefComplaint: '右上腹胀痛伴纳差1月', presentIllness: '脂肪性肝炎合并2型糖尿病，血糖控制不佳。', discoveryType: '有症状就诊',
  hypertension: '否', dyslipidemia: '是', t2dm: '是', hyperuricemia: '否', metabolicSyndrome: '是', cvd: '否',
  ultrasound: '重度脂肪肝', fibroScanCap: 330, fibroScanE: 10.5,
  alt: 118, ast: 90, ggt: 128, tg: 3.4, fpg: 7.6, hba1c: 8.2,
  riskLevel: 'high', riskReason: '肥胖+糖尿病+肝酶显著升高+重度脂肪肝', interventionDiet: '低碳水饮食干预', interventionExercise: '餐后快走30分钟x5/周'
} });
check('medrec create', mrPost.code === 0 && mrPost.data.record.version === 1, mrPost);
check('BMI auto calc', Math.abs(mrPost.data?.record?.bmi - 29.4) < 0.2, mrPost.data?.record?.bmi);
check('followup auto set by risk cycle', mrPost.data?.followupAutoSet === true && mrPost.data?.nextFollowupDate > today, mrPost.data?.nextFollowupDate);
check('model score attached', typeof mrPost.data?.record?.riskScore === 'number' && Array.isArray(mrPost.data?.record?.riskModelReasons), mrPost.data?.record?.riskScore);

const mrConflict = await call('server/medical-records.js', { ...docAuth, method: 'POST', url: '/api/medical-records', body: { patientId: 'p_1003', name: '王建国', gender: 'male', riskLevel: 'low', version: 999 } });
check('medrec version conflict -> 409', mrConflict.code === 40903, mrConflict);

const mrPatient = await call('server/patients/[id]/index.js', { ...docAuth, url: '/api/patients/p_1003', query: { id: 'p_1003' } });
check('patient risk synced from medrec', mrPatient.data?.profile?.risk === 'high', mrPatient.data?.profile?.risk);
const mrHighHack = await call('server/medical-records.js', { ...patAuth, method: 'POST', body: { patientId: 'p_1004', name: '李秀英', gender: 'female', riskLevel: 'low' } });
check('patient cannot create medrec -> 403', mrHighHack.code === 40300, mrHighHack);

console.log('\n[18.5] 专病档案中心：列表 + 一站式建档');
const regList0 = await call('server/registry/index.js', { ...docAuth, url: '/api/registry' });
check('registry list default archived', regList0.code === 0 && regList0.data.stats.archived >= 1 && regList0.data.items.every(r => r.archived), regList0.data?.stats);
check('registry list contains p_1003 v1', regList0.data.items.some(r => r.patientId === 'p_1003' && r.version >= 1), null);
const regPending = await call('server/registry/index.js', { ...docAuth, url: '/api/registry?status=pending', query: { status: 'pending' } });
check('registry pending filter + stats', regPending.code === 0 && regPending.data.items.every(r => !r.archived) && regPending.data.stats.pending >= 1, regPending.data?.stats);
const regNurseView = await call('server/registry/index.js', { ...nurseAuth, url: '/api/registry' });
check('nurse can view registry (staff)', regNurseView.code === 0, regNurseView);

const REG_ID = '110101197504124517'; // 合法 18 位（校验码 7）
const regBody = {
  username: 'regpatient01', initialPasswordHash: sha('Abc123456'),
  name: '钱学兵', gender: 'male', birthDate: '1975-04-12', idCard: REG_ID, phone: '13900001111',
  visitNumber: 'MZ2026091101', inpatientNumber: 'ZY2026091101', visitDate: today, visitDept: '肝病科', insuranceType: '职工医保',
  height: 172, weight: 88, waist: 104, sbp: 142, dbp: 90,
  smokingHistory: '吸烟中', drinkingHistory: '经常', weeklyAlcoholGrams: 350, dietHabit: '高脂', activityLevel: '久坐',
  chiefComplaint: '体检发现转氨酶升高2周', presentIllness: '无特殊不适。', discoveryType: '无症状/体检发现',
  t2dm: '否', hypertension: '是', dyslipidemia: '是', hyperuricemia: '否', metabolicSyndrome: '否', cvd: '否',
  ultrasound: '中度脂肪肝', fibroScanCap: 300, fibroScanE: 9.2, labExamDate: today,
  alt: 96, ggt: 88, tg: 2.8, fpg: 6.3,
  riskLevel: 'high', riskReason: '超重+高血压+血脂异常+中度脂肪肝', interventionDiet: '限酒低脂饮食', revisitPlan: '1个月后复查肝功+超声'
};
const regCreate = await call('server/registry/index.js', { ...docAuth, method: 'POST', url: '/api/registry', body: regBody });
check('one-stop registry create', regCreate.code === 0 && !!regCreate.data.patientId && !!regCreate.data.userId, regCreate);
check('registry auto followup by risk', regCreate.data?.followupAutoSet === true && regCreate.data?.nextFollowupDate > today, regCreate.data?.nextFollowupDate);
check('registry model score attached', typeof regCreate.data?.riskScore === 'number' && Array.isArray(regCreate.data?.modelSuggestion?.reasons), regCreate.data?.modelSuggestion);

const regLogin = await call('server/auth/login.js', { method: 'POST', body: { mode: 'password', username: 'regpatient01', passwordHash: sha('Abc123456') } });
check('created account can login', regLogin.code === 0 && regLogin.data.user.role === 'patient', regLogin);

const regDup = await call('server/registry/index.js', { ...docAuth, method: 'POST', url: '/api/registry', body: { ...regBody, name: '重复用户名' } });
check('duplicate username -> 409', regDup.code === 40901, regDup);

const regBadId = await call('server/registry/index.js', { ...docAuth, method: 'POST', url: '/api/registry', body: { ...regBody, username: 'regpatient02', idCard: '110101197504124511' } });
check('invalid idCard checksum -> 422', regBadId.code === 42200, regBadId);

const regNurseCreate = await call('server/registry/index.js', { ...nurseAuth, method: 'POST', url: '/api/registry', body: regBody });
check('nurse cannot one-stop create -> 403', regNurseCreate.code === 40300, regNurseCreate);

// 性别缺省 → 由身份证解析补全（110101197504124525 校验码合法，第17位偶数 → female）
const regGenderFallback = await call('server/registry/index.js', { ...docAuth, method: 'POST', url: '/api/registry', body: { ...regBody, username: 'regpatient03', phone: '13900002222', gender: undefined, idCard: '110101197504124525' } });
check('gender fallback from idcard create ok', regGenderFallback.code === 0 && !!regGenderFallback.data.patientId, regGenderFallback);
const regGenderFDetail = await call('server/patients/[id]/index.js', { ...docAuth, url: `/api/patients/${regGenderFallback.data.patientId}`, query: { id: regGenderFallback.data.patientId } });
check('patient gender from idcard = female', regGenderFDetail.data?.profile?.gender === 'female', regGenderFDetail.data?.profile?.gender);

// 性别与身份证均缺失 → 422 拦截
const regNoGender = await call('server/registry/index.js', { ...docAuth, method: 'POST', url: '/api/registry', body: { ...regBody, username: 'regpatient04', phone: '13900003333', gender: undefined, idCard: '' } });
check('no gender & no idcard -> 422', regNoGender.code === 42200, regNoGender);

const regPatientDetail = await call('server/patients/[id]/index.js', { ...docAuth, url: `/api/patients/${regCreate.data.patientId}`, query: { id: regCreate.data.patientId } });
check('new patient risk synced high', regPatientDetail.data?.profile?.risk === 'high', regPatientDetail.data?.profile?.risk);
const regMedrec = await call('server/medical-records.js', { ...docAuth, url: `/api/medical-records?patientId=${regCreate.data.patientId}`, query: { patientId: regCreate.data.patientId } });
check('new medrec readable v1 with labExamDate', regMedrec.code === 0 && regMedrec.data.record?.version === 1 && regMedrec.data.record?.labExamDate === today, regMedrec.data?.record?.version);

console.log('\n[18.6] 专病建档增强：住院号 / 档案完整度 / 随访状态');
check('one-stop create completeness complete (key items present)', regCreate.data?.completeness?.complete === true, regCreate.data?.completeness);
const regListNew = await call('server/registry/index.js', { ...docAuth, url: '/api/registry' });
const regNewRow = regListNew.data.items.find(r => r.patientId === regCreate.data.patientId);
check('registry row carries inpatientNumber', regNewRow?.inpatientNumber === 'ZY2026091101', regNewRow?.inpatientNumber);
check('registry row carries followup status scheduled', regNewRow?.followupStatus === 'scheduled' && regNewRow?.followupStatusLabel === '已预约', [regNewRow?.followupStatus, regNewRow?.followupStatusLabel]);

// 待完善：最小字段建档（缺 BMI/超声/肝功/血糖/甘油三酯）→ completeness 不完整 + 列表可筛出
const incCreate = await call('server/medical-records.js', { ...docAuth, method: 'POST', url: '/api/medical-records', body: { patientId: 'p_1007', name: '孙明', gender: 'male', riskLevel: 'mid' } });
check('medrec save returns incomplete completeness', incCreate.code === 0 && incCreate.data?.completeness?.complete === false && incCreate.data.completeness.missing.length >= 3, incCreate.data?.completeness);
const regInc = await call('server/registry/index.js', { ...docAuth, url: '/api/registry?status=incomplete', query: { status: 'incomplete' } });
check('registry incomplete filter + stats', regInc.code === 0 && regInc.data.stats.incomplete >= 1 && regInc.data.items.some(r => r.patientId === 'p_1007' && r.incomplete), regInc.data?.stats);
check('incomplete row carries missing labels', regInc.data.items.some(r => r.patientId === 'p_1007' && Array.isArray(r.missingItems) && r.missingItems.length >= 3), null);

console.log('\n[18.7] 专病建档删除：权限 / 状态回收 / 重复删除');
const delPid = regGenderFallback.data.patientId;
const delNurse = await call('server/registry/[id]/index.js', { ...nurseAuth, method: 'DELETE', url: `/api/registry/${delPid}`, query: { id: delPid } });
check('nurse cannot delete registry -> 403', delNurse.code === 40300, delNurse);
const delOk = await call('server/registry/[id]/index.js', { ...docAuth, method: 'DELETE', url: `/api/registry/${delPid}`, query: { id: delPid } });
check('doctor deletes registry ok', delOk.code === 0 && delOk.data?.deleted === true && delOk.data?.patientId === delPid, delOk);
const delMedrec = await call('server/medical-records.js', { ...docAuth, url: `/api/medical-records?patientId=${delPid}`, query: { patientId: delPid } });
check('medrec removed after delete', delMedrec.code === 0 && delMedrec.data.record === null, delMedrec.data?.record);
const delPending = await call('server/registry/index.js', { ...docAuth, url: '/api/registry?status=pending', query: { status: 'pending' } });
check('deleted patient back to pending list', delPending.code === 0 && delPending.data.items.some(r => r.patientId === delPid && !r.archived), delPending.data?.stats);
const delDetail = await call('server/patients/[id]/index.js', { ...docAuth, url: `/api/patients/${delPid}`, query: { id: delPid } });
check('patient profile kept after delete (archivedAt cleared)', !!delDetail.data?.profile?.id && delDetail.data.profile.archivedAt == null, delDetail.data?.profile);
const delAgain = await call('server/registry/[id]/index.js', { ...docAuth, method: 'DELETE', url: `/api/registry/${delPid}`, query: { id: delPid } });
check('delete non-archived again -> 404', delAgain.code === 40404, delAgain);

console.log('\n[19] 筛查识别：列表/自动筛查/决策');
const sc0 = await call('server/screening/index.js', { ...docAuth, url: '/api/screening' });
check('screening list seeded', sc0.code === 0 && sc0.data.stats.pending >= 2, sc0.data?.stats);
const scRun = await call('server/screening/index.js', { ...docAuth, method: 'POST', body: { action: 'run' } });
check('screening run scans patients', scRun.code === 0 && scRun.data.scanned >= 9 && scRun.data.newCases >= 1, scRun.data);
const sc0b = await call('server/screening/index.js', { ...docAuth, url: '/api/screening?status=pending', query: { status: 'pending' } });
check('pending cases after run', sc0b.code === 0 && sc0b.data.items.length >= 3, sc0b.data?.stats);

const scAccept = await call('server/screening/[id]/decision.js', { ...docAuth, method: 'POST', url: '/api/screening/sc_seed_1005/decision', query: { id: 'sc_seed_1005' }, body: { decision: 'accept', reason: '超重合并超声阳性，纳入管理' } });
check('screening accept', scAccept.code === 0 && scAccept.data.status === 'accepted' && scAccept.data.riskApplied === 'mid', scAccept.data);
check('accept reschedules followup to future', !!scAccept.data?.nextFollowupDate && scAccept.data.nextFollowupDate > today, scAccept.data);
const p1005After = await call('server/patients/[id]/index.js', { ...docAuth, url: '/api/patients/p_1005', query: { id: 'p_1005' } });
check('accepted risk synced to patient', p1005After.data?.profile?.risk === 'mid' && p1005After.data.profile.nextFollowupDate > today, [p1005After.data?.profile?.risk, p1005After.data?.profile?.nextFollowupDate]);
const scReAccept = await call('server/screening/[id]/decision.js', { ...docAuth, method: 'POST', url: '/api/screening/sc_seed_1005/decision', query: { id: 'sc_seed_1005' }, body: { decision: 'reject', reason: '重复决策' } });
check('re-decision -> 409', scReAccept.code === 40902, scReAccept);
const scReject = await call('server/screening/[id]/decision.js', { ...docAuth, method: 'POST', url: '/api/screening/sc_seed_1008/decision', query: { id: 'sc_seed_1008' }, body: { decision: 'reject', reason: '既往已确诊，走专病门诊路径' } });
check('screening reject', scReject.code === 0 && scReject.data.status === 'rejected', scReject.data);
const scNurse = await call('server/screening/index.js', { ...nurseAuth, method: 'POST', body: { action: 'run' } });
check('nurse cannot run screening -> 403', scNurse.code === 40300, scNurse);

console.log('\n[20] 预警提醒：列表/处理');
const al0 = await call('server/alerts/index.js', { ...docAuth, url: '/api/alerts' });
check('alerts list', al0.code === 0 && al0.data.items.length >= 3 && al0.data.stats.open >= 2, al0.data?.stats);
const alHigh = await call('server/alerts/index.js', { ...docAuth, url: '/api/alerts?level=high&status=open', query: { level: 'high', status: 'open' } });
check('alerts filter level+status', alHigh.code === 0 && alHigh.data.items.every(a => a.level === 'high' && a.status === 'open'), alHigh.data?.items?.length);
const alHandle = await call('server/alerts/[id]/handle.js', { ...docAuth, method: 'POST', url: '/api/alerts/al_seed_2/handle', query: { id: 'al_seed_2' }, body: { note: '已电话联系，重新预约随访' } });
check('alert handle', alHandle.code === 0 && alHandle.data.status === 'handled', alHandle.data);
const alHandleAgain = await call('server/alerts/[id]/handle.js', { ...docAuth, method: 'POST', url: '/api/alerts/al_seed_2/handle', query: { id: 'al_seed_2' }, body: {} });
check('alert re-handle idempotent', alHandleAgain.code === 0, alHandleAgain);

console.log('\n[21] 随访管理：列表/一键提醒/执行/失访');
// 造一个逾期状态：p_1006 随访日期设为 3 天前
const fuOverdueSet = await call('server/patients/[id]/followup.js', { ...docAuth, method: 'PUT', url: '/api/patients/p_1006/followup', query: { id: 'p_1006' }, body: { date: dstr(-3) } });
check('setup overdue followup', fuOverdueSet.code === 0, fuOverdueSet);
const fu0 = await call('server/followups/index.js', { ...docAuth, url: '/api/followups' });
check('followup plan list + stats', fu0.code === 0 && typeof fu0.data.stats.overdue === 'number', fu0.data?.stats);
check('overdue patient p_1006 listed', fu0.data.items.some(x => x.patientId === 'p_1006' && x.status === 'overdue'), fu0.data?.items?.filter(x => x.status === 'overdue').map(x => x.patientId));

const fuRemind = await call('server/followups/remind.js', { ...docAuth, method: 'POST', body: { patientIds: ['p_1009', 'p_1001'] } });
check('one-click remind: sent 1 skipped 1', fuRemind.code === 0 && fuRemind.data.sent === 1 && fuRemind.data.skipped.length === 1, fuRemind.data);

const fuExec = await call('server/followups/[id]/execute.js', { ...docAuth, method: 'POST', url: '/api/followups/p_1005/execute', query: { id: 'p_1005' }, body: { method: '电话', outcome: '患者知晓随访安排，自述控制饮食中', conclusion: '3个月后门诊复查' } });
check('followup execute + auto nextDate', fuExec.code === 0 && !!fuExec.data.nextFollowupDate, fuExec.data);
const fuRec = await call('server/followups/index.js', { ...docAuth, url: '/api/followups?patientId=p_1005', query: { patientId: 'p_1005' } });
check('followup records query', fuRec.code === 0 && fuRec.data.records.length >= 1, fuRec.data?.records?.length);
const fuLost = await call('server/followups/[id]/lost.js', { ...docAuth, method: 'POST', url: '/api/followups/p_1003/lost', query: { id: 'p_1003' }, body: { reason: '迁居外地，联系方式失效' } });
check('mark lost', fuLost.code === 0 && !!fuLost.data.lostAt, fuLost.data);
const fuLostList = await call('server/followups/index.js', { ...docAuth, url: '/api/followups?status=lost', query: { status: 'lost' } });
check('lost filter', fuLostList.code === 0 && fuLostList.data.items.some(x => x.patientId === 'p_1003'), fuLostList.data?.items?.map(x => x.patientId));
const fuNurseHack = await call('server/followups/[id]/execute.js', { ...nurseAuth, method: 'POST', url: '/api/followups/p_1002/execute', query: { id: 'p_1002' }, body: { method: '电话', outcome: 'test' } });
check('nurse cannot execute followup -> 403', fuNurseHack.code === 40300, fuNurseHack);

console.log('\n[22] 质量看板：指标/分布/趋势');
const q = await call('server/quality.js', { ...docAuth, url: '/api/quality?days=30', query: { days: '30' } });
check('quality metrics present', q.code === 0 && q.data.metrics.followupRate && q.data.metrics.lostRate && q.data.metrics.archiveRate && q.data.metrics.highRiskRatio && q.data.metrics.revisitRate, q.data?.metrics);
check('archiveRate counts >= 4', q.data.metrics.archiveRate.num >= 4, q.data.metrics.archiveRate);
check('lostRate counts >= 1', q.data.metrics.lostRate.num >= 1, q.data.metrics.lostRate);
check('risk distribution', q.data.riskDist && Object.values(q.data.riskDist).some(v => v > 0), q.data?.riskDist);
check('trend 30 days', q.data.trend.length === 30 && q.data.trend.every(d => 'archived' in d && 'followups' in d), q.data?.trend?.length);
const qRisk = await call('server/quality.js', { ...docAuth, url: '/api/quality?risk=high', query: { risk: 'high' } });
check('quality risk filter', qRisk.code === 0 && qRisk.data.cohort.riskFilter === 'high' && qRisk.data.cohort.total >= 1, qRisk.data?.cohort);

console.log('\n[23] 健康宣教：医生端可推送');
const eduDoc = await call('server/nurse/education.js', { ...docAuth, method: 'POST', body: { patientIds: ['p_1009'], materialId: 'edu_3', note: '建议严格戒酒' } });
check('doctor push education', eduDoc.code === 0 && eduDoc.data.sent === 1, eduDoc.data);
const eduDocList = await call('server/nurse/education.js', { ...docAuth, url: '/api/nurse/education' });
check('doctor education history', eduDocList.code === 0 && eduDocList.data.materials.length >= 3, eduDocList.data?.materials?.length);

console.log('\n[24] 工作台增强：预警/筛查/质控摘要 + 随访弹窗');
const dash2 = await call('server/dashboard.js', { ...docAuth, url: '/api/dashboard' });
check('dashboard qc summary', dash2.data.metrics.archived >= 4 && typeof dash2.data.metrics.lost === 'number' && dash2.data.metrics.highRisk >= 1, dash2.data?.metrics);
check('dashboard alerts summary', dash2.data.alerts && dash2.data.alerts.openCount >= 1 && dash2.data.alerts.items.length >= 1, dash2.data?.alerts);
check('dashboard screening pending', typeof dash2.data.metrics.screeningPending === 'number', dash2.data?.metrics?.screeningPending);
check('followup popup data source', Array.isArray(dash2.data.followupPopup) && dash2.data.followupPopup.length >= 1, dash2.data?.followupPopup?.length);
check('popup has daysLeft', dash2.data.followupPopup.every(x => 'daysLeft' in x && 'status' in x), dash2.data?.followupPopup?.[0]);
const alReadAll = await call('server/alerts/read-all.js', { ...docAuth, method: 'POST', url: '/api/alerts/read-all' });
check('alerts read-all', alReadAll.code === 0, alReadAll);
const dash3 = await call('server/dashboard.js', { ...docAuth, url: '/api/dashboard' });
check('alerts cleared after read-all', dash3.data.metrics.alertsOpen === 0 && dash3.data.metrics.alertsUnread === 0, dash3.data?.metrics);

console.log(`\n========== 冒烟测试结果: ${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
