import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { onSync } from '../utils/syncBus';
import { evaluateTest } from '../utils/validity';
import { useInstrumentStore } from './instrumentStore';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type { TimekeepingTest, TimekeepingTestDraft, TestValidity } from '../types/test';

interface StepState {
  items: RepairStep[];
  tests: TimekeepingTest[];
  loaded: boolean;
}

let syncSubscribed = false;

export const useStepStore = defineStore('step', {
  state: (): StepState => ({ items: [], tests: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) =>
      state.items.filter((it) => it.clockId === clockId).sort((a, b) => a.seq - b.seq),
    testsByClock: (state) => (clockId: string) =>
      state.tests.filter((it) => it.clockId === clockId).sort((a, b) => b.testedAt - a.testedAt),
    /** 旧测试无仪器记录 → 待补证队列（不沿用原合格结果） */
    pendingEvidenceTests: (state) => state.tests.filter((t) => t.validity === 'pending_evidence'),
  },
  actions: {
    async load() {
      const steps = await db.steps.toArray();
      steps.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
      this.items = steps;
      const tests = await db.tests.toArray();
      this.tests = tests.sort((a, b) => b.testedAt - a.testedAt);
      this.loaded = true;
      await this.recomputeAll();
      this.subscribeSync();
    },

    /**
     * 依据当前仪器台账重算全部测试的证据状态，变更项批量回写。
     * 补检 / 停用 / 改有效期（仪器纪元翻页）后由广播触发，立即生效。
     */
    async recomputeAll() {
      const instrumentStore = useInstrumentStore();
      if (!instrumentStore.loaded) await instrumentStore.load();
      const now = Date.now();
      const changed: TimekeepingTest[] = [];
      this.tests = this.tests.map((test) => {
        const instrument = test.instrumentId
          ? instrumentStore.byId(test.instrumentId)
          : undefined;
        const calibrations = test.instrumentId
          ? instrumentStore.calibrationsOf(test.instrumentId)
          : [];
        const events = test.instrumentId ? instrumentStore.eventsOf(test.instrumentId) : [];
        const { validity, reason } = evaluateTest(test, instrument, calibrations, events, now);
        const next: TimekeepingTest =
          test.validity === validity && test.invalidReason === reason
            ? test
            : { ...test, validity, invalidReason: reason };
        if (next !== test) changed.push(next);
        return next;
      });
      if (changed.length > 0) {
        await db.transaction('rw', db.tests, async () => {
          for (const t of changed) {
            await db.tests.update(t.id, { validity: t.validity, invalidReason: t.invalidReason });
          }
        });
      }
    },

    /** 仅重算涉及某台仪器的测试（仪器事件后立即作废相关测试） */
    async recomputeForInstrument(instrumentId: string) {
      const instrumentStore = useInstrumentStore();
      if (!instrumentStore.loaded) await instrumentStore.load();
      const now = Date.now();
      const instrument = instrumentStore.byId(instrumentId);
      const calibrations = instrumentStore.calibrationsOf(instrumentId);
      const events = instrumentStore.eventsOf(instrumentId);
      const changed: TimekeepingTest[] = [];
      this.tests = this.tests.map((test) => {
        if (test.instrumentId !== instrumentId) return test;
        const { validity, reason } = evaluateTest(test, instrument, calibrations, events, now);
        if (test.validity === validity && test.invalidReason === reason) return test;
        const next = { ...test, validity, invalidReason: reason };
        changed.push(next);
        return next;
      });
      if (changed.length > 0) {
        await db.transaction('rw', db.tests, async () => {
          for (const t of changed) {
            await db.tests.update(t.id, { validity: t.validity, invalidReason: t.invalidReason });
          }
        });
      }
    },

    /**
     * 旧测试补证：指定当时所用仪器，按「测试时刻该仪器所处的证据纪元」登记。
     * 若仪器已停用 / 测试时刻无检定覆盖 / 测试之后仪器已发生补检·停用·改有效期事件，
     * 补证后依然失效——只有真正站得住的证据才能让旧测试重新有效；否则应复测。
     */
    async attachEvidence(testId: string, instrumentId: string): Promise<TestValidity> {
      const test = await db.tests.get(testId);
      if (!test) throw new Error('测试记录不存在');
      const instrumentStore = useInstrumentStore();
      if (!instrumentStore.loaded) await instrumentStore.load();
      const instrument = instrumentStore.byId(instrumentId);
      if (!instrument) throw new Error('请选择仪器');
      // 盖测试当时的纪元；测试之后若有事件，该纪元必然小于当前纪元 → 判定失效
      const epochAtTest = instrumentStore.epochAt(instrumentId, test.testedAt);
      const patch: Partial<TimekeepingTest> = {
        instrumentId,
        evidenceEpoch: epochAtTest,
      };
      await db.tests.update(testId, toPlain(patch));
      this.tests = this.tests.map((it) =>
        it.id === testId ? { ...it, ...patch, validity: undefined } : it,
      );
      await this.recomputeForInstrument(instrumentId);
      const updated = this.tests.find((it) => it.id === testId);
      return updated?.validity ?? 'pending_evidence';
    },

    subscribeSync() {
      if (syncSubscribed) return;
      syncSubscribed = true;
      onSync(async (msg) => {
        const stepStore = useStepStore();
        if (msg.topic === 'instruments') {
          const instrumentStore = useInstrumentStore();
          await instrumentStore.load();
          const payload = (msg.payload ?? {}) as { type?: string; id?: string };
          // 补检 / 停用 / 改有效期：相关测试立即失效重算，钟表完工由 getter 自动撤下
          if (
            payload.id &&
            ['calibrate_supplementary', 'retire', 'change_validity'].includes(String(payload.type))
          ) {
            await stepStore.recomputeForInstrument(payload.id);
          } else {
            await stepStore.recomputeAll();
          }
        }
      });
    },

    async add(step: RepairStepDraft) {
      const record: RepairStep = { ...toPlain(step), id: newId('stp') };
      await db.steps.put(toPlain(record));
      this.items = [...this.items, record];
      return record;
    },
    async finish(id: string) {
      const patch: Partial<RepairStep> = { state: 'done', finishedAt: Date.now() };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    async rollback(id: string) {
      const patch: Partial<RepairStep> = { state: 'rolledback', finishedAt: undefined };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    /** 上下移动排序：交换两个相邻步骤的 seq */
    async swapSeq(aId: string, bId: string) {
      const a = this.items.find((it) => it.id === aId);
      const b = this.items.find((it) => it.id === bId);
      if (!a || !b) return;
      const aSeq = a.seq;
      await db.steps.update(a.id, { seq: b.seq });
      await db.steps.update(b.id, { seq: aSeq });
      this.items = this.items.map((it) => {
        if (it.id === a.id) return { ...it, seq: b.seq };
        if (it.id === b.id) return { ...it, seq: aSeq };
        return it;
      });
    },

    /**
     * 直接登记走时测试（仅供无界面流程 / 数据修复用）。
     * 正常走时测试必须经 utils/booking 的「占台 → confirmTest 原子落库」路径，
     * 该路径会强制仪器在用、检定有效、时段无冲突；此处同样拒绝无仪器的记录。
     */
    async addTest(draft: TimekeepingTestDraft) {
      if (!draft.instrumentId) {
        throw new Error('走时测试必须选择校表仪并完成占台');
      }
      const record: TimekeepingTest = { ...toPlain(draft), id: newId('tst') };
      await db.tests.put(toPlain(record));
      this.tests = [record, ...this.tests];
      return record;
    },

    /** 占台确认后，booking 返回的已落库记录并入内存态 */
    acceptSavedTest(record: TimekeepingTest) {
      this.tests = [record, ...this.tests.filter((it) => it.id !== record.id)];
    },

    /** 从库中重新拉取测试（其他页签保存后同步） */
    async refreshTests() {
      const tests = await db.tests.toArray();
      this.tests = tests.sort((a, b) => b.testedAt - a.testedAt);
      await this.recomputeAll();
    },

    async removeTest(id: string) {
      await db.tests.delete(id);
      this.tests = this.tests.filter((it) => it.id !== id);
    },
  },
});
