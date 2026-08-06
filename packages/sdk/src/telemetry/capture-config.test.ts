import { describe, it, expect, afterEach } from 'vitest';
import { isCapturePayloadsEnabled, setCapturePayloadsEnabled } from './capture-config.js';

describe('capture-config', () => {
  afterEach(() => {
    setCapturePayloadsEnabled(true);
  });

  it('defaults to enabled', () => {
    expect(isCapturePayloadsEnabled()).toBe(true);
  });

  it('reflects the last value set', () => {
    setCapturePayloadsEnabled(false);
    expect(isCapturePayloadsEnabled()).toBe(false);
    setCapturePayloadsEnabled(true);
    expect(isCapturePayloadsEnabled()).toBe(true);
  });
});
