// Let's Encrypt renewal-config migration tests.
//
// The migration rewrites each legacy `authenticator = standalone` renewal config
// IN PLACE to webroot (atomically, after backing up the original). These tests
// prove the standalone -> webroot transform, idempotency, backup, validation,
// failure handling, and the schema marker. No renewal execution is exercised.

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

let tmp, renewalDir, backupDir, markerPath;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renewal-mig-'));
  renewalDir = path.join(tmp, 'renewal');
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

const opts = () => ({ renewalDir, backupDir, markerPath });
const writeConf = (name, content) => fs.writeFileSync(path.join(renewalDir, name), content);
const readLive = (name) => fs.readFileSync(path.join(renewalDir, name), 'utf8');
const webrootRe = new RegExp(`^webroot_path = ${WEBROOT_PATH.replace(/\//g, '\\/')}$`, 'm');

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
    expect(out).toMatch(webrootRe);
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

// ── In-place migration (standalone -> webroot) ─────────────────────────────
describe('migration (standalone -> webroot, in place)', () => {
  it('rewrites a single standalone live config to webroot', () => {
    writeConf('example.com.conf', STANDALONE);
    const s = migrate(opts());
    expect(s).toMatchObject({ scanned: 1, migrated: 1, failed: 0 });
    const live = readLive('example.com.conf');
    expect(live).toMatch(/^authenticator = webroot$/m);
    expect(live).not.toMatch(/^authenticator = standalone$/m);
    expect(live).toMatch(webrootRe);
    expect(validateMigratedContent(live)).toBe(true);
  });

  it('leaves an already-webroot config unchanged', () => {
    writeConf('site.conf', WEBROOT_ALREADY);
    const s = migrate(opts());
    expect(s).toMatchObject({ scanned: 1, migrated: 0, skipped: 1 });
    expect(readLive('site.conf')).toBe(WEBROOT_ALREADY);
  });

  it('handles a mix of standalone and already-webroot configs', () => {
    writeConf('a.conf', STANDALONE);
    writeConf('b.conf', WEBROOT_ALREADY);
    const s = migrate(opts());
    expect(s).toMatchObject({ scanned: 2, migrated: 1, skipped: 1, failed: 0 });
    expect(isStandaloneConfig(readLive('a.conf'))).toBe(false); // migrated
    expect(readLive('b.conf')).toBe(WEBROOT_ALREADY);           // untouched
  });

  it('does nothing when there are no configs', () => {
    expect(migrate(opts())).toMatchObject({ scanned: 0, migrated: 0 });
  });

  it('does nothing (and does not throw) when the renewal dir is absent', () => {
    fs.rmSync(renewalDir, { recursive: true, force: true });
    expect(() => migrate(opts())).not.toThrow();
    expect(migrate(opts())).toMatchObject({ scanned: 0, migrated: 0 });
  });

  it('preserves all unrelated settings when rewriting in place', () => {
    writeConf('example.com.conf', STANDALONE);
    migrate(opts());
    const live = readLive('example.com.conf');
    for (const line of [
      'version = 2.11.0',
      'cert = /etc/letsencrypt/live/example.com/cert.pem',
      'account = abc123def456',
      'server = https://acme-v02.api.letsencrypt.org/directory',
      'key_type = ecdsa',
    ]) {
      expect(live).toContain(line);
    }
  });

  it('backs up the original standalone config verbatim before rewriting', () => {
    writeConf('example.com.conf', STANDALONE);
    migrate(opts());
    expect(fs.readFileSync(path.join(backupDir, 'example.com.conf'), 'utf8')).toBe(STANDALONE);
  });

  it('writes atomically — leaves no temp files behind', () => {
    writeConf('example.com.conf', STANDALONE);
    migrate(opts());
    expect(fs.readdirSync(renewalDir).some((f) => f.includes('migrate-tmp'))).toBe(false);
  });

  it('is idempotent — a second run is a no-op', () => {
    writeConf('example.com.conf', STANDALONE);
    migrate(opts());
    const afterFirst = readLive('example.com.conf');
    const second = migrate(opts());
    expect(second).toMatchObject({ migrated: 0, skipped: 1 });
    expect(readLive('example.com.conf')).toBe(afterFirst); // unchanged
  });
});

// ── Marker behavior ────────────────────────────────────────────────────────
describe('marker', () => {
  it('writes the schema-version marker on a clean run', () => {
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

  it('records only the schema version (independent of any app version)', () => {
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

// ── Failure handling (warn and continue; never corrupt; never throw) ───────
describe('failure handling', () => {
  it('handles an unreadable config and continues with the rest', () => {
    writeConf('good.conf', STANDALONE);
    fs.mkdirSync(path.join(renewalDir, 'bad.conf')); // a directory named *.conf -> read fails
    const s = migrate(opts());
    expect(s.failed).toBeGreaterThanOrEqual(1);
    expect(s.migrated).toBe(1); // the good one still migrated
    expect(isStandaloneConfig(readLive('good.conf'))).toBe(false);
  });

  it('on a validation failure, leaves the live config untouched and never throws', () => {
    // Standalone authenticator but NO [renewalparams] header -> migrated output invalid.
    writeConf('broken.conf', 'authenticator = standalone\n');
    let s;
    expect(() => { s = migrate(opts()); }).not.toThrow();
    expect(s.failed).toBe(1);
    expect(readLive('broken.conf')).toBe('authenticator = standalone\n'); // preserved, never corrupted
  });

  it('on a write failure, preserves the original and never throws', () => {
    writeConf('example.com.conf', STANDALONE);
    fs.writeFileSync(backupDir, 'i am a file, not a directory'); // mkdir(backupDir) will fail
    let s;
    expect(() => { s = migrate(opts()); }).not.toThrow();
    expect(s.failed).toBe(1);
    expect(s.migrated).toBe(0);
    expect(readLive('example.com.conf')).toBe(STANDALONE); // live config never corrupted
  });
});
