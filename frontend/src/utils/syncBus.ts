/**
 * 跨页签同步总线：仪器台账变动、占台变动时通知其他页签立即刷新。
 * 优先用 BroadcastChannel；不可用时退化到 localStorage storage 事件
 *（storage 事件天然只在同站的其他页签触发，不会回环到自己）。
 */

export type SyncTopic = 'instruments' | 'reservations';

export interface SyncMessage {
  topic: SyncTopic;
  payload?: unknown;
}

type Listener = (msg: SyncMessage) => void;

const STORAGE_KEY = 'gbclockrepair:sync';
let channel: BroadcastChannel | null = null;
const listeners = new Set<Listener>();
let listening = false;

function ensureListening(): void {
  if (listening) return;
  listening = true;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('gbclockrepair:sync');
      channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
        listeners.forEach((fn) => fn(ev.data));
      };
      return;
    }
  } catch {
    channel = null;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== STORAGE_KEY || !ev.newValue) return;
      try {
        const msg = JSON.parse(ev.newValue) as SyncMessage;
        listeners.forEach((fn) => fn(msg));
      } catch {
        /* 忽略无法解析的消息 */
      }
    });
  }
}

/** 广播给其他页签（本页签不会收到自己的消息） */
export function publishSync(msg: SyncMessage): void {
  ensureListening();
  if (channel) {
    channel.postMessage(msg);
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...msg, t: Date.now() }));
  } catch {
    /* localStorage 不可用时仅本页签生效 */
  }
}

export function onSync(fn: Listener): () => void {
  ensureListening();
  listeners.add(fn);
  return () => listeners.delete(fn);
}
