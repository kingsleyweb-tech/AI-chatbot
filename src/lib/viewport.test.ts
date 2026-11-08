import { describe, expect, it } from 'vitest';
import { frameFor } from './viewport';

describe('visual viewport frame', () => {
  it('follows the viewport at normal zoom', () => {
    expect(frameFor({ height: 800, offsetTop: 0, scale: 1 }, 800)).toEqual({ height: 800, top: 0, keyboard: false });
  });
  it('detects the on-screen keyboard', () => {
    expect(frameFor({ height: 450, offsetTop: 0, scale: 1 }, 800)).toEqual({ height: 450, top: 0, keyboard: true });
  });
  it('leaves the frame alone while pinch-zoomed (no resize or jump while panning)', () => {
    expect(frameFor({ height: 400, offsetTop: 230, scale: 2 }, 800)).toBeNull();
    expect(frameFor({ height: 790, offsetTop: 3, scale: 1.012 }, 800)).toBeNull();
  });
  it('never uses a negative offset (iOS rubber-band scroll)', () => {
    expect(frameFor({ height: 800, offsetTop: -12, scale: 1 }, 800)?.top).toBe(0);
  });
});
