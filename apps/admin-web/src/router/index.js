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
      { path: 'registry', name: 'registry', component: () => import('../views/Registry.vue'), meta: { title: '专病档案', roles: ['doctor'] } },
      {
        path: 'medical-records', name: 'medicalRecord', component: () => import('../views/MedicalRecord.vue'), meta: { title: '专病建档', roles: ['doctor'] },
        // 表单页仅在有上下文时可达（一站式新建 / 编辑指定患者）；裸访问重定向回档案列表，避免与列表页混淆
        beforeEnter: (to) => {
          if (to.query.mode !== 'new' && !to.query.patientId) return { path: '/registry', replace: true };
        }
      },
      { path: 'screening', name: 'screening', component: () => import('../views/Screening.vue'), meta: { title: '筛查识别', roles: ['doctor'] } },
      { path: 'followup', name: 'followup', component: () => import('../views/Followup.vue'), meta: { title: '随访管理', roles: ['doctor'] } },
      { path: 'alerts', name: 'alerts', component: () => import('../views/Alerts.vue'), meta: { title: '预警提醒', roles: ['doctor'] } },
      { path: 'quality', name: 'quality', component: () => import('../views/Quality.vue'), meta: { title: '质量看板', roles: ['doctor'] } },
      { path: 'education', name: 'education', component: () => import('../views/nurse/Education.vue'), meta: { title: '宣教推送', roles: ['doctor', 'nurse'] } },
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
