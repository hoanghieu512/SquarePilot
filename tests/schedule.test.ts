import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LABEL, buildPlist } from '../src/scripts/schedule.js';

const opts = { repoDir: "/Users/someone/Dev/Square Pilot's", logDir: '/Users/someone/.squarepilot/logs', publish: true };

describe('buildPlist', () => {
  it('runs at 07:00, 13:00 and 20:00, never at load', () => {
    const plist = buildPlist(opts);
    const hours = [...plist.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));
    expect(hours).toEqual([7, 13, 20]);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toContain(`<string>${LABEL}</string>`);
  });

  it('starts one publishing run from the checkout, logging to a file per day', () => {
    const plist = buildPlist(opts);
    // Quoted for the shell and escaped for XML: a space and an apostrophe in
    // the path survive both.
    expect(plist).toContain(`cd '/Users/someone/Dev/Square Pilot'\\''s' &amp;&amp; mkdir -p`);
    expect(plist).toContain('npm start -- --publish &gt;&gt;');
    expect(plist).toContain(`'/Users/someone/.squarepilot/logs'/run-$(date +%F).log 2&gt;&amp;1`);
    expect(plist).toContain('<string>/Users/someone/.squarepilot/logs/launchd.log</string>');
  });

  it('leaves publishing off when asked', () => {
    expect(buildPlist({ ...opts, publish: false })).not.toContain('--publish');
  });

  it('is a valid property list', () => {
    if (!fs.existsSync('/usr/bin/plutil')) return;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plist-')), 'x.plist');
    fs.writeFileSync(file, buildPlist(opts));
    expect(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })).toMatch(/OK/);
  });
});
