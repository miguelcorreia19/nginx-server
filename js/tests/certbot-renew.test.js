// Tests for certbot_renew.sh's locking and port-80 restoration logic (Phase 5A).
//
// The script is exercised end-to-end as a real bash subprocess against a
// temporary directory tree, with `nginx` and `node` replaced by stub binaries
// on PATH (the same approach as healthcheck.test.js). Path-sensitive behavior
// (lock dir, port-80 dirs, JS working dir) is redirected into the temp tree
// via the CERTBOT_* environment variable overrides the script supports —
// production always uses the real /etc/nginx/... and /tmp/... paths; only the
// override mechanism itself is test-specific.
//
// `cp`, `rm`, `mv`, `mkdir` are the *real* system binaries operating on the
// temp tree, so the assertions reflect genuine filesystem state rather than
// recorded mock-call arguments.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'certbot_renew.sh');
const UNREACHABLE_PID = '2147483647';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-test-'));

  const port80Dir    = path.join(tmp, 'etc', 'nginx', 'conf.d', '80');
  const port80Backup = path.join(tmp, 'etc', 'nginx', 'conf.d', '_80');
  const lockDir      = path.join(tmp, 'lock', 'certbot_renew.lock.d');
  const lockParent   = path.join(tmp, 'lock');
  const jsDir        = path.join(tmp, 'js');
  const binDir       = path.join(tmp, 'bin');

  fs.mkdirSync(port80Dir, { recursive: true });
  fs.writeFileSync(path.join(port80Dir, 'default.conf'), 'server { listen 80; }');
  fs.mkdirSync(lockParent, { recursive: true });
  fs.mkdirSync(jsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    CERTBOT_LOCK_DIR: lockDir,
    CERTBOT_PORT80_DIR: port80Dir,
    CERTBOT_PORT80_BACKUP: port80Backup,
    CERTBOT_JS_DIR: jsDir,
  };

  return { tmp, binDir, port80Dir, port80Backup, lockDir, env };
}

function writeStub(binDir, name, exitCode = 0, body = '') {
  const stubPath = path.join(binDir, name);
  fs.writeFileSync(stubPath, `#!/bin/bash\n${body}\nexit ${exitCode}\n`, { mode: 0o755 });
}

function run(env) {
  const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function cleanupCtx(ctx) {
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
}

describe('certbot_renew.sh — lock behavior', () => {
  let ctx;

  beforeEach(() => {
    ctx = setup();
    writeStub(ctx.binDir, 'nginx', 0);
    writeStub(ctx.binDir, 'node', 0);
  });

  afterEach(() => cleanupCtx(ctx));

  it('acquires the lock directory before running the renewal', () => {
    // Replace the node stub with one that observes the lock dir mid-run.
    fs.writeFileSync(
      path.join(ctx.binDir, 'node'),
      `#!/bin/bash\n[ -d "${ctx.lockDir}" ] && echo LOCK_HELD_DURING_RUN\nexit 0\n`,
      { mode: 0o755 }
    );

    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/LOCK_HELD_DURING_RUN/);
  });

  it('skips cleanly (exit 0) when a live renewal already holds the lock', () => {
    fs.mkdirSync(ctx.lockDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.lockDir, 'pid'), String(process.pid));

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/already in progress.*skipping/i);
    // The script must not disturb a lock it doesn't own.
    expect(fs.existsSync(ctx.lockDir)).toBe(true);
    expect(fs.existsSync(ctx.port80Backup)).toBe(false);
  });

  it('detects a stale lock (dead PID), clears it, and proceeds with renewal', () => {
    fs.mkdirSync(ctx.lockDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.lockDir, 'pid'), UNREACHABLE_PID);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stale lock/i);
    expect(r.stdout).toMatch(/certbot renew succeeded/);
  });

  it('releases the lock after a successful renewal', () => {
    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });

  it('releases the lock after the renewal script fails', () => {
    writeStub(ctx.binDir, 'node', 1);
    const r = run(ctx.env);
    expect(r.code).toBe(1);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });
});

describe('certbot_renew.sh — port-80 restoration', () => {
  let ctx;

  beforeEach(() => {
    ctx = setup();
    writeStub(ctx.binDir, 'nginx', 0);
    writeStub(ctx.binDir, 'node', 0);
  });

  afterEach(() => cleanupCtx(ctx));

  it('restores the port-80 config after a successful renewal', () => {
    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(fs.existsSync(ctx.port80Dir)).toBe(true);
    expect(fs.existsSync(path.join(ctx.port80Dir, 'default.conf'))).toBe(true);
    expect(fs.existsSync(ctx.port80Backup)).toBe(false);
  });

  it('restores the port-80 config even when certbot/the renewal script fails', () => {
    writeStub(ctx.binDir, 'node', 1);
    const r = run(ctx.env);
    expect(r.code).toBe(1);
    expect(fs.existsSync(ctx.port80Dir)).toBe(true);
    expect(fs.existsSync(ctx.port80Backup)).toBe(false);
  });

  it('is idempotent: leaves port 80 untouched when the initial backup never happens', () => {
    // cp fails -> the script aborts before removing port80; nothing to restore.
    writeStub(ctx.binDir, 'cp', 1);
    const r = run(ctx.env);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/failed to back up port-80 config/);
    expect(fs.existsSync(ctx.port80Dir)).toBe(true);
    expect(fs.existsSync(ctx.port80Backup)).toBe(false);
  });

  it('cleans up an orphaned backup left over from an earlier run', () => {
    // Simulate a prior interrupted run that left both directories present.
    fs.mkdirSync(ctx.port80Backup, { recursive: true });
    fs.writeFileSync(path.join(ctx.port80Backup, 'orphan.conf'), 'server { listen 80; }');

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    // restore_port80 in the EXIT trap removes the orphan once the run's own
    // backup/restore cycle completes and leaves port80 in place.
    expect(fs.existsSync(ctx.port80Dir)).toBe(true);
    expect(fs.existsSync(ctx.port80Backup)).toBe(false);
  });

  it('reports restoration failure without silently succeeding', () => {
    // mv is the only command restore_port80 uses to move the backup back;
    // forcing it to fail simulates a filesystem-level restore failure.
    writeStub(ctx.binDir, 'mv', 1);
    const r = run(ctx.env);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/failed to move port-80 config back into place/);
    // Lock must still be released even though restoration failed.
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });
});

describe('certbot_renew.sh — exit codes', () => {
  let ctx;

  beforeEach(() => {
    ctx = setup();
    writeStub(ctx.binDir, 'nginx', 0);
    writeStub(ctx.binDir, 'node', 0);
  });

  afterEach(() => cleanupCtx(ctx));

  it('exits 0 on a successful renewal', () => {
    expect(run(ctx.env).code).toBe(0);
  });

  it('exits 0 when skipped due to an active lock', () => {
    fs.mkdirSync(ctx.lockDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.lockDir, 'pid'), String(process.pid));
    expect(run(ctx.env).code).toBe(0);
  });

  it('exits 1 when the certbot/Node renewal script fails', () => {
    writeStub(ctx.binDir, 'node', 1);
    const r = run(ctx.env);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/certbot renewal script failed \(exit 1\)/);
  });

  it('exits 1 when the initial port-80 backup cannot be created', () => {
    writeStub(ctx.binDir, 'cp', 1);
    expect(run(ctx.env).code).toBe(1);
  });

  it('exits 3 when renewal succeeds but port-80 restoration fails', () => {
    writeStub(ctx.binDir, 'mv', 1);
    expect(run(ctx.env).code).toBe(3);
  });

  it('distinguishes skipped, failed, and successful runs in the log output', () => {
    const success = run(ctx.env);
    expect(success.stdout).toMatch(/certbot renew succeeded/);
    expect(success.stdout).not.toMatch(/skipping|failed/i);
    cleanupCtx(ctx);

    ctx = setup();
    writeStub(ctx.binDir, 'nginx', 0);
    fs.mkdirSync(ctx.lockDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.lockDir, 'pid'), String(process.pid));
    const skipped = run(ctx.env);
    expect(skipped.stdout).toMatch(/skipping/i);
    expect(skipped.stdout).not.toMatch(/succeeded/);
    cleanupCtx(ctx);

    ctx = setup();
    writeStub(ctx.binDir, 'nginx', 0);
    writeStub(ctx.binDir, 'node', 1);
    const failed = run(ctx.env);
    expect(failed.stdout).toMatch(/ERROR: certbot renewal script failed/);
    expect(failed.stdout).not.toMatch(/succeeded/);
  });
});

describe('certbot_renew.sh — signal handling', () => {
  let ctx;

  beforeEach(() => {
    ctx = setup();
    writeStub(ctx.binDir, 'nginx', 0);
  });

  afterEach(() => cleanupCtx(ctx));

  // Bash defers signal delivery while waiting on a foreground child (the
  // `node` stub here), processing it once that child exits — so a brief
  // sleep gives us a reliable window to confirm port 80 is disabled before
  // sending SIGTERM, without making the test slow.
  it('restores port 80 and releases the lock when SIGTERM arrives mid-renewal', (done) => {
    writeStub(ctx.binDir, 'node', 0, 'sleep 0.5');

    const child = spawn('bash', [SCRIPT], { env: ctx.env });
    let terminated = false;

    const iv = setInterval(() => {
      if (!terminated && fs.existsSync(ctx.port80Backup) && !fs.existsSync(ctx.port80Dir)) {
        terminated = true;
        clearInterval(iv);
        child.kill('SIGTERM');
      }
    }, 25);

    child.on('close', () => {
      clearInterval(iv);
      expect(terminated).toBe(true);
      expect(fs.existsSync(ctx.port80Dir)).toBe(true);
      expect(fs.existsSync(ctx.port80Backup)).toBe(false);
      expect(fs.existsSync(ctx.lockDir)).toBe(false);
      done();
    });
  }, 10000);

  it('restores port 80 and releases the lock when SIGINT arrives mid-renewal', (done) => {
    writeStub(ctx.binDir, 'node', 0, 'sleep 0.5');

    const child = spawn('bash', [SCRIPT], { env: ctx.env });
    let interrupted = false;

    const iv = setInterval(() => {
      if (!interrupted && fs.existsSync(ctx.port80Backup) && !fs.existsSync(ctx.port80Dir)) {
        interrupted = true;
        clearInterval(iv);
        child.kill('SIGINT');
      }
    }, 25);

    child.on('close', () => {
      clearInterval(iv);
      expect(interrupted).toBe(true);
      expect(fs.existsSync(ctx.port80Dir)).toBe(true);
      expect(fs.existsSync(ctx.port80Backup)).toBe(false);
      expect(fs.existsSync(ctx.lockDir)).toBe(false);
      done();
    });
  }, 10000);
});
