// The four-state startup model: bootstrap and local-residue handling.
//
// Every desired Let's Encrypt site lands in exactly one state, and the states
// differ in what is *safe*, not just convenient:
//
//   discoverable     normal flow
//   undiscoverable   renewal config Certbot cannot read -> replacement restore,
//                    else suppress (issuing makes <id>-0001)
//   locally absent   nothing at all -> bootstrap from backup, else issue
//   local residue    live/ or archive/ but no renewal config -> neither
//
// The residue rule is the one that needs stating: verified against the pinned
// Certbot 5.6, issuing there completes the ACME exchange and only then fails to
// store the result, so the certificate is spent and lost. Suppressing is the
// only way to avoid paying for a certificate that cannot be kept.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

const calls = [];

jest.mock('../letsencrypt/restore_lineage.js', () => ({
  recoverInterruptedRestores: jest.fn(() => { calls.push('recoverRestores'); return []; }),
  restoreLineageFromBackup: jest.fn(),
}));

jest.mock('../letsencrypt/bootstrap_lineage.js', () => ({
  recoverInterruptedBootstraps: jest.fn(() => { calls.push('recoverBootstraps'); return []; }),
  bootstrapLineageFromBackup: jest.fn(),
}));

jest.mock('../letsencrypt/validate_backup.js', () => ({
  validateBackupLineage: jest.fn(),
}));

// The real path helper with a mocked fs underneath, so slot classification is
// driven by the files the test says exist.
jest.mock('../letsencrypt/utils.js', () => ({
  parseCerts: jest.fn(),
  checkCertFiles: jest.fn(),
  hasManagedCertbotState: jest.fn(() => { calls.push('hasManagedCertbotState'); return true; }),
  certbotBackupEnabled: jest.fn(() => true),
  listRenewalStems: jest.fn(() => []),
  renewalConfigPath: jest.fn((stem) => `/etc/letsencrypt/renewal/${stem}.conf`),
  backupCertbotState: jest.fn(() => Promise.resolve()),
}));

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve('')),
  commandSafe: jest.fn(() => Promise.resolve()),
  configFiles: jest.fn(() => Promise.resolve()),
}));

jest.mock('../letsencrypt/manage_certs.js', () => ({
  createCert: jest.fn(() => Promise.resolve(true)),
  deleteCert: jest.fn(() => Promise.resolve(true)),
  createConf: jest.fn(() => Promise.resolve()),
}));

// Only the paths named here exist. The `mock` prefix is required, not
// stylistic: a jest.mock() factory may not close over an out-of-scope
// variable unless its name starts with `mock`, so any other name makes the
// whole suite fail to load.
let mockPresent = new Set();
jest.mock('fs', () => ({
  appendFileSync: jest.fn(),
  existsSync: jest.fn((p) => mockPresent.has(String(p))),
  lstatSync: jest.fn(() => undefined),
}));

const { parseCerts, checkCertFiles, hasManagedCertbotState, certbotBackupEnabled, listRenewalStems, backupCertbotState } = require('../letsencrypt/utils.js');
const { recoverInterruptedBootstraps, bootstrapLineageFromBackup } = require('../letsencrypt/bootstrap_lineage.js');
const { recoverInterruptedRestores } = require('../letsencrypt/restore_lineage.js');
const { validateBackupLineage } = require('../letsencrypt/validate_backup.js');
const { command, configFiles } = require('../utils.js');
const { createCert, deleteCert, createConf } = require('../letsencrypt/manage_certs.js');
const letsencryptMode = require('../letsencrypt/index.js');

const lineage = (domains) => ({
  cert_path: '/etc/letsencrypt/live/x/fullchain.pem',
  cert_key_path: '/etc/letsencrypt/live/x/privkey.pem',
  cert_domains: domains,
  status: 'valid',
});

const setConfig = (config) => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, config);
};

const slot = (id) => ({
  renewal: `/etc/letsencrypt/renewal/${id}.conf`,
  live: `/etc/letsencrypt/live/${id}`,
  archive: `/etc/letsencrypt/archive/${id}`,
});

const logged = (spy, re) => spy.mock.calls.some(([line]) => re.test(String(line)));
const transaction = (overrides = {}) => ({
  committed: true,
  transactionDir: '/etc/letsencrypt/.nginx-server-bootstrap/A',
  finalize: jest.fn(() => ({ finalized: true })),
  rollback: jest.fn(),
  ...overrides,
});

// A desired site whose cert-name slot is completely empty.
const locallyAbsentA = () => {
  setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
  // Instrumented like the beforeEach default: a plain mockResolvedValue would
  // replace the implementation and silently stop recording into `calls`, which
  // the ordering assertions read.
  parseCerts.mockImplementation(() => { calls.push('parseCerts'); return Promise.resolve({}); });
  listRenewalStems.mockReturnValue([]);
  mockPresent = new Set();
};

let logSpy, warnSpy, errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockPresent = new Set();
  checkCertFiles.mockReturnValue(true);
  hasManagedCertbotState.mockImplementation(() => { calls.push('hasManagedCertbotState'); return true; });
  certbotBackupEnabled.mockReturnValue(true);
  listRenewalStems.mockReturnValue([]);
  recoverInterruptedRestores.mockImplementation(() => { calls.push('recoverRestores'); return []; });
  recoverInterruptedBootstraps.mockImplementation(() => { calls.push('recoverBootstraps'); return []; });
  parseCerts.mockImplementation(() => { calls.push('parseCerts'); return Promise.resolve({}); });
  // validateBackupLineage always resolves to a verdict object or throws — it
  // never resolves to undefined. Most tests here are not about the verdict, so
  // default to the ordinary "this site has never been backed up" answer; the
  // recovery tests stub it explicitly. Set every run because
  // jest.clearAllMocks() keeps whatever implementation the previous test
  // installed.
  validateBackupLineage.mockResolvedValue({ valid: false, reason: 'backup-renewal-missing' });
  process.env.CERTBOT_BACKUP_PATH = '/home/letsencrypt';
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ──────────────────────────────────────────────
//  Discovery no longer mutates
// ──────────────────────────────────────────────
describe('startup discovery is pure', () => {
  it('never asks parseCerts to restore a backup', async () => {
    locallyAbsentA();

    await letsencryptMode();

    // parseCerts(true) is the legacy bulk restore; startup must not reach it.
    for (const call of parseCerts.mock.calls) expect(call).toEqual([]);
  });
});

// ──────────────────────────────────────────────
//  Recovery ordering
// ──────────────────────────────────────────────
describe('both transaction namespaces recover before anything reads state', () => {
  it('recovers restores and bootstraps before the fast path', async () => {
    setConfig({});
    hasManagedCertbotState.mockImplementation(() => { calls.push('hasManagedCertbotState'); return false; });

    await letsencryptMode();

    expect(calls.indexOf('recoverRestores')).toBeLessThan(calls.indexOf('hasManagedCertbotState'));
    expect(calls.indexOf('recoverBootstraps')).toBeLessThan(calls.indexOf('hasManagedCertbotState'));
  });

  it('recovers both before discovery', async () => {
    locallyAbsentA();

    await letsencryptMode();

    expect(calls.indexOf('recoverBootstraps')).toBeLessThan(calls.indexOf('parseCerts'));
  });

  it.each([
    ['an unrecognised bootstrap leftover', { id: 'A', action: 'unrecognised', transactionDir: '/etc/letsencrypt/.nginx-server-bootstrap/A' }],
    ['a failed bootstrap recovery', { id: 'A', action: 'failed', error: 'EACCES', transactionDir: '/etc/letsencrypt/.nginx-server-bootstrap/A' }],
  ])('refuses to continue after %s', async (_label, result) => {
    locallyAbsentA();
    recoverInterruptedBootstraps.mockReturnValue([result]);

    await expect(letsencryptMode()).rejects.toThrow(/Unresolved certificate transaction state/);
    expect(parseCerts).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
    expect(backupCertbotState).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('crond'));
  });
});

// ──────────────────────────────────────────────
//  Locally absent -> bootstrap
// ──────────────────────────────────────────────
describe('a locally absent site with a valid backup', () => {
  const succeed = () => {
    locallyAbsentA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    const txn = transaction();
    bootstrapLineageFromBackup.mockReturnValue(txn);
    parseCerts
      .mockImplementationOnce(() => { calls.push('parseCerts'); return Promise.resolve({}); })
      .mockImplementation(() => { calls.push('parseCerts'); return Promise.resolve({ A: lineage(['a.example.com']) }); });
    return txn;
  };

  it('installs the backup instead of requesting a certificate', async () => {
    const txn = succeed();

    await letsencryptMode();

    expect(bootstrapLineageFromBackup).toHaveBeenCalledWith('A');
    expect(txn.finalize).toHaveBeenCalled();
    expect(txn.rollback).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
  });

  it('serves the site in the same startup', async () => {
    succeed();

    await letsencryptMode();

    expect(createConf).toHaveBeenCalledWith('A', expect.objectContaining({ status: 'valid' }));
    expect(configFiles).toHaveBeenCalledWith('A', 'valid', undefined, ['a.example.com']);
  });

  it('verifies the installed lineage without the legacy restore', async () => {
    succeed();

    await letsencryptMode();

    for (const call of parseCerts.mock.calls) expect(call).toEqual([]);
    expect(checkCertFiles).toHaveBeenCalledWith('A', expect.objectContaining({ cert_domains: ['a.example.com'] }));
  });
});

describe('a locally absent site without a usable backup issues normally', () => {
  // The key difference from the undiscoverable path: an empty slot is exactly
  // what a brand-new site looks like, so issuance is correct here.
  it.each(['not-enumerated', 'environment-mismatch', 'identifier-mismatch', 'backup-renewal-missing'])(
    'falls through to issuance when validation reports %s', async (reason) => {
      locallyAbsentA();
      validateBackupLineage.mockResolvedValue({ valid: false, reason });

      await letsencryptMode();

      expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
      expect(createCert).toHaveBeenCalledWith('A');
      expect(logged(logSpy, new RegExp(reason))).toBe(true);
    });

  it('does not consult the backup at all when the feature is disabled', async () => {
    locallyAbsentA();
    certbotBackupEnabled.mockReturnValue(false);

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
    expect(createCert).toHaveBeenCalledWith('A');
  });

  it('still issues when the transaction rolls itself back', async () => {
    locallyAbsentA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    bootstrapLineageFromBackup.mockImplementation(() => { throw new Error('failed and was rolled back'); });

    await letsencryptMode();

    // The slot is empty again, so this is simply a new site.
    expect(createCert).toHaveBeenCalledWith('A');
  });

  it('does not issue when the failed transaction left the slot occupied', async () => {
    locallyAbsentA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    bootstrapLineageFromBackup.mockImplementation(() => {
      mockPresent.add(slot('A').archive);           // rollback did not complete
      throw new Error('rollback failed');
    });

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /not in a known state/)).toBe(true);
  });

  it('rolls back and still issues when live verification fails', async () => {
    locallyAbsentA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    const txn = transaction();
    bootstrapLineageFromBackup.mockReturnValue(txn);
    parseCerts.mockResolvedValue({});          // never enumerated after install

    await letsencryptMode();

    expect(txn.rollback).toHaveBeenCalled();
    expect(txn.finalize).not.toHaveBeenCalled();
    expect(createCert).toHaveBeenCalledWith('A');
  });

  it('does not issue when that rollback also fails', async () => {
    locallyAbsentA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    const txn = transaction({ rollback: jest.fn(() => { throw new Error('EACCES'); }) });
    bootstrapLineageFromBackup.mockReturnValue(txn);
    parseCerts.mockResolvedValue({});

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(logged(errorSpy, /rollback failed/)).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Local residue
// ──────────────────────────────────────────────
describe('a cert-name holding residue is left alone entirely', () => {
  const withResidue = (...paths) => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);
    mockPresent = new Set(paths);
  };

  it.each([
    ['live only', [slot('A').live]],
    ['archive only', [slot('A').archive]],
    ['live and archive', [slot('A').live, slot('A').archive]],
  ])('neither bootstraps nor issues with %s', async (_label, paths) => {
    withResidue(...paths);

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
    expect(deleteCert).not.toHaveBeenCalled();
  });

  it('explains why, and what the operator can do about it', async () => {
    withResidue(slot('A').live, slot('A').archive);

    await letsencryptMode();

    expect(logged(warnSpy, /leftover certificate files/)).toBe(true);
    expect(logged(warnSpy, /spent and lost/)).toBe(true);
    expect(logged(warnSpy, /remove or rename them/)).toBe(true);
    expect(logged(warnSpy, /\/etc\/letsencrypt\/live\/A/)).toBe(true);
  });

  it('reports it distinctly from an undiscoverable lineage', async () => {
    withResidue(slot('A').archive);

    await letsencryptMode();

    expect(logged(logSpy, /- A: leftover files, no renewal config/)).toBe(true);
  });

  it('writes no self-signed fallback for it', async () => {
    withResidue(slot('A').archive);

    await letsencryptMode();

    expect(createConf).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  The other two states still behave as before
// ──────────────────────────────────────────────
describe('the existing states are unchanged', () => {
  it('leaves a discoverable site alone', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    parseCerts.mockResolvedValue({ A: lineage(['a.example.com']) });
    listRenewalStems.mockReturnValue(['A']);

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
  });

  it('keeps suppressing an undiscoverable site rather than bootstrapping it', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue(['A']);
    validateBackupLineage.mockResolvedValue({ valid: false, reason: 'not-enumerated' });

    await letsencryptMode();

    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(true);
  });

  // Found without the stem list, so classification falls back to the filesystem
  // and must still reach the conservative answer.
  it('suppresses a renewal config found only on disk', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockImplementation(() => { throw new Error('EACCES'); });
    mockPresent = new Set([slot('A').renewal]);

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  Eligibility
// ──────────────────────────────────────────────
describe('only desired Let\'s Encrypt sites can bootstrap', () => {
  it.each([
    ['http', { mode: 'http', names: ['a.example.com'] }],
    ['custom', { mode: 'custom', names: ['a.example.com'], cert: 'c.pem', cert_key: 'k.pem' }],
  ])('ignores a %s site even when the backup holds that name', async (_label, entry) => {
    setConfig({ A: entry });
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
  });

  it('installs nothing when no Let\'s Encrypt site is configured', async () => {
    setConfig({});
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
  });

  it.each([
    ['letsencrypt-staging', { mode: 'letsencrypt-staging', names: ['a.example.com'] }],
    ['an omitted mode', { names: ['a.example.com'] }],
  ])('considers a %s site', async (_label, entry) => {
    setConfig({ A: entry });
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);
    validateBackupLineage.mockResolvedValue({ valid: false, reason: 'not-enumerated' });

    await letsencryptMode();

    expect(validateBackupLineage).toHaveBeenCalledWith('A');
  });
});

// ──────────────────────────────────────────────
//  All four at once
// ──────────────────────────────────────────────
describe('the four states coexist without interfering', () => {
  it('handles discoverable, bootstrap, issuance and residue in one startup', async () => {
    setConfig({
      good: { mode: 'letsencrypt', names: ['good.example.com'] },
      B: { mode: 'letsencrypt', names: ['b.example.com'] },   // absent + valid backup
      C: { mode: 'letsencrypt', names: ['c.example.com'] },   // absent + no backup
      D: { mode: 'letsencrypt', names: ['d.example.com'] },   // residue
    });
    listRenewalStems.mockReturnValue(['good']);
    mockPresent = new Set([slot('D').live, slot('D').archive]);
    validateBackupLineage.mockImplementation((id) =>
      id === 'B' ? Promise.resolve({ valid: true }) : Promise.resolve({ valid: false, reason: 'backup-renewal-missing' }));
    bootstrapLineageFromBackup.mockReturnValue(transaction());
    const healthy = { good: lineage(['good.example.com']) };
    parseCerts
      .mockImplementationOnce(() => Promise.resolve(healthy))
      .mockImplementation(() => Promise.resolve({ ...healthy, B: lineage(['b.example.com']) }));

    await letsencryptMode();

    expect(bootstrapLineageFromBackup).toHaveBeenCalledTimes(1);
    expect(bootstrapLineageFromBackup).toHaveBeenCalledWith('B');
    // Only the site with an empty slot and no backup asks the CA.
    expect(createCert.mock.calls.map(([id]) => id)).toEqual(['C']);
    expect(validateBackupLineage).not.toHaveBeenCalledWith('D');
    expect(configFiles).toHaveBeenCalledWith('good', 'valid', undefined, ['good.example.com']);
    expect(configFiles).toHaveBeenCalledWith('B', 'valid', undefined, ['b.example.com']);
    expect(configFiles).not.toHaveBeenCalledWith('D', expect.anything(), expect.anything(), expect.anything());
  });
});
