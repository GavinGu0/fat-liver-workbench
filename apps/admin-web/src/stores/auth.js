import { defineStore } from 'pinia';
import { api } from '../api';
import { tokenStore, bindAuthHooks } from '../api/request';
import router from '../router';

function loadUser() {
  try { return JSON.parse(localStorage.getItem('flwb_user') || 'null'); } catch { return null; }
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
    }
  }
});

// 401 且刷新失败 → 踢回登录页
bindAuthHooks({ onAuthFail: () => useAuthStore().clear() });
