import { describe, expect, it } from 'vitest';
import {
  PERSONA_CAP_WINDOW,
  checkPersona,
  detectPersona,
  personaCapInUse,
} from '../src/compose/persona-guard.js';

const NAMES_JOB = "I've been a QA for eight years, and this looks familiar.";
const SHOWS_JOB = 'Put the expectation beside the outcome and the gap is the story. It usually is.';

describe('detectPersona', () => {
  it('catches the English forms', () => {
    expect(detectPersona(NAMES_JOB).mentionsPersona).toBe(true);
    expect(detectPersona('My day job is testing trading systems.').mentionsPersona).toBe(true);
  });

  it('catches the Vietnamese forms', () => {
    expect(detectPersona('Mình làm QA 8 năm rồi.').mentionsPersona).toBe(true);
    expect(detectPersona('Nghề của mình là kiểm thử.').mentionsPersona).toBe(true);
  });

  it('catches a phrase that ends in an accented letter', () => {
    // JS `\b` only knows ASCII word characters, so a boundary after "ử" never
    // matched. The sentence above passed only because "nghề của mình" fired.
    expect(detectPersona('Hồi đó mình làm kiểm thử.').matched).toContain('kiểm thử');
  });

  it('catches the year count written as a digit in English', () => {
    // Draft #1 (2026-09-30) said "I've spent 8 years watching systems" and was
    // caught only because the same paragraph also said "QA".
    expect(detectPersona("I've spent 8 years watching systems fail.").mentionsPersona).toBe(true);
  });

  it('lets reasoning that shows the job through, without naming it', () => {
    // The craft answer: the discipline shows in how the argument is built.
    expect(detectPersona(SHOWS_JOB).mentionsPersona).toBe(false);
    expect(detectPersona('Suspect the inputs before you blame the system.').mentionsPersona).toBe(false);
  });

  it('does not fire on "quality" or "quantity" containing the letters', () => {
    expect(detectPersona('The quality of the data is the question.').mentionsPersona).toBe(false);
  });
});

describe('checkPersona', () => {
  it('allows naming the job when recent posts did not', () => {
    expect(checkPersona(NAMES_JOB, [SHOWS_JOB, SHOWS_JOB, SHOWS_JOB]).ok).toBe(true);
  });

  it('blocks a second mention inside the window', () => {
    const verdict = checkPersona(NAMES_JOB, [NAMES_JOB, SHOWS_JOB, SHOWS_JOB]);

    expect(verdict.ok).toBe(false);
    expect(verdict.recentCount).toBe(1);
    expect(verdict.reason).toMatch(/1 of the last 10/);
  });

  it('tells the drafter what to do instead of naming the job', () => {
    const verdict = checkPersona(NAMES_JOB, [NAMES_JOB]);
    expect(verdict.reason).toMatch(/stated position/);
    expect(verdict.reason).toMatch(/not in a byline/);
    expect(verdict.reason).toMatch(/synonym/);
  });

  it('never blocks a draft that does not name the job, however many recent ones did', () => {
    const verdict = checkPersona(SHOWS_JOB, [NAMES_JOB, NAMES_JOB, NAMES_JOB]);
    expect(verdict.ok).toBe(true);
  });

  it('only looks back as far as the window', () => {
    // The mention sits at position eleven, outside the ten-post window.
    const older = [...Array(10).fill(SHOWS_JOB), NAMES_JOB];
    expect(checkPersona(NAMES_JOB, older).ok).toBe(true);
  });

  it('keeps the window wide enough that one mention is genuinely rare', () => {
    // 1 in 10, set 2026-09-30. Must match the X pipeline's numbers.
    expect(PERSONA_CAP_WINDOW).toBe(10);
  });

  it('reproduces the X-pipeline failure: four in five would be blocked', () => {
    // Measured 2026-09-27 on outputs/x: 4 of 5 posts named the job. Under this
    // cap the second one onward is refused.
    const history = [NAMES_JOB, NAMES_JOB, NAMES_JOB, SHOWS_JOB, SHOWS_JOB];
    const verdict = checkPersona(NAMES_JOB, history);
    expect(verdict.ok).toBe(false);
    expect(verdict.recentCount).toBe(3);
  });
});

describe('personaCapInUse', () => {
  it('is in use once a post inside the window named the job', () => {
    expect(personaCapInUse([SHOWS_JOB, NAMES_JOB])).toBe(true);
  });

  it('is free when no post in the window did', () => {
    expect(personaCapInUse([SHOWS_JOB, SHOWS_JOB])).toBe(false);
    expect(personaCapInUse([...Array(10).fill(SHOWS_JOB), NAMES_JOB])).toBe(false);
  });
});
