import type readline from 'node:readline/promises';

import {
  HIDE_CURSOR,
  SHOW_CURSOR,
  ERASE_LINE,
  enterFullScreen as enterFullScreenBase,
  leaveFullScreen as leaveFullScreenBase,
  clearScreen,
} from '../tui/screen.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const LOGO_WIDE = [
  `${CYAN} ██╗██████╗ ██╗     ███████╗${RESET}    ${BOLD}██╗  ██╗ █████╗ ███╗   ██╗██████╗ ███████╗${RESET}`,
  `${CYAN} ██║██╔══██╗██║     ██╔════╝${RESET}    ${BOLD}██║  ██║██╔══██╗████╗  ██║██╔══██╗██╔════╝${RESET}`,
  `${CYAN} ██║██║  ██║██║     █████╗${RESET}      ${BOLD}███████║███████║██╔██╗ ██║██║  ██║███████╗${RESET}`,
  `${CYAN} ██║██║  ██║██║     ██╔══╝${RESET}      ${BOLD}██╔══██║██╔══██║██║╚██╗██║██║  ██║╚════██║${RESET}`,
  `${CYAN} ██║██████╔╝███████╗███████╗${RESET}    ${BOLD}██║  ██║██║  ██║██║ ╚████║██████╔╝███████║${RESET}`,
  `${CYAN} ╚═╝╚═════╝ ╚══════╝╚══════╝${RESET}    ${BOLD}╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝${RESET}`,
];

const LOGO_NARROW = [`  ${CYAN}${BOLD}I D L E${RESET}   ${BOLD}H A N D S${RESET}`];

let inAltScreen = false;

export function isInAltScreen(): boolean {
  return inAltScreen;
}

export function enterFullScreen(): void {
  enterFullScreenBase();
  inAltScreen = true;
}

export function leaveFullScreen(): void {
  leaveFullScreenBase();
  inAltScreen = false;
}

export function drawHeader(stepLabel?: string): void {
  clearScreen();
  const cols = process.stdout.columns ?? 80;
  const logo = cols >= 78 ? LOGO_WIDE : LOGO_NARROW;
  console.log();
  for (const line of logo) {
    console.log(line);
  }
  console.log(`  ${DIM}Local-first coding agent${RESET}`);
  if (stepLabel) {
    console.log();
    const bar = '─'.repeat(Math.min(cols - 4, 60));
    console.log(`  ${DIM}${bar}${RESET}`);
    console.log(`  ${BOLD}${stepLabel}${RESET}`);
  }
  console.log();
}

export function info(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`);
}

export function success(text: string): void {
  console.log(`  ${GREEN}✓${RESET} ${text}`);
}

export function warn(text: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${text}`);
}

export async function ask(rl: readline.Interface, prompt: string, fallback = ''): Promise<string> {
  process.stdout.write(SHOW_CURSOR);
  const hint = fallback ? ` ${DIM}[${fallback}]${RESET}` : '';
  const ans = (await rl.question(`  ${prompt}${hint}: `)).trim();
  return ans || fallback;
}

export async function pause(): Promise<void> {
  return new Promise<void>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(`  ${DIM}Press any key to continue...${RESET}`);
    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === '\x03') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw ?? false);
        leaveFullScreen();
        process.exit(0);
      }
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw ?? false);
      resolve();
    };
    process.stdin.on('data', onData);
  });
}

export async function askYN(
  rl: readline.Interface,
  prompt: string,
  defaultYes = true
): Promise<boolean> {
  process.stdout.write(SHOW_CURSOR);
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await rl.question(`  ${prompt} ${DIM}[${hint}]${RESET}: `)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans.startsWith('y');
}

function moveUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : '';
}

export async function selectChoice(
  choices: { value: string; desc?: string }[],
  defaultValue: string
): Promise<string> {
  const defaultIdx = Math.max(
    0,
    choices.findIndex((c) => c.value === defaultValue)
  );
  let selected = defaultIdx;

  function render(firstDraw: boolean): void {
    if (!firstDraw) {
      process.stdout.write(moveUp(choices.length + 2));
    }
    const maxLen = Math.max(...choices.map((c) => c.value.length));
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i];
      const arrow = i === selected ? `${GREEN}❯${RESET}` : ' ';
      const padded = c.value.padEnd(maxLen);
      const label = i === selected ? `${BOLD}${padded}${RESET}` : `${DIM}${padded}${RESET}`;
      const desc = c.desc ? `  ${DIM}${c.desc}${RESET}` : '';
      process.stdout.write(`${ERASE_LINE}  ${arrow} ${label}${desc}\n`);
    }
    process.stdout.write(`${ERASE_LINE}\n`);
    process.stdout.write(`${ERASE_LINE}  ${DIM}↑/↓ to move, Enter to select${RESET}\n`);
  }

  process.stdout.write('\n');
  process.stdout.write(HIDE_CURSOR);
  render(true);

  return new Promise<string>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === '\x1b[A' || key === 'k') {
        selected = (selected - 1 + choices.length) % choices.length;
        render(false);
      } else if (key === '\x1b[B' || key === 'j') {
        selected = (selected + 1) % choices.length;
        render(false);
      } else if (key === '\r' || key === '\n') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw ?? false);
        process.stdout.write(SHOW_CURSOR);
        resolve(choices[selected].value);
      } else if (key === '\x03') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw ?? false);
        process.stdout.write(SHOW_CURSOR);
        leaveFullScreen();
        process.exit(0);
      }
    };

    process.stdin.on('data', onData);
  });
}
