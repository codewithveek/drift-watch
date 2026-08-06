import { describe, it, expect } from 'vitest';
import { extractFirstJsonObject } from './detector.js';

describe('extractFirstJsonObject', () => {
  it('returns a lone JSON object unchanged', () => {
    const text = '{"drift":true,"severity":"high"}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it('unwraps a ```json fenced block', () => {
    const text = 'Here you go:\n```json\n{"drift":false,"severity":"none"}\n```\nDone.';
    expect(extractFirstJsonObject(text)).toBe('{"drift":false,"severity":"none"}');
  });

  it('salvages the object from a markdown report prefix', () => {
    const text = [
      '# 🚨 DRIFT ALERT — Human Review Recommended',
      '',
      '## Executive Summary',
      '',
      'Some prose about the verdict.',
      '',
      '{"drift":true,"severity":"medium","reasons":["latency up"],"recommended_action":"Investigate."}',
      '',
      'Thanks for reading.',
    ].join('\n');
    expect(extractFirstJsonObject(text)).toBe(
      '{"drift":true,"severity":"medium","reasons":["latency up"],"recommended_action":"Investigate."}',
    );
  });

  it('does not terminate early on a brace inside a string value', () => {
    const text =
      'note {"recommended_action":"restart the } service","drift":true} trailing';
    expect(extractFirstJsonObject(text)).toBe(
      '{"recommended_action":"restart the } service","drift":true}',
    );
  });

  it('handles nested objects', () => {
    const text = 'x {"a":{"b":1},"c":2} y';
    expect(extractFirstJsonObject(text)).toBe('{"a":{"b":1},"c":2}');
  });

  it('returns null for pure prose with no JSON object', () => {
    const text = '# DRIFT ALERT\n\nNo JSON here, just a narrative report.';
    expect(extractFirstJsonObject(text)).toBeNull();
  });

  it('returns null when braces never balance', () => {
    expect(extractFirstJsonObject('{"drift":true')).toBeNull();
  });
});
