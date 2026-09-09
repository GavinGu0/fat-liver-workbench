import { createRouter, createWebHistory } from 'vue-router';
import { tokenStore } from '../api/request';

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

router.beforeEach((to) => {
  if (!to.meta.public && !tokenStore.access) return { name: 'login' };
  if (to.name === 'login' && tokenStore.access) return { name: 'home' };
  return true;
});

export default router;
