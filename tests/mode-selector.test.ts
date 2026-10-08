import { describe, expect, it } from 'vitest';
import {
  MODES,
  MODE_COOLDOWN_POSTS,
  constraintsAsInstructions,
  selectMode,
  type Mode,
} from '../src/compose/modes.js';

describe('selectMode', () => {
  it('picks a mode when nothing has been used yet', () => {
    const choice = selectMode([]);
    expect(MODES).toContain(choice.spec.mode);
    expect(choice.forced).toBe(false);
    expect(choice.excluded).toHaveLength(0);
  });

  it('excludes modes used in the recent window', () => {
    const recent: Mode[] = ['explain', 'breakdown', 'observation'];
    const choice = selectMode(recent);

    expect(recent).not.toContain(choice.spec.mode);
    expect(choice.excluded.map((e) => e.mode).sort()).toEqual([...recent].sort());
  });

  it('only looks back as far as the cooldown window', () => {
    // Five entries, but only the newest three may block.
    const recent: Mode[] = ['explain', 'breakdown', 'observation', 'contrarian', 'implication'];
    const choice = selectMode(recent);
    expect(['contrarian', 'implication', 'compare']).toContain(choice.spec.mode);
  });

  it('reuses the least recent mode rather than failing when all are blocked', () => {
    const recent: Mode[] = ['explain', 'breakdown', 'observation'];
    const choice = selectMode(recent, ['explain', 'breakdown', 'observation']);

    expect(choice.forced).toBe(true);
    expect(choice.spec.mode).toBe('observation'); // last entry = least recent
  });

  it('gives every mode a distinct shape, so rotation is visible in the output', () => {
    const shapes = MODES.map((m) => {
      const { constraints } = selectMode([], [m]).spec;
      return `${constraints.paragraphs.join('-')}|${constraints.takePosition.join('-')}|${constraints.maxQuestionParagraphs}`;
    });
    expect(new Set(shapes).size).toBe(MODES.length);
  });

  it('keeps the cooldown window smaller than the number of modes', () => {
    // Otherwise every pick would be forced and rotation would be theatre.
    expect(MODE_COOLDOWN_POSTS).toBeLessThan(MODES.length);
  });
});

describe('constraintsAsInstructions', () => {
  it('states the take position in words a drafter can act on', () => {
    const early = constraintsAsInstructions(selectMode([], ['observation']).spec);
    const late = constraintsAsInstructions(selectMode([], ['implication']).spec);

    expect(early.join(' ')).toMatch(/opening third/);
    expect(late.join(' ')).toMatch(/very end/);
  });

  it('carries the paragraph range and question budget', () => {
    const text = constraintsAsInstructions(selectMode([], ['breakdown']).spec).join(' ');
    expect(text).toMatch(/between 7 and 10 paragraphs/);
    expect(text).toMatch(/At most 1 paragraph may contain a question/);
  });
});
