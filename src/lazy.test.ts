import { describe, expect, test } from 'vitest';
import { lazyloadObject } from './lazy.js';

describe('lazy', () => {
  test('lazyloadObject', () => {
    const lazy1 = lazyloadObject(() => ({ x: 1 }));
    expect(lazy1.x).toBe(1);

    let hasInitialized = false;
    const lazy2 = lazyloadObject(() => {
      hasInitialized = true;
      return { x: 2 };
    });
    expect(hasInitialized).toBe(false);
    expect(lazy2.x).toBe(2);
    expect(hasInitialized).toBe(true);
  });
});
