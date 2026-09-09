<template>
  <div>
    <div class="page-head">
      <h1>你好，{{ user && user.name || '用户' }} 👋</h1>
      <p class="sub">{{ today }} · 坚持记录，医生随时看得到</p>
    </div>

    <div class="card">
      <div class="card-title">今日数据记录</div>
      <div style="display:flex;align-items:baseline;gap:6px">
        <span style="font-size:32px;font-weight:700;color:var(--brand)">{{ todayCount }}</span>
        <span style="color:#9ca3af;font-size:13px">条（饮食 / 运动 / 指标）</span>
      </div>
    </div>

    <div style="padding:0 12px">
      <div class="grid">
        <div class="grid-item" @click="$router.push('/diet')">
          <div class="grid-icon">🍚</div><div class="grid-label">饮食记录</div>
        </div>
        <div class="grid-item" @click="$router.push('/exercise')">
          <div class="grid-icon">🏃</div><div class="grid-label">运动记录</div>
        </div>
        <div class="grid-item" @click="$router.push('/vitals')">
          <div class="grid-icon">💉</div><div class="grid-label">随访指标</div>
        </div>
        <div class="grid-item" @click="$router.push('/messages')">
          <div class="grid-icon">💬</div><div class="grid-label">消息中心</div>
          <span v-if="unread" class="badge" style="position:absolute;top:8px;right:14px">{{ unread }}</span>
        </div>
        <div class="grid-item" @click="$router.push('/timeline')">
          <div class="grid-icon">📋</div><div class="grid-label">记录时间轴</div>
        </div>
        <div class="grid-item" @click="logout">
          <div class="grid-icon">🚪</div><div class="grid-label">退出登录</div>
        </div>
      </div>
    </div>

    <!-- 随访弹窗（PRD 3.1.3：随访当日登录提醒） -->
    <div class="mask" v-if="followup" @click.self="followup = null">
      <div class="sheet">
        <h3>⏰ 今日随访提醒</h3>
        <p style="line-height:1.7;font-size:14px">
          您的医生为您安排了今天的随访，请记得完成<b>指标填报</b>（体重 / 腹围 / 血压 / 血糖），医生将在工作台实时看到您的数据。
        </p>
        <p v-if="followup.note" style="margin-top:8px;font-size:13px;color:#6b7280">医生留言：{{ followup.note }}</p>
        <button class="btn" @click="followup = null; $router.push('/vitals')">立即填报</button>
        <button class="btn plain" @click="followup = null">稍后再说</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, currentUser } from '../api';
import { tokenStore } from '../api/request';
import { todayStr } from '../utils';

const router = useRouter();
const user = currentUser();
const followup = ref(null);
const unread = ref(0);
const todayCount = ref(0);
const today = todayStr();

onMounted(async () => {
  try {
    const d = await api.messages();
    followup.value = d.followupToday;
    unread.value = d.unread || 0;
  } catch { /* 静默 */ }
  try {
    const d = await api.myRecords({ limit: 50 });
    const start = new Date(); start.setHours(0, 0, 0, 0);
    todayCount.value = d.items.filter((x) => x.ts >= start.getTime()).length;
  } catch { /* 静默 */ }
});

async function logout() {
  try { await api.logout(tokenStore.refresh); } catch { /* 忽略 */ }
  tokenStore.clear();
  router.replace('/login');
}
</script>
