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

/**
 * 测试证据状态（由仪器台账实时重算，快照写在记录上供列表页直接读取）：
 * - valid：仪器在用、检定覆盖测试时刻、证据纪元一致
 * - pending_evidence：旧测试，没有仪器记录，列入待补证，不沿用原合格结果
 * - invalid_instrument：仪器已停用
 * - invalid_calibration：测试时刻无有效检定覆盖
 * - invalid_epoch：补检 / 停用 / 改有效期后被作废，等待复测
 */
export type TestValidity =
  | 'valid'
  | 'pending_evidence'
  | 'invalid_instrument'
  | 'invalid_calibration'
  | 'invalid_epoch';

export const TEST_VALIDITY_META: Record<
  TestValidity,
  { label: string; type: 'success' | 'warning' | 'danger' }
> = {
  valid: { label: '有效', type: 'success' },
  pending_evidence: { label: '待补证', type: 'warning' },
  invalid_instrument: { label: '仪器停用失效', type: 'danger' },
  invalid_calibration: { label: '无有效检定失效', type: 'danger' },
  invalid_epoch: { label: '仪器事件作废', type: 'danger' },
};

/** 走时测试记录 */
export interface TimekeepingTest {
  id: string;
  clockId: string;
  testedAt: number;
  /** 占用仪器时段的结束时刻 */
  slotEnd?: number;
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
  /** 所用校表仪；旧记录缺失即列入待补证 */
  instrumentId?: string;
  /** 保存时仪器的证据纪元 */
  evidenceEpoch?: number;
  /** 证据状态快照（由 recompute 统一回写） */
  validity?: TestValidity;
  /** 失效原因文案（关联仪器事件） */
  invalidReason?: string;
}

export type TimekeepingTestDraft = Omit<TimekeepingTest, 'id'>;

/** 走时合格判定 */
export function judgeTest(rate: number, beatError: number, amplitude: number): string {
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
}
