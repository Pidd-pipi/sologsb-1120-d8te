<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useStepStore } from '../stores/stepStore';
import { useInstrumentStore } from '../stores/instrumentStore';
import { useRepairProgress } from '../hooks/useRepairProgress';
import StepSequence from '../components/common/StepSequence.vue';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import { CONDITION_GRADES, type ConditionGrade } from '../types/clock';
import { invalidReasonLabel, validityLabel, judgeTest } from '../types/test';
import { repairStateOf } from '../utils/repairState';
import { onChange } from '../utils/crossTab';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const partStore = usePartStore();
const stepStore = useStepStore();
const instrumentStore = useInstrumentStore();

const clockId = computed(() => String(route.params.id ?? ''));
const clock = computed(() => clockStore.byId(clockId.value));
const { progress, steps, done, total, percent, current, gaps } = useRepairProgress(clockId);
const parts = computed(() => partStore.byClock(clockId.value));
const tests = computed(() => stepStore.testsByClock(clockId.value));
const activeTab = ref('steps');

const repairState = computed(() => repairStateOf(steps.value, tests.value));
const allStepsDone = computed(() => steps.value.length > 0 && steps.value.every((s) => s.state === 'done'));
const validPassTests = computed(() =>
  tests.value.filter((t) => t.validity === 'valid' && t.conclusion === '合格'),
);
const invalidTests = computed(() => tests.value.filter((t) => t.validity === 'invalid'));
const pendingProofTests = computed(() => tests.value.filter((t) => t.validity === 'pending-proof'));

function instrumentNameOf(t: (typeof tests.value)[number]): string {
  if (!t.instrumentId) return '';
  const inst = instrumentStore.byId(t.instrumentId);
  return inst ? `${inst.assetNo} · ${inst.name}` : `${t.instrumentNo ?? ''}（台账已删）`;
}

async function finish(id: string) {
  await stepStore.finish(id);
  ElMessage.success('步骤已完成');
}
async function rollback(id: string) {
  await stepStore.rollback(id);
  ElMessage.warning('步骤已回退');
}
async function move(payload: { id: string; direction: 'up' | 'down' }) {
  const list = steps.value;
  const index = list.findIndex((it) => it.id === payload.id);
  const target = payload.direction === 'up' ? list[index - 1] : list[index + 1];
  if (!target) return;
  await stepStore.swapSeq(payload.id, target.id);
  ElMessage.success('顺序已调整');
}
async function reorder(payload: { fromId: string; toId: string }) {
  await stepStore.swapSeq(payload.fromId, payload.toId);
  ElMessage.success('已按拖拽交换顺序');
}
async function changeGrade(value: unknown) {
  const grade = String(value) as ConditionGrade;
  await clockStore.setGrade(clockId.value, grade);
  ElMessage.success(`品相等级已更新为「${grade}」`);
}

const offCrossTab = onChange((topic) => {
  if (topic === 'instruments') void instrumentStore.load();
  if (topic === 'tests' || topic === 'instruments') void stepStore.loadTests();
});

onMounted(async () => {
  await clockStore.load();
  await partStore.load();
  await stepStore.load();
  await instrumentStore.load();
});
onBeforeUnmount(offCrossTab);
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>钟表详情 · {{ clock?.clockNo ?? '未找到' }}</h2>
      <StateBadge v-if="clock" :grade="clock.conditionGrade" />
      <el-tag v-if="gaps.length" type="danger">顺序号缺口：{{ gaps.join('、') }}</el-tag>
      <el-tag v-else type="success" effect="plain">顺序号连续</el-tag>
      <el-tag :type="repairState === '已完成' ? 'success' : repairState === '待测试' ? 'warning' : 'info'">
        {{ repairState }}
      </el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="router.push(`/steps/new?clockId=${clockId}`)">追加维修工序</el-button>
      <el-button @click="router.push(`/tests/${clockId}`)">走时测试录入</el-button>
      <el-button @click="router.push('/clocks')">返回台账</el-button>
    </div>

    <el-alert v-if="!clock" type="warning" :closable="false" title="未找到该钟表（可能已被删除）" show-icon />

    <el-alert
      v-if="clock && allStepsDone && repairState === '已完成'"
      type="success"
      :closable="false"
      show-icon
      :title="`完工结论有效：依据 ${validPassTests.length} 条仪器凭证有效且合格的走时测试（${validPassTests
        .map((t) => t.instrumentNo ?? '未知仪器')
        .join('、')}）`"
      style="margin-bottom: 4px"
    />
    <el-alert
      v-if="clock && allStepsDone && repairState !== '已完成'"
      type="warning"
      :closable="false"
      show-icon
      :title="
        invalidTests.length
          ? `完工结论已撤下：${invalidTests.length} 条测试因仪器停用/补检/改有效期失效，须用可用仪器复测合格后恢复`
          : pendingProofTests.length
            ? '旧测试未记录校表仪，列入待补证，不沿用原合格结果；请选可用仪器补测'
            : '工序已全部完成，尚缺凭证有效且合格的走时测试，暂不能完工'
      "
      style="margin-bottom: 4px"
    />

    <div v-if="clock" class="grid">
      <el-card shadow="never">
        <template #header><strong>机芯信息</strong></template>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="藏品号">{{ clock.clockNo }}</el-descriptions-item>
          <el-descriptions-item label="种类">{{ clock.kind }}</el-descriptions-item>
          <el-descriptions-item label="机芯型号">{{ clock.caliber }}</el-descriptions-item>
          <el-descriptions-item label="国别 / 制作者">{{ clock.origin }} / {{ clock.maker }}</el-descriptions-item>
          <el-descriptions-item label="年代">{{ clock.yearMade }}</el-descriptions-item>
          <el-descriptions-item label="钟壳材质">{{ clock.caseMaterial }}</el-descriptions-item>
          <el-descriptions-item label="尺寸 mm">{{ clock.size }}</el-descriptions-item>
          <el-descriptions-item label="盘面标识">{{ clock.dialMark }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ clock.acquireFrom }}</el-descriptions-item>
          <el-descriptions-item label="存放位置">{{ clock.storagePos }}</el-descriptions-item>
          <el-descriptions-item label="零件条目">{{ parts.length }} 项</el-descriptions-item>
        </el-descriptions>
        <div class="grade-row">
          <span>品相等级：</span>
          <el-radio-group :model-value="clock.conditionGrade" size="small" @change="changeGrade">
            <el-radio-button v-for="g in CONDITION_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
          </el-radio-group>
        </div>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>修复进度</strong>
              <el-tag size="small">{{ done }}/{{ total }} · {{ percent }}%</el-tag>
              <span v-if="current" class="muted">
                当前卡点：#{{ current.seq }} {{ current.stepType }}（{{ current.operator }}）
              </span>
              <span v-else class="muted">全部步骤已完成</span>
            </div>
          </template>
          <el-progress :percentage="percent" :stroke-width="12" />
          <el-tabs v-model="activeTab" style="margin-top: 12px">
            <el-tab-pane label="工序顺序" name="steps">
              <StepSequence
                :items="steps"
                sortable
                @finish="finish"
                @rollback="rollback"
                @move="move"
                @reorder="reorder"
              />
            </el-tab-pane>
            <el-tab-pane :label="`零件清单（${parts.length}）`" name="parts">
              <el-table :data="parts" size="small" border>
                <el-table-column prop="name" label="零件" width="110" />
                <el-table-column prop="position" label="装配位置" min-width="150" />
                <el-table-column prop="wearState" label="磨损" width="90" />
                <el-table-column prop="decision" label="处理" width="90" />
                <el-table-column prop="sourceLot" label="来源批号" width="120" />
                <el-table-column prop="dimension" label="尺寸 mm" width="100" />
              </el-table>
              <el-empty v-if="parts.length === 0" description="暂无零件登记" :image-size="60" />
            </el-tab-pane>
            <el-tab-pane name="tests">
              <template #label>
                <span>
                  走时测试（{{ tests.length }}）
                  <el-badge v-if="pendingProofTests.length + invalidTests.length" :value="pendingProofTests.length + invalidTests.length" type="danger" />
                </span>
              </template>
              <div v-for="t in tests" :key="t.id" class="test-block">
                <div class="card-head">
                  <strong>{{ new Date(t.testedAt).toLocaleString('zh-CN') }}</strong>
                  <el-tag
                    size="small"
                    :type="t.validity === 'valid' ? 'success' : t.validity === 'invalid' ? 'danger' : 'warning'"
                  >
                    {{ validityLabel(t.validity) }}
                  </el-tag>
                  <el-tag v-if="t.validity === 'valid'" size="small" type="success">{{ t.conclusion || judgeTest(t.rate, t.beatError, t.amplitude) }}</el-tag>
                  <span class="muted">
                    {{ instrumentNameOf(t) || '未记录仪器' }} · 日差 {{ t.rate }} s/d · 摆幅 {{ t.amplitude }}° · 偏振 {{ t.beatError }} ms
                  </span>
                </div>
                <div v-if="t.validity !== 'valid'" class="invalid-reason">
                  {{ invalidReasonLabel(t.invalidReason) }}
                </div>
                <RateChart v-if="t.positions?.length" :readings="t.positions" />
              </div>
              <el-empty v-if="tests.length === 0" description="暂无走时测试记录" :image-size="60" />
            </el-tab-pane>
          </el-tabs>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 380px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.grade-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.test-block {
  margin-bottom: 16px;
}
.invalid-reason {
  color: #c45656;
  font-size: 13px;
  margin: 4px 0;
}
</style>
