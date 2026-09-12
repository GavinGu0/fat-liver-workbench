<template>
  <el-container class="layout">
    <el-aside width="210px" class="aside">
      <div class="logo">
        <span class="logo-icon">🫀</span>
        <span>脂肪肝专病管理</span>
      </div>
      <el-menu :default-active="$route.path" router background-color="#001529" text-color="#a6adb4" active-text-color="#fff">
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon><span>工作台</span>
        </el-menu-item>
        <el-menu-item index="/patients">
          <el-icon><User /></el-icon><span>患者管理</span>
        </el-menu-item>
        <template v-if="auth.isDoctor">
          <el-menu-item index="/registry">
            <el-icon><Notebook /></el-icon><span>专病建档</span>
          </el-menu-item>
          <el-menu-item index="/screening">
            <el-icon><Search /></el-icon><span>筛查识别</span>
          </el-menu-item>
          <el-menu-item index="/followup">
            <el-icon><Calendar /></el-icon><span>随访管理</span>
          </el-menu-item>
          <el-menu-item index="/alerts">
            <el-icon><Bell /></el-icon><span>预警提醒</span>
          </el-menu-item>
          <el-menu-item index="/mdt">
            <el-icon><Connection /></el-icon><span>MDT会诊</span>
          </el-menu-item>
          <el-menu-item index="/quality">
            <el-icon><DataAnalysis /></el-icon><span>质量看板</span>
          </el-menu-item>
          <el-menu-item index="/login-logs">
            <el-icon><Lock /></el-icon><span>登录日志</span>
          </el-menu-item>
        </template>
        <el-menu-item v-if="auth.isDoctor || auth.isNurse" index="/education">
          <el-icon><Reading /></el-icon><span>宣教推送</span>
        </el-menu-item>
        <template v-if="auth.isNurse">
          <el-menu-item index="/guidance">
            <el-icon><ChatDotRound /></el-icon><span>个案指导</span>
          </el-menu-item>
          <el-menu-item index="/templates">
            <el-icon><Files /></el-icon><span>评估模板</span>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <div class="header-title">{{ $route.meta.title || '工作台' }}</div>
        <div class="header-right">
          <el-badge :value="unread" :hidden="!unread" :max="99" class="msg-badge">
            <el-button text aria-label="消息中心" @click="$router.push('/messages')">
              <el-icon :size="18"><ChatDotRound /></el-icon>
            </el-button>
          </el-badge>
          <el-dropdown @command="onCmd">
            <span class="user-info">
              <el-avatar :size="28" style="background:#1668dc">{{ (auth.user && auth.user.name || '?').slice(0,1) }}</el-avatar>
              <span class="uname">{{ auth.user && auth.user.name }}</span>
              <el-tag size="small" type="info">{{ auth.isDoctor ? '医生' : '护士' }}</el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { api } from '../api';

const auth = useAuthStore();
const route = useRoute();
const unread = ref(0);
let timer = null;

async function loadUnread() {
  try {
    const d = await api.messages();
    unread.value = d.unread || 0;
  } catch { /* 静默：未读数刷新失败不打扰使用 */ }
}

function startPolling() {
  if (timer) return;
  timer = setInterval(loadUnread, 30000);
}
function stopPolling() {
  clearInterval(timer);
  timer = null;
}

onMounted(() => {
  loadUnread();
  startPolling();
});
// keep-alive 场景：失活时停止轮询，激活时恢复（onMounted 不会重复触发，需幂等）
onDeactivated(stopPolling);
onActivated(startPolling);
onBeforeUnmount(stopPolling);
// 路由切换后刷新（离开消息中心时角标同步）
watch(() => route.path, loadUnread);

function onCmd(cmd) {
  if (cmd === 'logout') auth.logout();
}
</script>

<style scoped>
.layout { height: 100vh; }
.aside { background: #001529; }
.logo {
  height: 56px; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: #fff; font-weight: 600; font-size: 15px;
}
.header {
  background: #fff; display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid #e5e6eb; height: 56px;
}
.header-title { font-size: 16px; font-weight: 600; }
.header-right { display: flex; align-items: center; gap: 16px; }
.msg-badge :deep(.el-button) { padding: 6px; color: #4e5969; }
.user-info { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.uname { font-size: 14px; }
.main { padding: 16px; overflow: auto; }
.el-menu { border-right: none; }
</style>
