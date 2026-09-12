import { http } from './request';

export const api = {
  /* 认证 */
  login: (data) => http.post('/auth/login', data),
  sendSms: (phone) => http.post('/auth/sms', { phone }),
  logout: (refreshToken) => http.post('/auth/logout', { refreshToken }),
  config: () => http.get('/config'),

  /* 消息中心（医护端） */
  messages: () => http.get('/messages'),
  readMessage: (mid) => http.post(`/messages/${mid}/read`),
  readAllMessages: () => http.post('/messages/read-all'),

  /* 医生 · 工作台 */
  dashboard: () => http.get('/dashboard'),

  /* 医生 · 患者 */
  patients: (params) => http.get('/patients', { params }),
  patientDetail: (id) => http.get(`/patients/${id}`),
  patientRecords: (id, params) => http.get(`/patients/${id}/records`, { params }),
  patientTrend: (id, params) => http.get(`/patients/${id}/trend`, { params }),
  setFollowup: (id, data) => http.put(`/patients/${id}/followup`, data),
  batchFollowup: (data) => http.post('/patients/followup-batch', data),
  setRevisit: (id, data) => http.put(`/patients/${id}/revisit`, data),
  sendRevisitReminder: (id) => http.post(`/patients/${id}/revisit`, {}),
  patientLabs: (id, params) => http.get(`/patients/${id}/labs`, { params }),
  addLab: (id, data) => http.post(`/patients/${id}/labs`, data),
  patientMdt: (id) => http.get(`/patients/${id}/mdt`),

  /* MDT */
  mdtList: () => http.get('/mdt'),
  mdtAction: (id, data) => http.post(`/patients/${id}/mdt`, data),

  /* 医生 · 专病建档 */
  registryList: (params) => http.get('/registry', { params }),
  createRegistry: (data) => http.post('/registry', data),
  deleteRegistry: (patientId) => http.delete(`/registry/${patientId}`),
  medicalRecord: (patientId) => http.get('/medical-records', { params: { patientId } }),
  saveMedicalRecord: (data) => http.post('/medical-records', data),

  /* 医生 · 筛查识别 */
  screeningList: (params) => http.get('/screening', { params }),
  screeningRun: () => http.post('/screening', { action: 'run' }),
  screeningManual: (data) => http.post('/screening', data),
  screeningDecision: (id, data) => http.post(`/screening/${id}/decision`, data),

  /* 医生 · 预警提醒 */
  alerts: (params) => http.get('/alerts', { params }),
  alertHandle: (id, data) => http.post(`/alerts/${id}/handle`, data),
  alertsReadAll: () => http.post('/alerts/read-all'),

  /* 医生 · 随访管理 */
  followups: (params) => http.get('/followups', { params }),
  followupRecords: (patientId) => http.get('/followups', { params: { patientId } }),
  followupExecute: (id, data) => http.post(`/followups/${id}/execute`, data),
  followupLost: (id, data) => http.post(`/followups/${id}/lost`, data),
  followupRemind: (data) => http.post('/followups/remind', data),

  /* 医生 · 质量看板 */
  quality: (params) => http.get('/quality', { params }),

  /* 护理端 */
  education: () => http.get('/nurse/education'),
  pushEducation: (data) => http.post('/nurse/education', data),
  guidance: (params) => http.get('/nurse/guidance', { params }),
  createGuidance: (data) => http.post('/nurse/guidance', data),
  templates: () => http.get('/nurse/templates'),
  submitAssessment: (data) => http.post('/nurse/templates', data),
  report: (id) => http.get(`/reports/${id}`)
};
