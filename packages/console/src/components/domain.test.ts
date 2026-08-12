import { describe, it, expect } from 'vitest';
import { timeAgo, timeUntil } from './domain.js';

const NOW = 1_700_000_000_000;

describe('timeAgo', () => {
  it('reads in seconds, minutes, hours then days', () => {
    expect(timeAgo(NOW - 5_000, NOW)).toBe('5s ago');
    expect(timeAgo(NOW - 90_000, NOW)).toBe('2m ago');
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  it('clamps a future timestamp to 0 rather than rendering negative time', () => {
    // Clock skew between the server and the browser is normal; "-3s ago" is not.
    expect(timeAgo(NOW + 3_000, NOW)).toBe('0s ago');
  });
});

describe('timeUntil', () => {
  it('counts down a pending approval deadline', () => {
    expect(timeUntil(NOW + 45_000, NOW)).toBe('45s left');
    expect(timeUntil(NOW + 125_000, NOW)).toBe('2m 5s left');
  });

  it('reports expired at and past the deadline', () => {
    // The gate has already resolved by this point, so the UI must stop
    // offering Approve/Reject rather than show a negative countdown.
    expect(timeUntil(NOW, NOW)).toBe('expired');
    expect(timeUntil(NOW - 1_000, NOW)).toBe('expired');
  });
});
