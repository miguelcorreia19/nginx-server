// Automatic per-lineage restore, as wired into the Let's Encrypt handler.
//
// The primitives are trusted here (they have their own suites); what these
// tests pin is the orchestration around them — ordering, the CERTBOT_BACKUP
// gate, which failures may mutate live state, and what happens to a site whose
// recovery does or does not succeed.
//
// The single most important assertion is the ordering one: an interrupted
// restore leaves renewal/<id>.conf absent while the original lineage sits in
// the transaction directory. Discovery, the zero-state fast path and the legacy
// bulk backup restore would all read that as "this lineage does not exist", so
// recovery has to run before any of them.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

const calls = [];

jest.mock('../letsencrypt/restore_lineage.js', () => ({
  recoverInterruptedRestores: jest.fn(() => { calls.push('recover'); return []; }),
  restoreLineageFromBackup: jest.fn(),
}));

jest.mock('../letsencrypt/validate_backup.js', () => ({
  validateBackupLineage: jest.fn(),
}));

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

jest.mock('fs', () => ({ appendFileSync: jest.fn(), existsSync: jest.fn(() => true) }));

const {
  parseCerts, checkCertFiles, hasManagedCertbotState,
  certbotBackupEnabled, listRenewalStems, backupCertbotState,
} = require('../letsencrypt/utils.js');
const { recoverInterruptedRestores, restoreLineageFromBackup } = require('../letsencrypt/restore_lineage.js');
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

const logged = (spy, re) => spy.mock.calls.some(([line]) => re.test(String(line)));
const transaction = (overrides = {}) => ({
  committed: true,
  transactionDir: '/etc/letsencrypt/.nginx-server-restore/A',
  finalize: jest.fn(() => ({ finalized: true })),
  rollback: jest.fn(),
  ...overrides,
});

// The desired-undiscoverable setup every restore test starts from.
const undiscoverableA = () => {
  setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
  listRenewalStems.mockReturnValue(['A']);
  parseCerts.mockResolvedValue({});
};

let logSpy, warnSpy, errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  checkCertFiles.mockReturnValue(true);
  hasManagedCertbotState.mockImplementation(() => { calls.push('hasManagedCertbotState'); return true; });
  certbotBackupEnabled.mockReturnValue(true);
  listRenewalStems.mockReturnValue([]);
  recoverInterruptedRestores.mockImplementation(() => { calls.push('recover'); return []; });
  parseCerts.mockImplementation(() => { calls.push('parseCerts'); return Promise.resolve({}); });
  process.env.CERTBOT_BACKUP_PATH = '/home/letsencrypt';
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ──────────────────────────────────────────────
//  Ordering — the correction this wiring exists for
// ──────────────────────────────────────────────
describe('interrupted-restore recovery runs before anything reads Certbot state', () => {
  it('runs before the zero-state fast path', async () => {
    // A crash mid-restore leaves the renewal config absent, which the fast path
    // would otherwise read as "no Certbot state at all".
    setConfig({});
    hasManagedCertbotState.mockImplementation(() => { calls.push('hasManagedCertbotState'); return false; });

    await letsencryptMode();

    expect(calls.indexOf('recover')).toBeLessThan(calls.indexOf('hasManagedCertbotState'));
  });

  it('runs before parseCerts(true)', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });

    await letsencryptMode();

    expect(calls.indexOf('recover')).toBeLessThan(calls.indexOf('parseCerts'));
  });

  it('still lets the fast path return when there is genuinely nothing to do', async () => {
    setConfig({});
    hasManagedCertbotState.mockImplementation(() => { calls.push('hasManagedCertbotState'); return false; });

    await letsencryptMode();

    expect(parseCerts).not.toHaveBeenCalled();
  });
});

describe('an interrupted restore that cannot be resolved stops startup', () => {
  const assertNothingRan = () => {
    expect(parseCerts).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
    expect(deleteCert).not.toHaveBeenCalled();
    expect(backupCertbotState).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('crond'));
  };

  it.each([
    ['an unrecognised leftover', [{ id: 'A', action: 'unrecognised', transactionDir: '/etc/letsencrypt/.nginx-server-restore/A' }]],
    ['a failed recovery', [{ id: 'A', action: 'failed', error: 'EACCES', transactionDir: '/etc/letsencrypt/.nginx-server-restore/A' }]],
  ])('refuses to continue after %s', async (_label, results) => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    recoverInterruptedRestores.mockReturnValue(results);

    await expect(letsencryptMode()).rejects.toThrow(/Unresolved certificate restore state/);
    assertNothingRan();
  });

  it('names the preserved transaction directory', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    recoverInterruptedRestores.mockReturnValue([
      { id: 'A', action: 'unrecognised', transactionDir: '/etc/letsencrypt/.nginx-server-restore/A' },
    ]);

    await expect(letsencryptMode()).rejects.toThrow();

    expect(logged(errorSpy, /\.nginx-server-restore\/A/)).toBe(true);
  });

  it('propagates a recovery that throws', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    recoverInterruptedRestores.mockImplementation(() => { throw new Error('EIO'); });

    await expect(letsencryptMode()).rejects.toThrow(/EIO/);
    expect(parseCerts).not.toHaveBeenCalled();
  });

  it('continues normally for ordinary recovery outcomes', async () => {
    setConfig({});
    recoverInterruptedRestores.mockReturnValue([
      { id: 'A', action: 'rolled-back' },
      { id: 'B', action: 'rolled-forward' },
      { id: 'C', action: 'discarded' },
    ]);

    await expect(letsencryptMode()).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────
//  The CERTBOT_BACKUP gate
// ──────────────────────────────────────────────
describe('CERTBOT_BACKUP is the only opt-in', () => {
  it('does not even look at the backup when the feature is disabled', async () => {
    undiscoverableA();
    certbotBackupEnabled.mockReturnValue(false);

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(restoreLineageFromBackup).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(true);
    expect(createCert).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  Success
// ──────────────────────────────────────────────
describe('a valid backup is restored and the site continues', () => {
  const succeed = () => {
    undiscoverableA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    const txn = transaction();
    restoreLineageFromBackup.mockReturnValue(txn);
    // Discovery after the restore finds the lineage.
    parseCerts
      .mockImplementationOnce(() => { calls.push('parseCerts'); return Promise.resolve({}); })
      .mockImplementation(() => { calls.push('parseCerts'); return Promise.resolve({ A: lineage(['a.example.com']) }); });
    return txn;
  };

  it('finalizes the transaction and never rolls back', async () => {
    const txn = succeed();

    await letsencryptMode();

    expect(txn.finalize).toHaveBeenCalled();
    expect(txn.rollback).not.toHaveBeenCalled();
  });

  it('verifies against live state without triggering the legacy bulk restore', async () => {
    succeed();

    await letsencryptMode();

    // parseCerts(true) is discovery; every later call must be argument-free so
    // the old backup-restore branch is unreachable.
    expect(parseCerts).toHaveBeenNthCalledWith(1, true);
    for (const call of parseCerts.mock.calls.slice(1)) expect(call).toEqual([]);
  });

  it('lifts issuance suppression so the site is served this startup', async () => {
    succeed();

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(createConf).toHaveBeenCalledWith('A', expect.objectContaining({ status: 'valid' }));
    expect(configFiles).toHaveBeenCalledWith('A', 'valid', undefined, ['a.example.com']);
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(false);
  });

  it('says where the certificate came from', async () => {
    succeed();

    await letsencryptMode();

    expect(logged(logSpy, /valid backup found/)).toBe(true);
    expect(logged(logSpy, /restored from the Certbot backup/)).toBe(true);
  });

  // Frozen on purpose: the backup keeps its previous copy for this startup, and
  // a later cleanly healthy startup updates it normally.
  it('still protects the backup copy for the rest of this startup', async () => {
    succeed();

    await letsencryptMode();

    expect(backupCertbotState).toHaveBeenCalledWith({ protectedLineages: ['A'] });
  });

  it('reports success even when the leftover transaction state cannot be removed', async () => {
    undiscoverableA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    restoreLineageFromBackup.mockReturnValue(transaction({
      finalize: jest.fn(() => ({ finalized: false, transactionDir: '/etc/letsencrypt/.nginx-server-restore/A' })),
    }));
    parseCerts
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementation(() => Promise.resolve({ A: lineage(['a.example.com']) }));

    await letsencryptMode();

    expect(logged(logSpy, /restored from the Certbot backup/)).toBe(true);
    expect(logged(warnSpy, /could not be removed/)).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Nothing usable — live state must not change
// ──────────────────────────────────────────────
describe('an unusable backup never touches live state', () => {
  const expectPreserved = () => {
    expect(restoreLineageFromBackup).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
    expect(deleteCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(true);
  };

  it.each(['not-enumerated', 'environment-mismatch', 'identifier-mismatch', 'backup-renewal-missing'])(
    'preserves the lineage when validation reports %s', async (reason) => {
      undiscoverableA();
      validateBackupLineage.mockResolvedValue({ valid: false, reason });

      await letsencryptMode();

      expect(logged(warnSpy, new RegExp(reason))).toBe(true);
      expectPreserved();
    });

  it('degrades this site alone when validation cannot be performed', async () => {
    undiscoverableA();
    validateBackupLineage.mockRejectedValue(new Error('certbot unavailable'));

    await expect(letsencryptMode()).resolves.not.toThrow();

    expect(logged(errorSpy, /could not check the backup/)).toBe(true);
    expectPreserved();
  });

  it('preserves the lineage when the transaction rejects its preconditions', async () => {
    undiscoverableA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    restoreLineageFromBackup.mockReturnValue({ committed: false, reason: 'non-canonical-backup-paths' });

    await letsencryptMode();

    expect(logged(warnSpy, /non-canonical-backup-paths/)).toBe(true);
    expect(createCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(true);
  });

  it('keeps the site suppressed when the transaction throws', async () => {
    undiscoverableA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    restoreLineageFromBackup.mockImplementation(() => { throw new Error('rename failed and was rolled back'); });

    await expect(letsencryptMode()).resolves.not.toThrow();

    expect(logged(errorSpy, /restore failed/)).toBe(true);
    expect(createCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Verification failure
// ──────────────────────────────────────────────
describe('a restore that fails live verification is rolled back', () => {
  const failVerification = (arrange) => {
    undiscoverableA();
    validateBackupLineage.mockResolvedValue({ valid: true });
    const txn = transaction();
    restoreLineageFromBackup.mockReturnValue(txn);
    arrange();
    return txn;
  };

  it('rolls back when the restored lineage is still not enumerated', async () => {
    const txn = failVerification(() => parseCerts.mockResolvedValue({}));

    await letsencryptMode();

    expect(txn.rollback).toHaveBeenCalled();
    expect(txn.finalize).not.toHaveBeenCalled();
    expect(logged(errorSpy, /failed verification/)).toBe(true);
  });

  it('rolls back when the restored certificate does not satisfy the site', async () => {
    const txn = failVerification(() => {
      parseCerts
        .mockImplementationOnce(() => Promise.resolve({}))
        .mockImplementation(() => Promise.resolve({ A: lineage(['a.example.com']) }));
      checkCertFiles.mockReturnValue(false);
    });

    await letsencryptMode();

    expect(txn.rollback).toHaveBeenCalled();
    expect(txn.finalize).not.toHaveBeenCalled();
  });

  it('keeps the site suppressed rather than issuing after a failed verification', async () => {
    failVerification(() => parseCerts.mockResolvedValue({}));

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(true);
  });

  it('leaves the transaction for the next startup when rollback also fails', async () => {
    const txn = failVerification(() => parseCerts.mockResolvedValue({}));
    txn.rollback.mockImplementation(() => { throw new Error('EACCES'); });

    await expect(letsencryptMode()).resolves.not.toThrow();

    expect(logged(errorSpy, /rollback failed/)).toBe(true);
    expect(logged(errorSpy, /\.nginx-server-restore\/A/)).toBe(true);
    expect(createCert).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  Several sites
// ──────────────────────────────────────────────
describe('recovery is per lineage', () => {
  it('restores one site while another stays suppressed and a healthy one is untouched', async () => {
    setConfig({
      A: { mode: 'letsencrypt', names: ['a.example.com'] },
      B: { mode: 'letsencrypt', names: ['b.example.com'] },
      good: { mode: 'letsencrypt', names: ['good.example.com'] },
    });
    listRenewalStems.mockReturnValue(['A', 'B', 'good']);
    validateBackupLineage.mockImplementation((id) =>
      id === 'A' ? Promise.resolve({ valid: true }) : Promise.resolve({ valid: false, reason: 'not-enumerated' }));
    restoreLineageFromBackup.mockReturnValue(transaction());
    const healthy = { good: lineage(['good.example.com']) };
    parseCerts
      .mockImplementationOnce(() => Promise.resolve(healthy))
      .mockImplementation(() => Promise.resolve({ ...healthy, A: lineage(['a.example.com']) }));

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(deleteCert).not.toHaveBeenCalled();
    expect(configFiles).toHaveBeenCalledWith('A', 'valid', undefined, ['a.example.com']);
    expect(configFiles).toHaveBeenCalledWith('good', 'valid', undefined, ['good.example.com']);
    expect(configFiles).not.toHaveBeenCalledWith('B', expect.anything(), expect.anything(), expect.anything());
    // Both undiscoverable lineages keep their protected backup copy.
    expect(backupCertbotState).toHaveBeenCalledWith({ protectedLineages: ['A', 'B'] });
  });

  it('attempts a later lineage even after an earlier one fails', async () => {
    setConfig({
      A: { mode: 'letsencrypt', names: ['a.example.com'] },
      B: { mode: 'letsencrypt', names: ['b.example.com'] },
    });
    listRenewalStems.mockReturnValue(['A', 'B']);
    validateBackupLineage.mockImplementation((id) =>
      id === 'A' ? Promise.reject(new Error('boom')) : Promise.resolve({ valid: false, reason: 'not-enumerated' }));

    await letsencryptMode();

    expect(validateBackupLineage).toHaveBeenCalledWith('A');
    expect(validateBackupLineage).toHaveBeenCalledWith('B');
  });
});

// ──────────────────────────────────────────────
//  Mode coverage and existing policy
// ──────────────────────────────────────────────
describe('eligibility follows the existing desired-set rules', () => {
  it.each([
    ['letsencrypt-staging', { mode: 'letsencrypt-staging', names: ['a.example.com'] }],
    ['an omitted mode', { names: ['a.example.com'] }],
  ])('attempts recovery for %s', async (_label, entry) => {
    setConfig({ A: entry });
    listRenewalStems.mockReturnValue(['A']);
    parseCerts.mockResolvedValue({});
    validateBackupLineage.mockResolvedValue({ valid: false, reason: 'not-enumerated' });

    await letsencryptMode();

    expect(validateBackupLineage).toHaveBeenCalledWith('A');
  });

  it('does not attempt recovery for an undiscoverable orphan', async () => {
    // Not configured, so it is cleaned up by the existing policy instead.
    setConfig({});
    listRenewalStems.mockReturnValue(['old']);
    parseCerts.mockResolvedValue({});

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(deleteCert).toHaveBeenCalledWith('old');
  });

  // A leftover from the historical issue-then-delete cycle is still cleaned up
  // as a stale lineage; it is never adopted as recovery material.
  it('still removes a historical <id>-0001 while restoring <id>', async () => {
    undiscoverableA();
    listRenewalStems.mockReturnValue(['A', 'A-0001']);
    validateBackupLineage.mockResolvedValue({ valid: true });
    restoreLineageFromBackup.mockReturnValue(transaction());
    const stale = { 'A-0001': lineage(['a.example.com']) };
    parseCerts
      .mockImplementationOnce(() => Promise.resolve(stale))
      .mockImplementation(() => Promise.resolve({ ...stale, A: lineage(['a.example.com']) }));

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('A-0001');
    expect(createCert).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  A healthy startup afterwards
// ──────────────────────────────────────────────
describe('once a lineage is healthy again', () => {
  it('does not attempt recovery or suppress issuance', async () => {
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });
    listRenewalStems.mockReturnValue(['A']);
    parseCerts.mockResolvedValue({ A: lineage(['a.example.com']) });

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(restoreLineageFromBackup).not.toHaveBeenCalled();
    expect(logged(warnSpy, /Issuance suppressed/)).toBe(false);
    // No longer protected, so its backup updates normally.
    expect(backupCertbotState).toHaveBeenCalledWith({ protectedLineages: [] });
  });
});
