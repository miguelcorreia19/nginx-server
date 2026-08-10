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
  const renewedFlag = path.join(tmp, 'renewed.flag');

  fs.mkdirSync(lockParent, { recursive: true });
  fs.mkdirSync(jsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    CERTBOT_LOCK_DIR: lockDir,
    CERTBOT_JS_DIR: jsDir,
    NGINX_CALLS: nginxCalls,
    CERTBOT_RENEWED_FLAG: renewedFlag,
  };
  return { tmp, binDir, lockDir, nginxCalls, renewedFlag, env };
}

// node stub that simulates Certbot actually renewing a cert: its deploy hook
// touches the renewed-flag the way the real certbot deploy hook does.
const RENEWED = 'touch "$CERTBOT_RENEWED_FLAG"';

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

describe('certbot_renew.sh — reload only when a certificate was renewed', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); });
  afterEach(() => cleanupCtx(ctx));

  it('reloads nginx when certbot renewed at least one certificate', () => {
    writeStub(ctx.binDir, 'node', 0, RENEWED); // deploy hook touched the flag
    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/Certificates renewed; reloading nginx/);
    expect(r.stdout).toMatch(/nginx reloaded after renewal/);
    // The flag is consumed so it can't trigger a reload on a later run.
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
  });

  it('skips the reload when no certificate was renewed (flag absent)', () => {
    writeStub(ctx.binDir, 'node', 0); // no renewal -> deploy hook never runs -> no flag
    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toBe(''); // nginx not reloaded
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
    expect(r.stdout).not.toMatch(/reloading nginx/);
  });

  it('clears a stale renewal flag before the run so it cannot cause a false reload', () => {
    fs.writeFileSync(ctx.renewedFlag, ''); // leftover flag from a previous (e.g. SIGKILLed) run
    writeStub(ctx.binDir, 'node', 0);       // this run renews nothing
    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toBe('');       // must NOT reload off the stale flag
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
  });

  it('does not reload when the renewal fails (even if a flag somehow exists)', () => {
    fs.writeFileSync(ctx.renewedFlag, '');
    writeStub(ctx.binDir, 'node', 1);
    const r = run(ctx.env);
    expect(r.code).toBe(1);
    expect(nginxCalls(ctx)).toBe(''); // failure exits before the reload decision
  });

  it('does NOT disable port 80 — nginx is only ever called with "-s reload"', () => {
    writeStub(ctx.binDir, 'node', 0, RENEWED);
    run(ctx.env);
    const calls = nginxCalls(ctx).trim().split('\n').filter(Boolean);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe('-s reload');
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

describe('certbot_renew.js — renewal-detection wiring', () => {
  const JS_SRC = fs.readFileSync(path.join(__dirname, '..', 'letsencrypt', 'certbot_renew.js'), 'utf8');
  it('renews via webroot and signals real renewals through the deploy-hook flag', () => {
    // The invocation is an argument vector now (commandSafe/execFile), so the
    // flags are asserted as array elements rather than as one shell string.
    expect(JS_SRC).toMatch(/commandSafe\('certbot', \[/);
    expect(JS_SRC).toMatch(/'--webroot', '-w', '\/var\/www\/certbot'/);
    expect(JS_SRC).toMatch(/'--deploy-hook'/);
    expect(JS_SRC).toMatch(/CERTBOT_RENEWED_FLAG/);
    // The hook the tests below build by hand has to be the one the source
    // actually emits, `--` included, or they would be pinning nothing.
    expect(JS_SRC).toMatch(/`touch -- \$\{shellQuote\(renewedFlag\)\}`/);
  });

  it('no longer builds the whole certbot invocation as a shell string', () => {
    // Matched on the shell helper being absent — imported nowhere, called
    // nowhere — rather than on a backtick before "certbot renew": the module's
    // own comments quote `certbot renew --webroot -w <path>` in prose, so a
    // backtick pattern pins nothing. `\bcommand\s*\(` does not match
    // `commandSafe(`.
    expect(JS_SRC).toMatch(/const \{ commandSafe \} = require\("\.\.\/utils\.js"\)/);
    expect(JS_SRC).not.toMatch(/\bcommand\s*\(/);
  });
});

// The deploy hook is the one value that unavoidably crosses a shell boundary:
// Certbot has no argv form for hooks and runs them through a shell. The flag
// path is therefore POSIX single-quoted, and these pin that contract.
//
// Quoting settles what the shell does with the value; it does not settle what
// touch(1) then does with its own argv, which is why the hook also carries
// `--`. Both halves are exercised below.
describe('certbot_renew.js — deploy-hook quoting', () => {
  const { shellQuote } = require('../letsencrypt/certbot_renew.js');

  // The hook exactly as js/letsencrypt/certbot_renew.js builds it. The
  // assertion above keeps this in step with the source.
  const deployHook = (flag) => `touch -- ${shellQuote(flag)}`;

  it('quotes an ordinary path', () => {
    expect(shellQuote('/tmp/certbot-renewed.flag')).toBe("'/tmp/certbot-renewed.flag'");
  });

  it('keeps a path containing spaces as a single word', () => {
    expect(shellQuote('/tmp/my flag.flag')).toBe("'/tmp/my flag.flag'");
  });

  it('escapes an embedded single quote with the POSIX idiom', () => {
    expect(shellQuote("/tmp/it's.flag")).toBe("'/tmp/it'\\''s.flag'");
  });

  it.each([
    ['semicolon',        '/tmp/a;touch owned.flag'],
    ['command substitution', '/tmp/$(touch owned).flag'],
    ['backticks',        '/tmp/`touch owned`.flag'],
    ['logical and',      '/tmp/a&&touch owned.flag'],
    ['pipe',             '/tmp/a|touch owned.flag'],
    ['double quote',     '/tmp/a"b.flag'],
    ['newline',          '/tmp/a\ntouch owned.flag'],
  ])('renders %s literally inside single quotes', (_label, value) => {
    const quoted = shellQuote(value);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // Nothing between the outer quotes may close them, so no metacharacter can
    // reach the shell as syntax.
    expect(quoted.slice(1, -1)).not.toContain("'");
    expect(quoted.slice(1, -1)).toBe(value);
  });

  // End-to-end: hand the produced hook to a real shell, exactly as Certbot
  // does, and confirm it creates the one file it was asked to.
  it.each([
    ['plain',        'renewed.flag'],
    ['spaces',       'my renewed flag.flag'],
    ['single quote', "it's-renewed.flag"],
    ['metacharacters', 'a;$(touch owned)&&`x`.flag'],
  ])('a %s flag path reaches touch(1) as one literal filename', (_label, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-hook-'));
    try {
      const target = path.join(dir, name);
      const r = spawnSync('/bin/sh', ['-c', deployHook(target)], { encoding: 'utf8' });

      expect(r.status).toBe(0);
      expect(fs.existsSync(target)).toBe(true);
      // Exactly one file: no injected command ran alongside it.
      expect(fs.readdirSync(dir)).toEqual([name]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The half quoting cannot cover. CERTBOT_RENEWED_FLAG is an operator-settable
  // override (certbot_renew.sh documents it and exports whatever it is given),
  // so the flag can begin with `-`; quoted or not, touch reads that as an
  // option. Run relative to the temp directory, because an absolute path can
  // never lead with a hyphen — that is exactly the case `--` exists for.
  it.each([
    ['a bare option-looking name', '-renewed.flag'],
    ['an option that takes a value', '-d'],
    ['a long option', '--help'],
  ])('%s is still created as a file, not parsed as a touch option', (_label, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-hook-'));
    try {
      const r = spawnSync('/bin/sh', ['-c', deployHook(name)], { cwd: dir, encoding: 'utf8' });

      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(fs.readdirSync(dir)).toEqual([name]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts the end-of-options marker before the quoted path', () => {
    expect(deployHook('-d')).toBe("touch -- '-d'");
  });
});
