import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run the bot on a schedule with launchd: 07:00, 13:00 and 20:00 local time.
 *
 *   npm run schedule -- install [--no-publish]
 *   npm run schedule -- uninstall
 *   npm run schedule -- status
 *
 * Each run is one `npm start -- --publish`: collect, draft, send to the
 * approval chat, and wait up to six hours for an answer. Nothing is posted
 * without "d" from the owner. A run that finds the previous one still waiting
 * steps aside (session lock), and a run missed while the Mac sleeps starts
 * once on wake. The local time zone is the Mac's; set it to Asia/Ho_Chi_Minh.
 *
 * The plist is written from this checkout's real paths, so nothing personal
 * lives in the repository.
 */

export const LABEL = 'com.squarepilot.run';
export const RUN_HOURS = [7, 13, 20] as const;

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export interface PlistOptions {
  repoDir: string;
  logDir: string;
  publish: boolean;
  hours?: readonly number[];
}

export function buildPlist(opts: PlistOptions): string {
  const hours = opts.hours ?? RUN_HOURS;
  // One log file per day; launchd's own output (a run that cannot start)
  // goes to launchd.log beside it.
  const command =
    `cd ${shellQuote(opts.repoDir)} && mkdir -p ${shellQuote(opts.logDir)} && ` +
    `npm start --${opts.publish ? ' --publish' : ''} >> ${shellQuote(opts.logDir)}/run-$(date +%F).log 2>&1`;
  const intervals = hours
    .map((h) => `    <dict>\n      <key>Hour</key>\n      <integer>${h}</integer>\n      <key>Minute</key>\n      <integer>0</integer>\n    </dict>`)
    .join('\n');
  const log = path.join(opts.logDir, 'launchd.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xml(command)}</string>
  </array>

  <!-- ${hours.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')} local time. A run missed while the Mac sleeps starts once on wake. -->
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function launchctl(args: string[], allowFailure = false): string {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (allowFailure) return '';
    throw err;
  }
}

function main(): void {
  const action = process.argv[2];
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const logDir = path.join(os.homedir(), '.squarepilot', 'logs');

  if (action === 'install') {
    const publish = !process.argv.includes('--no-publish');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), buildPlist({ repoDir, logDir, publish }));
    execFileSync('plutil', ['-lint', plistPath()], { stdio: 'inherit' });
    launchctl(['bootout', `${domain}/${LABEL}`], true);
    launchctl(['bootstrap', domain, plistPath()]);
    console.log(
      `Installed ${LABEL}: runs at ${RUN_HOURS.map((h) => `${h}:00`).join(', ')}` +
        `${publish ? ' with publishing on (every post still needs "d")' : ', publishing off'}. Logs: ${logDir}`,
    );
    return;
  }
  if (action === 'uninstall') {
    launchctl(['bootout', `${domain}/${LABEL}`], true);
    if (fs.existsSync(plistPath())) fs.unlinkSync(plistPath());
    console.log(`Removed ${LABEL}.`);
    return;
  }
  if (action === 'status') {
    const out = launchctl(['print', `${domain}/${LABEL}`], true);
    if (!out) {
      console.log(`${LABEL} is not loaded.`);
      return;
    }
    const pick = (re: RegExp) => out.match(re)?.[1]?.trim();
    console.log(`${LABEL}: state ${pick(/\bstate = (.+)/) ?? 'unknown'}, runs ${pick(/\bruns = (.+)/) ?? '0'}, last exit ${pick(/last exit code = (.+)/) ?? 'none'}`);
    return;
  }
  console.log('Usage: npm run schedule -- install [--no-publish] | uninstall | status');
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
