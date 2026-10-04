<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useStepStore } from '../../stores/stepStore';
import { useInstrumentStore } from '../../stores/instrumentStore';
import { calibrationCovers } from '../../types/instrument';
import type { TimekeepingTest } from '../../types/test';

const props = defineProps<{
  modelValue: boolean;
  test: TimekeepingTest | null;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'attached', payload: { testId: string; validity: string }): void;
}>();

const stepStore = useStepStore();
const instrumentStore = useInstrumentStore();

const instrumentId = ref('');
const submitting = ref(false);

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      instrumentId.value = '';
      await instrumentStore.load();
    }
  },
);

/** 补证可选的仪器：在用即可；是否站得住（覆盖测试时刻、纪元）交由重算判定 */
const options = computed(() =>
  instrumentStore.items
    .filter((it) => it.status === 'active')
    .map((it) => {
      const cals = instrumentStore.calibrationsOf(it.id);
      const latest = cals[0];
      const at = props.test?.testedAt ?? 0;
      const coversTest = cals.some((c) => calibrationCovers(c, at));
      const coveredNow = latest ? calibrationCovers(latest, Date.now()) : false;
      return {
        ...it,
        latest,
        coversTest,
        coveredNow,
        label: `${it.code} · ${it.name}${latest ? `（检定至 ${new Date(latest.validUntil).toLocaleDateString('zh-CN')}）` : '（无检定记录）'}`,
      };
    }),
);

const selected = computed(() => options.value.find((it) => it.id === instrumentId.value));

const hintType = computed<'success' | 'warning' | 'danger' | 'info'>(() => {
  if (!selected.value) return 'info';
  if (selected.value.evidenceEpoch > 0) return 'danger';
  if (!selected.value.latest) return 'danger';
  if (!selected.value.coversTest) return 'warning';
  return 'success';
});

const hint = computed(() => {
  if (!selected.value) return '请选择该测试当时实际使用的校表仪；选错仪器与伪造证据同责。';
  const it = selected.value;
  const eventAfterTest = instrumentStore.eventsOf(it.id).some((e) => e.happenedAt > (props.test?.testedAt ?? 0));
  if (eventAfterTest) {
    return `该仪器在测试之后发生过补检 / 停用 / 改有效期事件，补证后旧测试仍会因纪元落后而失效，须复测。`;
  }
  if (it.evidenceEpoch > 0) {
    return `该仪器发生过补检 / 停用 / 改有效期（证据纪元 ${it.evidenceEpoch}），补证后旧测试仍会因纪元落后而失效，须复测。`;
  }
  if (!it.latest) return '该仪器没有任何检定记录，补证后测试仍因无检定覆盖而失效，须复测。';
  if (!it.coversTest) {
    return '该仪器检定有效期不覆盖测试时刻，补证后测试仍失效，须复测。';
  }
  return '该仪器在用、检定覆盖测试时刻且测试后无仪器事件：补证后测试可恢复为有效。';
});

async function submit() {
  if (!props.test || !instrumentId.value) {
    ElMessage.warning('请选择仪器');
    return;
  }
  submitting.value = true;
  try {
    const validity = await stepStore.attachEvidence(props.test.id, instrumentId.value);
    ElMessage.success(validity === 'valid' ? '补证成功，测试恢复有效' : '已登记仪器，但测试仍不满足采信条件，请安排复测');
    emit('attached', { testId: props.test.id, validity });
    emit('update:modelValue', false);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '补证失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="旧测试补证：登记所用校表仪"
    width="560px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      v-if="test"
      :title="`原结论「${test.conclusion}」不沿用，补证后按仪器证据重新判定`"
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
    />
    <el-descriptions v-if="test" :column="1" border size="small" style="margin-bottom: 14px">
      <el-descriptions-item label="测试时间">{{ new Date(test.testedAt).toLocaleString('zh-CN') }}</el-descriptions-item>
      <el-descriptions-item label="读数">
        日差 {{ test.rate }} s/d · 摆幅 {{ test.amplitude }}° · 偏振 {{ test.beatError }} ms
      </el-descriptions-item>
    </el-descriptions>
    <el-form label-width="92px">
      <el-form-item label="校表仪" required>
        <el-select v-model="instrumentId" placeholder="选择当时使用的仪器" style="width: 100%">
          <el-option
            v-for="it in options"
            :key="it.id"
            :label="it.label"
            :value="it.id"
            :disabled="it.status !== 'active'"
          >
            <span>{{ it.code }} · {{ it.name }}</span>
            <el-tag v-if="!it.coveredNow" size="small" type="danger" style="margin-left: 8px">已过检</el-tag>
            <el-tag v-else size="small" type="success" style="margin-left: 8px">检定有效</el-tag>
          </el-option>
        </el-select>
      </el-form-item>
    </el-form>
    <el-alert :title="hint" :type="hintType" :closable="false" show-icon />
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">确认补证</el-button>
    </template>
  </el-dialog>
</template>
