// CERTBOT_BACKUP enablement, end to end through the Let's Encrypt handler.
//
// Environment values are strings, so a bare truthiness test treats the
// documented CERTBOT_BACKUP=false as enabled. The discovery-time restore path
// used to do exactly that while the two write paths tested `!== 'false'`, so
// `false` disabled writing the backup but still permitted restoring it.
//
// All the gates now share certbotBackupEnabled() (js/letsencrypt/utils.js).
// This file pins the *write* side of that contract on the real handler; the
// per-lineage recovery side is covered in restore-integration.test.js and
// bootstrap-integration.test.js, and the predicate itself in
// certbot-state.test.js.
//
// Mocking mirrors letsencrypt-lineage-cleanup.test.js.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../letsencrypt/utils.js', () => {
  // certbotBackupEnabled is the real implementation — it is the thing under
  // test here. Only its collaborators are stubbed.
  const actual = jest.requireActual('../letsencrypt/utils.js');
  return {
    parseCerts: jest.fn(),
    checkCertFiles: jest.fn(),
    hasManagedCertbotState: jest.fn(),
    certbotBackupEnabled: actual.certbotBackupEnabled,
    // The real writer, so these assertions still check the command actually
    // issued. Its `command` dependency resolves to the mock below.
    backupCertbotState: actual.backupCertbotState,
    listRenewalStems: jest.fn(() => []),
    renewalConfigPath: actual.renewalConfigPath,
  };
});

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

// appendFileSync: the renewal cron line. readdirSync: the real
// backupCertbotState now enumerates /etc/letsencrypt's top-level entries in
// Node — that enumeration replaced the shell glob in the old
// `cp -rf /etc/letsencrypt/* <backup>` — so it must answer with a
// Certbot-shaped listing here.
jest.mock('fs', () => ({
  appendFileSync: jest.fn(),
  readdirSync: jest.fn(() => ['accounts', 'archive', 'live', 'renewal']),
}));

const { parseCerts, checkCertFiles, hasManagedCertbotState } = require('../letsencrypt/utils.js');
const { commandSafe } = require('../utils.js');
const letsencryptMode = require('../letsencrypt/index.js');

const ENV_KEYS = ['CERTBOT_BACKUP', 'CERTBOT_BACKUP_PATH'];
const savedEnv = {};

// The bulk copy is no longer a shell string: the unprotected backup path issues
// one `cp -rf <entry> <backupPath>` execFile per top-level /etc/letsencrypt
// entry. Matched on that exact shape so the handler's *other* `cp` calls — the
// certificate export into /etc/ssl/certs — can never be mistaken for a backup.
const isBackupCopy = ([bin, args = []]) =>
  bin === 'cp'
  && args.includes('-rf')
  && String(args[2] || '').startsWith('/etc/letsencrypt/');

const backupWritten = () => commandSafe.mock.calls.some(isBackupCopy);

const backupDestinations = () =>
  commandSafe.mock.calls.filter(isBackupCopy).map(([, args]) => args[args.length - 1]);

// One configured site with a matching lineage, so the handler runs its full
// workflow and reaches the backup step.
const withConfiguredSite = () => {
  parseCerts.mockResolvedValue({
    A: {
      cert_path: '/etc/letsencrypt/live/A/fullchain.pem',
      cert_key_path: '/etc/letsencrypt/live/A/privkey.pem',
      cert_domains: ['a.example.com'],
      status: 'valid',
    },
  });
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, { A: { mode: 'letsencrypt', names: ['a.example.com'] } });
};

beforeEach(() => {
  jest.clearAllMocks();
  checkCertFiles.mockReturnValue(true);
  hasManagedCertbotState.mockReturnValue(true);
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CERTBOT_BACKUP_PATH = '/home/letsencrypt';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe('backup write gate — honours the shared enablement predicate', () => {
  it('writes the backup when CERTBOT_BACKUP=true', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(true);
  });

  it('does not write the backup when CERTBOT_BACKUP is the string "false"', async () => {
    process.env.CERTBOT_BACKUP = 'false';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(false);
  });

  it('does not write the backup when CERTBOT_BACKUP is unset', async () => {
    delete process.env.CERTBOT_BACKUP;
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(false);
  });

  it('does not write the backup for the empty string', async () => {
    process.env.CERTBOT_BACKUP = '';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(false);
  });

  it('writes the backup for any other non-empty value', async () => {
    process.env.CERTBOT_BACKUP = '1';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupWritten()).toBe(true);
  });

  it('leaves the destination path untouched — only enablement changed', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = '/mnt/backup';
    withConfiguredSite();

    await letsencryptMode();

    expect(backupDestinations()).not.toHaveLength(0);
    for (const destination of backupDestinations()) {
      expect(destination).toBe('/mnt/backup');
    }
  });
});

// The handler creates CERTBOT_BACKUP_PATH before doing anything else. That path
// is operator-supplied, so it is created with an argument vector rather than
// interpolated into `mkdir -p <path>` as a shell string — a backup directory
// containing a space used to be created as two separate directories.
//
// The vector ends its options with `--` as well: execFile removes the shell,
// not mkdir's own argv parsing, and this path is not validated anywhere.
describe('backup directory creation — operator path never reaches a shell', () => {
  const mkdirCalls = () => commandSafe.mock.calls.filter(([bin]) => bin === 'mkdir');

  it('creates the backup path with mkdir -p as separate arguments', async () => {
    withConfiguredSite();

    await letsencryptMode();

    expect(mkdirCalls()).toEqual([['mkdir', ['-p', '--', '/home/letsencrypt']]]);
  });

  it('passes a path containing spaces as one literal argument', async () => {
    process.env.CERTBOT_BACKUP_PATH = '/mnt/my backup dir';
    withConfiguredSite();

    await letsencryptMode();

    expect(mkdirCalls()).toEqual([['mkdir', ['-p', '--', '/mnt/my backup dir']]]);
  });

  it('passes shell metacharacters through literally', async () => {
    process.env.CERTBOT_BACKUP_PATH = '/mnt/a b;$(id)&&`x`';
    withConfiguredSite();

    await letsencryptMode();

    expect(mkdirCalls()).toEqual([['mkdir', ['-p', '--', '/mnt/a b;$(id)&&`x`']]]);
  });

  it('keeps a path beginning with a hyphen behind the end-of-options marker', async () => {
    // BusyBox 1.37.0 in the pinned runtime reads `-mybackup` as `-m ybackup`
    // and fails with `mkdir: invalid mode 'ybackup'`.
    process.env.CERTBOT_BACKUP_PATH = '-mybackup';
    withConfiguredSite();

    await letsencryptMode();

    expect(mkdirCalls()).toEqual([['mkdir', ['-p', '--', '-mybackup']]]);
  });

  it('runs the directory creation before any backup copy', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    withConfiguredSite();

    await letsencryptMode();

    const bins = commandSafe.mock.calls.map(([bin]) => bin);
    expect(bins.indexOf('mkdir')).toBe(0);
    expect(backupWritten()).toBe(true);
  });
});
