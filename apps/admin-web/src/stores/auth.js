import { defineStore } from 'pinia';
import { api } from '../api';
import { tokenStore, bindAuthHooks } from '../api/request';
import router from '../router';

function loadUser() {
  try { return JSON.parse(localStorage.getItem('flwb_user') || 'null'); } catch { return null; }
}

function sameUser(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

export const useAuthStore = defineStore('auth', {
  state: () => ({ user: loadUser() }),
  getters: {
    // 仅认可医护角色（doctor/nurse）；患者会话即使存在也不算医护端登录
    // 注意：必须先读响应式的 s.user——Pinia getter 是 computed，依赖动态追踪；
    // 若先读非响应式的 tokenStore.access 且为空时短路，s.user 永远不会被追踪，
    // 登录后缓存的 false 不失效，路由守卫会永远把已登录用户弹回登录页
    isLogin: (s) => !!s.user && !!tokenStore.access && ['doctor', 'nurse'].includes(s.user.role),
    isDoctor: (s) => s.user && s.user.role === 'doctor',
    isNurse: (s) => s.user && s.user.role === 'nurse',
    role: (s) => (s.user ? s.user.role : '')
  },
  actions: {
    async login(payload) {
      const d = await api.login(payload);
      tokenStore.set(d.accessToken, d.refreshToken);
      this.user = d.user;
      localStorage.setItem('flwb_user', JSON.stringify(d.user));
      return d.user;
    },
    async logout() {
      try { await api.logout(tokenStore.refresh); } catch { /* 忽略 */ }
      this.clear();
    },
    clear() {
      tokenStore.clear();
      localStorage.removeItem('flwb_user');
      this.user = null;
      router.replace('/login');
    },
    /** 以 localStorage 最新会话校准本标签页用户态（多标签页登录/登出/换号防滞留） */
    sync() {
      const stored = loadUser();
      if (!sameUser(stored, this.user)) this.user = stored;
    }
  }
});

// 401 且刷新失败 → 踢回登录页
bindAuthHooks({ onAuthFail: () => useAuthStore().clear() });

// 跨标签页会话同步：其他标签页登录/登出/换号写入 flwb_user 时，本标签页实时跟进，
// 确保路由守卫基于最新角色判定，不停留在旧版本或非当前角色页面
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'flwb_user') useAuthStore().sync();
  });
}
