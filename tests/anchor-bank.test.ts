import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAnchorBank, readAnchorBank } from '../src/perspective/anchor-bank.js';

/** Shaped like vault/projects/content-creator/anchor-bank.md. */
function bank(status: string): string {
  return `---
created: 2026-09-20
type: anchor-bank
status: ${status}
cooldown_days: 30
---

# Anchor Bank - tầng 2 của Rule E5

Intro text that is not an anchor.

---

## A01 - A synthetic anchor about a mismatched total

- **lens:** \`what-the-number-hides\`
- **source:** Q2
- **removed:** tên nền tảng
- **used:** false
- **last_used:** null

**text_en:**
> I added up the column myself before opening the report.
> The report's total was not the number I had written down.

**tóm tắt:** synthetic summary line.

> Editorial note that is also a blockquote.

---

## A02 - A synthetic anchor about two definitions

- **lens:** \`what-the-number-hides\`, \`docs-vs-reality\`
- **used:** true
- **last_used:** 2026-09-25

**text_en:**
> Two screens used the same word for two different counts.

---

## Còn lại

Section 1/7 đã rút xong.
`;
}

describe('parseAnchorBank', () => {
  it('yields no anchors until the bank is approved', () => {
    // The file says so itself: pipeline reads it only once status is approved.
    const parsed = parseAnchorBank(bank('draft-pending-review'));

    expect(parsed.status).toBe('draft-pending-review');
    expect(parsed.anchors).toEqual([]);
  });

  it('reads every anchor once approved', () => {
    const parsed = parseAnchorBank(bank('approved'));

    expect(parsed.anchors.map((a) => a.id)).toEqual(['A01', 'A02']);
    expect(parsed.cooldownDays).toBe(30);
  });

  it('keeps every lens an anchor belongs to', () => {
    const a02 = parseAnchorBank(bank('approved')).anchors[1]!;
    expect(a02.lenses).toEqual(['what-the-number-hides', 'docs-vs-reality']);
  });

  it('takes the English text from the quote under text_en only', () => {
    // The editorial note after the summary is also a blockquote; it is not text
    // the post may use.
    const a01 = parseAnchorBank(bank('approved')).anchors[0]!;

    expect(a01.textEn).toBe(
      "I added up the column myself before opening the report. The report's total was not the number I had written down.",
    );
  });

  it('reads last_used as a date, or null when never used', () => {
    const [a01, a02] = parseAnchorBank(bank('approved')).anchors;
    expect(a01!.lastUsed).toBeNull();
    expect(a02!.lastUsed).toBe('2026-09-25');
  });
});

describe('readAnchorBank', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bank-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('treats a missing bank as empty, so the ladder moves to the next rung', () => {
    expect(readAnchorBank(dir)).toEqual({ status: 'missing', cooldownDays: 30, anchors: [] });
  });

  it('reads anchor-bank.md from the vault directory', () => {
    fs.writeFileSync(path.join(dir, 'anchor-bank.md'), bank('approved'));
    expect(readAnchorBank(dir).anchors).toHaveLength(2);
  });
});
