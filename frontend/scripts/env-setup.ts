/** Node 测试环境桩：必须在任何 import Dexie / 业务模块之前加载 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

class FakeBroadcastChannel {
  static channels = new Set<FakeBroadcastChannel>();
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    FakeBroadcastChannel.channels.add(this);
  }
  postMessage(data: unknown) {
    for (const ch of FakeBroadcastChannel.channels) {
      if (ch.name === this.name && ch !== this) {
        queueMicrotask(() => ch.onmessage?.({ data }));
      }
    }
  }
  close() {
    FakeBroadcastChannel.channels.delete(this);
  }
}

const storage = new MemoryStorage();

/** 可控的 Web Locks API 模拟（同名互斥 + 队列 + query + 强制释放模拟崩溃） */
class FakeLockManager {
  private queues = new Map<string, Promise<unknown>>();
  private held = new Set<string>();

  private async enqueue<T>(name: string, cb: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const next = prev.then(() => gate);
    this.queues.set(name, next.catch(() => {}));
    await prev.catch(() => {});
    this.held.add(name);
    try {
      return await cb();
    } finally {
      this.held.delete(name);
      release();
    }
  }

  runExclusive<T>(name: string, cb: () => Promise<T>): Promise<T> {
    return this.enqueue(name, cb);
  }
  request<T>(name: string, cb: (lock: unknown) => Promise<T>): Promise<T> {
    return this.enqueue(name, () => cb({}));
  }
  query() {
    return Promise.resolve({
      held: [...this.held].map((name) => ({ name })),
      pending: [] as { name: string }[],
    });
  }
  /** 模拟页签崩溃：所有在持锁立即视为释放（真正的 Web Locks 由浏览器保证） */
  crash() {
    this.held.clear();
    this.queues.clear();
  }
}

export const fakeLocks = new FakeLockManager();

const fakeWindow = {
  localStorage: storage,
  addEventListener: () => {},
  removeEventListener: () => {},
  navigator: { userAgent: 'node-test', locks: fakeLocks },
};

(globalThis as any).window = fakeWindow;
(globalThis as any).document = {
  hidden: false,
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: (tag: string) => ({ tagName: tag, style: {}, setAttribute: () => {}, appendChild: () => {} }),
  createElementNS: () => ({ setAttribute: () => {}, appendChild: () => {} }),
  createTextNode: (text: string) => ({ nodeValue: text }),
  createComment: () => ({}),
  querySelector: () => null,
  querySelectorAll: () => [],
};
(globalThis as any).navigator = fakeWindow.navigator;
(globalThis as any).BroadcastChannel = FakeBroadcastChannel;
(globalThis as any).localStorage = storage;
(globalThis as any).indexedDB = new IDBFactory();
(globalThis as any).IDBKeyRange = IDBKeyRange;
