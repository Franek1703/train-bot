import { describe, expect, it } from 'vitest';
import { isUnavailableTrainCardText, trainNumberRegex } from '../src/checker/intercityChecker.js';

describe('isUnavailableTrainCardText', () => {
  const soldOut = 'Błąd 1 z 3\nBezpośredni\nCzas: 2h 52min\n19:32\n22:24\nPoznań Gł.\nWarszawa Zach.\n8110 Gałczyński\nKlasa 1\nNiedostępna\nKlasa 2\nNiedostępna\nDODATKOWE INFORMACJE';

  it('recognises a listed train with no available class', () => {
    expect(isUnavailableTrainCardText(soldOut, 'IC 8110', '19:32')).toBe(true);
  });

  it('ignores a card that can still be bought or belongs to another train', () => {
    expect(isUnavailableTrainCardText(`${soldOut}\nKUP BILET`, 'IC 8110', '19:32')).toBe(false);
    expect(isUnavailableTrainCardText(soldOut, 'IC 81100', '19:32')).toBe(false);
    expect(isUnavailableTrainCardText(soldOut, 'IC 8110', '19:40')).toBe(false);
  });
});

describe('trainNumberRegex', () => {
  it('matches train numbers with flexible whitespace', () => {
    const regex = trainNumberRegex('IC 146');

    expect(regex.test('IC 146 Wigry')).toBe(true);
    expect(regex.test('IC146 Wigry')).toBe(true);
  });
});
