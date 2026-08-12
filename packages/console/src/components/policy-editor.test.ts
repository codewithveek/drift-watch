import { describe, it, expect } from 'vitest';
import { coerceOperand } from './policy-editor.js';

/**
 * The operand box is free text, but the rule schema is typed. Getting this
 * wrong is silent: `amountUsd > "100"` would compare as a string, so a rule
 * meant to gate large refunds would match unpredictably.
 */
describe('coerceOperand', () => {
  it('coerces numeric input so comparisons are numeric', () => {
    expect(coerceOperand('100')).toBe(100);
    expect(coerceOperand('0')).toBe(0);
    expect(coerceOperand('12.5')).toBe(12.5);
    expect(coerceOperand('-3')).toBe(-3);
    expect(coerceOperand(' 42 ')).toBe(42);
  });

  it('keeps non-numeric input as a string so `equals` still works', () => {
    expect(coerceOperand('admin')).toBe('admin');
    expect(coerceOperand('123abc')).toBe('123abc');
  });

  it('recognises booleans, which `exists` and `equals` both use', () => {
    expect(coerceOperand('true')).toBe(true);
    expect(coerceOperand('false')).toBe(false);
  });

  it('leaves an empty/whitespace operand as a string rather than coercing to 0', () => {
    // Number('') is 0 — coercing here would turn "no value entered" into a
    // real comparison against zero.
    expect(coerceOperand('')).toBe('');
    expect(coerceOperand('   ')).toBe('   ');
  });
});
