/** 校表仪（走时测试仪）台账 */

/** 仪器启用状态 */
export type InstrumentStatus = 'active' | 'disabled';

export const INSTRUMENT_STATUSES: InstrumentStatus[] = ['active', 'disabled'];

export interface CalibrationInstrument {
  id: string;
  /** 资产编号 */
  assetNo: string;
  /** 仪器名称 */
  name: string;
  /** 型号 */
  model: string;
  /** 制造厂家 */
  maker: string;
  /** 检定/校准有效期至（时间戳） */
  validUntil: number;
  /** 最近一次检定/补检时间 */
  lastCheckedAt: number;
  /** 启用 / 停用 */
  status: InstrumentStatus;
  /**
   * 检定版本号：补检、改有效期、停用时递增。
   * 测试保存时快照该版本；版本不一致的测试一律失效，需复测确认。
   */
  certVersion: number;
  note: string;
  createdAt: number;
}

export type CalibrationInstrumentDraft = Omit<CalibrationInstrument, 'id' | 'createdAt' | 'certVersion'>;

/** 仪器是否可用于新测试：启用且在检定有效期内 */
export function isInstrumentUsable(inst: Pick<CalibrationInstrument, 'status' | 'validUntil'>, now = Date.now()): boolean {
  return inst.status === 'active' && inst.validUntil > now;
}

/** 仪器不可用原因（可用时返回空串） */
export function instrumentUnusableReason(
  inst: Pick<CalibrationInstrument, 'status' | 'validUntil'>,
  now = Date.now(),
): string {
  if (inst.status === 'disabled') return '仪器已停用';
  if (inst.validUntil <= now) return '仪器已超过检定有效期';
  return '';
}

/** 距有效期截止的天数描述 */
export function validUntilLabel(validUntil: number, now = Date.now()): string {
  const days = Math.ceil((validUntil - now) / (24 * 3600 * 1000));
  if (days < 0) return `已过检 ${-days} 天`;
  if (days === 0) return '今日到期';
  return `剩余 ${days} 天`;
}
