import axios from 'axios';

export const tokenStore = {
  get access() { return localStorage.getItem('flwb_at') || ''; },
  get refresh() { return localStorage.getItem('flwb_rt') || ''; },
  set(a, r) { if (a) localStorage.setItem('flwb_at', a); if (r) localStorage.setItem('flwb_rt', r); },
  clear() { localStorage.removeItem('flwb_at'); localStorage.removeItem('flwb_rt'); localStorage.removeItem('flwb_user'); }
};

export function currentUser() {
  try { return JSON.parse(localStorage.getItem('flwb_user') || 'null'); } catch { return null; }
}

const http = axios.create({ baseURL: '/api/v1', timeout: 20000 });

let refreshing = null;
async function doRefresh() {
  const rt = tokenStore.refresh;
  if (!rt) return false;
  try {
    const resp = await axios.post('/api/v1/auth/refresh', { refreshToken: rt });
    const body = resp.data;
    if (body && body.code === 0 && body.data) {
      tokenStore.set(body.data.accessToken, body.data.refreshToken);
      return true;
    }
  } catch { /* fallthrough */ }
  return false;
}

http.interceptors.request.use((cfg) => {
  const t = tokenStore.access;
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

http.interceptors.response.use(
  (resp) => {
    const b = resp.data;
    if (b && typeof b === 'object' && 'code' in b) {
      if (b.code === 0) return b.data;
      const err = new Error(b.message || '请求失败');
      err.code = b.code;
      return Promise.reject(err);
    }
    return b;
  },
  async (error) => {
    const { response, config } = error;
    if (response && response.status === 401 && config && !config.__retried) {
      config.__retried = true;
      refreshing = refreshing || doRefresh();
      const okd = await refreshing;
      refreshing = null;
      if (okd) return http(config);
      tokenStore.clear();
      window.location.href = '/patient/login';
    }
    const b = response && response.data;
    const err = new Error((b && b.message) || error.message || '网络异常');
    err.code = b && b.code;
    return Promise.reject(err);
  }
);

export { http as http };
