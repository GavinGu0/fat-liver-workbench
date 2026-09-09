import { createRouter, createWebHistory } from 'vue-router';
import { tokenStore, currentUser } from '../api/request';

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/Login.vue'), meta: { public: true } },
  { path: '/', name: 'home', component: () => import('../views/Home.vue') },
  { path: '/diet', name: 'diet', component: () => import('../views/RecordDiet.vue') },
  { path: '/exercise', name: 'exercise', component: () => import('../views/RecordExercise.vue') },
  { path: '/vitals', name: 'vitals', component: () => import('../views/RecordVitals.vue') },
  { path: '/messages', name: 'messages', component: () => import('../views/Messages.vue') },
  { path: '/timeline', name: 'timeline', component: () => import('../views/Timeline.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' }
];

const router = createRouter({
  history: createWebHistory('/patient/'),
  routes
});

// 仅认可患者角色的会话（与医护端同域部署，防止医生/护士 token 直接进入患者端）
function hasPatientSession() {
  const u = currentUser();
  return !!tokenStore.access && !!u && u.role === 'patient';
}

router.beforeEach((to) => {
  if (!to.meta.public && !hasPatientSession()) return { name: 'login' };
  if (to.name === 'login' && hasPatientSession()) return { name: 'home' };
  return true;
});

export default router;
