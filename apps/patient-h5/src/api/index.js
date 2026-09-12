import { http } from './request';

export const api = {
  login: (data) => http.post('/auth/login', data),
  sendSms: (phone) => http.post('/auth/sms', { phone }),
  resetPassword: (data) => http.post('/auth/reset-password', data),
  logout: (refreshToken) => http.post('/auth/logout', { refreshToken }),
  messages: () => http.get('/messages'),
  markRead: (mid) => http.post(`/messages/${mid}/read`),
  markAllRead: () => http.post('/messages/read-all'),
  myDetail: () => http.get(`/patients/${myPid()}`),
  myRecords: (params) => http.get(`/patients/${myPid()}/records`, { params }),
  myTrend: (params) => http.get(`/patients/${myPid()}/trend`, { params }),
  submitDiet: (data) => http.post('/records/diet', data),
  submitExercise: (data) => http.post('/records/exercise', data),
  submitVitals: (data) => http.post('/records/vitals', data),
  upload: (data) => http.post('/records/upload', data),
  config: () => http.get('/config')
};

function myPid() {
  const u = currentUser();
  return (u && u.patientId) || 'self';
}

export function currentUser() {
  try { return JSON.parse(localStorage.getItem('flwb_p_user') || 'null'); } catch { return null; }
}
