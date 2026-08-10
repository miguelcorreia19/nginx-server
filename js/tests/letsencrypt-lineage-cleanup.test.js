// Let's Encrypt managed-lineage lifecycle.
//
// config.json is the source of truth for the Certbot lineages this project
// manages: a lineage with no matching letsencrypt/letsencrypt-staging entry is
// deleted. That reconciliation used to be unreachable when the configured LE
// set became empty, because the handler returned before it — so removing one
// of two sites deleted its lineage, but removing the *last* site kept it
// forever. The zero-entry return now sits after the cleanup instead.
//
// Everything past that return needs actual current entries (issuance, export,
// site generation, cron), so a zero-entry startup must still do none of it.
//
// A zero-entry startup only reaches that reconciliation when there is Certbot
// state to reconcile; with none at all it returns before `parseCerts` (see the
// final describe block).
//
// Mocking mirrors letsencrypt-default-vhost.test.js.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../letsencrypt/utils.js', () => ({
  parseCerts: jest.fn(),
  checkCertFiles: jest.fn(),
  hasManagedCertbotState: jest.fn(),
  certbotBackupEnabled: jest.fn(() => false),
  listRenewalStems: jest.fn(() => []),
  renewalConfigPath: jest.fn((stem) => `/etc/letsencrypt/renewal/${stem}.conf`),
  backupCertbotState: jest.fn(() => Promise.resolve()),
}));

jest.mock('../letsencrypt/bootstrap_lineage.js', () => ({
  recoverInterruptedBootstraps: jest.fn(() => []),
  bootstrapLineageFromBackup: jest.fn(),
}));

jest.mock('../letsencrypt/restore_lineage.js', () => ({
  recoverInterruptedRestores: jest.fn(() => []),
  restoreLineageFromBackup: jest.fn(),
}));

jest.mock('../letsencrypt/validate_backup.js', () => ({
  validateBackupLineage: jest.fn(),
}));

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve()),
  commandSafe: jest.fn(() => Promise.resolve()),
  configFiles: jest.fn(() => Promise.resolve()),
}));

jest.mock('../letsencrypt/manage_certs.js', () => ({
  createCert: jest.fn(() => Promise.resolve(true)),
  deleteCert: jest.fn(() => Promise.resolve(true)),
  createConf: jest.fn(() => Promise.resolve()),
}));

// index.js classifies each desired site's cert-name slot through
// lineage_files.js (exists() -> existsSync/lstatSync), so those have to be
// mocked too. Nothing exists by default: this suite is about lineages Certbot
// enumerates, not about local residue.
jest.mock('fs', () => ({
  appendFileSync: jest.fn(),
  existsSync: jest.fn(() => false),
  lstatSync: jest.fn(() => undefined),
}));

const {
  parseCerts, checkCertFiles, hasManagedCertbotState, certbotBackupEnabled, backupCertbotState,
} = require('../letsencrypt/utils.js');
const { validateBackupLineage } = require('../letsencrypt/validate_backup.js');
const { restoreLineageFromBackup } = require('../letsencrypt/restore_lineage.js');
const { bootstrapLineageFromBackup } = require('../letsencrypt/bootstrap_lineage.js');
const { command, commandSafe, configFiles } = require('../utils.js');
const { createCert, deleteCert, createConf } = require('../letsencrypt/manage_certs.js');
const letsencryptMode = require('../letsencrypt/index.js');

const setConfig = (entries) => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, entries);
};

const lineage = (id, domains) => ({
  cert_path: `/etc/letsencrypt/live/${id}/fullchain.pem`,
  cert_key_path: `/etc/letsencrypt/live/${id}/privkey.pem`,
  cert_domains: domains,
  status: 'valid',
});

const shellCommands = () => command.mock.calls.map((call) => call[0]);
const crondStarted = () => shellCommands().some((c) => typeof c === 'string' && c.includes('crond'));

beforeEach(() => {
  jest.clearAllMocks();
  checkCertFiles.mockReturnValue(true);
  // These suites are about the reconciliation path itself, so they represent a
  // container that HAS managed Certbot state (a renewal config on disk). The
  // zero-state fast path that skips discovery entirely is covered separately,
  // in its own describe block at the bottom of this file.
  hasManagedCertbotState.mockReturnValue(true);
  // jest.clearAllMocks() clears recorded calls but keeps implementations, so
  // these are re-established every run rather than relying on the factory
  // defaults surviving whatever the previous test installed. The verdict is a
  // real object because validateBackupLineage never resolves undefined.
  certbotBackupEnabled.mockReturnValue(false);
  validateBackupLineage.mockResolvedValue({ valid: false, reason: 'backup-renewal-missing' });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ──────────────────────────────────────────────
//  Zero configured entries still reconcile lineages
// ──────────────────────────────────────────────
describe('letsencrypt handler — zero configured entries, an orphaned lineage exists', () => {
  const withOrphanAndNoConfig = () => {
    parseCerts.mockResolvedValue({ A: lineage('A', ['a.example.com']) });
    setConfig({});
  };

  it('discovers installed lineages instead of returning immediately', async () => {
    withOrphanAndNoConfig();

    await letsencryptMode();

    expect(parseCerts).toHaveBeenCalled();
  });

  it('deletes the orphaned lineage through the existing deleteCert path', async () => {
    withOrphanAndNoConfig();

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('A');
    expect(deleteCert).toHaveBeenCalledTimes(1);
  });

  it('issues nothing', async () => {
    withOrphanAndNoConfig();

    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
  });

  it('generates no site configuration, fragments or redirects', async () => {
    withOrphanAndNoConfig();

    await letsencryptMode();

    expect(createConf).not.toHaveBeenCalled();
    expect(configFiles).not.toHaveBeenCalled();
    // No certificate export either. The handler's one unconditional shell-out
    // is the CERTBOT_BACKUP_PATH `mkdir` it opens with, which has always run
    // ahead of everything here — it only moved from `command` to `commandSafe`
    // when that operator path stopped being interpolated into a shell string.
    // Asserted as the complete list, so any *other* call still fails this.
    expect(commandSafe.mock.calls.map(([bin]) => bin)).toEqual(['mkdir']);
  });

  it('does not start crond', async () => {
    withOrphanAndNoConfig();

    await letsencryptMode();

    expect(crondStarted()).toBe(false);
  });

  it('does not touch /etc/nginx/conf.d — nginx state is owned by production startup', async () => {
    withOrphanAndNoConfig();

    await letsencryptMode();

    for (const cmd of shellCommands()) {
      expect(String(cmd)).not.toContain('/etc/nginx/conf.d');
    }
  });

  it('deletes an orphaned lineage whose id is now a non-LE (custom) site', async () => {
    // The mode filter drops non-LE entries from `certs`, so a site that
    // switched away from Let's Encrypt no longer has a managed lineage.
    parseCerts.mockResolvedValue({ A: lineage('A', ['a.example.com']) });
    setConfig({ A: { mode: 'custom', names: ['a.example.com'], cert_file: 'a.crt', privkey_file: 'a.key' } });

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('A');
    expect(createCert).not.toHaveBeenCalled();
    expect(crondStarted()).toBe(false);
  });
});

describe('letsencrypt handler — zero configured entries, nothing installed', () => {
  beforeEach(() => {
    parseCerts.mockResolvedValue({});
    setConfig({});
  });

  it('attempts no deletion', async () => {
    await letsencryptMode();
    expect(deleteCert).not.toHaveBeenCalled();
  });

  it('issues nothing and starts no cron', async () => {
    await letsencryptMode();

    expect(createCert).not.toHaveBeenCalled();
    expect(crondStarted()).toBe(false);
  });

  it('resolves cleanly', async () => {
    await expect(letsencryptMode()).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────
//  Non-empty behaviour must be unchanged
// ──────────────────────────────────────────────
describe('letsencrypt handler — partial removal still reconciles (regression)', () => {
  it('deletes A and keeps B when only B remains configured', async () => {
    parseCerts.mockResolvedValue({
      A: lineage('A', ['a.example.com']),
      B: lineage('B', ['b.example.com']),
    });
    setConfig({ B: { mode: 'letsencrypt', names: ['b.example.com'] } });

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('A');
    expect(deleteCert).not.toHaveBeenCalledWith('B');
    // The non-empty workflow continues past the cleanup.
    expect(configFiles).toHaveBeenCalledWith('B', 'valid', undefined, ['b.example.com']);
    expect(crondStarted()).toBe(true);
  });

  it('deletes nothing when every installed lineage is still configured', async () => {
    parseCerts.mockResolvedValue({ A: lineage('A', ['a.example.com']) });
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });

    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalled();
    expect(configFiles).toHaveBeenCalledWith('A', 'valid', undefined, ['a.example.com']);
    expect(crondStarted()).toBe(true);
  });
});

describe('letsencrypt handler — staging entries are part of the managed set', () => {
  it('keeps a configured letsencrypt-staging lineage', async () => {
    parseCerts.mockResolvedValue({ S: lineage('S', ['s.example.com']) });
    setConfig({ S: { mode: 'letsencrypt-staging', names: ['s.example.com'] } });

    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalled();
    expect(crondStarted()).toBe(true);
  });

  it('deletes a staging lineage once its entry is removed entirely', async () => {
    parseCerts.mockResolvedValue({ S: lineage('S', ['s.example.com']) });
    setConfig({});

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('S');
    expect(crondStarted()).toBe(false);
  });

  it('deletes only the removed one of a mixed staging + production pair', async () => {
    parseCerts.mockResolvedValue({
      S: lineage('S', ['s.example.com']),
      P: lineage('P', ['p.example.com']),
    });
    setConfig({ P: { mode: 'letsencrypt', names: ['p.example.com'] } });

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('S');
    expect(deleteCert).not.toHaveBeenCalledWith('P');
  });
});

// ──────────────────────────────────────────────
//  Ordering: cleanup happens before the zero-entry return
// ──────────────────────────────────────────────
describe('letsencrypt handler — the zero-entry return sits after orphan cleanup', () => {
  it('deletes the orphan before stopping, and stops before issuance/generation/cron', async () => {
    parseCerts.mockResolvedValue({ A: lineage('A', ['a.example.com']) });
    setConfig({});

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledTimes(1);

    // Discovery ran before the deletion...
    expect(parseCerts.mock.invocationCallOrder[0])
      .toBeLessThan(deleteCert.mock.invocationCallOrder[0]);

    // ...and the handler stopped right after it: none of the phases that need
    // actual current entries were reached.
    expect(createCert).not.toHaveBeenCalled();
    expect(createConf).not.toHaveBeenCalled();
    expect(configFiles).not.toHaveBeenCalled();
    expect(crondStarted()).toBe(false);
    // parseCerts is called a second time only in the non-empty workflow.
    expect(parseCerts).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────
//  Failure policy is the pre-existing one
// ──────────────────────────────────────────────
describe('letsencrypt handler — deletion failure keeps its existing (non-fatal) contract', () => {
  it('logs an error and continues when deleteCert reports failure', async () => {
    parseCerts.mockResolvedValue({ A: lineage('A', ['a.example.com']) });
    deleteCert.mockResolvedValue(false);
    setConfig({});

    // deleteCert swallows the certbot error and returns false; the handler
    // logs it via error() and does not abort startup. Unchanged by this task.
    await expect(letsencryptMode()).resolves.toBeUndefined();

    expect(deleteCert).toHaveBeenCalledWith('A');
    expect(console.error).toHaveBeenCalled();
  });

  it('still propagates a certificate-discovery failure', async () => {
    parseCerts.mockRejectedValue(new Error('Failed to query certbot certificates'));
    setConfig({});

    await expect(letsencryptMode()).rejects.toBeDefined();
  });
});

// ──────────────────────────────────────────────
//  Zero-state fast path: nothing configured, nothing installed
// ──────────────────────────────────────────────
describe('letsencrypt handler — skips Certbot entirely when there is no state to reconcile', () => {
  beforeEach(() => {
    // No configured entries AND no local renewal config / applicable backup.
    setConfig({});
    hasManagedCertbotState.mockReturnValue(false);
  });

  it('never invokes certificate discovery', async () => {
    await letsencryptMode();

    // The whole point: an http/custom-only deployment must not depend on
    // `certbot certificates` succeeding just to learn it has nothing to do.
    expect(parseCerts).not.toHaveBeenCalled();
  });

  it('deletes nothing and issues nothing', async () => {
    await letsencryptMode();

    expect(deleteCert).not.toHaveBeenCalled();
    expect(createCert).not.toHaveBeenCalled();
  });

  it('generates no configuration, exports nothing and starts no cron', async () => {
    await letsencryptMode();

    expect(createConf).not.toHaveBeenCalled();
    expect(configFiles).not.toHaveBeenCalled();
    // As above: only the backup-directory `mkdir` the handler opens with.
    expect(commandSafe.mock.calls.map(([bin]) => bin)).toEqual(['mkdir']);
    expect(crondStarted()).toBe(false);
  });

  it('resolves cleanly', async () => {
    await expect(letsencryptMode()).resolves.toBeUndefined();
  });

  it('still runs discovery when Certbot state is present (renewal config on disk)', async () => {
    hasManagedCertbotState.mockReturnValue(true);
    parseCerts.mockResolvedValue({ A: lineage('A', ['a.example.com']) });

    await letsencryptMode();

    expect(parseCerts).toHaveBeenCalled();
    expect(deleteCert).toHaveBeenCalledWith('A');
  });
});

// ──────────────────────────────────────────────
//  Why a backup alone is not a reason to take the slow path
// ──────────────────────────────────────────────
describe('letsencrypt handler — with zero configured entries the backup is never reached', () => {
  // The handler returns as soon as cleanup is done when no letsencrypt/
  // letsencrypt-staging entry is left, and every backup interaction — reading
  // one for recovery, writing one — sits after that return. So a populated
  // backup cannot be restored, updated or discarded on this path, which is why
  // hasManagedCertbotState() no longer counts one as managed state.
  beforeEach(() => {
    setConfig({});
    hasManagedCertbotState.mockReturnValue(true);
    certbotBackupEnabled.mockReturnValue(true);
  });

  it('never validates or installs a backup', async () => {
    parseCerts.mockResolvedValue({});

    await letsencryptMode();

    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(restoreLineageFromBackup).not.toHaveBeenCalled();
    expect(bootstrapLineageFromBackup).not.toHaveBeenCalled();
  });

  it('never writes the backup, so an existing one is left exactly as it was', async () => {
    parseCerts.mockResolvedValue({});

    await letsencryptMode();

    expect(backupCertbotState).not.toHaveBeenCalled();
  });

  it('leaves the backup alone even while cleaning up a discovered orphan', async () => {
    parseCerts.mockResolvedValue({ A: lineage('A', ['a.example.com']) });

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('A');
    expect(backupCertbotState).not.toHaveBeenCalled();
    expect(validateBackupLineage).not.toHaveBeenCalled();
    expect(crondStarted()).toBe(false);
  });
});

describe('letsencrypt handler — the fast path requires zero configured entries', () => {
  it('never skips when a letsencrypt entry is configured, even with no local state', async () => {
    hasManagedCertbotState.mockReturnValue(false);
    parseCerts.mockResolvedValue({});
    setConfig({ A: { mode: 'letsencrypt', names: ['a.example.com'] } });

    await letsencryptMode();

    expect(parseCerts).toHaveBeenCalled();
    expect(createCert).toHaveBeenCalledWith('A');
  });

  it('never skips when a letsencrypt-staging entry is configured', async () => {
    hasManagedCertbotState.mockReturnValue(false);
    parseCerts.mockResolvedValue({});
    setConfig({ S: { mode: 'letsencrypt-staging', names: ['s.example.com'] } });

    await letsencryptMode();

    expect(parseCerts).toHaveBeenCalled();
    expect(createCert).toHaveBeenCalledWith('S');
  });

  it('does skip when the only entries are non-LE modes', async () => {
    hasManagedCertbotState.mockReturnValue(false);
    setConfig({
      A: { mode: 'http', names: ['a.example.com'] },
      B: { mode: 'custom', names: ['b.example.com'], cert_file: 'b.crt', privkey_file: 'b.key' },
    });

    await letsencryptMode();

    expect(parseCerts).not.toHaveBeenCalled();
  });
});
