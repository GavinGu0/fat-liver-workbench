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
    isLogin: (s) => !!tokenStore.access && !!s.user && ['doctor', 'nurse'].includes(s.user.role),
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
