import type { Instrument, InstrumentEvent, Calibration } from '../types/instrument';
import { calibrationCovers } from '../types/instrument';
import type { TimekeepingTest, TestValidity } from '../types/test';

export interface TestEvaluation {
  validity: TestValidity;
  reason?: string;
}

/**
 * 依据仪器台账实时判定一条测试的证据状态。
 * 顺序：无仪器 → 待补证；仪器停用 → 失效；纪元落后 → 被事件作废；
 * 测试时刻无检定覆盖 → 失效；否则有效。
 */
export function evaluateTest(
  test: TimekeepingTest,
  instrument: Instrument | undefined,
  calibrations: Calibration[],
  events: InstrumentEvent[],
  now: number,
): TestEvaluation {
  if (!test.instrumentId || !instrument) {
    return { validity: 'pending_evidence', reason: '旧测试无仪器记录，须补证或复测，不沿用原合格结果' };
  }
  if (instrument.status === 'retired') {
    return { validity: 'invalid_instrument', reason: `仪器「${instrument.code}」已停用，相关测试须复测` };
  }
  if ((test.evidenceEpoch ?? 0) < instrument.evidenceEpoch) {
    const event = events
      .filter((e) => e.instrumentId === instrument.id && e.epoch > (test.evidenceEpoch ?? 0))
      .sort((a, b) => b.happenedAt - a.happenedAt)[0];
    return {
      validity: 'invalid_epoch',
      reason: event
        ? `仪器「${instrument.code}」${event.happenedAt <= now ? '已发生' : '存在'}「${event.detail}」，此前测试作废，须复测确认`
        : `仪器「${instrument.code}」证据已更新，此前测试作废，须复测确认`,
    };
  }
  const covered = calibrations.some((c) => calibrationCovers(c, test.testedAt));
  if (!covered) {
    return { validity: 'invalid_calibration', reason: `测试时刻仪器「${instrument.code}」无有效检定覆盖` };
  }
  return { validity: 'valid' };
}

/** 钟表完工判定：全部工序完成且至少有一条「有效」走时测试（待补证 / 失效均不算） */
export function hasValidTest(tests: TimekeepingTest[]): boolean {
  return tests.some((t) => t.validity === 'valid');
}
