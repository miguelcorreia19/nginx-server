// hasManagedCertbotState() — the local proof that Certbot reconciliation can
// be skipped (js/letsencrypt/utils.js).
//
// It answers one question: "must the slow Certbot path run?". A startup with
// zero configured letsencrypt/letsencrypt-staging entries skips
// `certbot certificates` only when this returns false, so every uncertain
// answer must be `true` — skipping a cleanup that was needed would be a real
// defect, while running discovery unnecessarily costs one command.
//
// Local state is keyed on /etc/letsencrypt/renewal/*.conf because that is what
// Certbot actually enumerates: a live/<id> or archive/<id> left behind without
// a renewal config is invisible to `certbot certificates`, while a renewal
// config with neither is still Certbot's business.
//
// Exercised against a real temp filesystem (same approach as
// renewal-migration.test.js and reconcile.test.js) rather than a mocked fs,
// because the contract is about real directory/permission behaviour.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { hasManagedCertbotState } = require('../letsencrypt/utils.js');

let tmp, renewalDir, backupPath;

const ENV_KEYS = ['CERTBOT_BACKUP', 'CERTBOT_BACKUP_PATH'];
const savedEnv = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certbot-state-'));
  renewalDir = path.join(tmp, 'letsencrypt', 'renewal');
  backupPath = path.join(tmp, 'backup');
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// Only the renewal directory is overridden by default; backup inputs come from
// the environment exactly as they do in production, unless a test overrides them.
const opts = (extra = {}) => ({ renewalDir, ...extra });

const mkRenewal = () => fs.mkdirSync(renewalDir, { recursive: true });
const mkBackupLive = () => fs.mkdirSync(path.join(backupPath, 'live'), { recursive: true });

// ──────────────────────────────────────────────
//  Local renewal state
// ──────────────────────────────────────────────
describe('hasManagedCertbotState — local renewal state', () => {
  it('is false when the renewal directory does not exist', () => {
    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('is false when the renewal directory exists but is empty', () => {
    mkRenewal();
    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('is true when a renewal config is present', () => {
    mkRenewal();
    fs.writeFileSync(path.join(renewalDir, 'A.conf'), '[renewalparams]\n');
    expect(hasManagedCertbotState(opts())).toBe(true);
  });

  it('is true for a renewal config that is corrupt or empty — parseability is not required', () => {
    // Corrupt renewal state must stay on the Certbot path so Certbot can
    // surface it; the fast path must never hide it.
    mkRenewal();
    fs.writeFileSync(path.join(renewalDir, 'broken.conf'), 'not remotely valid ini');
    expect(hasManagedCertbotState(opts())).toBe(true);

    fs.rmSync(path.join(renewalDir, 'broken.conf'));
    fs.writeFileSync(path.join(renewalDir, 'empty.conf'), '');
    expect(hasManagedCertbotState(opts())).toBe(true);
  });

  it('is true for a *.conf entry that is not a regular file', () => {
    mkRenewal();
    fs.mkdirSync(path.join(renewalDir, 'weird.conf'));
    expect(hasManagedCertbotState(opts())).toBe(true);
  });

  it('is false when the renewal directory holds only non-.conf residue', () => {
    mkRenewal();
    fs.writeFileSync(path.join(renewalDir, 'A.conf.bak'), 'x');
    fs.writeFileSync(path.join(renewalDir, 'README'), 'x');
    expect(hasManagedCertbotState(opts())).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  live/ and archive/ residue are NOT the signal
// ──────────────────────────────────────────────
describe('hasManagedCertbotState — live/archive residue without a renewal config', () => {
  it('is false for a leftover live/<id> (Certbot does not enumerate it)', () => {
    mkRenewal();
    fs.mkdirSync(path.join(tmp, 'letsencrypt', 'live', 'A'), { recursive: true });
    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('is false for a leftover archive/<id>', () => {
    mkRenewal();
    fs.mkdirSync(path.join(tmp, 'letsencrypt', 'archive', 'A'), { recursive: true });
    expect(hasManagedCertbotState(opts())).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  Backup state — mirrors the parseCerts(true) restore gate exactly
// ──────────────────────────────────────────────
describe('hasManagedCertbotState — backup state', () => {
  beforeEach(mkRenewal);

  it('is true when backup is enabled and backup/live holds a lineage', () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    mkBackupLive();
    fs.mkdirSync(path.join(backupPath, 'live', 'A'));

    expect(hasManagedCertbotState(opts())).toBe(true);
  });

  it('is false when backup/live holds only README', () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    mkBackupLive();
    fs.writeFileSync(path.join(backupPath, 'live', 'README'), 'x');

    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('is false when backup/live is empty', () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    mkBackupLive();

    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('is false when the backup path exists but has no live/ directory', () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    fs.mkdirSync(backupPath, { recursive: true });

    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('is false when the backup path does not exist at all', () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = path.join(tmp, 'nowhere');

    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('ignores backup contents entirely when CERTBOT_BACKUP is unset', () => {
    delete process.env.CERTBOT_BACKUP;
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    mkBackupLive();
    fs.mkdirSync(path.join(backupPath, 'live', 'A'));

    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  it('is false when CERTBOT_BACKUP_PATH is unset, even with backup enabled', () => {
    process.env.CERTBOT_BACKUP = 'true';
    delete process.env.CERTBOT_BACKUP_PATH;

    expect(hasManagedCertbotState(opts())).toBe(false);
  });

  // parseCerts()'s restore gate is a bare truthiness test on CERTBOT_BACKUP, so
  // the string "false" enables it there. The predicate mirrors that exactly
  // rather than "fixing" it — the read/write gate inconsistency is a separate
  // decision, and diverging here could let the fast path skip a restore that
  // parseCerts would actually have performed.
  it('mirrors the existing truthiness semantics: the string "false" still counts as enabled', () => {
    process.env.CERTBOT_BACKUP = 'false';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    mkBackupLive();
    fs.mkdirSync(path.join(backupPath, 'live', 'A'));

    expect(hasManagedCertbotState(opts())).toBe(true);
  });

  it('treats the empty string as disabled, as a bare truthiness test does', () => {
    process.env.CERTBOT_BACKUP = '';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    mkBackupLive();
    fs.mkdirSync(path.join(backupPath, 'live', 'A'));

    expect(hasManagedCertbotState(opts())).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  Conservative failure handling
// ──────────────────────────────────────────────
describe('hasManagedCertbotState — an uninspectable directory chooses the slow path', () => {
  it('is true when the renewal directory cannot be read', () => {
    mkRenewal();
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    });

    // Absence was not proven, so the Certbot path must still run.
    expect(hasManagedCertbotState(opts())).toBe(true);

    spy.mockRestore();
  });

  it('is true when the backup live directory cannot be read', () => {
    mkRenewal();
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    mkBackupLive();

    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation((p) => {
      if (String(p).includes('backup')) {
        const err = new Error('EIO');
        err.code = 'EIO';
        throw err;
      }
      return [];
    });

    expect(hasManagedCertbotState(opts())).toBe(true);

    spy.mockRestore();
  });

  it('does not turn an unreadable directory into a thrown startup failure', () => {
    mkRenewal();
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => hasManagedCertbotState(opts())).not.toThrow();

    spy.mockRestore();
  });
});
