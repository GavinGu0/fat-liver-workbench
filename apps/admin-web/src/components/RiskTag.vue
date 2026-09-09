<template>
  <el-tag :type="type" effect="dark" size="small" round>{{ label }}</el-tag>
</template>

<script setup>
import { computed } from 'vue';
import { RISK_LABELS } from '@flwb/shared';

const props = defineProps({ risk: { type: String, default: 'low' } });
const label = computed(() => RISK_LABELS[props.risk] || props.risk);
const type = computed(() => (props.risk === 'high' ? 'danger' : props.risk === 'mid' ? 'warning' : 'success'));
</script>
