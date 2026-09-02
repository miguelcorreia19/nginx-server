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
    // The real pruner too: this suite is about what CERTBOT_BACKUP does and
    // does not gate, and pruning is deliberately outside that gate. The same
    // goes for the stale-backup reconciliation that drives it on upgrade.
    pruneBackupLineage: actual.pruneBackupLineage,
    listBackupLineages: actual.listBackupLineages,
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
  // The backup write creates its own destination directory now, instead of the
  // handler doing it unconditionally on entry.
  mkdirSync: jest.fn(),
  existsSync: jest.fn(() => false),
}));

const fs = require('fs');
const { parseCerts, checkCertFiles, hasManagedCertbotState } = require('../letsencrypt/utils.js');
const { command, commandSafe } = require('../utils.js');
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

// The handler used to create CERTBOT_BACKUP_PATH unconditionally on entry, so
// every deployment that never backs anything up still ended up with an empty
// directory that looked like certificate backup state. It is now created by the
// backup write itself, and only then.
//
// That path is operator-supplied and still never reaches a shell — it now goes
// to fs.mkdirSync, which has no option parser for a leading "-" to fall into at
// all, so the `--` guard the old `mkdir -p --` needed is simply not applicable.
describe('backup directory creation — only when something is written', () => {
  const mkdirCalls = () => fs.mkdirSync.mock.calls;

  it('is not created merely because the handler ran', async () => {
    // It used to be, unconditionally, on entry — so an http-only or
    // custom-only deployment ended up with an empty CERTBOT_BACKUP_PATH that
    // only looked like certificate backup state.
    process.env.CERTBOT_BACKUP = 'false';
    withConfiguredSite();

    await letsencryptMode();

    expect(mkdirCalls()).toEqual([]);
    expect(backupWritten()).toBe(false);
  });

  it('is created when the backup is actually written', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    withConfiguredSite();

    await letsencryptMode();

    expect(mkdirCalls()).toEqual([['/home/letsencrypt', { recursive: true }]]);
    expect(backupWritten()).toBe(true);
  });

  it('creates the directory before copying into it', async () => {
    process.env.CERTBOT_BACKUP = 'true';
    withConfiguredSite();

    await letsencryptMode();

    expect(fs.mkdirSync).toHaveBeenCalled();
    // Scoped to the first *backup* copy: the handler's earlier `cp` calls are
    // the certificate export into /etc/ssl/certs, which has nothing to do with
    // the backup directory and legitimately runs before it.
    const firstBackupCopy = commandSafe.mock.calls.findIndex(isBackupCopy);
    expect(firstBackupCopy).toBeGreaterThan(-1);
    // mkdirSync is synchronous and runs first inside backupCertbotState, so the
    // copies cannot have gone into a directory that did not exist yet.
    expect(fs.mkdirSync.mock.invocationCallOrder[0])
      .toBeLessThan(commandSafe.mock.invocationCallOrder[firstBackupCopy]);
  });

  // The operator path still never reaches a shell — it just gets there through
  // a filesystem call now, which has no option parser to fall into at all.
  it.each([
    ['a path containing spaces', '/mnt/my backup dir'],
    ['shell metacharacters', '/mnt/a b;$(id)&&`x`'],
    ['a path beginning with a hyphen', '-mybackup'],
  ])('passes %s through literally', async (_label, backupPath) => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = backupPath;
    withConfiguredSite();

    await letsencryptMode();

    expect(mkdirCalls()).toEqual([[backupPath, { recursive: true }]]);
    // and nothing about it was ever handed to the shell helper
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining(backupPath));
  });
});
