import type { Clock } from '../types/clock';
import type { RepairStep } from '../types/step';
import type { TimekeepingTest } from '../types/test';

export type RepairState = '未开工' | '维修中' | '待测试' | '已完成';

export const REPAIR_STATES: RepairState[] = ['未开工', '维修中', '待测试', '已完成'];

/**
 * 由工序与走时测试的证据状态推导修复状态（台账分栏用）。
 * 全部工序完成只是「待测试」；必须存在至少一条证据有效的走时测试才算「已完成」。
 * 待补证 / 仪器失效 / 无检定 / 事件作废的测试一律不算完工依据；
 * 仪器补检、停用、改有效期触发重算后，已完成的钟表会因此自动退回「待测试」。
 */
export function repairStateOf(
  steps: RepairStep[],
  tests: TimekeepingTest[],
): RepairState {
  const done = steps.filter((s) => s.state === 'done').length;
  if (steps.length === 0) return '未开工';
  if (done === steps.length) {
    if (tests.some((t) => t.validity === 'valid')) return '已完成';
    return '待测试';
  }
  if (done > 0) return '维修中';
  return '未开工';
}

/** 详情页汇总：钟表的有效 / 失效 / 待补证测试数量 */
export function testEvidenceSummary(tests: TimekeepingTest[]): {
  valid: number;
  invalid: number;
  pending: number;
} {
  return {
    valid: tests.filter((t) => t.validity === 'valid').length,
    invalid: tests.filter(
      (t) =>
        t.validity === 'invalid_instrument' ||
        t.validity === 'invalid_calibration' ||
        t.validity === 'invalid_epoch',
    ).length,
    pending: tests.filter((t) => t.validity === 'pending_evidence').length,
  };
}

/** 工具类型占位，便于页面按需导入 Clock（避免循环依赖时保持显式） */
export type { Clock };
