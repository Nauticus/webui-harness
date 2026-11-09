import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { SHELL, type Shell } from './tools';

/**
 * What the host actually is, resolved once at startup and told to the model
 * verbatim.
 *
 * The reason this exists as its own module is the same reason the shell is
 * decided in one place in tools.ts: the model writes commands for the
 * environment it believes it is in. If the prompt says nothing, it guesses —
 * and the usual guesses are wrong in the expensive direction: bash-isms on a
 * `sh` host, `$(cygpath -u ...)` on plain Windows, `systemctl` in a container
 * with no init, `127.0.0.1` for a service it can only reach over SSH. Every
 * wrong guess costs a failed tool call before the model notices.
 *
 * So: state the facts that change command syntax, and nothing else. Hostname,
 * user, and environment values stay out — they are readable with one `env`
 * call and are nobody's business in a prompt that may be logged or sent to a
 * third-party provider.
 */

export interface EnvironmentInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** Kernel release (`uname -r`); empty where there is no /proc. */
  kernel: string;
  node: string;
  timezone: string;
  shell: Shell;
  wsl: boolean;
  ssh: boolean;
  container: boolean;
}

/** Windows Subsystem for Linux, where Windows binaries are reachable by path. */
function isWsl(env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** A container, i.e. a host with no init system, no systemd, often no network admin. */
function isContainer(env: NodeJS.ProcessEnv): boolean {
  if (env.container || env.KUBERNETES_SERVICE_HOST) return true;
  if (existsSync('/.dockerenv')) return true;
  try {
    return /docker|kubepods|containerd|lxc/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

export function detectEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  shell: Shell = SHELL
): EnvironmentInfo {
  let kernel = '';
  try {
    kernel = os.release();
  } catch {
    kernel = '';
  }
  return Object.freeze({
    platform,
    arch: os.arch(),
    kernel,
    node: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    shell,
    wsl: platform === 'linux' && isWsl(env),
    ssh: Boolean(env.SSH_CONNECTION || env.SSH_TTY),
    container: platform === 'linux' && isContainer(env),
  });
}

/** Facts the model cannot derive from its own weights, plus what to do about them. */
export function environmentBlock(info: EnvironmentInfo = ENVIRONMENT): string {
  const { shell } = info;
  const host = `${info.platform} ${info.arch}, node ${info.node}`;
  const kernel = info.kernel ? `, kernel ${info.kernel}` : '';
  const lines = [
    `Host: ${host}${kernel}, timezone ${info.timezone}.`,
    `Shell: commands run as \`${shell.file} ${shell.argv.join(' ')} "<command>"\` — non-interactive, no login shell, so startup files (.bashrc, .bash_profile, $PROFILE) are not sourced and aliases and functions defined in them do not exist here.`,
  ];

  if (shell.dialect === 'bash') {
    lines.push('Write Bash syntax.');
  } else if (shell.dialect === 'posix') {
    lines.push(
      'Write portable POSIX shell syntax: this shell is not Bash, so `[[ ]]`, arrays, `(( ))`, `shopt`, and brace expansion will fail.'
    );
  } else {
    lines.push('Write PowerShell syntax, not Bash.');
    if (!/pwsh/i.test(shell.file)) {
      lines.push(
        'This is Windows PowerShell 5.1, not PowerShell 7: `&&` and `||` chaining, ternaries, and `-Encoding utf8NoBOM` do not exist here — sequence with `;` and test with `if`.'
      );
    }
  }

  if (info.wsl) {
    lines.push(
      'This is WSL: Windows drives are mounted under /mnt/<drive>, and Windows binaries run from Linux by path.'
    );
  }
  if (info.container) {
    lines.push(
      'This is a container: there is no init system, so do not start services with systemctl or expect a daemon to survive a command.'
    );
  }
  if (info.ssh) {
    lines.push('This session is reached over SSH: the terminal may be slow and detached processes are how work outlives a call.');
  }

  lines.push(
    'Commands run with the working directory as their only writable sandbox. Do not guess anything not stated above — check it with one command (`uname -a`, `command -v docker`) and act on the answer.'
  );
  return lines.join('\n');
}

/** Frozen at module load, so every prompt and every token estimate sees the same text. */
export const ENVIRONMENT: EnvironmentInfo = detectEnvironment();
