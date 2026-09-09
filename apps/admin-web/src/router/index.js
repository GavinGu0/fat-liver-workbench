import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('../layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/Dashboard.vue'), meta: { title: '工作台' } },
      { path: 'patients', name: 'patients', component: () => import('../views/Patients.vue'), meta: { title: '患者管理' } },
      { path: 'patients/:id', name: 'patientDetail', component: () => import('../views/PatientDetail.vue'), meta: { title: '患者详情' } },
      { path: 'mdt', name: 'mdt', component: () => import('../views/Mdt.vue'), meta: { title: 'MDT会诊', roles: ['doctor'] } },
      { path: 'education', name: 'education', component: () => import('../views/nurse/Education.vue'), meta: { title: '宣教推送', roles: ['nurse'] } },
      { path: 'guidance', name: 'guidance', component: () => import('../views/nurse/Guidance.vue'), meta: { title: '个案指导', roles: ['nurse'] } },
      { path: 'templates', name: 'templates', component: () => import('../views/nurse/Templates.vue'), meta: { title: '评估模板', roles: ['nurse'] } }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
];

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.isLogin) return { name: 'login', query: { redirect: to.fullPath } };
  if (to.meta.roles && auth.user && !to.meta.roles.includes(auth.user.role)) {
    return { name: 'dashboard' };
  }
  if (to.name === 'login' && auth.isLogin) return { name: 'dashboard' };
  return true;
});

export default router;
