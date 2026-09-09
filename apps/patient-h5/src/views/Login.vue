<template>
  <div>
    <div class="page-head"><h1>登录 / 注册</h1><p class="sub">脂肪肝专病管理 · 患者端</p></div>

    <div class="card">
      <div class="chips" style="margin-bottom:14px">
        <div class="chip" :class="{ active: mode === 'sms' }" @click="mode = 'sms'">验证码登录</div>
        <div class="chip" :class="{ active: mode === 'password' }" @click="mode = 'password'">密码登录</div>
        <div class="chip" :class="{ active: mode === 'register' }" @click="mode = 'register'">注册建档</div>
      </div>

      <!-- 验证码登录 -->
      <template v-if="mode === 'sms'">
        <div class="field">
          <label>手机号</label>
          <input v-model="smsForm.phone" type="tel" maxlength="11" placeholder="演示账号：13800000001" />
        </div>
        <div class="field">
          <label>验证码</label>
          <div style="display:flex;gap:8px">
            <input v-model="smsForm.code" type="tel" maxlength="6" placeholder="6位验证码" style="flex:1" />
            <button class="btn plain" style="width:110px;margin:0" :disabled="cooling > 0" @click="send">{{ cooling > 0 ? `${cooling}s` : '获取验证码' }}</button>
          </div>
          <p v-if="demoCode" class="hint" style="color:var(--brand)">演示模式验证码：{{ demoCode }}</p>
        </div>
      </template>

      <!-- 密码登录 -->
      <template v-else-if="mode === 'password'">
        <div class="field">
          <label>手机号 / 账号</label>
          <input v-model="pwdForm.phone" placeholder="演示账号：13800000001" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="pwdForm.password" type="password" placeholder="演示密码：123456" />
        </div>
      </template>

      <!-- 注册 -->
      <template v-else>
        <div class="field"><label>姓名</label><input v-model="regForm.name" placeholder="真实姓名" /></div>
        <div class="field">
          <label>性别</label>
          <div class="chips">
            <div class="chip" :class="{ active: regForm.gender === 'male' }" @click="regForm.gender = 'male'">男</div>
            <div class="chip" :class="{ active: regForm.gender === 'female' }" @click="regForm.gender = 'female'">女</div>
          </div>
        </div>
        <div class="field">
          <label>年龄</label>
          <input v-model="regForm.age" type="number" placeholder="如 42" />
        </div>
        <div class="field">
          <label>身高 (cm)</label>
          <input v-model="regForm.height" type="number" placeholder="如 170" />
          <p class="hint">50 - 250 cm</p>
        </div>
        <div class="field">
          <label>体重 (kg)</label>
          <input v-model="regForm.weight" type="number" placeholder="如 72" />
          <p class="hint">20 - 300 kg，用于自动计算 BMI 并建立健康档案</p>
        </div>
        <div class="field">
          <label>手机号</label>
          <div style="display:flex;gap:8px">
            <input v-model="regForm.phone" type="tel" maxlength="11" style="flex:1" />
            <button class="btn plain" style="width:110px;margin:0" :disabled="cooling > 0" @click="send(regForm.phone)">{{ cooling > 0 ? `${cooling}s` : '获取验证码' }}</button>
          </div>
          <p v-if="demoCode" class="hint" style="color:var(--brand)">演示模式验证码：{{ demoCode }}</p>
        </div>
        <div class="field"><label>验证码</label><input v-model="regForm.code" maxlength="6" /></div>
        <div class="field">
          <label>设置密码</label>
          <input v-model="regForm.password" type="password" placeholder="至少6位" />
        </div>
      </template>

      <button class="btn" :disabled="loading" @click="submit">{{ loading ? '处理中…' : mode === 'register' ? '注册并建立健康档案' : '登录' }}</button>
      <p v-if="err" style="color:#dc2626;font-size:13px;margin-top:10px;text-align:center">{{ err }}</p>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { tokenStore } from '../api/request';
import { hashPassword } from '../utils';

const router = useRouter();
const mode = ref('sms');
const loading = ref(false);
const err = ref('');
const demoCode = ref('');
const cooling = ref(0);

const smsForm = reactive({ phone: '', code: '' });
const pwdForm = reactive({ phone: '', password: '' });
const regForm = reactive({ name: '', gender: 'male', age: '', height: '', weight: '', phone: '', code: '', password: '' });

async function send(phone) {
  if (!/^1\d{10}$/.test(phone || '')) { err.value = '请输入正确的手机号'; return; }
  err.value = '';
  try {
    const d = await api.sendSms(phone);
    demoCode.value = d.demoCode || '';
    cooling.value = 60;
    const t = setInterval(() => { cooling.value -= 1; if (cooling.value <= 0) clearInterval(t); }, 1000);
  } catch (e) { err.value = e.message; }
}

async function submit() {
  err.value = '';
  loading.value = true;
  try {
    let d;
    if (mode.value === 'sms') {
      d = await api.login({ mode: 'sms', phone: smsForm.phone.trim(), code: smsForm.code.trim() });
    } else if (mode.value === 'password') {
      d = await api.login({ mode: 'password', username: pwdForm.phone.trim(), passwordHash: await hashPassword(pwdForm.password) });
    } else {
      d = await api.login({
        mode: 'register',
        phone: regForm.phone.trim(),
        code: regForm.code.trim(),
        passwordHash: await hashPassword(regForm.password),
        profile: {
          name: regForm.name.trim(),
          gender: regForm.gender,
          age: Number(regForm.age),
          height: Number(regForm.height),
          weight: Number(regForm.weight)
        }
      });
    }
    tokenStore.set(d.accessToken, d.refreshToken);
    localStorage.setItem('flwb_user', JSON.stringify(d.user));
    router.replace('/');
  } catch (e) {
    err.value = e.message || '操作失败';
  } finally {
    loading.value = false;
  }
}
</script>
