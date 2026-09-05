// Stale-lineage pruning from the certificate backup.
//
// Removing a site from config.json deleted its live Certbot lineage but left
// the backup copy — renewal config, live/, archive/ and the private key — in
// place forever. Two consequences, both reproduced against the built image:
// the key of a decommissioned site was retained indefinitely, and re-adding
// the same cert-name later silently reinstalled that old certificate from the
// backup instead of obtaining a new one.
//
// Pruning is therefore part of the same cleanup that removes the live lineage,
// driven by the same notion of "obsolete" rather than by a second scan of the
// backup.
//
// These run against a real temp filesystem — the backup is the thing under
// test, so mocking fs would only prove the code calls itself. Only the
// external boundaries (certbot invocation, discovery) are stubbed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

// The real module, with only the parts that shell out to certbot replaced —
// pruneBackupLineage itself is the real implementation.
jest.mock('../letsencrypt/utils.js', () => {
  const actual = jest.requireActual('../letsencrypt/utils.js');
  return {
    ...actual,
    parseCerts: jest.fn(),
    hasManagedCertbotState: jest.fn(() => true),
    listRenewalStems: jest.fn(() => []),
    backupCertbotState: jest.fn(() => Promise.resolve()),
  };
});

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

jest.mock('../letsencrypt/bootstrap_lineage.js', () => ({
  recoverInterruptedBootstraps: jest.fn(() => []),
  bootstrapLineageFromBackup: jest.fn(),
}));

jest.mock('../letsencrypt/restore_lineage.js', () => ({
  recoverInterruptedRestores: jest.fn(() => []),
  restoreLineageFromBackup: jest.fn(),
}));

const {
  pruneBackupLineage,
  listBackupLineages,
  parseCerts,
  listRenewalStems,
  hasManagedCertbotState,
  backupCertbotState,
} = require('../letsencrypt/utils.js');
const { deleteCert, createCert } = require('../letsencrypt/manage_certs.js');
const { validateBackupLineage } = require('../letsencrypt/validate_backup.js');
const letsencryptMode = require('../letsencrypt/index.js');

let tmp;
let backup;
let logSpy;
let errorSpy;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-prune-'));
  backup = path.join(tmp, 'backup');
  process.env.CERTBOT_BACKUP_PATH = backup;
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  // letsencryptMode() unconditionally appends the renewal cron line to
  // /etc/crontabs/root once it reaches that point — a container-only absolute
  // path unrelated to backup pruning, the thing under test here. Every other
  // suite that drives the real letsencryptMode() stubs this same write (see
  // e.g. letsencrypt-lineage-cleanup.test.js); spying on just this one fs call
  // keeps the real fs used everywhere else, matching the file's other
  // targeted spies (rmSync, readdirSync) below.
  jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

// A backed-up lineage in the shape backupCertbotState produces: archive holds
// the real files (including the private key), live holds relative symlinks into
// it, and renewal/<id>.conf describes them.
const backedUpLineage = (root, id) => {
  fs.mkdirSync(path.join(root, 'archive', id), { recursive: true });
  fs.mkdirSync(path.join(root, 'live', id), { recursive: true });
  fs.mkdirSync(path.join(root, 'renewal'), { recursive: true });
  for (const kind of ['cert', 'privkey', 'chain', 'fullchain']) {
    fs.writeFileSync(path.join(root, 'archive', id, `${kind}1.pem`), `${id} ${kind} material\n`);
    fs.symlinkSync(`../../archive/${id}/${kind}1.pem`, path.join(root, 'live', id, `${kind}.pem`));
  }
  fs.writeFileSync(
    path.join(root, 'renewal', `${id}.conf`),
    `archive_dir = /etc/letsencrypt/archive/${id}\n[renewalparams]\n`
  );
};

// migrate_renewal.js's pre-rewrite copy, which backupCertbotState carries over
// with every other top-level directory.
const renewalBackupEntry = (root, id) => {
  fs.mkdirSync(path.join(root, 'renewal-backup'), { recursive: true });
  fs.writeFileSync(path.join(root, 'renewal-backup', `${id}.conf`), `authenticator = standalone\n`);
};

// Shared, non-lineage Certbot state that must survive any pruning.
const globalState = (root) => {
  fs.mkdirSync(path.join(root, 'accounts', 'acme-v02', 'directory', 'abc123'), { recursive: true });
  fs.writeFileSync(path.join(root, 'accounts', 'acme-v02', 'directory', 'abc123', 'private_key.json'), '{"kty":"RSA"}');
  fs.mkdirSync(path.join(root, 'renewal-hooks', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli.ini', ), 'server = https://acme-v02.api.letsencrypt.org/directory\n');
};

const lineagePresent = (root, id) => ({
  renewal: fs.existsSync(path.join(root, 'renewal', `${id}.conf`)),
  renewalBackup: fs.existsSync(path.join(root, 'renewal-backup', `${id}.conf`)),
  live: fs.existsSync(path.join(root, 'live', id)),
  archive: fs.existsSync(path.join(root, 'archive', id)),
});

const NOTHING = { renewal: false, renewalBackup: false, live: false, archive: false };

// Every file under `root` whose contents mention this lineage's key material.
// The acceptance criterion is about the key actually being gone, not about the
// four paths having been unlinked.
const keyMaterialFor = (root, id) => {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isSymbolicLink()) continue;
      let body = '';
      try { body = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      if (body.includes(`${id} privkey material`)) hits.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return hits;
};

const logged = (spy, re) => spy.mock.calls.some(([msg]) => re.test(String(msg)));

// ──────────────────────────────────────────────
//  pruneBackupLineage on its own
// ──────────────────────────────────────────────
describe('pruneBackupLineage', () => {
  it('removes every artifact the lineage owns', () => {
    backedUpLineage(backup, 'main');
    renewalBackupEntry(backup, 'main');

    const { pruned, reason } = pruneBackupLineage('main');

    expect(reason).toBe('pruned');
    expect(pruned).toHaveLength(4);
    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
  });

  it('leaves no private key material behind anywhere in the backup', () => {
    backedUpLineage(backup, 'main');
    expect(keyMaterialFor(backup, 'main')).not.toHaveLength(0);

    pruneBackupLineage('main');

    expect(keyMaterialFor(backup, 'main')).toEqual([]);
  });

  it('leaves other lineages completely untouched', () => {
    backedUpLineage(backup, 'main');
    backedUpLineage(backup, 'scripts');
    renewalBackupEntry(backup, 'scripts');

    pruneBackupLineage('main');

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
    expect(lineagePresent(backup, 'scripts')).toEqual({
      renewal: true, renewalBackup: true, live: true, archive: true,
    });
    expect(fs.readFileSync(path.join(backup, 'archive', 'scripts', 'privkey1.pem'), 'utf8'))
      .toBe('scripts privkey material\n');
  });

  it('leaves shared Certbot state untouched', () => {
    backedUpLineage(backup, 'main');
    globalState(backup);

    pruneBackupLineage('main');

    expect(fs.existsSync(path.join(backup, 'accounts', 'acme-v02', 'directory', 'abc123', 'private_key.json'))).toBe(true);
    expect(fs.existsSync(path.join(backup, 'renewal-hooks', 'deploy'))).toBe(true);
    expect(fs.existsSync(path.join(backup, 'cli.ini'))).toBe(true);
  });

  it.each(['main2', 'main-old', 'domain-main', 'mainx'])(
    'deleting "main" does not touch the similarly-named "%s"',
    (neighbour) => {
      backedUpLineage(backup, 'main');
      backedUpLineage(backup, neighbour);

      pruneBackupLineage('main');

      expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
      expect(lineagePresent(backup, neighbour)).toEqual({
        renewal: true, renewalBackup: false, live: true, archive: true,
      });
    }
  );

  it('creates nothing when no backup exists', () => {
    // A deployment that has never taken a backup has nothing stale to remove,
    // and pruning must not be what brings a backup tree into existence.
    expect(fs.existsSync(backup)).toBe(false);

    const { pruned, reason } = pruneBackupLineage('main');

    expect(reason).toBe('no-backup');
    expect(pruned).toEqual([]);
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('does nothing when no backup path is configured', () => {
    delete process.env.CERTBOT_BACKUP_PATH;
    expect(pruneBackupLineage('main')).toEqual({ pruned: [], reason: 'no-backup-path' });
  });

  it('reports nothing-to-prune for a backup that never held this lineage', () => {
    backedUpLineage(backup, 'scripts');
    expect(pruneBackupLineage('main')).toEqual({ pruned: [], reason: 'nothing-to-prune' });
  });

  it('removes a dangling live symlink rather than skipping it', () => {
    // A half-copied backup leaves live/<id> pointing at archive files that were
    // never copied. existsSync follows symlinks and would call that absent.
    fs.mkdirSync(path.join(backup, 'live'), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(backup, 'live', 'main'));

    const { pruned } = pruneBackupLineage('main');

    expect(pruned).toHaveLength(1);
    expect(fs.lstatSync(path.join(backup, 'live', 'main'), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('refuses a cert-name that is not a single safe path segment', () => {
    backedUpLineage(backup, 'main');
    for (const bad of ['../main', 'a/b', '..', '', '.hidden']) {
      expect(() => pruneBackupLineage(bad)).toThrow(/invalid/i);
    }
    // and nothing was removed on the way to refusing
    expect(lineagePresent(backup, 'main').archive).toBe(true);
  });

  it('honours an explicit backupPath override without consulting the environment', () => {
    const other = path.join(tmp, 'elsewhere');
    backedUpLineage(other, 'main');
    backedUpLineage(backup, 'main');

    pruneBackupLineage('main', { backupPath: other });

    expect(lineagePresent(other, 'main')).toEqual(NOTHING);
    expect(lineagePresent(backup, 'main').archive).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Pruning as part of startup cleanup
// ──────────────────────────────────────────────
describe('startup cleanup prunes the backup of removed sites', () => {
  it('prunes the backup of a discovered lineage that is no longer configured', async () => {
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };
    backedUpLineage(backup, 'main');
    backedUpLineage(backup, 'scripts');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
      scripts: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['scripts.example.com'], status: 'valid' },
    });

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('main');
    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
    expect(lineagePresent(backup, 'scripts').archive).toBe(true);
  });

  it('prunes the backup of an undiscoverable lineage that is no longer configured', async () => {
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };
    backedUpLineage(backup, 'main');
    listRenewalStems.mockReturnValue(['main', 'scripts']);
    parseCerts.mockResolvedValue({
      scripts: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['scripts.example.com'], status: 'valid' },
    });

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('main');
    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
  });

  it('still prunes when the removed site was the last Let\'s Encrypt site', async () => {
    // The zero-configured-sites path returns early. Pruning has to happen
    // before that return, or removing the final site leaves its key forever.
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
    });

    await letsencryptMode();

    expect(Object.keys(mockConfig)).toHaveLength(0);
    expect(deleteCert).toHaveBeenCalledWith('main');
    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
    expect(keyMaterialFor(backup, 'main')).toEqual([]);
  });

  it('keeps the existing zero-site cleanup summary intact', async () => {
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
    });

    await letsencryptMode();

    expect(logged(logSpy, /certificate cleanup completed$/)).toBe(true);
  });

  it('does not prune a lineage that is merely being reissued', async () => {
    // deleteCert is also used to recreate a still-configured certificate whose
    // files no longer satisfy its config. That lineage is not obsolete and its
    // backup must survive.
    mockConfig.main = { names: ['example.com'], mode: 'letsencrypt' };
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['stale.example.com'], status: 'valid' },
    });

    await letsencryptMode();

    expect(deleteCert).toHaveBeenCalledWith('main');
    expect(createCert).toHaveBeenCalledWith('main');
    expect(lineagePresent(backup, 'main').archive).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  CERTBOT_BACKUP gating
// ──────────────────────────────────────────────
describe('pruning is cleanup, not a backup write', () => {
  it('prunes an existing stale lineage even with CERTBOT_BACKUP=false', async () => {
    // A deployment may have taken backups, then disabled them, then removed a
    // site. Gating pruning on the write flag would keep that key forever.
    process.env.CERTBOT_BACKUP = 'false';
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
      scripts: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['scripts.example.com'], status: 'valid' },
    });

    await letsencryptMode();

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
  });

  it('still does not write a backup of the surviving lineage when disabled', async () => {
    process.env.CERTBOT_BACKUP = 'false';
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
      scripts: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['scripts.example.com'], status: 'valid' },
    });

    await letsencryptMode();

    expect(backupCertbotState).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
//  No silent resurrection
// ──────────────────────────────────────────────
describe('a removed site cannot be silently restored later', () => {
  it('leaves the backup unusable as recovery material for the removed name', async () => {
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
    });

    await letsencryptMode();

    // Re-added later. validateBackupLineage is the gate both the restore and
    // the bootstrap path consult, and it rejects structurally before it ever
    // runs certbot — so this is the real check, not a stand-in.
    mockConfig.main = { names: ['example.com'], mode: 'letsencrypt' };
    const verdict = await validateBackupLineage('main');

    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('backup-renewal-missing');
  });

  it('takes the ordinary issuance path on re-add instead of installing the old backup', async () => {
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
    });
    await letsencryptMode();

    // Second startup, site re-added, nothing left in Certbot state.
    jest.clearAllMocks();
    mockConfig.main = { names: ['example.com'], mode: 'letsencrypt' };
    process.env.CERTBOT_BACKUP = 'true';
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);

    await letsencryptMode();

    expect(logged(logSpy, /valid backup found/)).toBe(false);
    expect(logged(logSpy, /installed from the Certbot backup/)).toBe(false);
    expect(createCert).toHaveBeenCalledWith('main');
  });
});

// ──────────────────────────────────────────────
//  Failure handling
// ──────────────────────────────────────────────
describe('a pruning failure is reported, not swallowed', () => {
  const failOnce = () => {
    const real = fs.rmSync;
    jest.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, rm');
    }).mockImplementation((...args) => real.apply(fs, args));
  };

  it('logs the lineage, the failure and the backup path, and continues startup', async () => {
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };
    backedUpLineage(backup, 'main');
    backedUpLineage(backup, 'scripts');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
      scripts: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['scripts.example.com'], status: 'valid' },
    });
    failOnce();

    await expect(letsencryptMode()).resolves.not.toThrow();

    expect(logged(errorSpy, /Certificate main: backup cleanup failed/)).toBe(true);
    expect(logged(errorSpy, /EACCES/)).toBe(true);
    expect(logged(errorSpy, new RegExp(backup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBe(true);
    expect(logged(errorSpy, /retried on the next startup/)).toBe(true);
  });

  it('does not damage other lineages when one fails to prune', async () => {
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };
    backedUpLineage(backup, 'main');
    backedUpLineage(backup, 'scripts');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
      scripts: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['scripts.example.com'], status: 'valid' },
    });
    failOnce();

    await letsencryptMode();

    expect(lineagePresent(backup, 'scripts')).toEqual({
      renewal: true, renewalBackup: false, live: true, archive: true,
    });
  });

  it('reports the zero-site summary as incomplete when pruning failed', async () => {
    // Folded into the existing cleanup reporting rather than a new category.
    backedUpLineage(backup, 'main');
    parseCerts.mockResolvedValue({
      main: { cert_path: '/x', cert_key_path: '/y', cert_domains: ['example.com'], status: 'valid' },
    });
    failOnce();

    await letsencryptMode();

    expect(logged(console.warn, /certificate cleanup incomplete/)).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  The pruned backup stays usable
// ──────────────────────────────────────────────
describe('the remaining backup is still structurally sound', () => {
  it('leaves the surviving lineage complete and its symlinks intact', () => {
    backedUpLineage(backup, 'main');
    backedUpLineage(backup, 'scripts');

    pruneBackupLineage('main');

    const link = path.join(backup, 'live', 'scripts', 'privkey.pem');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Resolves, so it is not left dangling by the neighbour's removal.
    expect(fs.readFileSync(link, 'utf8')).toBe('scripts privkey material\n');
  });

  it('leaves behind no renewal config whose lineage was removed', () => {
    backedUpLineage(backup, 'main');
    renewalBackupEntry(backup, 'main');
    backedUpLineage(backup, 'scripts');

    pruneBackupLineage('main');

    const stems = fs.readdirSync(path.join(backup, 'renewal')).map((n) => n.replace(/\.conf$/, ''));
    for (const stem of stems) {
      expect(fs.existsSync(path.join(backup, 'live', stem))).toBe(true);
      expect(fs.existsSync(path.join(backup, 'archive', stem))).toBe(true);
    }
    expect(fs.readdirSync(path.join(backup, 'renewal-backup'))).toEqual([]);
  });

  it('still offers the surviving lineage to validation, and the pruned one not at all', async () => {
    // validateBackupLineage checks all three parts are present before it builds
    // a sandbox and asks certbot anything, so that structural gate is what this
    // asserts. Getting a full verdict for the survivor would need the real
    // certbot binary, which the suite does not have — the neighbouring tests
    // cover the structure itself.
    const { commandSafe } = require('../utils.js');
    backedUpLineage(backup, 'main');
    backedUpLineage(backup, 'scripts');

    pruneBackupLineage('main');

    mockConfig.main = { names: ['example.com'], mode: 'letsencrypt' };
    expect((await validateBackupLineage('main')).reason).toBe('backup-renewal-missing');
    expect(commandSafe).not.toHaveBeenCalled();

    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };
    await validateBackupLineage('scripts').catch(() => {});
    // It got past the structural gate and went on to build the sandbox.
    expect(commandSafe.mock.calls.some(([bin]) => bin === 'cp')).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  Legacy reconciliation: backups an older release left behind
// ──────────────────────────────────────────────
//
// Deletion-time pruning only ever sees sites removed from this version
// onwards. An installation upgrading from a release that did not prune carries
// backups whose live counterpart was deleted long ago — nothing deletes them
// now, so nothing prunes them, and re-adding one of those names would still
// reinstall the old certificate. These cover the first startup after such an
// upgrade, where there is usually no live Certbot state at all.

// An upgraded installation: a backup on disk, and nothing live to match it.
const legacyInstall = (...ids) => {
  for (const id of ids) backedUpLineage(backup, id);
  globalState(backup);
  parseCerts.mockResolvedValue({});
  listRenewalStems.mockReturnValue([]);
  // No renewal configs left, so startup would take the zero-state fast path.
  hasManagedCertbotState.mockReturnValue(false);
};

describe('listBackupLineages', () => {
  it('finds lineages across all four managed locations', () => {
    backedUpLineage(backup, 'main');
    renewalBackupEntry(backup, 'legacy');
    fs.mkdirSync(path.join(backup, 'archive', 'archived-only'), { recursive: true });
    fs.mkdirSync(path.join(backup, 'live', 'live-only'), { recursive: true });

    expect(listBackupLineages().lineages).toEqual(
      ['archived-only', 'legacy', 'live-only', 'main']
    );
  });

  it('ignores shared and non-lineage state', () => {
    backedUpLineage(backup, 'main');
    globalState(backup);

    expect(listBackupLineages().lineages).toEqual(['main']);
  });

  it('returns nothing when the backup path does not exist, and creates nothing', () => {
    expect(listBackupLineages()).toEqual({ lineages: [], unsafe: [] });
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('returns nothing when no backup path is configured', () => {
    delete process.env.CERTBOT_BACKUP_PATH;
    expect(listBackupLineages()).toEqual({ lineages: [], unsafe: [] });
  });

  it('reports an entry whose name is not a valid cert-id instead of claiming it', () => {
    backedUpLineage(backup, 'main');
    fs.mkdirSync(path.join(backup, 'archive', '.hidden-thing'), { recursive: true });
    fs.mkdirSync(path.join(backup, 'archive', '-weird'), { recursive: true });
    fs.writeFileSync(path.join(backup, 'renewal', 'not a cert id.conf'), 'x');

    const { lineages, unsafe } = listBackupLineages();

    expect(lineages).toEqual(['main']);
    expect(unsafe.map((u) => u.name).sort()).toEqual(['-weird', 'not a cert id.conf']);
    // Dotfiles are skipped outright, the same way the backup writer skips them.
    expect(unsafe.some((u) => u.name === '.hidden-thing')).toBe(false);
  });

  it('raises rather than reporting empty when a location cannot be read', () => {
    backedUpLineage(backup, 'main');
    jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    expect(() => listBackupLineages()).toThrow(/EACCES/);
  });
});

describe('upgrading from a release that did not prune', () => {
  it('removes a stale lineage with no live state and no configured sites', async () => {
    legacyInstall('main');

    await letsencryptMode();

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
    expect(keyMaterialFor(backup, 'main')).toEqual([]);
  });

  it('needs no Certbot invocation to find it', async () => {
    legacyInstall('main');

    await letsencryptMode();

    // The zero-state fast path is still taken; discovery was filesystem-only.
    expect(parseCerts).not.toHaveBeenCalled();
    expect(logged(logSpy, /No Let's Encrypt sites configured and no Certbot state to reconcile/)).toBe(true);
  });

  it('creates no backup tree when there was never a backup', async () => {
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);
    hasManagedCertbotState.mockReturnValue(false);
    expect(fs.existsSync(backup)).toBe(false);

    await letsencryptMode();

    expect(fs.existsSync(backup)).toBe(false);
  });

  it('keeps shared Certbot state', async () => {
    legacyInstall('main');

    await letsencryptMode();

    expect(fs.existsSync(path.join(backup, 'accounts', 'acme-v02', 'directory', 'abc123', 'private_key.json'))).toBe(true);
    expect(fs.existsSync(path.join(backup, 'renewal-hooks', 'deploy'))).toBe(true);
    expect(fs.existsSync(path.join(backup, 'cli.ini'))).toBe(true);
  });

  it('reconciles a mix, removing only what is no longer configured', async () => {
    legacyInstall('main', 'scripts');
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };

    await letsencryptMode();

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
    expect(lineagePresent(backup, 'scripts')).toEqual({
      renewal: true, renewalBackup: false, live: true, archive: true,
    });
  });

  it('keeps a configured lineage even with no live state and nothing issued yet', async () => {
    // "Not currently usable" is validateBackupLineage's call at restore time.
    // Still configured is the only question here.
    legacyInstall('main');
    mockConfig.main = { names: ['example.com'], mode: 'letsencrypt' };

    await letsencryptMode();

    expect(lineagePresent(backup, 'main').archive).toBe(true);
  });

  it('keeps a configured staging lineage — staging shares the cert-name identity', async () => {
    legacyInstall('main');
    mockConfig.main = { names: ['example.com'], mode: 'letsencrypt-staging' };

    await letsencryptMode();

    expect(lineagePresent(backup, 'main').archive).toBe(true);
  });

  it('prunes a lineage whose site is now http or custom', async () => {
    legacyInstall('main');
    mockConfig.main = { names: ['example.com'], mode: 'http' };

    await letsencryptMode();

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
  });

  it('does not resurrect the stale lineage when the site is re-added later', async () => {
    legacyInstall('main');
    await letsencryptMode();

    jest.clearAllMocks();
    mockConfig.main = { names: ['example.com'], mode: 'letsencrypt' };
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);
    hasManagedCertbotState.mockReturnValue(true);

    await letsencryptMode();

    expect(logged(logSpy, /valid backup found/)).toBe(false);
    expect(logged(logSpy, /installed from the Certbot backup/)).toBe(false);
    expect(createCert).toHaveBeenCalledWith('main');
  });
});

describe('upgrading — partially stale historical backups', () => {
  const seedPartial = (build) => {
    build();
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);
    hasManagedCertbotState.mockReturnValue(false);
  };

  it('removes a renewal config left on its own', async () => {
    seedPartial(() => {
      fs.mkdirSync(path.join(backup, 'renewal'), { recursive: true });
      fs.writeFileSync(path.join(backup, 'renewal', 'main.conf'), '[renewalparams]\n');
    });

    await letsencryptMode();

    expect(fs.existsSync(path.join(backup, 'renewal', 'main.conf'))).toBe(false);
  });

  it('removes live/ and archive/ left without a renewal config', async () => {
    // The old backup write was additive and non-atomic, so this shape is
    // exactly what an interrupted historical write leaves behind — and it is
    // the shape that still holds the private key.
    seedPartial(() => {
      fs.mkdirSync(path.join(backup, 'archive', 'main'), { recursive: true });
      fs.writeFileSync(path.join(backup, 'archive', 'main', 'privkey1.pem'), 'main privkey material\n');
      fs.mkdirSync(path.join(backup, 'live', 'main'), { recursive: true });
      fs.symlinkSync('../../archive/main/privkey1.pem', path.join(backup, 'live', 'main', 'privkey.pem'));
    });

    await letsencryptMode();

    expect(fs.existsSync(path.join(backup, 'live', 'main'))).toBe(false);
    expect(fs.existsSync(path.join(backup, 'archive', 'main'))).toBe(false);
    expect(keyMaterialFor(backup, 'main')).toEqual([]);
  });

  it('removes a renewal-backup entry left on its own', async () => {
    seedPartial(() => renewalBackupEntry(backup, 'main'));

    await letsencryptMode();

    expect(fs.existsSync(path.join(backup, 'renewal-backup', 'main.conf'))).toBe(false);
  });

  it('does not require the stale lineage to be a valid backup before removing it', async () => {
    seedPartial(() => {
      fs.mkdirSync(path.join(backup, 'archive', 'main'), { recursive: true });
      fs.writeFileSync(path.join(backup, 'archive', 'main', 'cert1.pem'), 'not a certificate at all\n');
      fs.mkdirSync(path.join(backup, 'live', 'main'), { recursive: true });
      fs.symlinkSync('../../archive/main/gone.pem', path.join(backup, 'live', 'main', 'cert.pem'));
    });

    await letsencryptMode();

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
  });

  it('still distinguishes similarly-named lineages', async () => {
    legacyInstall('main', 'main2', 'main-old', 'domain-main');
    mockConfig['main2'] = { names: ['a.example.com'], mode: 'letsencrypt' };
    mockConfig['main-old'] = { names: ['b.example.com'], mode: 'letsencrypt' };
    mockConfig['domain-main'] = { names: ['c.example.com'], mode: 'letsencrypt' };

    await letsencryptMode();

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
    for (const kept of ['main2', 'main-old', 'domain-main']) {
      expect(lineagePresent(backup, kept).archive).toBe(true);
    }
  });
});

describe('upgrading — CERTBOT_BACKUP=false', () => {
  it('still removes a stale lineage', async () => {
    process.env.CERTBOT_BACKUP = 'false';
    legacyInstall('main', 'scripts');
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };

    await letsencryptMode();

    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
  });

  it('keeps the configured lineage and writes no new backup', async () => {
    process.env.CERTBOT_BACKUP = 'false';
    legacyInstall('main', 'scripts');
    mockConfig.scripts = { names: ['scripts.example.com'], mode: 'letsencrypt' };

    await letsencryptMode();

    expect(lineagePresent(backup, 'scripts').archive).toBe(true);
    expect(backupCertbotState).not.toHaveBeenCalled();
  });

  it('creates no backup directory when none existed', async () => {
    process.env.CERTBOT_BACKUP = 'false';
    parseCerts.mockResolvedValue({});
    listRenewalStems.mockReturnValue([]);
    hasManagedCertbotState.mockReturnValue(false);

    await letsencryptMode();

    expect(fs.existsSync(backup)).toBe(false);
  });
});

describe('upgrading — failures are reported, not swallowed', () => {
  it('reports an unsafe entry and leaves it in place', async () => {
    legacyInstall('main');
    fs.mkdirSync(path.join(backup, 'archive', '-weird'), { recursive: true });

    await letsencryptMode();

    expect(logged(console.warn, /not a valid certificate name/)).toBe(true);
    expect(fs.existsSync(path.join(backup, 'archive', '-weird'))).toBe(true);
    // and the lineage it could account for was still cleaned up
    expect(lineagePresent(backup, 'main')).toEqual(NOTHING);
  });

  it('reports an unreadable backup without deleting anything on that evidence', async () => {
    legacyInstall('main');
    jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    await expect(letsencryptMode()).resolves.not.toThrow();

    expect(logged(errorSpy, /Could not read the certificate backup/)).toBe(true);
    expect(logged(console.warn, /stale certificate backup cleanup incomplete/)).toBe(true);
  });

  it('continues to the next stale lineage after one fails to prune', async () => {
    legacyInstall('main', 'other');
    const real = fs.rmSync;
    jest.spyOn(fs, 'rmSync')
      .mockImplementationOnce(() => { throw new Error('EACCES: permission denied, rm'); })
      .mockImplementation((...args) => real.apply(fs, args));

    await letsencryptMode();

    expect(logged(errorSpy, /backup cleanup failed/)).toBe(true);
    // The second stale lineage was still attempted and removed.
    expect(lineagePresent(backup, 'other')).toEqual(NOTHING);
  });
});
