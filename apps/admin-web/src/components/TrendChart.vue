<template>
  <div ref="chartEl" class="trend-chart" :style="{ height }"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  /** [{name, unit, data: [[ts, value], ...], markLine?}] */
  series: { type: Array, default: () => [] },
  height: { type: String, default: '260px' }
});

const chartEl = ref(null);
let chart = null;

function render() {
  if (!chart || !props.series) return;
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: props.series.map((s) => s.name), bottom: 0 },
    grid: { left: 52, right: 24, top: 24, bottom: 48 },
    xAxis: { type: 'time', axisLabel: { formatter: '{MM}-{dd}' } },
    yAxis: { type: 'value', scale: true },
    series: props.series.map((s) => ({
      name: s.name,
      type: 'line',
      smooth: true,
      connectNulls: true,
      symbolSize: 5,
      data: s.data,
      markLine: s.markLine || undefined
    }))
  }, true);
}

function resize() { chart && chart.resize(); }

onMounted(() => {
  chart = echarts.init(chartEl.value);
  render();
  window.addEventListener('resize', resize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  if (chart) { chart.dispose(); chart = null; }
});
watch(() => props.series, render, { deep: true });
</script>

<style scoped>
.trend-chart { width: 100%; }
</style>
