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
            <button class="btn plain" style="width:110px;margin:0" :disabled="cooling > 0" @click="send(smsForm.phone)">{{ cooling > 0 ? `${cooling}s` : '获取验证码' }}</button>
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
          <input v-model="pwdForm.password" type="password" placeholder="演示密码：123456" @keyup.enter="submit" />
        </div>
        <p class="hint" style="text-align:right;margin-top:-4px">
          <a style="color:var(--brand)" @click="mode = 'reset'">忘记密码？手机验证码重置</a>
        </p>
      </template>

      <!-- 忘记密码（重置） -->
      <template v-else-if="mode === 'reset'">
        <p class="hint" style="margin-bottom:10px">通过注册手机号 + 短信验证码重置密码，重置成功后自动登录并解锁账号。</p>
        <div class="field">
          <label>注册手机号</label>
          <div style="display:flex;gap:8px">
            <input v-model="resetForm.phone" type="tel" maxlength="11" style="flex:1" />
            <button class="btn plain" style="width:110px;margin:0" :disabled="cooling > 0" @click="send(resetForm.phone)">{{ cooling > 0 ? `${cooling}s` : '获取验证码' }}</button>
          </div>
          <p v-if="demoCode" class="hint" style="color:var(--brand)">演示模式验证码：{{ demoCode }}</p>
        </div>
        <div class="field"><label>验证码</label><input v-model="resetForm.code" type="tel" maxlength="6" /></div>
        <div class="field"><label>新密码</label><input v-model="resetForm.password" type="password" placeholder="至少6位" /></div>
        <div class="field"><label>确认新密码</label><input v-model="resetForm.password2" type="password" placeholder="再次输入新密码" @keyup.enter="submit" /></div>
        <p class="hint" style="text-align:right;margin-top:-4px">
          <a style="color:var(--brand)" @click="mode = 'password'">想起密码了？返回登录</a>
        </p>
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

      <button class="btn" :disabled="loading" @click="submit">{{ loading ? '处理中…' : buttonText }}</button>
      <p v-if="err" style="color:#dc2626;font-size:13px;margin-top:10px;text-align:center">{{ err }}</p>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
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
const resetForm = reactive({ phone: '', code: '', password: '', password2: '' });
const regForm = reactive({ name: '', gender: 'male', age: '', height: '', weight: '', phone: '', code: '', password: '' });

const buttonText = computed(() => {
  if (mode.value === 'register') return '注册并建立健康档案';
  if (mode.value === 'reset') return '重置密码并登录';
  return '登录';
});

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

/** 登录/注册/重置成功后的统一落地：角色校验 → 会话持久化 → 进首页 */
function afterLogin(d) {
  // 角色校验：医护账号不允许进入患者端，避免医护 token 污染患者端会话命名空间
  if (d.user && d.user.role !== 'patient') {
    err.value = '该账号为医护账号，请使用医护端工作台登录';
    return false;
  }
  tokenStore.set(d.accessToken, d.refreshToken);
  localStorage.setItem('flwb_p_user', JSON.stringify(d.user));
  router.replace('/');
  return true;
}

async function submit() {
  err.value = '';
  loading.value = true;
  try {
    let d;
    if (mode.value === 'sms') {
      if (!smsForm.phone.trim()) { err.value = '请输入手机号'; return; }
      d = await api.login({ mode: 'sms', phone: smsForm.phone.trim(), code: smsForm.code.trim() });
    } else if (mode.value === 'password') {
      if (!pwdForm.phone.trim()) { err.value = '请输入账号'; return; }
      if (!pwdForm.password) { err.value = '请输入密码'; return; }
      d = await api.login({ mode: 'password', username: pwdForm.phone.trim(), passwordHash: await hashPassword(pwdForm.password) });
    } else if (mode.value === 'reset') {
      const phone = resetForm.phone.trim();
      if (!/^1\d{10}$/.test(phone)) { err.value = '请输入正确的注册手机号'; return; }
      if (!resetForm.code.trim()) { err.value = '请输入短信验证码'; return; }
      if (resetForm.password.length < 6) { err.value = '新密码至少6位'; return; }
      if (resetForm.password !== resetForm.password2) { err.value = '两次输入的新密码不一致'; return; }
      d = await api.resetPassword({
        phone,
        code: resetForm.code.trim(),
        newPasswordHash: await hashPassword(resetForm.password)
      });
    } else {
      if (!regForm.name.trim()) { err.value = '请填写姓名'; return; }
      if (regForm.password.length < 6) { err.value = '设置密码至少6位'; return; }
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
    afterLogin(d);
  } catch (e) {
    err.value = e.message || '操作失败';
  } finally {
    loading.value = false;
  }
}
</script>
