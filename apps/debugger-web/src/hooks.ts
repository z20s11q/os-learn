import { useCallback, useRef, useSyncExternalStore } from 'react';
import { store, type LabState } from './store';

/** 所有面板共用单一 Frame store 的订阅。 */
export function useLab(): LabState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** 浅比较：selector 返回新对象时，只有字段真的变了才触发重渲染。 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

/**
 * 带 selector 的 store 订阅（T13 性能优化）。
 *
 * `useLab()` 会在任何 state patch（包括通知、事件流）时重渲染整个面板；
 * 这里让组件只订阅自己需要的字段，并用稳定的 getSnapshot 缓存结果，避免
 * selector 每次返回新对象造成无限重渲染。
 */
export function useLabSelector<T>(
  selector: (state: LabState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const equalRef = useRef(isEqual);
  equalRef.current = isEqual;
  const cacheRef = useRef<{ state: LabState; value: T } | null>(null);

  const getSnapshot = useCallback(() => {
    const state = store.getState();
    const cached = cacheRef.current;
    if (cached !== null && cached.state === state) return cached.value;
    const next = selectorRef.current(state);
    if (cached !== null && equalRef.current(cached.value, next)) {
      // 复用缓存值的引用，让 React 因 Object.is 相等而跳过重渲染。
      cacheRef.current = { state, value: cached.value };
      return cached.value;
    }
    cacheRef.current = { state, value: next };
    return next;
  }, []);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
