import axios from 'axios';

/** axios 实例：统一 baseURL / Bearer 注入 / 业务码解包 / 401 自动刷新（单飞） */
export const http = axios.create({ baseURL: '/api/v1', timeout: 20000 });

/* ---------- Token 存取（localStorage） ---------- */
export const tokenStore = {
  get access() { return localStorage.getItem('flwb_at') || ''; },
  get refresh() { return localStorage.getItem('flwb_rt') || ''; },
  set(access, refresh) {
    if (access) localStorage.setItem('flwb_at', access);
    if (refresh) localStorage.setItem('flwb_rt', refresh);
  },
  clear() {
    localStorage.removeItem('flwb_at');
    localStorage.removeItem('flwb_rt');
  }
};

let _onAuthFail = () => {};
export function bindAuthHooks({ onAuthFail }) {
  _onAuthFail = onAuthFail;
}

http.interceptors.request.use((cfg) => {
  const t = tokenStore.access;
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

let refreshing = null;
async function doRefresh() {
  const rt = tokenStore.refresh;
  if (!rt) return false;
  try {
    const res = await axios.post('/api/v1/auth/refresh', { refreshToken: rt });
    const body = res.data;
    if (body && body.code === 0 && body.data) {
      tokenStore.set(body.data.accessToken, body.data.refreshToken);
      return true;
    }
  } catch { /* fallthrough */ }
  return false;
}

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
      _onAuthFail();
    }
    const b = response && response.data;
    const err = new Error((b && b.message) || error.message || '网络异常');
    err.code = b && b.code;
    return Promise.reject(err);
  }
);
