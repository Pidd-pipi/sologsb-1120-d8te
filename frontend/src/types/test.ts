import type { CalibrationInstrument } from './instrument';

/** 测试方位 */
export type TestPosition = '面上' | '面下' | '12上' | '6上';

export const TEST_POSITIONS: TestPosition[] = ['面上', '面下', '12上', '6上'];

/** 单方位读数 */
export interface PositionReading {
  position: TestPosition;
  /** 日差 s/d */
  rate: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
}

/** 测试凭证状态 */
export type TestValidity = 'valid' | 'invalid' | 'pending-proof';

export const TEST_VALIDITY_LABEL: Record<TestValidity, string> = {
  valid: '有效',
  invalid: '已失效',
  'pending-proof': '待补证',
};

/** 失效/待补证原因码 */
export type TestInvalidReason =
  | 'missing-instrument'
  | 'instrument-disabled'
  | 'instrument-expired'
  | 'cert-changed'
  | 'instrument-missing'
  | '';

export const TEST_INVALID_REASON_LABEL: Record<Exclude<TestInvalidReason, ''>, string> = {
  'missing-instrument': '旧测试未记录所用校表仪，列入待补证',
  'instrument-disabled': '所用校表仪已停用',
  'instrument-expired': '测试时段超出仪器检定有效期',
  'cert-changed': '仪器经补检/改有效期/停用，需复测确认',
  'instrument-missing': '所用校表仪已从台账删除',
};

/** 走时测试记录 */
export interface TimekeepingTest {
  id: string;
  clockId: string;
  testedAt: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
  /** 日差 s/d */
  rate: number;
  positions: PositionReading[];
  /** 动力储备 h */
  powerReserve: number;
  conclusion: string;

  /** ---- v3：仪器凭证与预约时段 ---- */
  /** 所用校表仪 id；旧记录为空（待补证） */
  instrumentId?: string;
  /** 仪器资产编号快照 */
  instrumentNo?: string;
  /** 仪器名称快照 */
  instrumentName?: string;
  /** 保存时仪器的检定版本快照 */
  certVersion?: number;
  /** 预约开始时间 */
  slotStart?: number;
  /** 预约结束时间 */
  slotEnd?: number;
  /** 凭证状态 */
  validity?: TestValidity;
  /** 失效原因码 */
  invalidReason?: TestInvalidReason;
  /** 失效时间（仪器台账变动时级联写入） */
  invalidatedAt?: number;
}

export type TimekeepingTestDraft = Omit<TimekeepingTest, 'id'>;

/** 走时合格判定 */
export function judgeTest(rate: number, beatError: number, amplitude: number): string {
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
}

export interface TestValidityResult {
  validity: TestValidity;
  reason: TestInvalidReason;
}

/**
 * 依据仪器台账现状重算单条测试的凭证状态。
 * - 无仪器记录：待补证（不沿用原合格结论）
 * - 仪器不存在：失效
 * - 停用 / 测试时段超出检定有效期 / 检定版本变动：失效
 */
export function evaluateTest(
  test: Pick<
    TimekeepingTest,
    'instrumentId' | 'certVersion' | 'slotStart' | 'testedAt'
  >,
  instrument: CalibrationInstrument | undefined,
): TestValidityResult {
  if (!test.instrumentId) return { validity: 'pending-proof', reason: 'missing-instrument' };
  if (!instrument) return { validity: 'invalid', reason: 'instrument-missing' };
  if (instrument.status === 'disabled') return { validity: 'invalid', reason: 'instrument-disabled' };
  const at = test.slotStart ?? test.testedAt;
  if (at > instrument.validUntil) return { validity: 'invalid', reason: 'instrument-expired' };
  if (test.certVersion !== instrument.certVersion) return { validity: 'invalid', reason: 'cert-changed' };
  return { validity: 'valid', reason: '' };
}

/** 有效且结论合格的测试才可支撑钟表完工结论 */
export function testSupportsFinish(test: TimekeepingTest): boolean {
  return test.validity === 'valid' && test.conclusion === '合格';
}

/** 凭证状态文案（容忍字符串/空值，供表格 any 行使用） */
export function validityLabel(value: TestValidity | string | undefined): string {
  return TEST_VALIDITY_LABEL[(value as TestValidity) ?? 'pending-proof'] ?? '待补证';
}

/** 失效原因文案 */
export function invalidReasonLabel(value: TestInvalidReason | string | undefined): string {
  if (!value) return '';
  return TEST_INVALID_REASON_LABEL[value as Exclude<TestInvalidReason, ''>] ?? '凭证不足，需复测补证';
}
