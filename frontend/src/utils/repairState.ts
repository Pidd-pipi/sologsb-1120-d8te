import type { RepairStep } from '../types/step';
import { testSupportsFinish, type TimekeepingTest } from '../types/test';

export const REPAIR_STATES = ['未开工', '维修中', '待测试', '已完成'] as const;

export type RepairState = (typeof REPAIR_STATES)[number];

/**
 * 由工序与走时测试推导修复状态（台账分栏 / 详情页共用）。
 * 完工条件：全部工序完成，且存在一条「凭证有效 + 结论合格」的测试。
 * 仪器补检/停用/改有效期使测试失效后，完工结论自动撤下；复测合格后自动恢复。
 * 旧测试无仪器记录属待补证，不沿用原合格结果。
 */
export function repairStateOf(steps: RepairStep[], tests: TimekeepingTest[]): RepairState {
  if (steps.length === 0) return '未开工';
  const done = steps.filter((s) => s.state === 'done').length;
  const hasValidPass = tests.some(testSupportsFinish);
  if (done === steps.length && hasValidPass) return '已完成';
  if (done === steps.length) return '待测试';
  if (done > 0) return '维修中';
  return '未开工';
}

/** 是否存在支撑完工的有效合格测试 */
export function hasValidPass(tests: TimekeepingTest[]): boolean {
  return tests.some(testSupportsFinish);
}

/** 待补证测试数（旧测试无仪器记录） */
export function pendingProofCount(tests: TimekeepingTest[]): number {
  return tests.filter((t) => t.validity === 'pending-proof').length;
}
