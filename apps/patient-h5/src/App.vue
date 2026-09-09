<template>
  <div class="app-shell">
    <router-view />
    <nav class="tabbar" v-if="showTabbar">
      <div class="tab" :class="{ active: $route.path === '/' }" @click="$router.replace('/')">
        <span class="tab-icon">🏠</span><span>首页</span>
      </div>
      <div class="tab" :class="{ active: $route.path === '/timeline' }" @click="$router.replace('/timeline')">
        <span class="tab-icon">📋</span><span>记录</span>
      </div>
      <div class="tab tab-msg" :class="{ active: $route.path === '/messages' }" @click="$router.replace('/messages')">
        <span class="tab-icon">💬</span><span>消息</span>
        <span v-if="unread > 0" class="badge">{{ unread > 99 ? '99+' : unread }}</span>
      </div>
    </nav>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from './api';
import { tokenStore } from './api/request';

const route = useRoute();
const unread = ref(0);
const showTabbar = computed(() => tokenStore.access && ['/', '/timeline', '/messages'].includes(route.path));

async function pollUnread() {
  if (!tokenStore.access) return;
  try {
    const d = await api.messages();
    unread.value = d.unread || 0;
  } catch { /* 静默 */ }
}
onMounted(() => {
  pollUnread();
  setInterval(pollUnread, 30000);
});
</script>
