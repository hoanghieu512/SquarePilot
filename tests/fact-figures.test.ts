import { describe, expect, it } from 'vitest';
import {
  checkFigures,
  extractFigures,
  figureAppearsIn,
  isSupported,
  type FigureCheckOptions,
  type FigureUnit,
} from '../src/compose/fact-figures.js';

describe('extractFigures extraction table', () => {
  it.each<{
    input: string;
    raw: string;
    value: number;
    unit: FigureUnit;
    precision: number;
  }>([
    { input: '$68k', raw: '$68k', value: 68_000, unit: 'currency', precision: 1000 },
    { input: '2.5%', raw: '2.5%', value: 2.5, unit: 'percent', precision: 0.1 },
    { input: '68,214', raw: '68,214', value: 68_214, unit: 'plain', precision: 1 },
    { input: '1.2 billion', raw: '1.2 billion', value: 1.2e9, unit: 'plain', precision: 1e8 },
    { input: '$3.4B', raw: '$3.4B', value: 3.4e9, unit: 'currency', precision: 1e8 },
    { input: '3x', raw: '3x', value: 3, unit: 'multiple', precision: 1 },
    { input: '10×', raw: '10×', value: 10, unit: 'multiple', precision: 1 },
    { input: '25 bps', raw: '25 bps', value: 25, unit: 'bps', precision: 1 },
    { input: '200-week', raw: '200-week', value: 200, unit: 'plain', precision: 1 },
    { input: '50-day', raw: '50-day', value: 50, unit: 'plain', precision: 1 },
    { input: '24-hour', raw: '24-hour', value: 24, unit: 'plain', precision: 1 },
    { input: '-12%', raw: '-12%', value: 12, unit: 'percent', precision: 1 },
    { input: '14:00', raw: '14:00', value: 1400, unit: 'plain', precision: 1 },
    { input: '8:30', raw: '8:30', value: 830, unit: 'plain', precision: 1 },
    { input: 'March 21', raw: '21', value: 21, unit: 'plain', precision: 1 },
    { input: '$7', raw: '$7', value: 7, unit: 'currency', precision: 1 },
    { input: '5%', raw: '5%', value: 5, unit: 'percent', precision: 1 },
    { input: 'US$2.5mn', raw: 'US$2.5mn', value: 2.5e6, unit: 'currency', precision: 1e5 },
    { input: '500 USDT', raw: '500 USDT', value: 500, unit: 'currency', precision: 1 },
  ])('extracts $input', ({ input, raw, value, unit, precision }) => {
    const figures = extractFigures(input);
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ raw, value, unit, precision });
  });

  it.each<{
    input: string;
    expected: { value: number; unit: FigureUnit; precision: number }[];
  }>([
    {
      input: '3-5%',
      expected: [
        { value: 3, unit: 'percent', precision: 1 },
        { value: 5, unit: 'percent', precision: 1 },
      ],
    },
    {
      input: '3–5%',
      expected: [
        { value: 3, unit: 'percent', precision: 1 },
        { value: 5, unit: 'percent', precision: 1 },
      ],
    },
    {
      input: '$60k-$65k',
      expected: [
        { value: 60_000, unit: 'currency', precision: 1000 },
        { value: 65_000, unit: 'currency', precision: 1000 },
      ],
    },
  ])('extracts range $input into two figures', ({ input, expected }) => {
    const figures = extractFigures(input);
    expect(figures).toHaveLength(2);
    expect(figures[0]).toMatchObject(expected[0]!);
    expect(figures[1]).toMatchObject(expected[1]!);
  });
});

describe('extractFigures skip table', () => {
  it.each<{ input: string; opts?: FigureCheckOptions }>([
    { input: 'Web3' },
    { input: 'L2' },
    { input: 'ERC20' },
    { input: 'G7' },
    { input: 'Q4' },
    { input: 'H1' },
    { input: 'x402' },
    { input: 'BEP20' },
    { input: '1inch' },
    { input: 'ERC-20' },
    { input: 'BEP-20' },
    { input: 'COVID-19' },
    { input: 'S&P 500' },
    { input: 'Nasdaq 100' },
    { input: 'Nasdaq-100' },
    { input: 'Russell 2000' },
    { input: 'FTSE 100' },
    { input: 'Nikkei 225' },
    { input: 'DAX 40' },
    { input: 'CAC 40' },
    { input: 'Euro Stoxx 50' },
    { input: '24/7' },
    { input: 'T+1' },
    { input: 'T+2' },
    { input: 'two reasons' },
    { input: '3 layers' },
    { input: 'the 2026 outlook', opts: { currentYear: 2026 } },
    { input: 'Near $68k today', opts: { exempt: ['$68k'] } },
  ])('skips non-figure in "$input"', ({ input, opts }) => {
    expect(extractFigures(input, opts)).toEqual([]);
  });

  it('skips the index number in "S&P 500 fell 2.5%" while keeping 2.5%', () => {
    const figures = extractFigures('S&P 500 fell 2.5%');
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ raw: '2.5%', value: 2.5, unit: 'percent', precision: 0.1 });
  });
});

describe('extractFigures years', () => {
  it('treats a non-current bare year as a figure', () => {
    const figures = extractFigures('since 2015', { currentYear: 2026 });
    expect(figures).toEqual([
      { raw: '2015', value: 2015, unit: 'plain', precision: 1, index: 6 },
    ]);
  });
});

describe('isSupported matching table', () => {
  it.each<{ draft: string; source: string; expected: boolean }>([
    { draft: '$68k', source: '68,214', expected: true },
    { draft: '2.5%', source: '2.47%', expected: true },
    { draft: '1.2 billion', source: '$1,180,000,000', expected: true },
    { draft: '-12%', source: 'down 12%', expected: true },
    { draft: '25 bps', source: '25 basis points', expected: true },
    { draft: '3x', source: '3x', expected: true },
    { draft: '70%', source: '65%', expected: false },
    { draft: '$68,214', source: '$68k', expected: false },
    { draft: '2.5%', source: '2.5', expected: false },
    { draft: '3x', source: '3%', expected: false },
    { draft: '25 bps', source: '25', expected: false },
  ])('isSupported($draft, $source) -> $expected', ({ draft, source, expected }) => {
    const [fig] = extractFigures(draft);
    const sources = extractFigures(source);
    expect(fig).toBeDefined();
    expect(isSupported(fig!, sources)).toBe(expected);
  });
});

describe('checkFigures', () => {
  it('reports unsupported figures in text order for the sample draft and evidence', () => {
    const body =
      'Bitcoin is near $68k and the S&P 500 is up 2.5% this month. The 200-week average has held since 2015, and 70% of supply has not moved.';
    const evidence = ['BTC last traded at $68,214.', 'S&P 500 month-to-date change: +2.47%.'];

    const result = checkFigures(body, evidence, { currentYear: 2026 });

    expect(result.ok).toBe(false);
    expect(result.unsupported.map((f) => f.raw)).toEqual(['200-week', '2015', '70%']);
    expect(result.corrections).toEqual([
      'The figure "200-week" is not in the evidence. Remove it or use a figure the evidence states; do not estimate or recall numbers.',
      'The figure "2015" is not in the evidence. Remove it or use a figure the evidence states; do not estimate or recall numbers.',
      'The figure "70%" is not in the evidence. Remove it or use a figure the evidence states; do not estimate or recall numbers.',
    ]);
  });

  it('deduplicates repeated unsupported figures by raw, keeping the first occurrence', () => {
    const body = 'Supply is 70% locked and 15% staked, so 70% stays idle.';
    const evidence = ['Staked share reached 15% this quarter.'];

    const result = checkFigures(body, evidence);

    expect(result.ok).toBe(false);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]).toMatchObject({ raw: '70%', index: 10 });
    expect(result.corrections).toEqual([
      'The figure "70%" is not in the evidence. Remove it or use a figure the evidence states; do not estimate or recall numbers.',
    ]);
  });

  it('returns ok true when every figure in the body is supported', () => {
    const result = checkFigures('BTC trades near $68k, up 2.5%.', [
      'BTC spot price: $68,214 (+2.47%).',
    ]);
    expect(result).toEqual({ ok: true, unsupported: [], corrections: [] });
  });
});

describe('figureAppearsIn', () => {
  it.each<{ raw: string; text: string; expected: boolean }>([
    { raw: '$68k', text: 'trading near $68,214 today', expected: true },
    { raw: '70%', text: '65% of supply', expected: false },
    { raw: 'Web3', text: 'Web3 adoption continues', expected: false },
  ])('figureAppearsIn($raw, $text) -> $expected', ({ raw, text, expected }) => {
    expect(figureAppearsIn(raw, text)).toBe(expected);
  });
});
