<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <div class="brand">
        <span style="font-size:34px">🫀</span>
        <h2>脂肪肝专病管理工作台</h2>
        <p class="sub">医护端 · 院外数据管理 / 随访 / MDT 协作</p>
      </div>

      <el-tabs v-model="mode" stretch>
        <el-tab-pane label="账号密码登录" name="password">
          <el-form @keyup.enter="submit">
            <el-form-item>
              <el-input v-model="form.username" placeholder="医生账号：GBMZ / 护士账号：HULI01" size="large" clearable>
                <template #prefix><el-icon><User /></el-icon></template>
              </el-input>
            </el-form-item>
            <el-form-item>
              <el-input v-model="form.password" type="password" placeholder="密码：123456" size="large" show-password>
                <template #prefix><el-icon><Lock /></el-icon></template>
              </el-input>
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="手机验证码" name="sms">
          <el-form @keyup.enter="submit">
            <el-form-item>
              <el-input v-model="smsForm.phone" placeholder="已注册手机号" size="large" clearable>
                <template #prefix><el-icon><Iphone /></el-icon></template>
              </el-input>
            </el-form-item>
            <el-form-item>
              <div style="display:flex;gap:8px;width:100%">
                <el-input v-model="smsForm.code" placeholder="验证码" size="large" />
                <el-button size="large" :disabled="cooling > 0" @click="sendCode">
                  {{ cooling > 0 ? `${cooling}s` : '获取验证码' }}
                </el-button>
              </div>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>

      <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="submit">登 录</el-button>

      <el-alert v-if="demoTip" :title="demoTip" type="info" :closable="false" style="margin-top:14px" />
      <p class="tip">患者请使用 <a href="/patient/">患者端 H5</a></p>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { hashPassword } from '../utils/crypto';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const mode = ref('password');
const loading = ref(false);
const demoTip = ref('');
const form = reactive({ username: 'GBMZ', password: '123456' });
const smsForm = reactive({ phone: '', code: '' });
const cooling = ref(0);

async function sendCode() {
  if (!/^1\d{10}$/.test(smsForm.phone)) return ElMessage.warning('请输入正确的手机号');
  const d = await api.sendSms(smsForm.phone);
  if (d.demoMode) {
    smsForm.code = d.demoCode;
    demoTip.value = `演示模式：验证码已自动填入（${d.demoCode}）`;
  }
  cooling.value = 60;
  const t = setInterval(() => { cooling.value--; if (cooling.value <= 0) clearInterval(t); }, 1000);
}

async function submit() {
  loading.value = true;
  try {
    let user;
    if (mode.value === 'password') {
      user = await auth.login({ mode: 'password', username: form.username.trim(), passwordHash: await hashPassword(form.password) });
    } else {
      user = await auth.login({ mode: 'sms', phone: smsForm.phone.trim(), code: smsForm.code.trim() });
    }
    if (user.role === 'patient') {
      // 患者误入医护端 → 清空医护端命名空间中的患者凭证后再跳患者端，避免会话串染影响后续医护登录
      auth.clear();
      window.location.href = '/patient/';
      return;
    }
    ElMessage.success(`欢迎，${user.name}`);
    router.replace(route.query.redirect || '/dashboard');
  } catch (e) {
    ElMessage.error(e.message || '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  height: 100vh; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #1668dc 0%, #0e42d2 60%, #0a2e9d 100%);
}
.login-card { width: 400px; padding: 8px 12px; border-radius: 12px; }
.brand { text-align: center; margin-bottom: 8px; }
.brand h2 { margin: 8px 0 4px; font-size: 18px; }
.sub { color: #86909c; font-size: 12px; margin: 0 0 8px; }
.tip { text-align: center; color: #86909c; font-size: 12px; margin-bottom: 0; }
</style>
