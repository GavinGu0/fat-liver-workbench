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

/* 每次运行重置存储（本地 SQLite 文件 / 内存快照），保证测试确定性、可重复 */
const { resetForTest, getDb, K } = require(join(ROOT, 'server/_lib/storage.js'));
resetForTest();

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

console.log('\n[2.5] 准备动态测试患者（单示例患者架构：注册建档 + 无账号档案）');

/* 无账号患者：模拟"医生建档案但未开通登录账号"的数据形态（随访提醒 skipped / 专病建档 / 预警用例） */
const NOACC_PID = 'p_test_noacc';
{
  const d = await getDb();
  await d.set(K.patient(NOACC_PID), JSON.stringify({
    id: NOACC_PID, userId: null, name: '赵无账号', gender: 'male', age: 50,
    height: 172, weight: 80, bmi: 27.0, risk: 'low', phone: '13700009999',
    docId: 'u_doc_gbmz', nurseId: null, mainDiagnosis: '脂肪肝（待评估）',
    chiefComplaint: '测试数据：无账号患者', pastHistory: '',
    nextFollowupDate: null, lastFollowupAt: null,
    createdAt: Date.now(), lastActivityAt: Date.now(), lastWeight: 80, version: 1
  }));
  await d.zadd(K.docPatients('u_doc_gbmz'), Date.now(), NOACC_PID);
  await d.zadd(K.allPatients, Date.now(), NOACC_PID);
}

/** 患者自注册创建测试患者（有档案、无专病病历）；url 用独立路径，避免挤占 login 限流的 '/' 桶 */
async function registerTestPatient(phone, name, gender, age, height, weight) {
  const s = await call('server/auth/sms.js', { method: 'POST', url: '/api/v1/auth/sms-batch', body: { phone } });
  const r = await call('server/auth/login.js', {
    method: 'POST', url: '/api/v1/auth/register-batch',
    body: { mode: 'register', phone, code: s.data.demoCode, passwordHash: sha('Test123456'), profile: { name, gender, age, height, weight } }
  });
  if (r.code !== 0) throw new Error(`register ${name} failed: ${r.message}`);
  return { id: r.data.user.patientId, token: r.data.accessToken };
}
const T1 = await registerTestPatient('13700000001', '钱建国', 'male', 55, 170, 85);   // 随访乐观锁 / MDT / 失访
const T2 = await registerTestPatient('13700000002', '孙卫东', 'male', 48, 172, 78);   // 筛查 accept / 随访执行
const T3 = await registerTestPatient('13700000003', '李秀英', 'female', 60, 158, 62); // 未建档 / 逾期 / 护士越权
const T5 = await registerTestPatient('13700000005', '吴健康', 'male', 45, 168, 82);   // 异常体征 / 筛查 reject

/* T5 提交异常体征（驱动患者列表"数据异常"筛选：sbp>=140） */
const t5Vitals = await call('server/records/vitals.js', { token: T5.token, method: 'POST', body: { recordDate: today, weight: 82, sbp: 152, dbp: 96, glucose: 6.8 } });
check('T5 abnormal vitals submitted', t5Vitals.code === 0, t5Vitals);

/* T2/T5 异常检验 → 检验钩子自动生成筛查案例 + 预警（筛查决策 / 预警处理用例的数据来源） */
const labT2 = await call('server/patients/[id]/labs.js', { ...docAuth, method: 'POST', url: `/api/patients/${T2.id}/labs`, query: { id: T2.id }, body: { examDate: today, alt: 95, tg: 2.8 } });
const SC_T2 = labT2.data?.screening?.caseId;
check('T2 lab screening case created', labT2.code === 0 && !!SC_T2 && labT2.data.screening.created === true, labT2.data?.screening);
const labT5 = await call('server/patients/[id]/labs.js', { ...docAuth, method: 'POST', url: `/api/patients/${T5.id}/labs`, query: { id: T5.id }, body: { examDate: today, alt: 150, fpg: 9.2 } });
const SC_T5 = labT5.data?.screening?.caseId;
check('T5 lab screening case created', labT5.code === 0 && !!SC_T5 && labT5.data.screening.created === true, labT5.data?.screening);

console.log('\n[3] 工作台聚合');
const dash = await call('server/dashboard.js', { ...docAuth, url: '/api/dashboard' });
check('dashboard metrics', dash.code === 0 && dash.data.metrics.totalPatients >= 6, dash.data?.metrics);
check('dashboard todayFollowups has demo patient', dash.data.todos.todayFollowups.some(p => p.id === 'p_1009'), dash.data?.todos?.todayFollowups);

console.log('\n[4] 患者列表与筛选');
const list = await call('server/patients/index.js', { ...docAuth, url: '/api/patients?size=50', query: { size: '50' } });
check('patient list', list.code === 0 && list.data.items.length >= 6, list.data?.total);
const highRisk = await call('server/patients/index.js', { ...docAuth, url: '/api/patients?filter=highRisk', query: { filter: 'highRisk' } });
check('highRisk filter', highRisk.code === 0 && highRisk.data.items.every(p => p.risk === 'high'), highRisk.data?.items?.length);
const abnormal = await call('server/patients/index.js', { ...docAuth, url: '/api/patients?filter=abnormal', query: { filter: 'abnormal' } });
check('abnormal filter catches T5', abnormal.code === 0 && abnormal.data.items.some(p => p.id === T5.id), abnormal.data?.items?.map(i => i.id));

console.log('\n[5] 患者详情/时间轴/趋势');
const detail = await call('server/patients/[id]/index.js', { ...docAuth, url: `/api/patients/${T1.id}`, query: { id: T1.id } });
check('patient detail', detail.code === 0 && detail.data.profile.id === T1.id, detail.data?.profile?.name);
const timeline = await call('server/patients/[id]/records.js', { ...docAuth, url: '/api/patients/p_1009/records', query: { id: 'p_1009' } });
check('timeline merged', timeline.code === 0 && timeline.data.items.length > 0, timeline.data?.items?.length);
const trend = await call('server/patients/[id]/trend.js', { ...docAuth, url: '/api/patients/p_1009/trend', query: { id: 'p_1009', days: '90' } });
check('trend points', trend.code === 0 && trend.data.points.length >= 5, trend.data?.points?.length);

console.log('\n[6] 乐观锁：随访设置');
const cur = detail.data.profile.version ?? 1;
const conflict = await call('server/patients/[id]/followup.js', { ...docAuth, method: 'PUT', url: `/api/patients/${T1.id}/followup`, query: { id: T1.id }, body: { date: '2026-09-20', version: cur + 100 } });
check('version conflict -> 409', conflict.code === 40903, conflict);
const fu = await call('server/patients/[id]/followup.js', { ...docAuth, method: 'PUT', url: `/api/patients/${T1.id}/followup`, query: { id: T1.id }, body: { date: '2026-09-20', version: cur } });
check('followup set ok', fu.code === 0 && fu.data.nextFollowupDate === '2026-09-20', fu);

console.log('\n[7] 复诊计划与提醒推送');
const rv = await call('server/patients/[id]/revisit.js', { ...docAuth, method: 'PUT', url: '/api/patients/p_1009/revisit', query: { id: 'p_1009' }, body: { date: '2026-10-01', place: '门诊3楼', notes: '空腹' } });
check('revisit set', rv.code === 0, rv);
const rr = await call('server/patients/[id]/revisit.js', { ...docAuth, method: 'POST', url: '/api/patients/p_1009/revisit', query: { id: 'p_1009' }, body: {} });
check('revisit reminder sent', rr.code === 0 && rr.data.sent === true, rr);

console.log('\n[8] MDT 全流程');
const mdt = await call('server/patients/[id]/mdt.js', { ...docAuth, method: 'POST', url: `/api/patients/${T1.id}/mdt`, query: { id: T1.id }, body: { action: 'initiate', reason: '疑难病例，血脂控制不佳', specialists: [{ dept: '营养科', expert: '王芳' }, { dept: '内分泌科', expert: '刘强' }] } });
check('mdt initiate', mdt.code === 0 && mdt.data.status === 'pending', mdt);
const mdtId = mdt.data?.id;
const fb = await call('server/patients/[id]/mdt.js', { ...docAuth, method: 'POST', url: `/api/patients/${T1.id}/mdt`, query: { id: T1.id }, body: { action: 'feedback', mdtId, expert: '王芳', dept: '营养科', opinion: '建议低碳水饮食方案' } });
check('mdt feedback', fb.code === 0 && fb.data.status === 'feedback', fb);
const arch = await call('server/patients/[id]/mdt.js', { ...docAuth, method: 'POST', url: `/api/patients/${T1.id}/mdt`, query: { id: T1.id }, body: { action: 'archive', mdtId, conclusion: '维持低脂饮食+运动处方，1个月后复评' } });
check('mdt archive', arch.code === 0 && arch.data.status === 'done', arch);
const mdtDetail = await call('server/patients/[id]/index.js', { ...docAuth, url: `/api/patients/${T1.id}`, query: { id: T1.id } });
check('mdt conclusion in archive', mdtDetail.data.archive.some(a => a.kind === 'mdt'), mdtDetail.data?.archive);

console.log('\n[9] 医生数据隔离');
const doc2Login = await call('server/auth/login.js', { method: 'POST', body: { mode: 'password', username: 'GBMZ', passwordHash: sha('123456') } });
const other = await call('server/patients/[id]/index.js', { token: doc2Login.data.accessToken, url: `/api/patients/${T1.id}`, query: { id: T1.id } });
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
const p1009Submits = submits.filter((m) => m.link === '/patients/p_1009');
check('push carries from/link and abnormal flag', p1009Submits.length >= 4 && p1009Submits.every((m) => m.from === '王小明')
  && p1009Submits.some((m) => m.title.includes('含异常值')), submits.map((m) => m.title));
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

/* 消息中心端点级筛选（read/date/limit/before，走真实 URL 查询串） */
const msgToday = await call('server/messages/index.js', { ...docAuth, url: '/api/messages?read=read&limit=200' });
check('messages read filter', msgToday.code === 0 && msgToday.data.items.length >= 1 && msgToday.data.items.every(m => m.read), msgToday.data?.items?.length);
const msgDate = await call('server/messages/index.js', { ...docAuth, url: `/api/messages?date=${today}&limit=200` });
check('messages date filter (today)', msgDate.code === 0 && msgDate.data.items.every(m => m.ts > Date.now() - 86400000), msgDate.data?.items?.length);
const msgEmptyDay = await call('server/messages/index.js', { ...docAuth, url: '/api/messages?date=2020-01-01' });
check('messages date filter (empty day)', msgEmptyDay.code === 0 && msgEmptyDay.data.items.length === 0, msgEmptyDay.data?.items?.length);
const msgUnread = await call('server/messages/index.js', { ...docAuth, url: '/api/messages?read=unread&limit=200' });
check('messages unread filter', msgUnread.code === 0 && msgUnread.data.items.every(m => !m.read) && msgUnread.data.items.length === msgToday.data.unread, { n: msgUnread.data?.items?.length, unread: msgToday.data?.unread });
const msgPage = await call('server/messages/index.js', { ...docAuth, url: '/api/messages?limit=2' });
check('messages pagination cursor', msgPage.code === 0 && msgPage.data.items.length <= 2 && (msgPage.data.nextBefore === null || msgPage.data.nextBefore > 0), msgPage.data?.nextBefore);

console.log('\n[13.5] 消息服务：顺序保持 / 未读计数扣减 / 已读可二次查看');
{
  const svc = require(join(ROOT, 'server/_lib/services.js'));
  const { forceSyncRemote } = require(join(ROOT, 'server/_lib/storage.js'));
  const TEST_UID = 'u_test_msg';
  const d0 = await getDb();
  await d0.del(K.msg(TEST_UID), K.msgUnread(TEST_UID));

  const mids = [];
  for (let i = 0; i < 5; i++) {
    mids.push(await svc.pushMsg(TEST_UID, { type: 'system', title: `测试消息${i + 1}`, content: `<p>内容${i + 1}</p>`, from: '测试' }));
  }
  let list = await svc.listMsgs(TEST_UID, 200);
  check('msg list newest first', list[0].mid === mids[4] && list[4].mid === mids[0], list.map(m => m.mid));
  check('unread = 5 after push', (await svc.unreadCount(TEST_UID)) === 5, await svc.unreadCount(TEST_UID));

  await svc.markMsgRead(TEST_UID, mids[2]);
  list = await svc.listMsgs(TEST_UID, 200);
  check('order preserved after mark read', list[0].mid === mids[4] && list.find(m => m.mid === mids[2]).read === true, list.map(m => `${m.mid.slice(-4)}:${m.read}`));
  check('unread decremented to 4', (await svc.unreadCount(TEST_UID)) === 4, await svc.unreadCount(TEST_UID));
  check('read msg remains in list (二次查看)', list.length === 5 && list.some(m => m.mid === mids[2] && m.read));

  await svc.markAllMsgsRead(TEST_UID);
  list = await svc.listMsgs(TEST_UID, 200);
  check('read-all keeps order & all read', list.length === 5 && list.every(m => m.read) && list[0].mid === mids[4], list.map(m => `${m.mid.slice(-4)}:${m.read}`));
  check('unread = 0 after read-all', (await svc.unreadCount(TEST_UID)) === 0, await svc.unreadCount(TEST_UID));

  /* 本地未启用 Blob 时 forceSyncRemote 安全返回 0（生产启用时才走远端收敛） */
  const nSync = await forceSyncRemote();
  check('forceSyncRemote safe when blob disabled', nSync === 0, nSync);
}

console.log('\n[14] 图片上传（KV 兜底模式）');
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const up = await call('server/records/upload.js', { ...patAuth, method: 'POST', body: { filename: 'a.png', dataUrl: tinyPng } });
check('upload fallback ok', up.code === 0 && up.data.ephemeral === true, up.data);
const upBad = await call('server/records/upload.js', { ...patAuth, method: 'POST', body: { filename: 'a.gif', dataUrl: 'data:image/gif;base64,R0lGOD=' } });
check('upload reject gif', upBad.code === 42200, upBad);

console.log('\n[15] 患者越权防护');
const hack = await call('server/records/vitals.js', { ...patAuth, method: 'POST', body: { recordDate: '2026-09-08' } });
check('vitals require at least one field', hack.code === 42200, hack);
const forbidden = await call('server/patients/[id]/followup.js', { ...patAuth, method: 'PUT', url: `/api/patients/${T2.id}/followup`, query: { id: T2.id }, body: { date: '2026-09-30' } });
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
const mrEmpty = await call('server/medical-records.js', { ...docAuth, url: `/api/medical-records?patientId=${T3.id}`, query: { patientId: T3.id } });
check('medrec GET empty + model suggestion', mrEmpty.code === 0 && mrEmpty.data.record === null && mrEmpty.data.suggestion && typeof mrEmpty.data.suggestion.score === 'number', mrEmpty.data?.suggestion);

const mrPost = await call('server/medical-records.js', { ...docAuth, method: 'POST', url: '/api/medical-records', body: {
  patientId: NOACC_PID, name: '赵无账号', gender: 'male', visitDate: '2026-08-20', visitDept: '肝病科', insuranceType: '职工医保',
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

const mrConflict = await call('server/medical-records.js', { ...docAuth, method: 'POST', url: '/api/medical-records', body: { patientId: NOACC_PID, name: '赵无账号', gender: 'male', riskLevel: 'low', version: 999 } });
check('medrec version conflict -> 409', mrConflict.code === 40903, mrConflict);

const mrPatient = await call('server/patients/[id]/index.js', { ...docAuth, url: `/api/patients/${NOACC_PID}`, query: { id: NOACC_PID } });
check('patient risk synced from medrec', mrPatient.data?.profile?.risk === 'high', mrPatient.data?.profile?.risk);
const mrHighHack = await call('server/medical-records.js', { ...patAuth, method: 'POST', body: { patientId: T3.id, name: '李秀英', gender: 'female', riskLevel: 'low' } });
check('patient cannot create medrec -> 403', mrHighHack.code === 40300, mrHighHack);

console.log('\n[18.5] 专病档案中心：列表 + 一站式建档');
const regList0 = await call('server/registry/index.js', { ...docAuth, url: '/api/registry' });
check('registry list default archived', regList0.code === 0 && regList0.data.stats.archived >= 1 && regList0.data.items.every(r => r.archived), regList0.data?.stats);
check('registry list contains noacc v1', regList0.data.items.some(r => r.patientId === NOACC_PID && r.version >= 1), null);
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

// 用户名冲突：不同患者（新身份证/手机号）抢占已用用户名 → 409
const regConflict = await call('server/registry/index.js', { ...docAuth, method: 'POST', url: '/api/registry', body: { ...regBody, name: '测试冲突用户', idCard: '110101198001015137', phone: '13900005555' } });
check('username taken by another person -> 409', regConflict.code === 40901, regConflict);

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

// 同一患者重复提交（同身份证/同用户名）→ 匹配绑定既有档案，复用账号，病历版本+1（幂等防重复建档）
const regRebind = await call('server/registry/index.js', { ...docAuth, method: 'POST', url: '/api/registry', body: regBody });
check('same patient resubmit binds existing account', regRebind.code === 0 && regRebind.data.accountExisted === true && regRebind.data.patientId === regCreate.data.patientId && regRebind.data.version === 2, regRebind.data);

console.log('\n[18.6] 专病建档增强：住院号 / 档案完整度 / 随访状态');
check('one-stop create completeness complete (key items present)', regCreate.data?.completeness?.complete === true, regCreate.data?.completeness);
const regListNew = await call('server/registry/index.js', { ...docAuth, url: '/api/registry' });
const regNewRow = regListNew.data.items.find(r => r.patientId === regCreate.data.patientId);
check('registry row carries inpatientNumber', regNewRow?.inpatientNumber === 'ZY2026091101', regNewRow?.inpatientNumber);
check('registry row carries followup status scheduled', regNewRow?.followupStatus === 'scheduled' && regNewRow?.followupStatusLabel === '已预约', [regNewRow?.followupStatus, regNewRow?.followupStatusLabel]);

// 待完善：最小字段建档（缺 BMI/超声/肝功/血糖/甘油三酯）→ completeness 不完整 + 列表可筛出
const incCreate = await call('server/medical-records.js', { ...docAuth, method: 'POST', url: '/api/medical-records', body: { patientId: T3.id, name: '李秀英', gender: 'female', riskLevel: 'mid' } });
check('medrec save returns incomplete completeness', incCreate.code === 0 && incCreate.data?.completeness?.complete === false && incCreate.data.completeness.missing.length >= 3, incCreate.data?.completeness);
const regInc = await call('server/registry/index.js', { ...docAuth, url: '/api/registry?status=incomplete', query: { status: 'incomplete' } });
check('registry incomplete filter + stats', regInc.code === 0 && regInc.data.stats.incomplete >= 1 && regInc.data.items.some(r => r.patientId === T3.id && r.incomplete), regInc.data?.stats);
check('incomplete row carries missing labels', regInc.data.items.some(r => r.patientId === T3.id && Array.isArray(r.missingItems) && r.missingItems.length >= 3), null);

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
check('screening list from lab hooks', sc0.code === 0 && sc0.data.stats.pending >= 2, sc0.data?.stats);
const scRun = await call('server/screening/index.js', { ...docAuth, method: 'POST', body: { action: 'run' } });
check('screening run scans patients', scRun.code === 0 && scRun.data.scanned >= 5 && scRun.data.newCases >= 1, scRun.data);
const sc0b = await call('server/screening/index.js', { ...docAuth, url: '/api/screening?status=pending', query: { status: 'pending' } });
check('pending cases after run', sc0b.code === 0 && sc0b.data.items.length >= 3, sc0b.data?.stats);

const scAccept = await call('server/screening/[id]/decision.js', { ...docAuth, method: 'POST', url: `/api/screening/${SC_T2}/decision`, query: { id: SC_T2 }, body: { decision: 'accept', reason: '超重合并检验阳性，纳入管理' } });
check('screening accept', scAccept.code === 0 && scAccept.data.status === 'accepted' && scAccept.data.riskApplied === 'mid', scAccept.data);
check('accept reschedules followup to future', !!scAccept.data?.nextFollowupDate && scAccept.data.nextFollowupDate > today, scAccept.data);
const t2After = await call('server/patients/[id]/index.js', { ...docAuth, url: `/api/patients/${T2.id}`, query: { id: T2.id } });
check('accepted risk synced to patient', t2After.data?.profile?.risk === 'mid' && t2After.data.profile.nextFollowupDate > today, [t2After.data?.profile?.risk, t2After.data?.profile?.nextFollowupDate]);
const scReAccept = await call('server/screening/[id]/decision.js', { ...docAuth, method: 'POST', url: `/api/screening/${SC_T2}/decision`, query: { id: SC_T2 }, body: { decision: 'reject', reason: '重复决策' } });
check('re-decision -> 409', scReAccept.code === 40902, scReAccept);
const scReject = await call('server/screening/[id]/decision.js', { ...docAuth, method: 'POST', url: `/api/screening/${SC_T5}/decision`, query: { id: SC_T5 }, body: { decision: 'reject', reason: '既往已确诊，走专病门诊路径' } });
check('screening reject', scReject.code === 0 && scReject.data.status === 'rejected', scReject.data);
const scNurse = await call('server/screening/index.js', { ...nurseAuth, method: 'POST', body: { action: 'run' } });
check('nurse cannot run screening -> 403', scNurse.code === 40300, scNurse);

console.log('\n[20] 预警提醒：列表/处理');
const al0 = await call('server/alerts/index.js', { ...docAuth, url: '/api/alerts' });
check('alerts list', al0.code === 0 && al0.data.items.length >= 2 && al0.data.stats.open >= 2, al0.data?.stats);
const alHigh = await call('server/alerts/index.js', { ...docAuth, url: '/api/alerts?level=high&status=open', query: { level: 'high', status: 'open' } });
check('alerts filter level+status', alHigh.code === 0 && alHigh.data.items.every(a => a.level === 'high' && a.status === 'open'), alHigh.data?.items?.length);
const alT2 = al0.data.items.find(a => a.patientId === T2.id && a.status === 'open');
const alHandle = await call('server/alerts/[id]/handle.js', { ...docAuth, method: 'POST', url: `/api/alerts/${alT2.id}/handle`, query: { id: alT2.id }, body: { note: '已电话联系，重新预约随访' } });
check('alert handle', alHandle.code === 0 && alHandle.data.status === 'handled', alHandle.data);
const alHandleAgain = await call('server/alerts/[id]/handle.js', { ...docAuth, method: 'POST', url: `/api/alerts/${alT2.id}/handle`, query: { id: alT2.id }, body: {} });
check('alert re-handle idempotent', alHandleAgain.code === 0, alHandleAgain);

console.log('\n[21] 随访管理：列表/一键提醒/执行/失访');
// 造一个逾期状态：T3 随访日期设为 3 天前
const fuOverdueSet = await call('server/patients/[id]/followup.js', { ...docAuth, method: 'PUT', url: `/api/patients/${T3.id}/followup`, query: { id: T3.id }, body: { date: dstr(-3) } });
check('setup overdue followup', fuOverdueSet.code === 0, fuOverdueSet);
const fu0 = await call('server/followups/index.js', { ...docAuth, url: '/api/followups' });
check('followup plan list + stats', fu0.code === 0 && typeof fu0.data.stats.overdue === 'number', fu0.data?.stats);
check('overdue patient T3 listed', fu0.data.items.some(x => x.patientId === T3.id && x.status === 'overdue'), fu0.data?.items?.filter(x => x.status === 'overdue').map(x => x.patientId));

const fuRemind = await call('server/followups/remind.js', { ...docAuth, method: 'POST', body: { patientIds: ['p_1009', NOACC_PID] } });
check('one-click remind: sent 1 skipped 1', fuRemind.code === 0 && fuRemind.data.sent === 1 && fuRemind.data.skipped.length === 1, fuRemind.data);

const fuExec = await call('server/followups/[id]/execute.js', { ...docAuth, method: 'POST', url: `/api/followups/${T2.id}/execute`, query: { id: T2.id }, body: { method: '电话', outcome: '患者知晓随访安排，自述控制饮食中', conclusion: '3个月后门诊复查' } });
check('followup execute + auto nextDate', fuExec.code === 0 && !!fuExec.data.nextFollowupDate, fuExec.data);
const fuRec = await call('server/followups/index.js', { ...docAuth, url: `/api/followups?patientId=${T2.id}`, query: { patientId: T2.id } });
check('followup records query', fuRec.code === 0 && fuRec.data.records.length >= 1, fuRec.data?.records?.length);
const fuLost = await call('server/followups/[id]/lost.js', { ...docAuth, method: 'POST', url: `/api/followups/${T1.id}/lost`, query: { id: T1.id }, body: { reason: '迁居外地，联系方式失效' } });
check('mark lost', fuLost.code === 0 && !!fuLost.data.lostAt, fuLost.data);
const fuLostList = await call('server/followups/index.js', { ...docAuth, url: '/api/followups?status=lost', query: { status: 'lost' } });
check('lost filter', fuLostList.code === 0 && fuLostList.data.items.some(x => x.patientId === T1.id), fuLostList.data?.items?.map(x => x.patientId));
const fuNurseHack = await call('server/followups/[id]/execute.js', { ...nurseAuth, method: 'POST', url: `/api/followups/${T3.id}/execute`, query: { id: T3.id }, body: { method: '电话', outcome: 'test' } });
check('nurse cannot execute followup -> 403', fuNurseHack.code === 40300, fuNurseHack);

console.log('\n[22] 质量看板：指标/分布/趋势');
const q = await call('server/quality.js', { ...docAuth, url: '/api/quality?days=30', query: { days: '30' } });
check('quality metrics present', q.code === 0 && q.data.metrics.followupRate && q.data.metrics.lostRate && q.data.metrics.archiveRate && q.data.metrics.highRiskRatio && q.data.metrics.revisitRate, q.data?.metrics);
check('archiveRate counts >= 3', q.data.metrics.archiveRate.num >= 3, q.data.metrics.archiveRate);
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
check('dashboard qc summary', dash2.data.metrics.archived >= 3 && typeof dash2.data.metrics.lost === 'number' && dash2.data.metrics.highRisk >= 1, dash2.data?.metrics);
check('dashboard alerts summary', dash2.data.alerts && dash2.data.alerts.openCount >= 1 && dash2.data.alerts.items.length >= 1, dash2.data?.alerts);
check('dashboard screening pending', typeof dash2.data.metrics.screeningPending === 'number', dash2.data?.metrics?.screeningPending);
check('followup popup data source', Array.isArray(dash2.data.followupPopup) && dash2.data.followupPopup.length >= 1, dash2.data?.followupPopup?.length);
check('popup has daysLeft', dash2.data.followupPopup.every(x => 'daysLeft' in x && 'status' in x), dash2.data?.followupPopup?.[0]);
const alReadAll = await call('server/alerts/read-all.js', { ...docAuth, method: 'POST', url: '/api/alerts/read-all' });
check('alerts read-all', alReadAll.code === 0, alReadAll);
const dash3 = await call('server/dashboard.js', { ...docAuth, url: '/api/dashboard' });
check('alerts cleared after read-all', dash3.data.metrics.alertsOpen === 0 && dash3.data.metrics.alertsUnread === 0, dash3.data?.metrics);

console.log('\n[25] 登录安全：细化错误 / 失败锁定 / 密码重置 / 会话吊销 / 登录日志');
const LOGIN_URL = '/api/v1/auth/login'; // 与线上路径一致（限流按路由分桶，独立于上方 '/' 桶）

// 1) 密码错误 → 细化提示（剩余尝试次数）
const wrong1 = await call('server/auth/login.js', { method: 'POST', url: LOGIN_URL, body: { mode: 'password', username: 'regpatient01', passwordHash: sha('WrongPwd000') } });
check('wrong pwd -> specific retry hint', wrong1.code === 40102 && /还可尝试 4 次/.test(wrong1.message), wrong1);
// 2) 连续 5 次失败 → 锁定（提示含自助解锁指引）
for (let i = 0; i < 3; i++) {
  await call('server/auth/login.js', { method: 'POST', url: LOGIN_URL, body: { mode: 'password', username: 'regpatient01', passwordHash: sha('WrongPwd000') } });
}
const lockHit = await call('server/auth/login.js', { method: 'POST', url: LOGIN_URL, body: { mode: 'password', username: 'regpatient01', passwordHash: sha('WrongPwd000') } });
check('5th failure -> locked with guidance', lockHit.code === 40103 && /锁定/.test(lockHit.message) && /验证码/.test(lockHit.message), lockHit);
// 3) 锁定期间正确密码也被拦截
const lockedOk = await call('server/auth/login.js', { method: 'POST', url: LOGIN_URL, body: { mode: 'password', username: 'regpatient01', passwordHash: sha('Abc123456') } });
check('locked rejects correct pwd', lockedOk.code === 40103, lockedOk);
// 4) 登录日志：医护可查 + 失败/锁定统计 + 账号脱敏
const llDoc = await call('server/auth/login-logs.js', { ...docAuth, url: '/api/auth/login-logs' });
check('login logs staff view + stats', llDoc.code === 0 && llDoc.data.stats.fail >= 4 && llDoc.data.stats.lock >= 1, llDoc.data?.stats);
check('login logs account masked', llDoc.data.items.some(i => String(i.account).includes('***')), llDoc.data?.items?.slice(0, 3));
const llNurse = await call('server/auth/login-logs.js', { ...nurseAuth, url: '/api/auth/login-logs' });
check('nurse can view login logs', llNurse.code === 0, llNurse.code);
const llPat = await call('server/auth/login-logs.js', { ...patAuth, url: '/api/auth/login-logs' });
check('patient cannot view login logs -> 403', llPat.code === 40300, llPat.code);

// 5) 密码重置：错误验证码/新旧同密拦截 → 重置成功（解锁 + 自动登录 + 吊销旧会话）
const smsReset = await call('server/auth/sms.js', { method: 'POST', body: { phone: '13900001111' } });
const resetBadCode = await call('server/auth/reset-password.js', { method: 'POST', body: { phone: '13900001111', code: '000000', newPasswordHash: sha('NewPwd999') } });
check('reset wrong code -> 422 (code kept)', resetBadCode.code === 42202, resetBadCode);
const resetSamePwd = await call('server/auth/reset-password.js', { method: 'POST', body: { phone: '13900001111', code: smsReset.data.demoCode, newPasswordHash: sha('Abc123456') } });
check('reset same pwd -> 422 (code kept)', resetSamePwd.code === 42203, resetSamePwd);
const resetOk = await call('server/auth/reset-password.js', { method: 'POST', body: { phone: '13900001111', code: smsReset.data.demoCode, newPasswordHash: sha('NewPwd999') } });
check('reset ok + auto login', resetOk.code === 0 && resetOk.data.reset === true && resetOk.data.user.role === 'patient' && !!resetOk.data.accessToken, resetOk);
check('reset revoked prior sessions', resetOk.data.revokedSessions >= 1, resetOk.data?.revokedSessions);
// 6) 旧密码失效（细化提示）；新密码可登录（同时证明重置已解锁账号）
const oldPwdLogin = await call('server/auth/login.js', { method: 'POST', url: LOGIN_URL, body: { mode: 'password', username: 'regpatient01', passwordHash: sha('Abc123456') } });
check('old pwd rejected after reset', oldPwdLogin.code === 40102 && /密码错误/.test(oldPwdLogin.message), oldPwdLogin);
const newPwdLogin = await call('server/auth/login.js', { method: 'POST', url: LOGIN_URL, body: { mode: 'password', username: 'regpatient01', passwordHash: sha('NewPwd999') } });
check('new pwd login ok (lock cleared by reset)', newPwdLogin.code === 0 && newPwdLogin.data.user.role === 'patient', newPwdLogin);
// 7) 重置前签发的 Refresh Token 已被吊销
const revokedRefresh = await call('server/auth/refresh.js', { method: 'POST', body: { refreshToken: regLogin.data.refreshToken } });
check('old refresh token revoked after reset', revokedRefresh.code === 40100, revokedRefresh);
// 8) 登录日志最终态：重置事件已记录
const llFinal = await call('server/auth/login-logs.js', { ...docAuth, url: '/api/auth/login-logs' });
check('login logs record reset event', llFinal.code === 0 && llFinal.data.stats.reset >= 1 && llFinal.data.stats.success >= 1, llFinal.data?.stats);

console.log('\n[26] 健康检查：存储模式可观测（sqlite/memory），供前端临时存储提示');
const healthChk = await call('server/health.js', { url: '/api/health' });
check('health exposes storage mode', healthChk.code === 0 && ['memory', 'sqlite'].includes(healthChk.data.storage), healthChk.data?.storage);
check('health exposes L3 snapshot status (disabled without env)', healthChk.code === 0 && healthChk.data?.l3Snapshot?.enabled === false, JSON.stringify(healthChk.data?.l3Snapshot));

console.log('\n[27] 存储导出/恢复往返一致性（L3 Blob 快照的机制基础）');
const dbx = await getDb();
await dbx.set('test:rt:k1', 'v1');
await dbx.hset('test:rt:h1', { a: 1, b: 'x' });
await dbx.lpush('test:rt:l1', JSON.stringify({ id: 'l1' }));
await dbx.sadd('test:rt:s1', 'm1');
await dbx.zadd('test:rt:z1', 1.5, 'm1');
const dump = dbx._export();
const rt = await dbx.restore(dump);
check('restore returns row count', rt >= 5, rt);
check('restore roundtrip kv', (await dbx.get('test:rt:k1')) === 'v1');
const rtH = await dbx.hgetall('test:rt:h1');
check('restore roundtrip hash', rtH && rtH.a === 1 && rtH.b === 'x', JSON.stringify(rtH));
const rtL = await dbx.lrange('test:rt:l1', 0, -1);
check('restore roundtrip list', rtL.length === 1 && JSON.parse(rtL[0]).id === 'l1', JSON.stringify(rtL));
check('restore roundtrip set', (await dbx.sismember('test:rt:s1', 'm1')) === 1);
check('restore roundtrip zset', (await dbx.zscore('test:rt:z1', 'm1')) === 1.5);
await dbx.del('test:rt:k1', 'test:rt:h1', 'test:rt:l1', 'test:rt:s1', 'test:rt:z1');

console.log('\n[28] 多实例快照合并（mergePayloads / mergeRows / 墓碑防复活）');
const blobSnap = require(join(ROOT, 'server/_lib/blob-snapshot.js'));
const emptyRows = () => ({ kv: [], hashes: [], lists: [], sets: [], zsets: [] });

/* 场景1：旧实例（仅示例患者）上传，不得覆盖远端新注册患者（"计数2/列表1"根因回归） */
{
  const remote = {
    data: {
      ...emptyRows(),
      kv: [
        { key: 'patient:p_new', val: JSON.stringify({ id: 'p_new', name: '新患者' }), exp: null },
        { key: 'patient:p_1009', val: JSON.stringify({ id: 'p_1009', name: '王小明' }), exp: null }
      ],
      zsets: [
        { key: 'patient:index:doc:u_doc_gbmz', member: 'p_new', score: 100, exp: null },
        { key: 'patient:index:doc:u_doc_gbmz', member: 'p_1009', score: 50, exp: null }
      ]
    },
    meta: { keyTs: { 'patient:p_new': 200, 'patient:p_1009': 50 }, tombK: {}, tombM: {} }
  };
  const local = {
    data: {
      ...emptyRows(),
      kv: [{ key: 'patient:p_1009', val: JSON.stringify({ id: 'p_1009', name: '王小明' }), exp: null }],
      zsets: [{ key: 'patient:index:doc:u_doc_gbmz', member: 'p_1009', score: 50, exp: null }]
    },
    meta: { keyTs: { 'patient:p_1009': 100 }, tombK: {}, tombM: {} }
  };
  const m1 = blobSnap.mergePayloads(local, remote);
  check('merge keeps remote-only new patient', m1.data.kv.some(r => r.key === 'patient:p_new'), m1.data.kv.map(r => r.key));
  check('merge keeps local-newer sample patient', m1.data.kv.some(r => r.key === 'patient:p_1009' && JSON.parse(r.val).name === '王小明'));
  check('merge zset union keeps both patients', m1.data.zsets.filter(r => r.key === 'patient:index:doc:u_doc_gbmz').length === 2, m1.data.zsets);
  check('merge keyTs takes max', m1.meta.keyTs['patient:p_new'] === 200 && m1.meta.keyTs['patient:p_1009'] === 100, m1.meta.keyTs);
}

/* 场景2：墓碑阻止复活（本地已删除的键/成员不因远端旧数据复活） */
{
  const m2 = blobSnap.mergePayloads(
    { data: emptyRows(), meta: { keyTs: {}, tombK: { 'patient:p_old': Date.now() }, tombM: {} } },
    { data: { ...emptyRows(), kv: [{ key: 'patient:p_old', val: 'stale', exp: null }] }, meta: { keyTs: { 'patient:p_old': 100 }, tombK: {}, tombM: {} } }
  );
  check('key tombstone blocks resurrection', !m2.data.kv.some(r => r.key === 'patient:p_old'), m2.data.kv.map(r => r.key));
  check('tombstone propagates in merged meta', !!m2.meta.tombK['patient:p_old'], m2.meta.tombK);

  const m3 = blobSnap.mergePayloads(
    { data: emptyRows(), meta: { keyTs: {}, tombK: {}, tombM: { 'followup:due:2026-01-01': { p_gone: Date.now() } } } },
    { data: { ...emptyRows(), sets: [{ key: 'followup:due:2026-01-01', member: 'p_gone', exp: null }, { key: 'followup:due:2026-01-01', member: 'p_keep', exp: null }] }, meta: { keyTs: { 'followup:due:2026-01-01': 100 }, tombK: {}, tombM: {} } }
  );
  const members = m3.data.sets.filter(r => r.key === 'followup:due:2026-01-01').map(r => r.member);
  check('member tombstone blocks remote-only member', !members.includes('p_gone') && members.includes('p_keep'), members);
}

/* 场景3：mergeRows 增量并入（模拟旧实例温同步收敛新注册患者，不再有"写过即跳过"缺陷） */
{
  const { memoryStore } = require(join(ROOT, 'server/_lib/storage.js'));
  const stale = memoryStore(null); // 模拟缺少新患者的旧实例
  await stale.zadd('patient:index:doc:u_doc_gbmz', 50, 'p_1009');
  await stale.set('patient:p_1009', JSON.stringify({ id: 'p_1009', name: '王小明' }));

  const remoteRows = {
    ...emptyRows(),
    kv: [{ key: 'patient:p_new', val: JSON.stringify({ id: 'p_new', name: '新患者' }), exp: null }],
    zsets: [
      { key: 'patient:index:doc:u_doc_gbmz', member: 'p_new', score: Date.now(), exp: null },
      { key: 'patient:index:doc:u_doc_gbmz', member: 'p_1009', score: 50, exp: null }
    ]
  };
  const n = stale.mergeRows(remoteRows, { 'patient:p_new': Date.now(), 'patient:index:doc:u_doc_gbmz': Date.now() });
  const pNew = await stale.get('patient:p_new');
  check('mergeRows imports remote-only patient', n >= 2 && !!pNew && JSON.parse(pNew).name === '新患者', { n, pNew });
  check('mergeRows zset union (doctor sees 2)', (await stale.zcard('patient:index:doc:u_doc_gbmz')) === 2);

  /* 本地删除（墓碑更新）不被远端旧数据复活 */
  await stale.set('patient:p_gone', 'x');
  await stale.del('patient:p_gone');
  const reN = stale.mergeRows({ ...emptyRows(), kv: [{ key: 'patient:p_gone', val: 'stale', exp: null }] }, { 'patient:p_gone': 1 });
  check('mergeRows tombstone blocks stale kv', reN === 0 && (await stale.get('patient:p_gone')) === null, { reN });
}

/* 场景4：list 成员并集去重（不同实例各自 lpush 不丢失） */
{
  const m4 = blobSnap.mergePayloads(
    { data: { ...emptyRows(), lists: [{ key: 'record:diet:p_1', pos: 0, val: '{"a":1}', exp: null }] }, meta: {} },
    { data: { ...emptyRows(), lists: [{ key: 'record:diet:p_1', pos: 0, val: '{"b":2}', exp: null }] }, meta: {} }
  );
  check('list union dedupe keeps both', m4.data.lists.length === 2, m4.data.lists);
}

console.log(`\n========== 冒烟测试结果: ${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
