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
const RENEW_JS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'letsencrypt', 'certbot_renew.js'), 'utf8');
const UNREACHABLE_PID = '2147483647';

// The lock-ownership contract certbot_renew.sh writes into every lock
// directory it creates. Pinned as literals here and cross-checked against the
// script source in the ownership suite below; several fixtures also need them
// to build a lock directory the script will recognise as its own.
const LOCK_MARKER_NAME  = '.nginx-server-certbot-renew-lock';
const LOCK_MARKER_VALUE = 'certbot-renew-lock-v1';

// The reload-readiness signal the Node renewal step raises once it has finished
// exporting (js/letsencrypt/certbot_renew.js). Pinned here and cross-checked
// against the script source in the readiness suite below; it lives inside the
// lock directory, which is the script's own private namespace for one run.
const READY_MARKER_NAME = '.nginx-server-reload-ready';

// The "a certificate really renewed" signal certbot's deploy hook raises. It
// used to be an operator-settable path (CERTBOT_RENEWED_FLAG); it is now a
// private file inside the same owned lock directory, for the same reasons.
// Pinned here and cross-checked against the script source below.
const RENEWED_MARKER_NAME = '.nginx-server-renewed';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-test-'));
  const lockDir    = path.join(tmp, 'lock', 'certbot_renew.lock.d');
  const lockParent = path.join(tmp, 'lock');
  const jsDir      = path.join(tmp, 'js');
  const binDir     = path.join(tmp, 'bin');
  const nginxCalls = path.join(tmp, 'nginx-calls');
  const nodeCalls  = path.join(tmp, 'node-calls');
  // Both signals are derived by the script from the lock directory it owns —
  // never from the environment — so the tests locate them the same way.
  const renewedFlag = path.join(lockDir, RENEWED_MARKER_NAME);
  const readyMarker = path.join(lockDir, READY_MARKER_NAME);

  fs.mkdirSync(lockParent, { recursive: true });
  fs.mkdirSync(jsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    CERTBOT_LOCK_DIR: lockDir,
    CERTBOT_JS_DIR: jsDir,
    NGINX_CALLS: nginxCalls,
    NODE_CALLS: nodeCalls,
  };
  return { tmp, binDir, lockDir, nginxCalls, nodeCalls, renewedFlag, readyMarker, env };
}

// The two on-disk signals a renewal run produces, as the stubs raise them.
//
// They answer different questions and the reload needs both: the flag says
// certbot's deploy hook ran (a certificate really renewed), the readiness
// marker says js/letsencrypt/certbot_renew.js then finished exporting it to
// the /etc/ssl/certs paths nginx actually serves. A stub that raises only the
// first models a run whose post-processing failed, not a successful one.
const TOUCH_RENEWED_FLAG   = 'touch "$CERTBOT_INTERNAL_RENEWED_FLAG"';
const SIGNAL_RELOAD_READY  = 'touch -- "$CERTBOT_INTERNAL_RELOAD_READY"';

// node stub that simulates Certbot actually renewing a cert and the renewal
// step completing: the deploy hook touches the renewed-flag the way the real
// certbot deploy hook does, and the export finishes and signals readiness.
const RENEWED = `${TOUCH_RENEWED_FLAG}\n${SIGNAL_RELOAD_READY}`;

// Same, but matching js/letsencrypt/certbot_renew.js's exact deploy-hook shape
// (`touch -- ${shellQuote(renewedFlag)}` there) rather than the plain form
// above. Used only where the flag path itself is under test, so the stub is
// not silently relying on a form production does not actually emit.
const RENEWED_VIA_PRODUCTION_HOOK = `touch -- "$CERTBOT_INTERNAL_RENEWED_FLAG"\n${SIGNAL_RELOAD_READY}`;

// A run that renewed nothing but completed cleanly — the ordinary daily case.
// Production signals readiness on this path too (post-processing succeeded);
// the reload is withheld by the absent flag, not by an absent marker.
const NOTHING_RENEWED = SIGNAL_RELOAD_READY;

// A partial renewal: certbot renewed at least one certificate (deploy hook
// fired) and then failed on another, so the Node step exports what it can,
// signals readiness, and exits non-zero.
const PARTIAL_RENEWAL = RENEWED;

// A run whose export finished and whose backup then failed. Indistinguishable
// from the line above at this layer, and deliberately so: readiness means the
// export completed, so both raise both signals and both exit non-zero. Named
// separately because the case it stands for is a different one — see
// partial-renewal.test.js for the Node side that tells them apart.
const EXPORTED_THEN_BACKUP_FAILED = RENEWED;

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

// A lock directory this script really did create, whose holder was SIGKILLed:
// ownership marker with the exact expected content, plus a PID that is gone.
// `extra` seeds whatever per-run state the dead run is meant to have left
// inside it. This is the only shape stale-lock recovery is permitted to clear.
function seedOwnedStaleLock(ctx, extra = {}) {
  fs.mkdirSync(ctx.lockDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.lockDir, LOCK_MARKER_NAME), `${LOCK_MARKER_VALUE}\n`);
  fs.writeFileSync(path.join(ctx.lockDir, 'pid'), UNREACHABLE_PID);
  for (const [name, body] of Object.entries(extra)) {
    fs.writeFileSync(path.join(ctx.lockDir, name), body);
  }
}

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

// CERTBOT_LOCK_DIR is the one path in this lifecycle an operator still
// supplies (the renewed and readiness markers are now derived from it rather
// than inherited), and it
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
    // The flag now lives inside the lock directory, so the only way a stale one
    // can exist at all is inside a lock a killed run left behind.
    seedOwnedStaleLock(ctx, { [RENEWED_MARKER_NAME]: '' });
    writeStub(ctx.binDir, 'node', 0);       // this run renews nothing
    const r = run(ctx.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stale lock/i);
    expect(nginxCalls(ctx)).toBe('');       // must NOT reload off the stale flag
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
  });

  it('does not reload when the renewal fails (even if a flag somehow exists)', () => {
    seedOwnedStaleLock(ctx, { [RENEWED_MARKER_NAME]: '' });
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

// ---------------------------------------------------------------------------
// The four renewal outcomes, and the two signals that separate them
// ---------------------------------------------------------------------------
//
// `certbot renew` renews every due certificate it can and exits non-zero if
// ANY of them failed, so its exit status cannot tell "nothing renewed" from
// "one lineage is broken and the rest renewed fine". This script used to exit
// on that status before reaching the reload decision, which threw the
// successful half of a partial run away: the renewed material never reached
// the /etc/ssl/certs copies nginx serves, so nginx kept the old certificates.
//
// The Node step now continues past a partial failure and exports what did
// renew, and this script reloads and *then* reports the failure. Which needs
// two independent signals, because the renewed flag answers only half the
// question:
//
//   renewed flag   certbot's deploy hook ran — a certificate really renewed.
//   ready marker   the Node step then finished exporting every certificate to
//                  /etc/ssl/certs. Written inside the lock directory, and
//                  never by this script.
//
// Reload requires both. The flag alone would reload after a failed export,
// announcing a renewal that was never applied. The marker's boundary is that
// export and nothing after it, so a backup that fails later still fails the
// run without withholding the reload — at this layer that is simply a run
// which raised both signals and exited non-zero. The Node half of the protocol
// — when the marker is and is not written — is in partial-renewal.test.js.
describe('certbot_renew.sh — the four renewal outcomes', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); });
  afterEach(() => cleanupCtx(ctx));

  // A — certbot succeeded, nothing was due.
  it('full success with nothing renewed: no reload, exit 0, no state left behind', () => {
    writeStub(ctx.binDir, 'node', 0, NOTHING_RENEWED);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
    expect(r.stdout).toMatch(/certbot renew succeeded/);
    // Readiness is per-run state: it must not survive to authorise a reload
    // the next run never earned.
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });

  // B — certbot succeeded and something renewed.
  it('full success with a renewal: reloads, exits 0, and clears both signals', () => {
    writeStub(ctx.binDir, 'node', 0, RENEWED);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/Certificates renewed; reloading nginx/);
    expect(r.stdout).toMatch(/nginx reloaded after renewal/);
    expect(r.stdout).toMatch(/certbot renew succeeded/);
    // A healthy run says nothing about partial failure.
    expect(r.stdout).not.toMatch(/still reported as failed/);
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });

  // C — certbot failed and nothing renewed.
  it('total failure: no reload, non-zero exit, no readiness signal', () => {
    writeStub(ctx.binDir, 'node', 1); // neither signal raised

    const r = run(ctx.env);

    expect(r.code).toBe(1);
    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/ERROR: certbot renewal script failed \(exit 1\)/);
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
    expect(r.stdout).not.toMatch(/succeeded/);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
  });

  // D — the core regression: certbot failed, but a certificate renewed and the
  // Node step exported it.
  it('partial renewal: reloads the certificates that did renew, then still exits non-zero', () => {
    writeStub(ctx.binDir, 'node', 1, PARTIAL_RENEWAL);

    const r = run(ctx.env);

    // Pre-fix, the script exited on the Node status above and none of this
    // happened — the renewed certificate sat exported but unserved.
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/Certificates renewed; reloading nginx/);
    expect(r.stdout).toMatch(/nginx reloaded after renewal/);
    // ...and the run is still reported as unhealthy.
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/ERROR: certbot renewal script failed \(exit 1\)/);
    expect(r.stdout).toMatch(/renewed certificates have been applied.*run failed after exporting them.*still reported as failed/);
    expect(r.stdout).not.toMatch(/certbot renew succeeded/);
    // The flag is consumed and the run's private state released as usual.
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });
});

// The renewed flag alone must never be reload permission: it says certbot
// deployed something, not that this pipeline finished applying it. These are
// the cases where exactly one of the two signals is present.
describe('certbot_renew.sh — reload needs the export to have completed', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); });
  afterEach(() => cleanupCtx(ctx));

  it('does not reload a partial renewal whose export failed', () => {
    // certbot renewed a certificate (flag raised by its deploy hook), then the
    // Node step failed before it could export — no readiness signal.
    writeStub(ctx.binDir, 'node', 1, TOUCH_RENEWED_FLAG);

    const r = run(ctx.env);

    expect(r.code).toBe(1);
    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/WARNING: certificates were renewed but post-renewal processing did not complete; nginx reload skipped/);
    expect(r.stdout).toMatch(/reloading would apply nothing/);
    expect(r.stdout).not.toMatch(/reloading nginx/);
  });

  it('does not reload when post-processing succeeded but nothing renewed', () => {
    // The readiness marker on its own is not a renewal: it only says the run
    // completed, which every ordinary daily no-op also does.
    writeStub(ctx.binDir, 'node', 0, SIGNAL_RELOAD_READY);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
  });

  it('does not reload on a renewed flag left behind by a failed run', () => {
    // Defensive: the Node step exits 0 only after signalling readiness, so
    // this combination should be unreachable. If it ever arises, the missing
    // signal — not the exit status — is what withholds the reload.
    writeStub(ctx.binDir, 'node', 0, TOUCH_RENEWED_FLAG);

    const r = run(ctx.env);

    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/post-renewal processing did not complete/);
  });

  it('releases the readiness marker even when the run failed', () => {
    writeStub(ctx.binDir, 'node', 1, PARTIAL_RENEWAL);

    const r = run(ctx.env);

    expect(r.code).toBe(1);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });

  it('starts each run with no readiness marker, whatever a previous one left', () => {
    // The marker lives in the lock directory, which is created fresh per run —
    // but a run that inherits a stale lock directory it owns must not inherit
    // its readiness either.
    seedOwnedStaleLock(ctx, { [READY_MARKER_NAME]: 'reload-ready-v1\n' });
    // This run renews nothing and signals nothing.
    writeStub(ctx.binDir, 'node', 0);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stale lock/i);
    expect(nginxCalls(ctx)).toBe('');
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
  });

  it('reloads a run whose backup failed after a complete export', () => {
    // The export put the certificates into the paths nginx reads, so they are
    // applied; the backup failure still fails the run. Withholding the reload
    // for it would leave nginx serving a certificate that had already been
    // replaced on disk.
    writeStub(ctx.binDir, 'node', 1, EXPORTED_THEN_BACKUP_FAILED);

    const r = run(ctx.env);

    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/nginx reloaded after renewal/);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/ERROR: certbot renewal script failed \(exit 1\)/);
    expect(r.stdout).not.toMatch(/certbot renew succeeded/);
    // The warning names the shape of the outcome, not certbot — the run may
    // have failed for a reason certbot had nothing to do with.
    expect(r.stdout).toMatch(/run failed after exporting them/);
    expect(r.stdout).not.toMatch(/certbot failed for at least one other certificate/);
    // And the run's private state is released as usual.
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });

  it('keeps a reload failure visible on the partial path instead of folding it into the renewal failure', () => {
    writeNginxStub(ctx.binDir, 1); // reload itself fails
    writeStub(ctx.binDir, 'node', 1, PARTIAL_RENEWAL);

    const r = run(ctx.env);

    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/WARNING: nginx reload after renewal failed/);
    expect(r.stdout).not.toMatch(/nginx reloaded after renewal/);
    // Still failed, and still failed for the renewal reason it reported.
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/ERROR: certbot renewal script failed/);
  });
});

// Both signals are internal coordination state, not features. These pin the
// properties that keep them that way, which no behavioural test can observe
// from outside.
describe('certbot_renew.sh — both signals are private, per-run state', () => {
  const MARKERS = [
    ['renewed',      'RENEWED_FLAG',          'CERTBOT_INTERNAL_RENEWED_FLAG', RENEWED_MARKER_NAME],
    ['reload-ready', 'RELOAD_READY_MARKER',   'CERTBOT_INTERNAL_RELOAD_READY', READY_MARKER_NAME],
  ];

  it.each(MARKERS)('names the %s marker inside the lock directory it already owns', (_label, shellVar, envVar, fileName) => {
    expect(SCRIPT_SRC).toMatch(
      new RegExp(`${shellVar}="\\$LOCK_DIR_ABS/${fileName.replace(/\./g, '\\.')}"`)
    );
    expect(SCRIPT_SRC).toMatch(new RegExp(`export ${envVar}="\\$${shellVar}"`));
  });

  it('derives both from LOCK_DIR, absolutised for the Node process boundary', () => {
    // Node runs from JS_DIR (the pushd), so a relative CERTBOT_LOCK_DIR would
    // otherwise name a different file at each end of the protocol. LOCK_DIR
    // itself must stay exactly as given, or lock acquisition and the ownership
    // check would start resolving differently too.
    expect(SCRIPT_SRC).toMatch(/case "\$LOCK_DIR" in\n\s*\/\*\) LOCK_DIR_ABS="\$LOCK_DIR" ;;\n\s*\*\)\s*LOCK_DIR_ABS="\$PWD\/\$LOCK_DIR" ;;/);
    expect(SCRIPT_SRC).toMatch(/^LOCK_DIR=\$\{CERTBOT_LOCK_DIR:-/m);
  });

  it.each(MARKERS)('the %s marker is not an operator-settable override', (_label, shellVar, envVar) => {
    // Unconditional assignment, and no `${VAR:-default}` form anywhere that
    // would let an inherited value redirect the marker at a path of its
    // choosing. This is the property the whole internalisation rests on.
    expect(SCRIPT_SRC).not.toMatch(new RegExp(`\\$\\{${envVar}:?-`));
    expect(SCRIPT_SRC).not.toMatch(new RegExp(`${shellVar}=\\$\\{`));
    // And neither is offered as one in the script's own documentation of them.
    const overridesBlock = SCRIPT_SRC.slice(
      SCRIPT_SRC.indexOf('# Test-override environment variables'),
      SCRIPT_SRC.indexOf('LOCK_DIR='),
    );
    expect(overridesBlock).not.toMatch(new RegExp(envVar));
  });

  it('never reads the old operator-controlled CERTBOT_RENEWED_FLAG at all', () => {
    // Stronger than "overwrites it": the name is unreferenced, so there is no
    // form of the script in which an inherited value reaches a filesystem
    // operation. Asserted on the source because no run can prove a negative
    // about a variable that is never read.
    expect(SCRIPT_SRC).not.toMatch(/CERTBOT_RENEWED_FLAG/);
    expect(RENEW_JS_SRC).not.toMatch(/process\.env\.CERTBOT_RENEWED_FLAG/);
  });

  it.each(MARKERS)('clears the %s marker before the run and releases it with the lock', (_label, shellVar) => {
    expect(SCRIPT_SRC).toMatch(new RegExp(`rm -f -- "\\$${shellVar}"`));
    const release = SCRIPT_SRC.slice(
      SCRIPT_SRC.indexOf('release_lock() {'),
      SCRIPT_SRC.indexOf('# ---- Lock ownership'),
    );
    expect(release).toMatch(new RegExp(`rm -f -- "\\$${shellVar}"`));
    // Before the rmdir, which would otherwise refuse a non-empty directory.
    expect(release.indexOf(`rm -f -- "$${shellVar}"`))
      .toBeLessThan(release.indexOf('rmdir -- "$LOCK_DIR"'));
    // Normal release stays non-recursive: it names each entry it removes.
    expect(release).not.toMatch(/rm -rf/);
  });

  it('clears neither marker while the lock is still being acquired', () => {
    // Deleting inside a directory this script has not proved it owns is the
    // whole class of bug this change closes. Nothing between the first mkdir
    // and the ownership guard's verdict may touch either marker; the pre-run
    // removals sit strictly after it. (release_lock is *defined* above this
    // block but only ever *called* once ownership is settled.)
    const acquire = SCRIPT_SRC.slice(
      SCRIPT_SRC.indexOf('if ! mkdir -- "$LOCK_DIR"'),
      SCRIPT_SRC.indexOf('if ! init_lock_metadata; then'),
    );
    expect(acquire).toContain('lock_is_ours');
    for (const shellVar of ['RENEWED_FLAG', 'RELOAD_READY_MARKER']) {
      expect(acquire).not.toMatch(new RegExp(`\\$${shellVar}`));
    }
    // And the pre-run clears really are downstream of the whole acquire block.
    const guardEnd = SCRIPT_SRC.indexOf('if ! init_lock_metadata; then');
    for (const shellVar of ['RENEWED_FLAG', 'RELOAD_READY_MARKER']) {
      expect(SCRIPT_SRC.indexOf(`rm -f -- "$${shellVar}"`, guardEnd)).toBeGreaterThan(guardEnd);
    }
  });

  it('gates the reload on both signals, and defers the failure exit until after it', () => {
    const reloadAt = SCRIPT_SRC.indexOf('nginx -s reload');
    const gateAt   = SCRIPT_SRC.indexOf('elif [ ! -f "$RELOAD_READY_MARKER" ]');
    const exitAt   = SCRIPT_SRC.indexOf('exit "$RENEWAL_EXIT"');

    expect(gateAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(-1);
    // The regression this whole change is about: the renewal-failure exit used
    // to sit above the reload decision, so a partial renewal never reloaded.
    expect(exitAt).toBeGreaterThan(reloadAt);
    // And there is only one of them.
    expect(SCRIPT_SRC.indexOf('exit "$RENEWAL_EXIT"', exitAt + 1)).toBe(-1);
  });
});

// The renewed marker's path is no longer operator-controlled. It is derived
// from the lock directory the script owns, so the only hostile path that can
// still reach it is a hostile CERTBOT_LOCK_DIR — which is exercised in full by
// the lock-directory suite above, and again here from the marker's side: the
// script still removes the marker (`rm -f -- "$RENEWED_FLAG"`, twice) and
// tests it (`[ -f "$RENEWED_FLAG" ]`, once), and the deploy hook still touches
// it through a shell.
//
// A leading-hyphen value only reaches rm's option parser when the *whole*
// operand starts with "-", so the derived marker — always absolute now — can
// never trigger it. The `--` guards stay anyway: they cost nothing and they
// outlive assumptions about how LOCK_DIR is resolved. What this suite pins is
// that a lock directory whose *name* is option-shaped, or which contains
// spaces and shell metacharacters, still carries a working renewed marker
// through create, detect and remove.
describe('certbot_renew.sh — the renewed marker under a hostile lock-directory name', () => {
  let ctx, hostileDir;

  beforeEach(() => {
    ctx = setup();
    writeNginxStub(ctx.binDir, 0);
    hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-hostile-flag-'));
  });
  afterEach(() => {
    cleanupCtx(ctx);
    fs.rmSync(hostileDir, { recursive: true, force: true });
  });

  // Relative + option-shaped: the one case where `--` is load-bearing for the
  // lock lifecycle, run with cwd pinned so every phase agrees on one location.
  it.each([
    ['a bare option-looking name', '-lock'],
    ['a long-option-shaped name',  '--verbose'],
  ])('clears a stale marker inside a lock dir named %s instead of failing to remove it', (_label, name) => {
    ctx.env.CERTBOT_LOCK_DIR = name;
    const lockPath = path.join(hostileDir, name);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, LOCK_MARKER_NAME), `${LOCK_MARKER_VALUE}\n`);
    fs.writeFileSync(path.join(lockPath, 'pid'), UNREACHABLE_PID);
    fs.writeFileSync(path.join(lockPath, RENEWED_MARKER_NAME), ''); // left by the killed run
    writeStub(ctx.binDir, 'node', 0); // this run renews nothing

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unrecognized option/);
    // The stale marker must not survive into the reload decision.
    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([
    ['a bare option-looking name', '-lock'],
    ['a long-option-shaped name',  '--verbose'],
    ['spaces and metacharacters',  'lock dir; echo pwned $(id) & `x`'],
  ])('creates, detects and removes the marker under a lock dir named %s', (_label, name) => {
    ctx.env.CERTBOT_LOCK_DIR = name;
    // The deploy hook exactly as js/letsencrypt/certbot_renew.js emits it
    // (`touch -- <flag>`), so this proves the derived path survives both ends
    // of the lifecycle, not just the one this file can stub directly.
    writeStub(ctx.binDir, 'node', 0, RENEWED_VIA_PRODUCTION_HOOK);

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unrecognized option/);
    // Detected: the marker was created under that path and the reload fired.
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/Certificates renewed; reloading nginx/);
    // Removed afterward, along with the lock itself — consumed, not left to
    // cause a false reload on the next run.
    expect(fs.existsSync(path.join(hostileDir, name))).toBe(false);
    // Nothing the metacharacter name could have expanded into ran: the only
    // entry the run left in the working directory is the empty lock's parent.
    expect(fs.readdirSync(hostileDir)).toEqual([]);
  });

  it('quotes the marker path through the deploy hook when the lock dir contains metacharacters', () => {
    const name = 'lock dir; touch pwned';
    ctx.env.CERTBOT_LOCK_DIR = name;
    writeStub(ctx.binDir, 'node', 0, RENEWED_VIA_PRODUCTION_HOOK);

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    // The `; touch pwned` half never executed as a command.
    expect(fs.existsSync(path.join(hostileDir, 'pwned'))).toBe(false);
  });
});

// THE PRIMARY REGRESSION.
//
// CERTBOT_RENEWED_FLAG used to name the renewed flag's path, and the script
// removed that path with `rm -f -- "$RENEWED_FLAG"` at two lifecycle points.
// BusyBox crond passes the container environment through to cron jobs, so an
// inherited value naming an operator file — CERTBOT_RENEWED_FLAG=/home/config.json
// — made this script delete it. Bounded to one non-directory entry, since the
// removal was never recursive, but arbitrary operator-data deletion all the
// same.
//
// The marker is now derived from the owned lock directory, and the old name is
// read nowhere. These runs supply the hostile value anyway and prove the file
// it names is neither written nor deleted, on both the nothing-renewed and the
// deploy-hook-fired paths.
describe('certbot_renew.sh — an inherited CERTBOT_RENEWED_FLAG cannot redirect anything', () => {
  let ctx, operatorFile;
  const OPERATOR_CONTENT = '{"operator":"data","must":"survive"}\n';

  beforeEach(() => {
    ctx = setup();
    writeNginxStub(ctx.binDir, 0);
    operatorFile = path.join(ctx.tmp, 'config.json');
    fs.writeFileSync(operatorFile, OPERATOR_CONTENT);
    // Exactly what a mis-set container environment would hand the cron job.
    ctx.env.CERTBOT_RENEWED_FLAG = operatorFile;
  });
  afterEach(() => cleanupCtx(ctx));

  const expectOperatorFileIntact = () => {
    expect(fs.existsSync(operatorFile)).toBe(true);
    expect(fs.readFileSync(operatorFile, 'utf8')).toBe(OPERATOR_CONTENT);
  };

  it('leaves the file untouched on a run that renews nothing', () => {
    writeStub(ctx.binDir, 'node', 0);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    // Pre-fix this run deleted the file outright, in the pre-run `rm -f`.
    expectOperatorFileIntact();
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
    expect(nginxCalls(ctx)).toBe('');
  });

  it('leaves the file untouched on a run whose deploy hook fires, and reloads off the internal marker', () => {
    writeStub(ctx.binDir, 'node', 0, RENEWED_VIA_PRODUCTION_HOOK);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    // Pre-fix the hook would have touched this path and the post-reload
    // `rm -f` would then have deleted it.
    expectOperatorFileIntact();
    // The reload still happened — driven by the marker inside the lock dir.
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/Certificates renewed; reloading nginx/);
  });

  it('leaves the file untouched across a partial renewal', () => {
    writeStub(ctx.binDir, 'node', 1, PARTIAL_RENEWAL);

    const r = run(ctx.env);

    expect(r.code).toBe(1);
    expectOperatorFileIntact();
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/still reported as failed/);
  });

  it('leaves the file untouched when the whole renewal fails', () => {
    writeStub(ctx.binDir, 'node', 1);

    const r = run(ctx.env);

    expect(r.code).toBe(1);
    expectOperatorFileIntact();
    expect(nginxCalls(ctx)).toBe('');
  });

  it('uses the internal marker rather than the inherited path, and hands Node an absolute one', () => {
    // Observed from inside the run: normal release removes the marker before
    // the script exits, so it cannot be inspected afterwards.
    writeRecordingNodeStub(ctx.binDir, 0,
      'echo "FLAG=$CERTBOT_INTERNAL_RENEWED_FLAG"\n' +
      'echo "OLD=${CERTBOT_RENEWED_FLAG:-<unset>}"\n');

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    // The internal protocol variable names a file inside the owned lock dir...
    expect(r.stdout).toContain(`FLAG=${ctx.renewedFlag}`);
    expect(path.isAbsolute(ctx.renewedFlag)).toBe(true);
    expect(path.dirname(ctx.renewedFlag)).toBe(ctx.lockDir);
    expect(path.basename(ctx.renewedFlag)).toBe(RENEWED_MARKER_NAME);
    // ...and it is emphatically not the inherited value, which is passed
    // through to the child untouched precisely because nothing consumes it.
    expect(r.stdout).not.toContain(`FLAG=${operatorFile}`);
    expect(r.stdout).toContain(`OLD=${operatorFile}`);
  });
});

// A relative CERTBOT_LOCK_DIR is the case absolutisation exists for: the Node
// step runs from JS_DIR, so an un-absolutised marker path would name one file
// for the hook and a different one for the reload check.
describe('certbot_renew.sh — the marker path handed to Node survives a relative lock dir', () => {
  let ctx, hostileDir;

  beforeEach(() => {
    ctx = setup();
    writeNginxStub(ctx.binDir, 0);
    hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-renew-rel-'));
  });
  afterEach(() => {
    cleanupCtx(ctx);
    fs.rmSync(hostileDir, { recursive: true, force: true });
  });

  it('exports an absolute renewed-marker path that is valid from the Node working directory', () => {
    ctx.env.CERTBOT_LOCK_DIR = 'rel.lock.d';
    // The Node step runs somewhere else entirely, and reports what it was told.
    writeRecordingNodeStub(ctx.binDir, 0, 'echo "FLAG=$CERTBOT_INTERNAL_RENEWED_FLAG"');

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    const flag = (r.stdout.match(/^FLAG=(.*)$/m) || [])[1];
    expect(flag).toBe(path.join(hostileDir, 'rel.lock.d', RENEWED_MARKER_NAME));
    expect(path.isAbsolute(flag)).toBe(true);
  });

  it('still reloads when the hook resolves that path from a different working directory', () => {
    ctx.env.CERTBOT_LOCK_DIR = 'rel.lock.d';
    // Runs with cwd = JS_DIR, as production's Node step does; only an absolute
    // path makes the touch and the reload check agree on one file.
    writeStub(ctx.binDir, 'node', 0, RENEWED_VIA_PRODUCTION_HOOK);

    const r = run(ctx.env, { cwd: hostileDir });

    expect(r.code).toBe(0);
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
    expect(r.stdout).toMatch(/Certificates renewed; reloading nginx/);
    expect(fs.existsSync(path.join(hostileDir, 'rel.lock.d'))).toBe(false);
  });
});

// Stale renewed state must not survive into a later run. The marker lives only
// inside the lock directory, and the stale path removes that wholesale.
describe('certbot_renew.sh — stale renewed state cannot leak into the next run', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); });
  afterEach(() => cleanupCtx(ctx));

  it('clears an owned stale lock carrying a renewed marker, and does not reload off it', () => {
    seedOwnedStaleLock(ctx, {
      [RENEWED_MARKER_NAME]: '',
      [READY_MARKER_NAME]: 'reload-ready-v1\n',
    });
    writeStub(ctx.binDir, 'node', 0); // this run renews nothing and signals nothing

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stale lock/i);
    // Both stale signals were removed with the directory, so neither could
    // authorise a reload this run never earned.
    expect(nginxCalls(ctx)).toBe('');
    expect(r.stdout).toMatch(/No certificates renewed; nginx reload skipped/);
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
  });

  it('still reloads on the next run when that run\'s own deploy hook fires', () => {
    seedOwnedStaleLock(ctx, { [RENEWED_MARKER_NAME]: '' });
    writeStub(ctx.binDir, 'node', 0, RENEWED_VIA_PRODUCTION_HOOK);

    const r = run(ctx.env);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stale lock/i);
    // Cleared, then legitimately re-raised by this run's own hook.
    expect(nginxCalls(ctx)).toMatch(/-s reload/);
  });

  it('leaves an unowned directory holding a renewed-marker-shaped file untouched', () => {
    // The ownership guard runs first: a directory this script cannot prove it
    // created is preserved whole, marker-shaped contents included.
    fs.mkdirSync(ctx.lockDir, { recursive: true });
    fs.writeFileSync(ctx.renewedFlag, 'operator data that merely looks like ours\n');
    writeStub(ctx.binDir, 'node', 0);

    const r = run(ctx.env);

    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/is not a renewal lock created by this script/);
    expect(fs.readFileSync(ctx.renewedFlag, 'utf8'))
      .toBe('operator data that merely looks like ours\n');
    expect(nodeCalls(ctx)).toBe('');
  });
});

// Normal completion leaves nothing behind: both signals and the lock metadata
// are removed, and the lock directory itself is gone.
describe('certbot_renew.sh — normal release removes every per-run internal file', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); writeNginxStub(ctx.binDir, 0); });
  afterEach(() => cleanupCtx(ctx));

  it.each([
    ['a run that renewed something', 0, () => RENEWED_VIA_PRODUCTION_HOOK],
    ['a run that renewed nothing',   0, () => NOTHING_RENEWED],
    ['a partial renewal',            1, () => PARTIAL_RENEWAL],
    ['a total failure',              1, () => ''],
  ])('leaves no marker, PID file, ownership marker or lock dir after %s', (_label, code, body) => {
    writeStub(ctx.binDir, 'node', code, body());

    const r = run(ctx.env);

    expect(r.code).toBe(code);
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(fs.existsSync(path.join(ctx.lockDir, 'pid'))).toBe(false);
    expect(fs.existsSync(path.join(ctx.lockDir, LOCK_MARKER_NAME))).toBe(false);
    // rmdir only succeeds on an empty directory, so its absence is also proof
    // that nothing else was left inside it.
    expect(fs.existsSync(ctx.lockDir)).toBe(false);
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
    expect(JS_SRC).toMatch(/process\.env\.CERTBOT_INTERNAL_RENEWED_FLAG/);
    // The old operator-controlled name is gone entirely, not merely shadowed.
    expect(JS_SRC).not.toMatch(/process\.env\.CERTBOT_RENEWED_FLAG/);
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

  // The half quoting cannot cover. The flag path is internal now, so in
  // production it is absolute and cannot itself begin with `-` — but touch's
  // option parsing is a property of the hook, not of today's caller, and the
  // hook must stay correct for any filename it is handed. Quoted or not, touch
  // reads a leading `-` as an option. Run relative to the temp directory,
  // because an absolute path can never lead with a hyphen — that is exactly
  // the case `--` exists for.
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
