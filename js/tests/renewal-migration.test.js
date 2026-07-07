// Phase B — Let's Encrypt renewal-config migration tests.
//
// The migration PREPARES (stages) webroot renewal configs without touching the
// live ones, so these tests assert both the transform correctness AND that the
// live standalone configs are left byte-for-byte unchanged (renewal behavior
// stays standalone until Phase C). No renewal-execution is exercised here.

const fs = require('fs');
const os = require('os');
const path = require('path');

const migrate = require('../letsencrypt/migrate_renewal');
const {
  SCHEMA_VERSION,
  WEBROOT_PATH,
  isStandaloneConfig,
  migrateConfigContent,
  validateMigratedContent,
} = migrate;

const STANDALONE = `version = 2.11.0
archive_dir = /etc/letsencrypt/archive/example.com
cert = /etc/letsencrypt/live/example.com/cert.pem
privkey = /etc/letsencrypt/live/example.com/privkey.pem
chain = /etc/letsencrypt/live/example.com/chain.pem
fullchain = /etc/letsencrypt/live/example.com/fullchain.pem

[renewalparams]
account = abc123def456
authenticator = standalone
server = https://acme-v02.api.letsencrypt.org/directory
key_type = ecdsa
`;

const WEBROOT_ALREADY = STANDALONE
  .replace('authenticator = standalone', `authenticator = webroot\nwebroot_path = ${WEBROOT_PATH}`);

let tmp, renewalDir, stagedDir, backupDir, markerPath;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renewal-mig-'));
  renewalDir = path.join(tmp, 'renewal');
  stagedDir = path.join(tmp, 'renewal-webroot');
  backupDir = path.join(tmp, 'renewal-backup');
  markerPath = path.join(tmp, '.schema');
  fs.mkdirSync(renewalDir, { recursive: true });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const opts = () => ({ renewalDir, stagedDir, backupDir, markerPath });
const writeConf = (name, content) => fs.writeFileSync(path.join(renewalDir, name), content);
const readStaged = (name) => fs.readFileSync(path.join(stagedDir, name), 'utf8');
const readLive = (name) => fs.readFileSync(path.join(renewalDir, name), 'utf8');

// ── Pure transform/validation helpers ─────────────────────────────────────
describe('helpers', () => {
  it('detects standalone vs webroot configs', () => {
    expect(isStandaloneConfig(STANDALONE)).toBe(true);
    expect(isStandaloneConfig(WEBROOT_ALREADY)).toBe(false);
    expect(isStandaloneConfig('')).toBe(false);
  });

  it('rewrites the authenticator and injects the verified webroot_path', () => {
    const out = migrateConfigContent(STANDALONE);
    expect(out).toMatch(/^authenticator = webroot$/m);
    expect(out).not.toMatch(/^authenticator = standalone$/m);
    expect(out).toMatch(new RegExp(`^webroot_path = ${WEBROOT_PATH.replace(/\//g, '\\/')}$`, 'm'));
  });

  it('preserves all unrelated [renewalparams] and lineage settings', () => {
    const out = migrateConfigContent(STANDALONE);
    for (const line of [
      'version = 2.11.0',
      'cert = /etc/letsencrypt/live/example.com/cert.pem',
      'account = abc123def456',
      'server = https://acme-v02.api.letsencrypt.org/directory',
      'key_type = ecdsa',
    ]) {
      expect(out).toContain(line);
    }
    // webroot_path lands inside [renewalparams], right after the authenticator.
    expect(out).toMatch(/authenticator = webroot\nwebroot_path = /);
  });

  it('does not duplicate an existing webroot_path', () => {
    const withPath = STANDALONE.replace(
      'authenticator = standalone',
      `authenticator = standalone\nwebroot_path = ${WEBROOT_PATH}`,
    );
    const out = migrateConfigContent(withPath);
    expect((out.match(/^webroot_path = /gm) || []).length).toBe(1);
  });

  it('validates produced webroot configs and rejects bad ones', () => {
    expect(validateMigratedContent(migrateConfigContent(STANDALONE))).toBe(true);
    expect(validateMigratedContent(STANDALONE)).toBe(false); // still standalone
    expect(validateMigratedContent('authenticator = webroot\n')).toBe(false); // no [renewalparams]/path
  });
});

// ── Detection ──────────────────────────────────────────────────────────────
describe('detection', () => {
  it('migrates a single standalone config', () => {
    writeConf('example.com.conf', STANDALONE);
    const s = migrate(opts());
    expect(s).toMatchObject({ scanned: 1, migrated: 1, failed: 0 });
    expect(fs.existsSync(path.join(stagedDir, 'example.com.conf'))).toBe(true);
  });

  it('skips an already-webroot config', () => {
    writeConf('site.conf', WEBROOT_ALREADY);
    const s = migrate(opts());
    expect(s).toMatchObject({ scanned: 1, migrated: 0, skipped: 1 });
    expect(fs.existsSync(path.join(stagedDir, 'site.conf'))).toBe(false);
  });

  it('handles a mix of standalone and webroot configs', () => {
    writeConf('a.conf', STANDALONE);
    writeConf('b.conf', WEBROOT_ALREADY);
    const s = migrate(opts());
    expect(s).toMatchObject({ scanned: 2, migrated: 1, skipped: 1, failed: 0 });
    expect(fs.existsSync(path.join(stagedDir, 'a.conf'))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, 'b.conf'))).toBe(false);
  });

  it('does nothing when there are no configs', () => {
    const s = migrate(opts());
    expect(s).toMatchObject({ scanned: 0, migrated: 0 });
  });

  it('does nothing (and does not throw) when the renewal dir is absent', () => {
    fs.rmSync(renewalDir, { recursive: true, force: true });
    expect(() => migrate(opts())).not.toThrow();
    expect(migrate(opts())).toMatchObject({ scanned: 0, migrated: 0 });
  });
});

// ── Migration correctness + live-config safety ─────────────────────────────
describe('migration output', () => {
  beforeEach(() => writeConf('example.com.conf', STANDALONE));

  it('stages a correct webroot config', () => {
    migrate(opts());
    const staged = readStaged('example.com.conf');
    expect(staged).toMatch(/^authenticator = webroot$/m);
    expect(staged).toMatch(new RegExp(`^webroot_path = ${WEBROOT_PATH.replace(/\//g, '\\/')}$`, 'm'));
    expect(validateMigratedContent(staged)).toBe(true);
  });

  it('leaves the LIVE renewal config byte-for-byte unchanged (still standalone)', () => {
    migrate(opts());
    expect(readLive('example.com.conf')).toBe(STANDALONE);
    expect(isStandaloneConfig(readLive('example.com.conf'))).toBe(true);
  });

  it('backs up the original standalone config verbatim', () => {
    migrate(opts());
    expect(fs.readFileSync(path.join(backupDir, 'example.com.conf'), 'utf8')).toBe(STANDALONE);
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────
describe('idempotency', () => {
  it('is safe to run repeatedly', () => {
    writeConf('example.com.conf', STANDALONE);
    const first = migrate(opts());
    const stagedBefore = readStaged('example.com.conf');
    const second = migrate(opts());
    expect(first).toMatchObject({ migrated: 1 });
    expect(second).toMatchObject({ migrated: 0, alreadyStaged: 1 });
    expect(readStaged('example.com.conf')).toBe(stagedBefore); // unchanged
  });
});

// ── Failure handling (warn and continue; never fail startup) ───────────────
describe('failure handling', () => {
  it('handles an unreadable config and continues', () => {
    writeConf('good.conf', STANDALONE);
    fs.mkdirSync(path.join(renewalDir, 'bad.conf')); // a directory named *.conf -> read fails
    const s = migrate(opts());
    expect(s.failed).toBeGreaterThanOrEqual(1);
    expect(s.migrated).toBe(1); // the good one still migrated
    expect(fs.existsSync(path.join(stagedDir, 'good.conf'))).toBe(true);
  });

  it('does not stage a config that fails validation, and never throws', () => {
    // Standalone authenticator but NO [renewalparams] header -> migrated output invalid.
    writeConf('broken.conf', 'authenticator = standalone\n');
    let s;
    expect(() => { s = migrate(opts()); }).not.toThrow();
    expect(s.failed).toBe(1);
    expect(fs.existsSync(path.join(stagedDir, 'broken.conf'))).toBe(false);
    // Live config untouched.
    expect(readLive('broken.conf')).toBe('authenticator = standalone\n');
  });

  it('handles a staged-write failure without throwing', () => {
    writeConf('example.com.conf', STANDALONE);
    fs.writeFileSync(stagedDir, 'i am a file, not a directory'); // mkdir/staged write will fail
    let s;
    expect(() => { s = migrate(opts()); }).not.toThrow();
    expect(s.failed).toBe(1);
    expect(s.migrated).toBe(0);
  });
});

// ── Marker behavior ────────────────────────────────────────────────────────
describe('marker', () => {
  it('writes the schema-version marker on a clean first run', () => {
    writeConf('example.com.conf', STANDALONE);
    const s = migrate(opts());
    expect(s.markerWritten).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8').trim()).toBe(SCHEMA_VERSION);
  });

  it('does not rewrite the marker on a repeated run', () => {
    writeConf('example.com.conf', STANDALONE);
    migrate(opts());
    const second = migrate(opts());
    expect(second.markerWritten).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('marker is independent of any app version (only the schema version)', () => {
    writeConf('example.com.conf', STANDALONE);
    migrate(opts());
    expect(fs.readFileSync(markerPath, 'utf8').trim()).toBe('webroot-renewal-v1');
  });

  it('does NOT mark complete on a partial migration (so it retries next run)', () => {
    writeConf('good.conf', STANDALONE);
    fs.mkdirSync(path.join(renewalDir, 'bad.conf')); // forces a failure
    const s = migrate(opts());
    expect(s.failed).toBeGreaterThanOrEqual(1);
    expect(s.markerWritten).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
