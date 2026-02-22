/**
 * Service subcommand: `idlehands service [status|start|stop|restart|logs|uninstall]`
 *
 * Manages the unified idlehands-bot systemd user service.
 */

import { spawnSync } from 'node:child_process';

import {
  serviceState,
  hasSystemd,
  installBotService,
  uninstallBotService,
  checkLingerEnabled,
} from './bot.js';
import { runHealthSubcommand } from './runtime-cmds.js';

const SVC = 'idlehands-bot.service';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function checkActive(): boolean {
  return serviceState(SVC).active;
}

async function waitForActive(timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (checkActive()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return checkActive();
}

async function showRestartProgress(): Promise<void> {
  process.stdout.write(`  ⏳ Stopping service...`);
  spawnSync('systemctl', ['--user', 'stop', SVC], { stdio: 'pipe' });
  // Brief pause for clean shutdown
  await new Promise((r) => setTimeout(r, 1000));
  console.log(` ${GREEN}✓${RESET}`);

  process.stdout.write(`  ⏳ Starting service...`);
  spawnSync('systemctl', ['--user', 'start', SVC], { stdio: 'pipe' });
  const started = await waitForActive();
  if (started) {
    console.log(` ${GREEN}✓${RESET}`);
  } else {
    console.log(` ${RED}✗${RESET}`);
    console.log(`  ${RED}Service failed to start. Check logs: idlehands service logs${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Run full health check to verify all hosts and models are responding
  try {
    const { loadConfig } = await import('../config.js');
    const { config } = await loadConfig({});
    process.stdout.write(`  ⏳ Running health check...`);
    // Run the full health command which checks all hosts and models
    await runHealthSubcommand({}, config);
  } catch {
    // Config/runtime not available — skip health check
  }
}

export async function runServiceSubcommand(args: any): Promise<void> {
  const action = args._[1] || 'status';

  if (!hasSystemd()) {
    console.error('Systemd not available on this system. Service management requires systemd.');
    process.exit(1);
  }

  switch (action) {
    case 'status': {
      const st = serviceState(SVC);
      console.log(`Service: ${SVC}`);
      console.log(`  Installed: ${st.exists ? 'yes' : 'no'}`);
      console.log(`  Enabled:   ${st.enabled ? 'yes' : 'no'}`);
      console.log(`  Active:    ${st.active ? 'yes' : 'no'}`);
      if (!checkLingerEnabled()) {
        console.log(`\n  ⚠ Linger not enabled. Service will stop when you log out.`);
        console.log(`    Run: loginctl enable-linger`);
      }
      break;
    }
    case 'start': {
      process.stdout.write(`Starting ${SVC}...`);
      spawnSync('systemctl', ['--user', 'start', SVC], { stdio: 'pipe' });
      const up = await waitForActive();
      console.log(up ? ` ${GREEN}✓${RESET}` : ` ${RED}✗${RESET}`);
      if (!up) process.exitCode = 1;
      break;
    }
    case 'stop': {
      process.stdout.write(`Stopping ${SVC}...`);
      spawnSync('systemctl', ['--user', 'stop', SVC], { stdio: 'pipe' });
      await new Promise((r) => setTimeout(r, 1000));
      const stopped = !checkActive();
      console.log(stopped ? ` ${GREEN}✓${RESET}` : ` ${RED}✗${RESET}`);
      if (!stopped) process.exitCode = 1;
      break;
    }
    case 'restart': {
      console.log(`Restarting ${SVC}...`);
      await showRestartProgress();
      break;
    }
    case 'logs':
      spawnSync('journalctl', ['--user', '-u', SVC, '-f', '--no-pager'], { stdio: 'inherit' });
      break;
    case 'install': {
      const st = serviceState(SVC);
      if (st.exists && st.active) {
        console.log('Service already installed and running.');
      } else {
        await installBotService();
        console.log('Service installed and started.');
        if (!checkLingerEnabled()) {
          console.log('\n  ⚠ Run `loginctl enable-linger` so the service survives logout.');
        }
      }
      break;
    }
    case 'uninstall': {
      const removed = await uninstallBotService();
      if (removed) {
        console.log('Service stopped, disabled, and removed.');
      } else {
        console.log('No service found to remove.');
      }
      break;
    }
    default:
      console.error(`Unknown service action: ${action}`);
      console.log('Usage: idlehands service [status|start|stop|restart|logs|install|uninstall]');
      process.exit(1);
  }
}
