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

// The lock-ownership contract certbot_renew.sh writes into every lock
// directory it creates. Pinned as literals here and cross-checked against the
// script source in the ownership suite below; several fixtures also need them
// to build a lock directory the script will recognise as its own.
const LOCK_MARKER_NAME  = '.nginx-server-certbot-renew-lock';
const LOCK_MARKER_VALUE = 'certbot-renew-lock-v1';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-test-'));
  const lockDir    = path.join(tmp, 'lock', 'certbot_renew.lock.d');
  const lockParent = path.join(tmp, 'lock');
  const jsDir      = path.join(tmp, 'js');
  const binDir     = path.join(tmp, 'bin');
  const nginxCalls = path.join(tmp, 'nginx-calls');
  const nodeCalls  = path.join(tmp, 'node-calls');
  const renewedFlag = path.join(tmp, 'renewed.flag');

  fs.mkdirSync(lockParent, { recursive: true });
  fs.mkdirSync(jsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    CERTBOT_LOCK_DIR: lockDir,
    CERTBOT_JS_DIR: jsDir,
    NGINX_CALLS: nginxCalls,
    NODE_CALLS: nodeCalls,
    CERTBOT_RENEWED_FLAG: renewedFlag,
  };
  return { tmp, binDir, lockDir, nginxCalls, nodeCalls, renewedFlag, env };
}

// node stub that simulates Certbot actually renewing a cert: its deploy hook
// touches the renewed-flag the way the real certbot deploy hook does.
const RENEWED = 'touch "$CERTBOT_RENEWED_FLAG"';

// Same, but matching js/letsencrypt/certbot_renew.js's exact deploy-hook shape
// (`touch -- ${shellQuote(renewedFlag)}` there) rather than the plain form
// above. Used only where the flag path itself is under test, so the stub is
// not silently relying on a form production does not actually emit.
const RENEWED_VIA_PRODUCTION_HOOK = 'touch -- "$CERTBOT_RENEWED_FLAG"';

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
// node stub that records the fact it ran, the way writeNginxStub does for
// nginx. Used where the assertion is that the renewal never started at all —
// an absent call file proves the script aborted before the renewal step,
// which "no nginx reload" alone would not (a skipped run has no reload either).
function writeRecordingNodeStub(binDir, exitCode = 0, body = '') {
  fs.writeFileSync(
    path.join(binDir, 'node'),
    `#!/bin/bash\necho "$@" >> "$NODE_CALLS"\n${body}\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
}
function run(env, spawnOpts = {}) {
  const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', ...spawnOpts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function nginxCalls(ctx) {
  return fs.existsSync(ctx.nginxCalls) ? fs.readFileSync(ctx.nginxCalls, 'utf8') : '';
}
function nodeCalls(ctx) {
  return fs.existsSync(ctx.nodeCalls) ? fs.readFileSync(ctx.nodeCalls, 'utf8') : '';
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
    // A stale lock is one this script created and then lost, so the fixture
    // carries the ownership marker a real lock directory holds — without it
    // the run is refused, which the ownership suite below covers separately.
    fs.writeFileSync(path.join(ctx.lockDir, LOCK_MARKER_NAME), `${LOCK_MARKER_VALUE}\n`);
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

// Clearing a stale lock is a *recursive* delete of whatever CERTBOT_LOCK_DIR
// names, and nothing validates that path. Before the ownership marker existed,
// the only precondition was "the directory exists and holds no live PID" —
// which every ordinary data directory satisfies on the very first run. Pointing
// CERTBOT_LOCK_DIR at /home/letsencrypt (the default CERTBOT_BACKUP_PATH) was
// enough to destroy the certificate backup, private keys included, behind a
// single "removing stale lock" warning.
//
// The environment does reach this script in production: BusyBox crond passes
// its inherited environment through to cron jobs, so the "test-override"
// framing in the script header is a convention, not an enforcement.
//
// The guard is an explicit marker file with exact expected content, written
// only by this script — deliberately checked by content and not by filename
// alone, so a directory that merely happens to contain a same-named file is
// still refused.
describe('certbot_renew.sh — stale-lock removal requires proven ownership', () => {
  let ctx, dataDir;

  // Shaped like the certificate backup an operator could plausibly point
  // CERTBOT_LOCK_DIR at by mistake, key material included — an empty directory
  // would not show that real contents survive.
  const FIXTURE = {
    'live/example.com/privkey.pem':   '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
    'live/example.com/fullchain.pem': '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n',
    'renewal/example.com.conf':       'version = 5.6.0\narchive_dir = /etc/letsencrypt/archive/example.com\n',
  };

  const writeFixture = (root) => {
    for (const [rel, content] of Object.entries(FIXTURE)) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  };
  const expectFixtureIntact = (root) => {
    expect(fs.existsSync(root)).toBe(true);
    for (const [rel, content] of Object.entries(FIXTURE)) {
      const target = path.join(root, rel);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(content);
    }
  };
  const markerPath = (dir) => path.join(dir, LOCK_MARKER_NAME);

  beforeEach(() => {
    ctx = setup();
    writeNginxStub(ctx.binDir, 0);
    writeRecordingNodeStub(ctx.binDir, 0);
    // A directory that already exists, with contents, and no live holder.
    dataDir = path.join(ctx.tmp, 'operator-data');
    writeFixture(dataDir);
    ctx.env.CERTBOT_LOCK_DIR = dataDir;
  });
  afterEach(() => cleanupCtx(ctx));

  // The core regression. Without the ownership guard this run deletes dataDir
  // outright, so every assertion below fails against the pre-fix script.
  it('refuses to clear a pre-existing directory carrying no ownership marker, and preserves it', () => {
    const r = run(ctx.env);

    expect(r.code).toBe(2);
    expectFixtureIntact(dataDir);
    // Aborted before the renewal step, not merely before the reload.
    expect(nodeCalls(ctx)).toBe('');
    expect(nginxCalls(ctx)).toBe('');
    // Never took the destructive branch at all.
    expect(r.stdout).not.toMatch(/removing stale lock/i);
    // The message has to name the path an operator must go and look at.
    expect(r.stdout).toContain(dataDir);
    expect(r.stdout).toMatch(/not a renewal lock created by this script/i);
    expect(r.stdout).toMatch(/preserved/i);
  });

  // Proves the guard is a content contract, not a filename check: a directory
  // holding a same-named file with different content is still not ours.
  it('refuses a directory whose marker file holds unexpected content', () => {
    fs.writeFileSync(markerPath(dataDir), 'some-other-tool-lock-v9\n');

    const r = run(ctx.env);

    expect(r.code).toBe(2);
    expectFixtureIntact(dataDir);
    expect(fs.readFileSync(markerPath(dataDir), 'utf8')).toBe('some-other-tool-lock-v9\n');
    expect(nodeCalls(ctx)).toBe('');
    expect(r.stdout).not.toMatch(/removing stale lock/i);
    expect(r.stdout).toMatch(/not a renewal lock created by this script/i);
  });

  it('refuses a directory whose marker is empty', () => {
    fs.writeFileSync(markerPath(dataDir), '');

    const r = run(ctx.env);

    expect(r.code).toBe(2);
    expectFixtureIntact(dataDir);
    expect(nodeCalls(ctx)).toBe('');
    expect(r.stdout).not.toMatch(/removing stale lock/i);
  });

  // A marker that is a directory rather than a regular file: `[ -f ]` rejects
  // it, so the guard holds instead of erroring out on the `cat`.
  it('refuses a directory whose marker path is not a regular file', () => {
    fs.mkdirSync(markerPath(dataDir));

    const r = run(ctx.env);

    expect(r.code).toBe(2);
    expectFixtureIntact(dataDir);
    expect(nodeCalls(ctx)).toBe('');
  });

  // The live-holder check runs before the ownership check, and must stay
  // there: the safe answer for a directory holding a live PID is to leave it
  // alone and skip, whether or not it is ours.
  it('still skips (exit 0) when an unowned directory holds a live PID, without deleting it', () => {
    fs.writeFileSync(path.join(dataDir, 'pid'), String(process.pid));

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/already in progress.*skipping/i);
    expectFixtureIntact(dataDir);
    expect(nodeCalls(ctx)).toBe('');
  });

  // Backward compatibility for the case the guard exists to permit: a lock
  // this script really did create, whose holder was SIGKILLed.
  it('clears a genuine stale lock (valid marker, dead PID) and re-acquires it', () => {
    const lockDir = ctx.lockDir;
    ctx.env.CERTBOT_LOCK_DIR = lockDir;
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(markerPath(lockDir), `${LOCK_MARKER_VALUE}\n`);
    fs.writeFileSync(path.join(lockDir, 'pid'), UNREACHABLE_PID);
    // Left behind by the killed run; proves the removal really was recursive.
    fs.mkdirSync(path.join(lockDir, 'leftover'), { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'leftover', 'junk'), 'x');

    // Observe the re-created metadata mid-run: normal release removes both
    // before the script exits, so it cannot be inspected afterwards.
    writeRecordingNodeStub(ctx.binDir, 0,
      `echo "MARKER=$(cat "${markerPath(lockDir)}" 2>/dev/null)"\n` +
      `echo "PID=$(cat "${path.join(lockDir, 'pid')}" 2>/dev/null)"\n` +
      `[ -e "${path.join(lockDir, 'leftover')}" ] && echo LEFTOVER_SURVIVED\n` +
      RENEWED,
    );

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/removing stale lock/i);
    expect(r.stdout).not.toMatch(/not a renewal lock created by this script/i);
    // Re-acquired, with fresh metadata, and the stale contents really gone.
    expect(r.stdout).toMatch(new RegExp(`MARKER=${LOCK_MARKER_VALUE}$`, 'm'));
    expect(r.stdout).toMatch(/^PID=[1-9][0-9]*$/m);
    expect(r.stdout).not.toMatch(/LEFTOVER_SURVIVED/);
    // Renewal ran, and normal cleanup still removed the lock.
    expect(nodeCalls(ctx)).not.toBe('');
    expect(r.stdout).toMatch(/certbot renew succeeded/);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('writes the marker and PID when acquiring a fresh lock', () => {
    const lockDir = ctx.lockDir;
    ctx.env.CERTBOT_LOCK_DIR = lockDir;
    writeRecordingNodeStub(ctx.binDir, 0,
      `echo "MARKER=$(cat "${markerPath(lockDir)}" 2>/dev/null)"\n` +
      `echo "PID=$(cat "${path.join(lockDir, 'pid')}" 2>/dev/null)"\n`,
    );

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`MARKER=${LOCK_MARKER_VALUE}$`, 'm'));
    expect(r.stdout).toMatch(/^PID=[1-9][0-9]*$/m);
  });

  it('removes the marker along with the PID file on normal release', () => {
    const lockDir = ctx.lockDir;
    ctx.env.CERTBOT_LOCK_DIR = lockDir;

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    // rmdir only succeeds on an empty directory, so a surviving marker would
    // leave the whole lock behind and wedge every later run.
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.existsSync(markerPath(lockDir))).toBe(false);
  });

  it('declares the marker filename and value the lock contract is pinned on', () => {
    // Keeps the literals above honest: renaming either in the script without
    // updating these tests would otherwise pass silently.
    expect(SCRIPT_SRC).toContain(`LOCK_MARKER_FILE="$LOCK_DIR/${LOCK_MARKER_NAME}"`);
    expect(SCRIPT_SRC).toContain(`LOCK_MARKER_VALUE="${LOCK_MARKER_VALUE}"`);
    // The recursive delete must stay behind the ownership gate.
    expect(SCRIPT_SRC).toMatch(/if ! lock_is_ours; then[\s\S]*?rm -rf -- "\$LOCK_DIR"/);
  });
});

// CERTBOT_LOCK_DIR is the same kind of operator-settable override as
// CERTBOT_RENEWED_FLAG (see the describe block below this one), but it
// reaches more external commands across the lock lifecycle: both `mkdir`
// attempts, `cat` (reading the held PID), `rm -f` and `rmdir` (release), and
// `rm -rf` (clearing a stale lock). A value whose entire string begins with
// "-" is only misread as an option when nothing precedes it — an absolute
// path like "/tmp/x/-lock" never triggers this, since it starts with "/" —
// so these run the script against a bare relative directory name, with cwd
// pinned to one temp directory that every phase (mkdir, cat, rm, rmdir, and
// the `>` redirection that writes the PID file) agrees on throughout,
// exactly as the default absolute CERTBOT_LOCK_DIR does in production.
describe('certbot_renew.sh — a lock directory beginning with a hyphen', () => {
  let ctx, hostileDir;

  beforeEach(() => {
    ctx = setup();
    writeNginxStub(ctx.binDir, 0);
    hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-hostile-lock-'));
  });
  afterEach(() => {
    cleanupCtx(ctx);
    fs.rmSync(hostileDir, { recursive: true, force: true });
  });

  it.each([
    ['a bare option-looking name', '-lock'],
    ['a long-option-shaped name',  '--verbose'],
  ])('acquires a fresh lock named %s and completes a renewal', (_label, name) => {
    ctx.env.CERTBOT_LOCK_DIR = name;
    writeStub(ctx.binDir, 'node', 0, RENEWED);

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unrecognized option/);
    // If mkdir had misparsed the name, this run would have taken the
    // "already locked" branch on a lock directory that never existed.
    expect(r.stdout).not.toMatch(/already in progress/);
    expect(r.stdout).not.toMatch(/ERROR: cannot acquire renewal lock/);
    expect(r.stdout).toMatch(/certbot renew succeeded/);
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
  });

  it.each([
    ['a bare option-looking name', '-lock'],
    ['a long-option-shaped name',  '--verbose'],
  ])('removes the lock directory and PID file named %s after a successful run', (_label, name) => {
    ctx.env.CERTBOT_LOCK_DIR = name;
    writeStub(ctx.binDir, 'node', 0);

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    // Without `--`, rm -f/rmdir both fail by misparse and leave this behind —
    // exactly what a real stale lock caused by this defect would look like.
    expect(fs.existsSync(path.join(hostileDir, name))).toBe(false);
  });

  it.each([
    ['a bare option-looking name', '-lock'],
    ['a long-option-shaped name',  '--verbose'],
  ])('clears a stale lock named %s (dead PID) and re-acquires it in the same run', (_label, name) => {
    ctx.env.CERTBOT_LOCK_DIR = name;
    const lockPath = path.join(hostileDir, name);
    fs.mkdirSync(lockPath, { recursive: true });
    // Same as the ordinary stale-lock fixture: a lock this script created
    // carries the ownership marker, so clearing it is permitted.
    fs.writeFileSync(path.join(lockPath, LOCK_MARKER_NAME), `${LOCK_MARKER_VALUE}\n`);
    fs.writeFileSync(path.join(lockPath, 'pid'), UNREACHABLE_PID);
    writeStub(ctx.binDir, 'node', 0, RENEWED);

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unrecognized option/);
    expect(r.stdout).toMatch(/stale lock/i);
    expect(r.stdout).not.toMatch(/ERROR: cannot acquire renewal lock/);
    expect(r.stdout).toMatch(/certbot renew succeeded/);
    // Released again after this run, same as any other successful renewal.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([
    ['a bare option-looking name', '-lock'],
    ['a long-option-shaped name',  '--verbose'],
  ])('detects a live lock named %s instead of misreading its PID as empty', (_label, name) => {
    ctx.env.CERTBOT_LOCK_DIR = name;
    const lockPath = path.join(hostileDir, name);
    fs.mkdirSync(lockPath, { recursive: true });
    // A real, currently-running PID (this Jest process) — the same technique
    // the ordinary "skips cleanly" lock test above uses. If `cat` misparsed
    // the option-like PID-file path, held_pid would always read empty, `kill
    // -0` would never run, and the script would treat this exactly like a
    // dead/stale lock instead of a live one — clearing it out from under
    // whichever renewal actually holds it.
    fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid));

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unrecognized option/);
    expect(r.stdout).toMatch(/already in progress.*skipping/i);
    expect(r.stdout).not.toMatch(/stale lock/i);
    expect(fs.existsSync(lockPath)).toBe(true); // must not disturb a lock it doesn't own
    expect(nginxCalls(ctx)).toBe('');
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

// The renewed-flag path is operator-controlled (CERTBOT_RENEWED_FLAG), and the
// script both removes it (`rm -f -- "$RENEWED_FLAG"`, twice) and tests it
// (`[ -f "$RENEWED_FLAG" ]`, once). `rm` parses its own argv even under
// execFile-free bash, so a value whose first character is "-" would be read
// as an rm option without the `--` guard added alongside this test; `[ -f ]`
// takes no such risk (see the comment above it in certbot_renew.sh) and stays
// unguarded.
//
// A leading-hyphen value only reaches rm's option parser when the *whole*
// operand starts with "-" — an absolute path like "/tmp/x/-flag" does not,
// since it starts with "/". So this exercises a bare relative name, run with
// the script's cwd and CERTBOT_JS_DIR pointed at the same directory: the
// pre-run `rm`, the deploy hook's `touch`, the `[ -f ]` check and the post-run
// `rm` then all agree on one location, exactly as they do in production when
// CERTBOT_JS_DIR is left at its default and RENEWED_FLAG is resolved once.
describe('certbot_renew.sh — a renewed-flag path beginning with a hyphen', () => {
  let ctx, hostileDir;

  beforeEach(() => {
    ctx = setup();
    writeNginxStub(ctx.binDir, 0);
    hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-hostile-'));
    ctx.env.CERTBOT_JS_DIR = hostileDir;
  });
  afterEach(() => {
    cleanupCtx(ctx);
    fs.rmSync(hostileDir, { recursive: true, force: true });
  });

  it.each([
    ['a bare option-looking name', '-renewed.flag'],
    ['a long-option-shaped name',  '--verbose'],
  ])('clears a stale flag named %s before the run, instead of failing to remove it', (_label, name) => {
    ctx.env.CERTBOT_RENEWED_FLAG = name;
    writeStub(ctx.binDir, 'node', 0); // this run renews nothing
    fs.writeFileSync(path.join(hostileDir, name), ''); // stale flag from a previous run

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    // Without `--` this `rm -f` fails with busybox's "unrecognized option" and
    // leaves the stale flag in place — which would then falsely trigger a
    // reload below. Proving both halves at once: rm actually ran (file gone)
    // and nothing downstream was misled by a leftover flag.
    expect(fs.existsSync(path.join(hostileDir, name))).toBe(false);
    expect(r.stdout).not.toMatch(/unrecognized option/);
    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
  });

  it.each([
    ['a bare option-looking name', '-renewed.flag'],
    ['a long-option-shaped name',  '--verbose'],
  ])('creates, detects, and removes a flag named %s across a real renewal', (_label, name) => {
    ctx.env.CERTBOT_RENEWED_FLAG = name;
    // The deploy hook exactly as js/letsencrypt/certbot_renew.js emits it
    // (`touch -- <flag>`), so this proves the hostile name survives both ends
    // of the lifecycle, not just the one this test file can stub directly.
    writeStub(ctx.binDir, 'node', 0, RENEWED_VIA_PRODUCTION_HOOK);

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unrecognized option/);
    // Detected: the flag was created under that name and the reload fired.
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/Certificates renewed; reloading nginx/);
    // Removed afterward: consumed, not left behind to cause a false reload on
    // the next run.
    expect(fs.existsSync(path.join(hostileDir, name))).toBe(false);
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
    // `--` guards the operand from mkdir's own option parsing (see the
    // "operator-controlled lock directory" describe block below); the source
    // pin follows that shape rather than the pre-hardening one.
    expect(SCRIPT_SRC).toMatch(/mkdir -- "\$LOCK_DIR"/);
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
