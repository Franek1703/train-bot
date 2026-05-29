import { describe, expect, it } from 'vitest';
import { trainNumberRegex } from '../src/checker/intercityChecker.js';

describe('trainNumberRegex', () => {
  it('matches train numbers with flexible whitespace', () => {
    const regex = trainNumberRegex('IC 146');

    expect(regex.test('IC 146 Wigry')).toBe(true);
    expect(regex.test('IC146 Wigry')).toBe(true);
  });
});
