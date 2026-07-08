// Tests for certbot_renew.sh (webroot model, Phase C).
//
// The script is exercised end-to-end as a real bash subprocess against a
// temporary directory tree, with `nginx` and `node` replaced by stub binaries
// on PATH (same approach as healthcheck.test.js). The lock dir and Node working
// dir are redirected into the temp tree via the CERTBOT_* env overrides the
// script supports.
//
// Phase C removed the port-80 disable/restore handoff: nginx keeps port 80
// throughout renewal (webroot challenge), so there is no backup/remove/restore
// of /etc/nginx/conf.d/80, no restore-related exit code, and no SIGKILL port-80
// window. These tests assert the lock machinery and the new reload-on-success
// behavior, and that none of the old port-80 logic remains in the script.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'certbot_renew.sh');
const SCRIPT_SRC = fs.readFileSync(SCRIPT, 'utf8');
const UNREACHABLE_PID = '2147483647';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-test-'));
  const lockDir    = path.join(tmp, 'lock', 'certbot_renew.lock.d');
  const lockParent = path.join(tmp, 'lock');
  const jsDir      = path.join(tmp, 'js');
  const binDir     = path.join(tmp, 'bin');
  const nginxCalls = path.join(tmp, 'nginx-calls');

  fs.mkdirSync(lockParent, { recursive: true });
  fs.mkdirSync(jsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    CERTBOT_LOCK_DIR: lockDir,
    CERTBOT_JS_DIR: jsDir,
    NGINX_CALLS: nginxCalls,
  };
  return { tmp, binDir, lockDir, nginxCalls, env };
}

// nginx stub records its args so we can assert exactly when (and whether) the
// script reloads nginx.
function writeNginxStub(binDir, exitCode = 0) {
  fs.writeFileSync(
    path.join(binDir, 'nginx'),
    `#!/bin/bash\necho "$@" >> "$NGINX_CALLS"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
}
function writeStub(binDir, name, exitCode = 0, body = '') {
  fs.writeFileSync(path.join(binDir, name), `#!/bin/bash\n${body}\nexit ${exitCode}\n`, { mode: 0o755 });
}
function run(env) {
  const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function nginxCalls(ctx) {
  return fs.existsSync(ctx.nginxCalls) ? fs.readFileSync(ctx.nginxCalls, 'utf8') : '';
}
function cleanupCtx(ctx) { fs.rmSync(ctx.tmp, { recursive: true, force: true }); }

describe('certbot_renew.sh — lock behavior', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); writeStub(ctx.binDir, 'node', 0); });
  afterEach(() => cleanupCtx(ctx));

  it('acquires the lock directory before running the renewal', () => {
    fs.writeFileSync(
      path.join(ctx.binDir, 'node'),
      `#!/bin/bash\n[ -d "${ctx.lockDir}" ] && echo LOCK_HELD_DURING_RUN\nexit 0\n`,
      { mode: 0o755 },
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
    expect(fs.existsSync(ctx.lockDir)).toBe(true); // must not disturb a lock it doesn't own
    expect(nginxCalls(ctx)).toBe('');              // and must not touch nginx
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

describe('certbot_renew.sh — nginx reload (port 80 never disabled)', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); });
  afterEach(() => cleanupCtx(ctx));

  it('reloads nginx after a successful renewal so renewed certs are picked up', () => {
    writeStub(ctx.binDir, 'node', 0);
    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/nginx reloaded after renewal/);
  });

  it('does NOT disable port 80 — nginx is only ever called with "-s reload"', () => {
    writeStub(ctx.binDir, 'node', 0);
    run(ctx.env);
    const calls = nginxCalls(ctx).trim().split('\n').filter(Boolean);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe('-s reload');
  });

  it('does not reload nginx when the renewal fails', () => {
    writeStub(ctx.binDir, 'node', 1);
    const r = run(ctx.env);
    expect(r.code).toBe(1);
    expect(nginxCalls(ctx)).toBe(''); // reload is reached only on success
  });
});

describe('certbot_renew.sh — exit codes', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); writeStub(ctx.binDir, 'node', 0); });
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

  it('distinguishes skipped, failed, and successful runs in the log output', () => {
    expect(run(ctx.env).stdout).toMatch(/certbot renew succeeded/);

    cleanupCtx(ctx);
    ctx = setup(); writeNginxStub(ctx.binDir, 0);
    fs.mkdirSync(ctx.lockDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.lockDir, 'pid'), String(process.pid));
    const skipped = run(ctx.env);
    expect(skipped.stdout).toMatch(/skipping/i);
    expect(skipped.stdout).not.toMatch(/succeeded/);

    cleanupCtx(ctx);
    ctx = setup(); writeNginxStub(ctx.binDir, 0); writeStub(ctx.binDir, 'node', 1);
    const failed = run(ctx.env);
    expect(failed.stdout).toMatch(/ERROR: certbot renewal script failed/);
    expect(failed.stdout).not.toMatch(/succeeded/);
  });
});

describe('certbot_renew.sh — signal handling', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); });
  afterEach(() => cleanupCtx(ctx));

  it('releases the lock when SIGTERM arrives mid-renewal', (done) => {
    writeStub(ctx.binDir, 'node', 0, 'sleep 0.5');
    const child = spawn('bash', [SCRIPT], { env: ctx.env });
    let signaled = false;
    const iv = setInterval(() => {
      if (!signaled && fs.existsSync(ctx.lockDir)) {
        signaled = true; clearInterval(iv); child.kill('SIGTERM');
      }
    }, 25);
    child.on('close', () => {
      clearInterval(iv);
      expect(signaled).toBe(true);
      expect(fs.existsSync(ctx.lockDir)).toBe(false); // EXIT trap released the lock
      done();
    });
  }, 10000);
});

describe('certbot_renew.sh — old port-80 handoff fully removed', () => {
  it('contains no backup/remove/restore of /etc/nginx/conf.d/80', () => {
    expect(SCRIPT_SRC).not.toMatch(/conf\.d\/80/);
    expect(SCRIPT_SRC).not.toMatch(/restore_port80/);
    expect(SCRIPT_SRC).not.toMatch(/PORT80/);
    expect(SCRIPT_SRC).not.toMatch(/Port 80 disabled/);
  });
  it('has no restore-related exit code 3 or orphaned-backup cleanup', () => {
    expect(SCRIPT_SRC).not.toMatch(/exit 3/);
    expect(SCRIPT_SRC).not.toMatch(/orphan/i);
  });
  it('keeps the lock + stale-lock machinery', () => {
    expect(SCRIPT_SRC).toMatch(/mkdir "\$LOCK_DIR"/);
    expect(SCRIPT_SRC).toMatch(/stale lock/i);
    expect(SCRIPT_SRC).toMatch(/release_lock/);
  });
});
