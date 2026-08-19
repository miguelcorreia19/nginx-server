// Partial renewal: `certbot renew` fails, but at least one certificate renewed.
//
// `certbot renew` renews every certificate that is due and exits non-zero if
// ANY of them failed, so its exit status alone cannot tell "nothing renewed"
// from "one lineage is broken and the rest renewed fine". The renewal script
// used to abort on that status, which threw away the successful half of a
// partial run: the renewed material stayed in /etc/letsencrypt/live and was
// never exported to the /etc/ssl/certs copies nginx actually serves, so nginx
// kept the old certificates until some later run happened to succeed outright.
//
// The distinguishing evidence is certbot's own deploy hook, which runs only
// for a certificate it really renewed and deployed. Flag present + non-zero
// exit is a partial renewal (continue, apply, still report failure); flag
// absent + non-zero exit is a total failure (fail fast, unchanged).
//
// Two signals, not one. The renewed flag says certbot deployed something; it
// does NOT say this script then finished exporting it. So post-processing
// raises a second, private signal — the reload-ready marker, written last —
// and certbot_renew.sh reloads nginx only when both are present. The suites
// below pin that the marker is never raised by a run whose export or backup
// failed; the shell half of the protocol is in certbot-renew.test.js.
//
// start() is not exported (the module self-invokes only under
// `require.main === module`), so every scenario drives the real script as a
// child process with `certbot` and `cp` replaced by stubs on PATH — the same
// real-process approach certbot-renew.test.js uses for the shell driver and
// chain-path-derivation.test.js uses for this script. Mocks cannot stand in
// here: what is under test is a protocol carried by files between two
// processes, and the certbot stub runs the deploy hook exactly as certbot does
// (as a shell command string), so the production `touch -- '<path>'` hook is
// exercised rather than a reimplementation of it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const JS_ROOT = path.join(__dirname, '..');
const SCRIPT_REL = path.join('letsencrypt', 'certbot_renew.js');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

// The script is copied out of the repository for each run rather than executed
// in place. Its backup branch does `require("../config.json")` — a file that
// exists only inside a running container — and the backup scenarios need one,
// which must never be written into the real source tree.
function copyJsTree(dest) {
  fs.cpSync(JS_ROOT, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(JS_ROOT, src);
      if (rel === '') return true;
      const top = rel.split(path.sep)[0];
      return top !== 'node_modules' && top !== 'tests';
    },
  });
  // luxon (via letsencrypt/utils.js) must still resolve from the copy.
  fs.symlinkSync(path.join(JS_ROOT, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
}

// One lineage's block of `certbot certificates` output, in the pinned Certbot
// 5.6.0 format the real parser expects. The reported paths are the fixture's
// own, so the export below copies real files rather than asserting on an argv
// that never touched a filesystem.
const certBlock = (liveDir, id) => `  Certificate Name: ${id}
    Serial Number: 3d8b2f29c9fa34921b3037ebdb6d5a1cad080173
    Key Type: RSA
    Identifiers: ${id}.example.com
    Expiry Date: 2026-09-26 23:25:50+00:00 (VALID: 29 days)
    Certificate Path: ${liveDir}/${id}/fullchain.pem
    Private Key Path: ${liveDir}/${id}/privkey.pem`;

const certbotCertificates = (liveDir, ids) => `
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
Found the following certs:
${ids.map((id) => certBlock(liveDir, id)).join('\n')}
- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
`;

// Distinct per file and per lineage, so "the healthy certificate reached the
// path nginx serves" is checked by content and not just by filename.
const pem = (id, kind) => `-----BEGIN ${kind}-----\nfixture:${id}:${kind}\n-----END ${kind}-----\n`;

// `certbot`, as far as this script can tell. `renew` optionally runs the
// deploy hook the way Certbot does — the hook is stored as a command string
// and executed through a shell — so the flag is raised by the exact
// `touch -- '<path>'` the production hook builds, not by a stand-in.
const CERTBOT_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$CERTBOT_CALLS"

if [ "$1" = "certificates" ]; then
  cat "$CERTBOT_CERTIFICATES_OUTPUT"
  exit 0
fi

if [ "$1" = "renew" ]; then
  if [ "\${CERTBOT_STUB_DEPLOY_HOOK_FIRES:-0}" = "1" ]; then
    hook=""; prev=""
    for arg in "$@"; do
      if [ "$prev" = "--deploy-hook" ]; then hook="$arg"; fi
      prev="$arg"
    done
    [ -n "$hook" ] && sh -c "$hook"
  fi
  if [ "\${CERTBOT_STUB_RENEW_EXIT:-0}" != "0" ]; then
    echo "Failed to renew certificate broken.example.com with error: some challenge failed" >&2
  fi
  exit "\${CERTBOT_STUB_RENEW_EXIT:-0}"
fi

exit 0
`;

// `cp`, recording every copy and performing the export ones for real.
//
// The export destinations are the fixed /etc/ssl/certs paths the script
// hard-codes, which no test may write to, so they are remapped into the
// fixture. Backup copies (`cp -rf -- <src> <backup>`) are told apart by their
// first argument and are the only ones a scenario can fail independently.
const CP_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$CP_CALLS"

if [ "$1" = "-rf" ]; then
  exit "\${CP_STUB_BACKUP_EXIT:-0}"
fi

if [ "\${CP_STUB_EXPORT_EXIT:-0}" != "0" ]; then
  echo "cp: can't stat '$1': No such file or directory" >&2
  exit "\${CP_STUB_EXPORT_EXIT}"
fi

src="$1"; dst="$2"
case "$dst" in
  /etc/ssl/certs/*) dst="$SSL_CERTS_DIR/\${dst#/etc/ssl/certs/}" ;;
esac
exec /bin/cp "$src" "$dst"
`;

function setup({ lineages = ['healthy'], enumerated = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-renewal-'));
  const jsDir      = path.join(tmp, 'js');
  const binDir     = path.join(tmp, 'bin');
  const lockDir    = path.join(tmp, 'lock');
  const liveDir    = path.join(tmp, 'letsencrypt', 'live');
  const renewalDir = path.join(tmp, 'letsencrypt', 'renewal');
  const sslCerts   = path.join(tmp, 'ssl-certs');
  const backupDir  = path.join(tmp, 'backup');

  for (const dir of [binDir, lockDir, liveDir, renewalDir, sslCerts, backupDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  copyJsTree(jsDir);

  // Real lineage material for every configured lineage, and a webroot renewal
  // config each, so the defensive migration step sees a realistic tree.
  for (const id of lineages) {
    fs.mkdirSync(path.join(liveDir, id), { recursive: true });
    fs.writeFileSync(path.join(liveDir, id, 'fullchain.pem'), pem(id, 'CERTIFICATE'));
    fs.writeFileSync(path.join(liveDir, id, 'privkey.pem'), pem(id, 'PRIVATE KEY'));
    fs.writeFileSync(path.join(liveDir, id, 'chain.pem'), pem(id, 'TRUSTED CERTIFICATE'));
    fs.writeFileSync(
      path.join(renewalDir, `${id}.conf`),
      `version = 5.6.0\narchive_dir = ${tmp}/letsencrypt/archive/${id}\n\n[renewalparams]\nauthenticator = webroot\nwebroot_path = /var/www/certbot\n`,
    );
  }

  const certificatesOut = path.join(tmp, 'certbot-certificates.out');
  fs.writeFileSync(certificatesOut, certbotCertificates(liveDir, enumerated || lineages));

  fs.writeFileSync(path.join(binDir, 'certbot'), CERTBOT_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'cp'), CP_STUB, { mode: 0o755 });

  const renewedFlag = path.join(tmp, 'renewed.flag');
  const readyMarker = path.join(lockDir, '.nginx-server-reload-ready');

  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    // Keeps the defensive renewal-config migration away from a real
    // /etc/letsencrypt.
    CERTBOT_RENEWAL_DIR: renewalDir,
    CERTBOT_RENEWAL_BACKUP_DIR: path.join(tmp, 'renewal-backup'),
    CERTBOT_RENEWAL_MARKER: path.join(tmp, 'renewal-marker'),
    // The two cross-process signals, named exactly as certbot_renew.sh exports
    // them.
    CERTBOT_RENEWED_FLAG: renewedFlag,
    CERTBOT_INTERNAL_RELOAD_READY: readyMarker,
    // Stub controls.
    CERTBOT_CALLS: path.join(tmp, 'certbot-calls'),
    CERTBOT_CERTIFICATES_OUTPUT: certificatesOut,
    CP_CALLS: path.join(tmp, 'cp-calls'),
    SSL_CERTS_DIR: sslCerts,
  };

  return { tmp, jsDir, binDir, liveDir, renewalDir, sslCerts, backupDir, renewedFlag, readyMarker, env };
}

function run(ctx, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT_REL], {
    cwd: ctx.jsDir,
    encoding: 'utf8',
    env: { ...ctx.env, ...extraEnv },
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    output: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

const lines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];

const cpCalls      = (ctx) => lines(ctx.env.CP_CALLS);
const certbotCalls = (ctx) => lines(ctx.env.CERTBOT_CALLS);
const exported     = (ctx, id, file) => path.join(ctx.sslCerts, `${id}_${file}.pem`);
const cleanup      = (ctx) => fs.rmSync(ctx.tmp, { recursive: true, force: true });

// certbot renewed something and the run should keep going.
const RENEWED = { CERTBOT_STUB_DEPLOY_HOOK_FIRES: '1' };
// ...and certbot then failed on some other lineage.
const RENEW_FAILED = { CERTBOT_STUB_RENEW_EXIT: '1' };

// ---------------------------------------------------------------------------
// A + B — full success (the two outcomes that must not change)
// ---------------------------------------------------------------------------

describe('certbot_renew.js — certbot renew succeeded', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx));

  it('exports and signals readiness when nothing was renewed', () => {
    const r = run(ctx); // no deploy hook: nothing was due

    expect(r.code).toBe(0);
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
    // Post-processing still ran (discovery + export are unconditional today).
    expect(fs.readFileSync(exported(ctx, 'healthy', 'fullchain'), 'utf8'))
      .toBe(pem('healthy', 'CERTIFICATE'));
    // Readiness says "post-processing completed", which it did. The reload is
    // withheld by the absent renewed flag, not by this — see the shell suite.
    expect(fs.existsSync(ctx.readyMarker)).toBe(true);
    expect(r.output).not.toMatch(/Partial renewal:/);
  });

  it('exports and signals readiness when a certificate was renewed', () => {
    const r = run(ctx, RENEWED);

    expect(r.code).toBe(0);
    expect(fs.existsSync(ctx.renewedFlag)).toBe(true);
    for (const [file, kind] of [['fullchain', 'CERTIFICATE'], ['privkey', 'PRIVATE KEY'], ['chain', 'TRUSTED CERTIFICATE']]) {
      expect(fs.readFileSync(exported(ctx, 'healthy', file), 'utf8')).toBe(pem('healthy', kind));
    }
    expect(fs.existsSync(ctx.readyMarker)).toBe(true);
    expect(r.output).not.toMatch(/WARNING|ERROR/);
  });

  it('writes the readiness marker only after the export has completed', () => {
    // The marker's mtime must not precede the exported files': it is the last
    // thing the run does, and a marker raised any earlier would authorise a
    // reload onto an export still in progress.
    const r = run(ctx, RENEWED);

    expect(r.code).toBe(0);
    const markerAt = fs.statSync(ctx.readyMarker).mtimeMs;
    for (const file of ['fullchain', 'privkey', 'chain']) {
      expect(markerAt).toBeGreaterThanOrEqual(fs.statSync(exported(ctx, 'healthy', file)).mtimeMs);
    }
  });
});

// ---------------------------------------------------------------------------
// C — total failure
// ---------------------------------------------------------------------------

describe('certbot_renew.js — certbot renew failed with nothing renewed', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx));

  it('fails fast: no discovery, no export, no readiness signal', () => {
    const r = run(ctx, RENEW_FAILED); // deploy hook never fires

    expect(r.code).toBe(1);
    expect(fs.existsSync(ctx.renewedFlag)).toBe(false);
    // The absent flag is what makes this a total failure, so nothing beyond
    // the renew attempt may run.
    expect(certbotCalls(ctx)).toEqual(expect.not.arrayContaining([expect.stringContaining('certificates')]));
    expect(cpCalls(ctx)).toEqual([]);
    expect(fs.readdirSync(ctx.sslCerts)).toEqual([]);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(r.output).toMatch(/ERROR: certbot renewal failed/);
    // Not reinterpreted as a partial success. (Matched on the messages rather
    // than the bare word: the fixture's own temp path contains it.)
    expect(r.output).not.toMatch(/Partial renewal:/);
    expect(r.output).not.toMatch(/deploy hook recorded at least one successful renewal/);
  });

  it('does not treat a flag left behind by an earlier run as evidence', () => {
    // certbot_renew.sh clears the flag before every run precisely so this
    // cannot happen; asserted here as the Node half of that contract, since a
    // stale flag would turn every total failure into a false partial success.
    // (The flag is written *before* the run, so only a pre-existing one is
    // being simulated — the hook still never fires.)
    fs.writeFileSync(ctx.renewedFlag, '');

    const r = run(ctx, RENEW_FAILED);

    // With the flag present this run *is* classified as partial — which is
    // exactly why the shell must clear it first. What must not happen is the
    // failure being lost.
    expect(r.code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D — partial renewal: the core regression
// ---------------------------------------------------------------------------

describe('certbot_renew.js — partial renewal (certbot failed, a certificate renewed)', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx));

  it('continues through discovery and export instead of aborting', () => {
    const r = run(ctx, { ...RENEWED, ...RENEW_FAILED });

    expect(fs.existsSync(ctx.renewedFlag)).toBe(true);
    // The pre-fix behaviour: certbot's non-zero status ended the run here and
    // none of the following happened.
    expect(certbotCalls(ctx)).toEqual(expect.arrayContaining([expect.stringContaining('certificates')]));
    expect(cpCalls(ctx).length).toBe(3);
    for (const [file, kind] of [['fullchain', 'CERTIFICATE'], ['privkey', 'PRIVATE KEY'], ['chain', 'TRUSTED CERTIFICATE']]) {
      expect(fs.readFileSync(exported(ctx, 'healthy', file), 'utf8')).toBe(pem('healthy', kind));
    }
  });

  it('signals reload readiness once post-processing has completed', () => {
    const r = run(ctx, { ...RENEWED, ...RENEW_FAILED });

    expect(fs.existsSync(ctx.readyMarker)).toBe(true);
    expect(fs.statSync(ctx.readyMarker).mtimeMs)
      .toBeGreaterThanOrEqual(fs.statSync(exported(ctx, 'healthy', 'chain')).mtimeMs);
  });

  it('still exits non-zero so the run is reported as unhealthy', () => {
    const r = run(ctx, { ...RENEWED, ...RENEW_FAILED });
    expect(r.code).toBe(1);
  });

  it('warns that certbot failed, that something renewed, and that the run still fails', () => {
    const r = run(ctx, { ...RENEWED, ...RENEW_FAILED });

    expect(r.output).toMatch(/certbot renew failed, but its deploy hook recorded at least one successful renewal/);
    expect(r.output).toMatch(/continuing with export and post-processing/);
    expect(r.output).toMatch(/this run will still be reported as failed/);
    expect(r.output).toMatch(/Partial renewal: .*exported successfully.*reporting this run as failed/);
    // certbot's own diagnosis is carried through rather than swallowed.
    expect(r.output).toMatch(/broken\.example\.com/);
    // Never the certificate material itself.
    expect(r.output).not.toMatch(/BEGIN (PRIVATE KEY|CERTIFICATE)/);
  });
});

// ---------------------------------------------------------------------------
// E — partial renewal whose export then fails
// ---------------------------------------------------------------------------
//
// The test that proves the renewed flag alone is not being used as reload
// permission: everything about this run says "a certificate renewed", and the
// readiness signal must still be withheld.

describe('certbot_renew.js — partial renewal with a failing export', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => cleanup(ctx));

  it('fails, exports nothing, and never signals readiness', () => {
    const r = run(ctx, { ...RENEWED, ...RENEW_FAILED, CP_STUB_EXPORT_EXIT: '1' });

    expect(r.code).toBe(1);
    expect(fs.existsSync(ctx.renewedFlag)).toBe(true); // certbot really did renew
    expect(fs.readdirSync(ctx.sslCerts)).toEqual([]);  // but nothing reached nginx's paths
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(r.output).toMatch(/ERROR: certbot renewal failed/);
  });

  it('withholds readiness on an export failure even when certbot itself succeeded', () => {
    // Same gate on the ordinary path: this is not a partial-renewal special
    // case, it is what "reload only after post-processing succeeded" means.
    const r = run(ctx, { ...RENEWED, CP_STUB_EXPORT_EXIT: '1' });

    expect(r.code).toBe(1);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F — partial renewal whose backup then fails
// ---------------------------------------------------------------------------
//
// Backup is part of the required completion path today: a failure in it
// already fails the run. That ordering is preserved rather than worked around,
// so readiness is signalled after the backup, not before it.

describe('certbot_renew.js — partial renewal with a failing backup', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
    // The backup branch is the one code path here that reads config.json.
    fs.writeFileSync(
      path.join(ctx.jsDir, 'config.json'),
      JSON.stringify({ healthy: { mode: 'letsencrypt', names: ['healthy.example.com'], email: 'admin@example.com' } }),
    );
  });
  afterEach(() => cleanup(ctx));

  const BACKUP_ON = { CERTBOT_BACKUP: 'true' };

  it('fails after a completed export, and never signals readiness', () => {
    // backupCertbotState() copies out of the fixed /etc/letsencrypt, so the
    // failure is forced at whichever step that path reaches first on this
    // host: enumerating a directory that is not there, or the `cp -rf` the
    // stub refuses. Both are genuine backup failures and both must land in the
    // same place.
    const r = run(ctx, {
      ...RENEWED,
      ...RENEW_FAILED,
      ...BACKUP_ON,
      CERTBOT_BACKUP_PATH: ctx.backupDir,
      CP_STUB_BACKUP_EXIT: '1',
    });

    expect(r.code).toBe(1);
    // The export had already succeeded — this is a failure strictly after it.
    expect(fs.readFileSync(exported(ctx, 'healthy', 'fullchain'), 'utf8'))
      .toBe(pem('healthy', 'CERTIFICATE'));
    expect(r.output).toMatch(/Backing up Let's Encrypt state/);
    expect(r.output).not.toMatch(/Backup completed/);
    // The whole point: a completed export is not enough on its own.
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
    expect(r.output).toMatch(/ERROR: certbot renewal failed/);
  });

  it('withholds readiness on a backup failure even when certbot itself succeeded', () => {
    const r = run(ctx, {
      ...RENEWED,
      ...BACKUP_ON,
      CERTBOT_BACKUP_PATH: ctx.backupDir,
      CP_STUB_BACKUP_EXIT: '1',
    });

    expect(r.code).toBe(1);
    expect(fs.existsSync(ctx.readyMarker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G — the motivating case: one damaged lineage, one healthy renewal
// ---------------------------------------------------------------------------

describe('certbot_renew.js — a damaged lineage alongside a healthy renewal', () => {
  let ctx, brokenConf, brokenConfBody;

  beforeEach(() => {
    // Two configured lineages; Certbot can only enumerate the healthy one,
    // which is what an unreadable renewal config looks like from here.
    ctx = setup({ lineages: ['healthy', 'broken'], enumerated: ['healthy'] });
    brokenConf = path.join(ctx.renewalDir, 'broken.conf');
    brokenConfBody = '# damaged: truncated mid-write\nversion = 5.6.0\narchive_dir\n';
    fs.writeFileSync(brokenConf, brokenConfBody);
  });
  afterEach(() => cleanup(ctx));

  const PARTIAL = { CERTBOT_STUB_DEPLOY_HOOK_FIRES: '1', CERTBOT_STUB_RENEW_EXIT: '1' };

  it('exports the healthy lineage to the paths nginx serves', () => {
    const r = run(ctx, PARTIAL);

    expect(r.code).toBe(1);
    for (const [file, kind] of [['fullchain', 'CERTIFICATE'], ['privkey', 'PRIVATE KEY'], ['chain', 'TRUSTED CERTIFICATE']]) {
      expect(fs.readFileSync(exported(ctx, 'healthy', file), 'utf8')).toBe(pem('healthy', kind));
    }
    expect(fs.existsSync(ctx.readyMarker)).toBe(true);
  });

  it('leaves the damaged lineage alone: not exported, not deleted, not reissued', () => {
    const r = run(ctx, PARTIAL);

    // Nothing is exported for a lineage Certbot could not enumerate — there is
    // no reported path to export from, and none is guessed at.
    expect(fs.readdirSync(ctx.sslCerts).sort()).toEqual(
      ['healthy_chain.pem', 'healthy_fullchain.pem', 'healthy_privkey.pem'],
    );
    expect(cpCalls(ctx).join('\n')).not.toMatch(/broken/);

    // Its material and its renewal config are preserved exactly as found: the
    // renewal path never deletes or reissues a damaged lineage.
    expect(fs.readFileSync(brokenConf, 'utf8')).toBe(brokenConfBody);
    for (const file of ['fullchain.pem', 'privkey.pem', 'chain.pem']) {
      expect(fs.existsSync(path.join(ctx.liveDir, 'broken', file))).toBe(true);
    }
    const certbot = certbotCalls(ctx).join('\n');
    expect(certbot).not.toMatch(/delete/);
    expect(certbot).not.toMatch(/certonly/);
  });

  it('reports the run as failed even though the healthy certificate was applied', () => {
    const r = run(ctx, PARTIAL);

    expect(r.code).toBe(1);
    expect(r.output).toMatch(/Partial renewal/);
    expect(r.stdout).toMatch(/- healthy: valid/);
  });
});
