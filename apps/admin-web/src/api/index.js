import { http } from './request';

export const api = {
  /* 认证 */
  login: (data) => http.post('/auth/login', data),
  sendSms: (phone) => http.post('/auth/sms', { phone }),
  logout: (refreshToken) => http.post('/auth/logout', { refreshToken }),
  config: () => http.get('/config'),

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

  /* 护理端 */
  education: () => http.get('/nurse/education'),
  pushEducation: (data) => http.post('/nurse/education', data),
  guidance: (params) => http.get('/nurse/guidance', { params }),
  createGuidance: (data) => http.post('/nurse/guidance', data),
  templates: () => http.get('/nurse/templates'),
  submitAssessment: (data) => http.post('/nurse/templates', data),
  report: (id) => http.get(`/reports/${id}`)
};
