/** 仪器在用状态（过检不等于停用：过检是「在用但当前无有效检定」） */
export type InstrumentStatus = 'active' | 'retired';

/** 触发证据纪元翻页的仪器事件类型 */
export type InstrumentEventType = 'calibrate_supplementary' | 'retire' | 'change_validity';

export const INSTRUMENT_EVENT_LABEL: Record<InstrumentEventType, string> = {
  calibrate_supplementary: '补检登记',
  retire: '停用',
  change_validity: '改检定有效期',
};

/** 检定 / 校准记录 */
export interface Calibration {
  id: string;
  instrumentId: string;
  /** 检定日期（毫秒，当日 00:00） */
  calibratedAt: number;
  /** 有效期至（毫秒，当日 23:59:59.999） */
  validUntil: number;
  /** 证书编号 */
  certNo: string;
  /** 检定机构 */
  org: string;
  /** 是否脱检后的补检 */
  supplementary: boolean;
  note: string;
  createdAt: number;
}

/**
 * 仪器事件：补检、停用、改有效期三类。
 * 每发生一次，仪器证据纪元 +1，纪元之前保存的测试一律不再被采信，必须复测确认。
 */
export interface InstrumentEvent {
  id: string;
  instrumentId: string;
  type: InstrumentEventType;
  /** 事件发生后该仪器的新纪元 */
  epoch: number;
  happenedAt: number;
  detail: string;
}

/** 校表仪（仪器台账条目） */
export interface Instrument {
  id: string;
  /** 仪器编号，唯一 */
  code: string;
  name: string;
  model: string;
  maker: string;
  /** 摆放位置 */
  location: string;
  status: InstrumentStatus;
  /**
   * 证据纪元：测试保存时记录当时纪元；测试上的纪元小于仪器当前纪元即失效。
   * 补检 / 停用 / 改有效期都会 +1，重新启用不清算（停用前测试仍须复测）。
   */
  evidenceEpoch: number;
  /** 当前生效检定记录 id */
  activeCalibrationId?: string;
  note: string;
  createdAt: number;
}

export type InstrumentDraft = Omit<Instrument, 'id' | 'createdAt' | 'evidenceEpoch' | 'status'>;

/**
 * 临时占台记录：读数保存前先预约时段。
 * 持有页签同时持有同名 Web Lock 哨兵；页签崩溃 / 关闭时浏览器自动放锁，
 * 其他页签可立即识别；心跳 expiresAt（TTL）兜底无 Web Lock 的环境。
 */
export interface Reservation {
  id: string;
  instrumentId: string;
  clockId: string;
  slotStart: number;
  slotEnd: number;
  /** 持有页签短标识 */
  owner: string;
  /** Web Lock 哨兵名 */
  sentinelName: string;
  /** 占台成功瞬间仪器的证据纪元；保存时若已变化则拒绝 */
  evidenceEpoch: number;
  /** 心跳续期的兜底过期时刻 */
  expiresAt: number;
  createdAt: number;
}

/** 判断某检定记录是否覆盖给定时刻 */
export function calibrationCovers(calibration: Calibration, at: number): boolean {
  return calibration.calibratedAt <= at && at <= calibration.validUntil;
}
