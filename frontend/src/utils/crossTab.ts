/**
 * 跨页签数据变更通知：任一页面改动仪器台账/测试后广播，其他页面收到后重载。
 * 只走 localStorage storage 事件，本页签不会收到自己发出的事件。
 */
export const CHANGE_KEY = 'gbclockrepair:change';

export type ChangeTopic = 'instruments' | 'tests' | 'clocks' | 'booking';

/** 预约心跳广播通道（localStorage，收到即刷新占用列表，不做持久化） */
export const BOOKING_PULSE_KEY = 'gbclockrepair:booking-pulse';
const TAB_SECRET = Math.random().toString(36).slice(2);

export function pulseBooking(instrumentId: string): void {
  try {
    window.localStorage.setItem(
      BOOKING_PULSE_KEY,
      JSON.stringify({ instrumentId, tab: TAB_SECRET, at: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

export function onBookingPulse(handler: (instrumentId: string) => void): () => void {
  const listener = (e: StorageEvent) => {
    if (e.key !== BOOKING_PULSE_KEY || !e.newValue) return;
    try {
      const payload = JSON.parse(e.newValue) as { instrumentId?: string };
      if (payload.instrumentId) handler(payload.instrumentId);
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

export function broadcastChange(topic: ChangeTopic, detail = ''): void {
  try {
    window.localStorage.setItem(CHANGE_KEY, JSON.stringify({ topic, detail, at: Date.now() }));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function onChange(handler: (topic: ChangeTopic, detail: string) => void): () => void {
  const listener = (e: StorageEvent) => {
    if (e.key !== CHANGE_KEY || !e.newValue) return;
    try {
      const payload = JSON.parse(e.newValue) as { topic?: ChangeTopic; detail?: string };
      if (payload.topic) handler(payload.topic, payload.detail ?? '');
    } catch {
      /* 忽略无法解析的载荷 */
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
