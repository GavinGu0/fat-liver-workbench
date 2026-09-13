<template>
  <div>
    <div class="page-head" style="display:flex;align-items:center;gap:10px">
      <span class="back" @click="$router.back()">←</span>
      <div>
        <h1>个人中心</h1>
        <p class="sub">查看个人资料与健康档案</p>
      </div>
    </div>

    <!-- 会话卡片 -->
    <div class="card profile-user">
      <div class="avatar">{{ (me.name || '患')[0] }}</div>
      <div class="profile-user-info">
        <div class="profile-name">{{ me.name || '用户' }}</div>
        <div class="profile-sub">{{ maskPhone(me.profile && me.profile.phone || me.phone) || '未绑定手机号' }}</div>
      </div>
      <span v-if="risk" class="risk-tag" :class="'risk-' + risk">{{ riskLabel }}</span>
    </div>

    <!-- 健康档案 -->
    <div class="card" v-if="me.profile" v-loading="loading">
      <div class="card-title">健康档案</div>
      <div class="info-list">
        <div class="info-row"><span class="info-label">性别</span><span>{{ genderText }}</span></div>
        <div class="info-row"><span class="info-label">年龄</span><span>{{ me.profile.age != null ? me.profile.age + ' 岁' : '-' }}</span></div>
        <div class="info-row"><span class="info-label">身高</span><span>{{ me.profile.height != null ? me.profile.height + ' cm' : '-' }}</span></div>
        <div class="info-row"><span class="info-label">体重</span><span>{{ me.profile.weight != null ? me.profile.weight + ' kg' : '-' }}</span></div>
        <div class="info-row"><span class="info-label">BMI</span><span>{{ me.profile.bmi != null ? me.profile.bmi : '-' }}</span></div>
        <div class="info-row"><span class="info-label">风险分层</span><span>{{ riskLabel }}</span></div>
        <div class="info-row"><span class="info-label">主诊断</span><span>{{ me.profile.mainDiagnosis || '-' }}</span></div>
        <div class="info-row"><span class="info-label">主管医生</span><span>{{ me.profile.docName || '-' }}</span></div>
        <div class="info-row"><span class="info-label">下次随访</span><span>{{ me.profile.nextFollowupDate || '暂未安排' }}</span></div>
        <div class="info-row"><span class="info-label">建档时间</span><span>{{ fmtCreated }}</span></div>
      </div>
    </div>
    <p v-if="loadErr" class="hint" style="text-align:center">{{ loadErr }}</p>

    <!-- 退出登录 -->
    <div style="padding:0 12px;margin-top:16px">
      <button class="btn danger" :disabled="loggingOut" @click="confirmVisible = true">退出登录</button>
    </div>

    <!-- 退出确认 -->
    <div class="mask" v-if="confirmVisible" @click.self="confirmVisible = false">
      <div class="sheet">
        <h3>退出登录</h3>
        <p style="line-height:1.7;font-size:14px">确定要退出当前账号吗？退出后需要重新登录才能查看您的健康数据。</p>
        <button class="btn danger" :disabled="loggingOut" @click="doLogout">{{ loggingOut ? '退出中…' : '确定退出' }}</button>
        <button class="btn plain" @click="confirmVisible = false">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, currentUser } from '../api';
import { tokenStore } from '../api/request';
import toast from '../utils/toast';

const router = useRouter();
const me = ref({});
const loading = ref(false);
const loadErr = ref('');
const confirmVisible = ref(false);
const loggingOut = ref(false);

const RISK_LABELS = { high: '高风险', mid: '中风险', low: '低风险' };
const risk = computed(() => (me.value.profile && me.value.profile.risk) || '');
const riskLabel = computed(() => RISK_LABELS[risk.value] || '未评估');
const genderText = computed(() => {
  const g = me.value.profile && me.value.profile.gender;
  return g === 'male' ? '男' : g === 'female' ? '女' : '-';
});
const fmtCreated = computed(() => {
  const ts = me.value.profile && me.value.profile.createdAt;
  if (!ts) return '-';
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

function maskPhone(p) {
  if (!p || !/^\d{11}$/.test(String(p))) return p || '';
  return String(p).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

/** 手机号在档案缺失时回退展示，脱敏处理避免完整泄露 */
onMounted(async () => {
  loading.value = true;
  try {
    const d = await api.me();
    me.value = d || {};
    // 同步本地会话缓存中的姓名，保持首页问候一致
    const cached = currentUser();
    if (cached && d && d.name && cached.name !== d.name) {
      localStorage.setItem('flwb_p_user', JSON.stringify({ ...cached, name: d.name }));
    }
  } catch (e) {
    loadErr.value = e.message || '个人信息加载失败，请稍后重试';
    const cached = currentUser();
    if (cached) me.value = { name: cached.name, patientId: cached.patientId };
  } finally {
    loading.value = false;
  }
});

/** 安全退出：吊销服务端 Refresh Token → 清空本地会话 → 回登录页 */
async function doLogout() {
  loggingOut.value = true;
  try {
    await api.logout(tokenStore.refresh).catch(() => {}); // 吊销失败不阻塞本地退出
    tokenStore.clear();
    confirmVisible.value = false;
    toast.success('已退出登录');
    router.replace('/login');
  } finally {
    loggingOut.value = false;
  }
}
</script>

<style scoped>
.back { font-size: 22px; cursor: pointer; padding: 0 6px; color: var(--text, #1f2937); }
.profile-user { display: flex; align-items: center; gap: 14px; }
.avatar {
  width: 56px; height: 56px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg, var(--brand, #2563eb), #60a5fa);
  color: #fff; font-size: 24px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.profile-user-info { flex: 1; min-width: 0; }
.profile-name { font-size: 18px; font-weight: 700; }
.profile-sub { font-size: 13px; color: #9ca3af; margin-top: 2px; }
.risk-tag { font-size: 12px; padding: 3px 10px; border-radius: 999px; flex-shrink: 0; }
.risk-high { background: #fee2e2; color: #dc2626; }
.risk-mid { background: #fef3c7; color: #d97706; }
.risk-low { background: #d1fae5; color: #059669; }
.info-list { display: flex; flex-direction: column; }
.info-row {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 11px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px;
}
.info-row:last-child { border-bottom: none; }
.info-label { color: #6b7280; flex-shrink: 0; }
</style>
