<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useStepStore } from '../stores/stepStore';
import { useInstrumentStore } from '../stores/instrumentStore';
import { useRepairProgress } from '../hooks/useRepairProgress';
import { repairStateOf, testEvidenceSummary } from '../utils/repairState';
import StepSequence from '../components/common/StepSequence.vue';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import { CONDITION_GRADES, type ConditionGrade } from '../types/clock';
import { judgeTest, TEST_VALIDITY_META } from '../types/test';

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
const evidenceSummary = computed(() => testEvidenceSummary(tests.value));

function instrumentCodeOf(id?: string): string {
  if (!id) return '未登记仪器';
  return instrumentStore.byId(id)?.code ?? '未知仪器';
}
function validityOf(row: { validity?: keyof typeof TEST_VALIDITY_META }) {
  return TEST_VALIDITY_META[row.validity ?? 'pending_evidence'];
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

onMounted(async () => {
  await clockStore.load();
  await partStore.load();
  await instrumentStore.load();
  await stepStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>钟表详情 · {{ clock?.clockNo ?? '未找到' }}</h2>
      <StateBadge v-if="clock" :grade="clock.conditionGrade" />
      <el-tag v-if="gaps.length" type="danger">顺序号缺口：{{ gaps.join('、') }}</el-tag>
      <el-tag v-else type="success" effect="plain">顺序号连续</el-tag>
      <el-tag :type="repairState === '已完成' ? 'success' : repairState === '待测试' ? 'warning' : 'info'">
        当前结论：{{ repairState }}
      </el-tag>
      <el-tag v-if="evidenceSummary.pending > 0" type="warning">待补证 {{ evidenceSummary.pending }}</el-tag>
      <el-tag v-if="evidenceSummary.invalid > 0" type="danger">失效待复测 {{ evidenceSummary.invalid }}</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="router.push(`/steps/new?clockId=${clockId}`)">追加维修工序</el-button>
      <el-button @click="router.push(`/tests/${clockId}`)">走时测试录入</el-button>
      <el-button @click="router.push('/clocks')">返回台账</el-button>
    </div>

    <el-alert v-if="!clock" type="warning" :closable="false" title="未找到该钟表（可能已被删除）" show-icon />

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
            <el-tab-pane :label="`走时测试（${tests.length}）`" name="tests">
              <el-alert
                v-if="evidenceSummary.pending > 0 || evidenceSummary.invalid > 0"
                :title="
                  evidenceSummary.pending > 0
                    ? `有 ${evidenceSummary.pending} 条旧测试查不到所用校表仪，列入待补证，不沿用原合格结果。`
                    : `有 ${evidenceSummary.invalid} 条测试因仪器补检 / 停用 / 改有效期已失效，完工结论撤下，复测确认后恢复。`
                "
                :type="evidenceSummary.pending > 0 ? 'warning' : 'error'"
                :closable="false"
                show-icon
                style="margin-bottom: 10px"
              />
              <div v-for="t in tests" :key="t.id" class="test-block">
                <div class="card-head">
                  <strong>{{ new Date(t.testedAt).toLocaleString('zh-CN') }}</strong>
                  <el-tag size="small" effect="plain">{{ t.conclusion || judgeTest(t.rate, t.beatError, t.amplitude) }}</el-tag>
                  <StateBadge :label="validityOf(t).label" :tone="validityOf(t).type" />
                  <el-tag size="small" effect="plain">{{ instrumentCodeOf(t.instrumentId) }}</el-tag>
                  <span class="muted">日差 {{ t.rate }} s/d · 摆幅 {{ t.amplitude }}° · 偏振 {{ t.beatError }} ms</span>
                </div>
                <div v-if="t.invalidReason" class="invalid-reason">{{ t.invalidReason }}</div>
                <RateChart :readings="t.positions" />
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
  margin: 6px 0;
  font-size: 12px;
  color: #c45656;
  line-height: 1.6;
}
</style>
