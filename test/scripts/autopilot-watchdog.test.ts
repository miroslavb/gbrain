import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = resolve(import.meta.dir, '..', '..');
const watchdog = join(repoRoot, 'scripts', 'host', 'autopilot-watchdog.sh');
const scratch: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-watchdog-'));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('host autopilot watchdog', () => {
  it('is valid shell', () => {
    const result = spawnSync('bash', ['-n', watchdog], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('treats a runtime mask as an operator fence before systemctl discovery', () => {
    const dir = makeScratch();
    const runtimeDir = join(dir, 'runtime');
    const userDir = join(dir, 'config');
    const fakeBin = join(dir, 'bin');
    const unitDir = join(runtimeDir, 'systemd', 'user');
    const systemctlCalled = join(dir, 'systemctl-called');
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    symlinkSync('/dev/null', join(unitDir, 'gbrain-autopilot.service'));
    const fakeSystemctl = join(fakeBin, 'systemctl');
    writeFileSync(
      fakeSystemctl,
      `#!/bin/sh\nprintf called > ${JSON.stringify(systemctlCalled)}\nexit 99\n`,
      { mode: 0o755 },
    );
    chmodSync(fakeSystemctl, 0o755);

    const result = spawnSync('bash', [watchdog], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        XDG_CONFIG_HOME: userDir,
        XDG_RUNTIME_DIR: runtimeDir,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(existsSync(systemctlCalled)).toBe(false);
  });
});
