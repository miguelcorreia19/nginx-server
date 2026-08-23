// restoreLineageFromBackup() / recoverInterruptedRestore() — crash-safe
// replacement of one Certbot lineage from an already-validated backup.
//
// The module is a filesystem primitive: it runs no Certbot command and decides
// nothing about whether a restore should happen (the handler does that — see
// restore-integration.test.js). So these tests are pure filesystem assertions
// on real temp trees — real renames, real symlinks, no mocked fs.
//
// The property under test is that no interruption can leave a half-restored
// lineage. Certbot enumerates through renewal/<id>.conf, so the transaction
// displaces that file first (making the lineage invisible for the whole
// sequence) and installs the replacement last (making that one rename the
// commit). Failure is injected only at those boundaries.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  restoreLineageFromBackup,
  recoverInterruptedRestore,
  recoverInterruptedRestores,
  rollbackLineageRestore,
} = require('../letsencrypt/restore_lineage.js');

let tmp, root, backup;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-lineage-'));
  root = path.join(tmp, 'letsencrypt');
  backup = path.join(tmp, 'backup');
  for (const dir of ['renewal', 'live', 'archive']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.mkdirSync(path.join(backup, dir), { recursive: true });
  }
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const opts = (extra = {}) => ({ letsencryptDir: root, backupPath: backup, ...extra });
const run = (id, extra = {}) => restoreLineageFromBackup(id, opts(extra));

// A Certbot-shaped lineage: archive holds the material, live holds relative
// symlinks into archive, renewal carries canonical absolute paths. `marker`
// makes each generation distinguishable.
const lineage = (where, id, marker, { renewalRoot = root } = {}) => {
  fs.mkdirSync(path.join(where, 'archive', id), { recursive: true });
  fs.mkdirSync(path.join(where, 'live', id), { recursive: true });
  fs.mkdirSync(path.join(where, 'renewal'), { recursive: true });
  for (const name of ['cert', 'privkey', 'chain', 'fullchain']) {
    fs.writeFileSync(path.join(where, 'archive', id, `${name}1.pem`), `${marker}-${name}\n`);
    fs.symlinkSync(`../../archive/${id}/${name}1.pem`, path.join(where, 'live', id, `${name}.pem`));
  }
  fs.writeFileSync(path.join(where, 'renewal', `${id}.conf`), [
    'version = 5.6.0',
    `archive_dir = ${renewalRoot}/archive/${id}`,
    `cert = ${renewalRoot}/live/${id}/cert.pem`,
    `privkey = ${renewalRoot}/live/${id}/privkey.pem`,
    `chain = ${renewalRoot}/live/${id}/chain.pem`,
    `fullchain = ${renewalRoot}/live/${id}/fullchain.pem`,
    '',
    '# a comment',
    '[renewalparams]',
    'authenticator = webroot',
    `server = https://acme-v02.api.letsencrypt.org/directory`,
    '',
  ].join('\n'));
};

const corrupt = (where, id) =>
  fs.writeFileSync(path.join(where, 'renewal', `${id}.conf`), '!!! not remotely valid ini !!!\n');

// A complete, comparable picture of one lineage: material, config, symlink
// targets, and the presence or absence of each part.
const snapshot = (where, id) => {
  const at = (...p) => path.join(where, ...p);
  const readDir = (dir) => {
    if (!fs.existsSync(dir)) return null;
    return fs.readdirSync(dir).sort().map((name) => {
      const full = path.join(dir, name);
      return fs.lstatSync(full).isSymbolicLink()
        ? `${name} -> ${fs.readlinkSync(full)}`
        : `${name}: ${fs.readFileSync(full, 'utf8')}`;
    });
  };
  return {
    renewal: fs.existsSync(at('renewal', `${id}.conf`)) ? fs.readFileSync(at('renewal', `${id}.conf`), 'utf8') : null,
    live: readDir(at('live', id)),
    archive: readDir(at('archive', id)),
  };
};

const txnDir = (id) => path.join(root, '.nginx-server-restore', id);
const transactionRoot = () => path.join(root, '.nginx-server-restore');
const materialOf = (id) => fs.readFileSync(path.join(root, 'archive', id, 'cert1.pem'), 'utf8');
const BOUNDARIES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];

// ──────────────────────────────────────────────
//  Success
// ──────────────────────────────────────────────
describe('a successful restore', () => {
  beforeEach(() => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
  });

  it('installs the backup material', () => {
    const result = run('A');

    expect(result.committed).toBe(true);
    expect(materialOf('A')).toBe('backed-up-cert\n');
  });

  it('installs the backup renewal config, replacing the corrupt one', () => {
    run('A');

    const restored = fs.readFileSync(path.join(root, 'renewal', 'A.conf'), 'utf8');
    expect(restored).toContain('[renewalparams]');
    expect(restored).not.toContain('not remotely valid');
    expect(restored).toBe(fs.readFileSync(path.join(backup, 'renewal', 'A.conf'), 'utf8'));
  });

  it('keeps the displaced original available until finalize', () => {
    const result = run('A');

    expect(fs.existsSync(path.join(txnDir('A'), 'displaced', 'renewal.conf'))).toBe(true);
    expect(fs.readFileSync(path.join(txnDir('A'), 'displaced', 'archive', 'cert1.pem'), 'utf8'))
      .toBe('old-cert\n');

    result.finalize();

    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });

  it('removes the shared transaction directory once it is empty', () => {
    run('A').finalize();

    expect(fs.existsSync(transactionRoot())).toBe(false);
  });

  it('leaves the backup byte-identical', () => {
    const before = snapshot(backup, 'A');

    run('A').finalize();

    expect(snapshot(backup, 'A')).toEqual(before);
  });
});

// ──────────────────────────────────────────────
//  Symlinks
// ──────────────────────────────────────────────
describe('symlink handling', () => {
  it('installs live entries as symlinks with their original relative targets', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');

    run('A').finalize();

    const link = path.join(root, 'live', 'A', 'cert.pem');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Absolute targets here would point back into the backup mount.
    expect(fs.readlinkSync(link)).toBe('../../archive/A/cert1.pem');
  });

  it('resolves live links to the newly installed archive', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');

    run('A').finalize();

    expect(fs.readFileSync(path.join(root, 'live', 'A', 'cert.pem'), 'utf8')).toBe('backed-up-cert\n');
  });
});

// ──────────────────────────────────────────────
//  Preconditions — nothing may be touched
// ──────────────────────────────────────────────
describe('preconditions reject before any live mutation', () => {
  const untouched = (before) => {
    expect(snapshot(root, 'A')).toEqual(before);
    expect(fs.existsSync(transactionRoot())).toBe(false);
  };

  it.each([
    ['renewal', () => fs.rmSync(path.join(backup, 'renewal', 'A.conf'))],
    ['live', () => fs.rmSync(path.join(backup, 'live', 'A'), { recursive: true })],
    ['archive', () => fs.rmSync(path.join(backup, 'archive', 'A'), { recursive: true })],
  ])('rejects a backup missing %s', (part, breakIt) => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    breakIt();
    const before = snapshot(root, 'A');

    expect(run('A')).toEqual({ committed: false, reason: `backup-${part}-missing` });
    untouched(before);
  });

  // A backup written some other way can carry paths into a temp directory or
  // another cert-name; restoring it byte-for-byte would install a config
  // pointing outside the tree.
  it('rejects a backup renewal config with non-canonical paths', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up', { renewalRoot: '/somewhere/else' });
    const before = snapshot(root, 'A');

    const result = run('A');

    expect(result).toEqual(expect.objectContaining({ committed: false, reason: 'non-canonical-backup-paths' }));
    untouched(before);
  });

  it('rejects a config whose paths name a different lineage', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    fs.writeFileSync(
      path.join(backup, 'renewal', 'A.conf'),
      fs.readFileSync(path.join(backup, 'renewal', 'A.conf'), 'utf8').replace(/archive\/A/, 'archive/B')
    );
    const before = snapshot(root, 'A');

    expect(run('A').reason).toBe('non-canonical-backup-paths');
    untouched(before);
  });

  it('rejects a config missing a path key entirely', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    fs.writeFileSync(
      path.join(backup, 'renewal', 'A.conf'),
      fs.readFileSync(path.join(backup, 'renewal', 'A.conf'), 'utf8').replace(/^chain = .*$/m, '')
    );

    expect(run('A').reason).toBe('non-canonical-backup-paths');
  });

  // The live renewal config is the commit marker, so a transaction is only
  // well-defined when there is one to displace.
  it('rejects when the live lineage has no renewal config', () => {
    lineage(root, 'A', 'old');
    fs.rmSync(path.join(root, 'renewal', 'A.conf'));
    lineage(backup, 'A', 'backed-up');

    expect(run('A')).toEqual({ committed: false, reason: 'live-renewal-missing' });
  });

  it('rejects when no backup path is configured', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');

    expect(restoreLineageFromBackup('A', { letsencryptDir: root, backupPath: undefined }))
      .toEqual({ committed: false, reason: 'no-backup-path' });
  });
});

// ──────────────────────────────────────────────
//  Rollback at every boundary
// ──────────────────────────────────────────────
describe('failure at any mutation boundary rolls back exactly', () => {
  it.each(BOUNDARIES)('restores the original after a failure at %s', (boundary) => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(root, 'A');

    expect(() => run('A', { failAfter: boundary })).toThrow(/rolled back/);

    expect(snapshot(root, 'A')).toEqual(before);
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });

  it('restores the corrupt renewal config byte-for-byte', () => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');

    expect(() => run('A', { failAfter: 'M5' })).toThrow();

    expect(fs.readFileSync(path.join(root, 'renewal', 'A.conf'), 'utf8'))
      .toBe('!!! not remotely valid ini !!!\n');
  });

  it('leaves the live lineage untouched when staging fails', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(root, 'A');

    expect(() => run('A', { failAfter: 'S' })).toThrow(/Could not stage/);

    expect(snapshot(root, 'A')).toEqual(before);
    expect(fs.existsSync(transactionRoot())).toBe(false);
  });

  it('rolls back a committed transaction when the caller rejects it', () => {
    // Post-commit rollback must stay possible, which is why finalize is the
    // caller's call rather than automatic.
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(root, 'A');

    const result = run('A');
    expect(result.committed).toBe(true);
    result.rollback();

    expect(snapshot(root, 'A')).toEqual(before);
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  Class B: parts that were absent to begin with
// ──────────────────────────────────────────────
describe('a lineage whose material was already missing', () => {
  // Rollback must restore absence, not manufacture a directory. Nothing records
  // that live/A was missing — staged/live still existing is what proves M5 never
  // ran, so the canonical path was never ours to remove.
  it.each(BOUNDARIES)('restores the missing live/<id> as missing after a failure at %s', (boundary) => {
    lineage(root, 'A', 'old');
    fs.rmSync(path.join(root, 'live', 'A'), { recursive: true });
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(root, 'A');
    expect(before.live).toBeNull();

    expect(() => run('A', { failAfter: boundary })).toThrow();

    expect(snapshot(root, 'A')).toEqual(before);
    expect(fs.existsSync(path.join(root, 'live', 'A'))).toBe(false);
  });

  it.each(BOUNDARIES)('restores a missing archive/<id> as missing after a failure at %s', (boundary) => {
    lineage(root, 'A', 'old');
    fs.rmSync(path.join(root, 'archive', 'A'), { recursive: true });
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(root, 'A');
    expect(before.archive).toBeNull();

    expect(() => run('A', { failAfter: boundary })).toThrow();

    expect(snapshot(root, 'A')).toEqual(before);
  });

  it('still restores successfully from a partially missing original', () => {
    lineage(root, 'A', 'old');
    fs.rmSync(path.join(root, 'live', 'A'), { recursive: true });
    lineage(backup, 'A', 'backed-up');

    const result = run('A');
    result.finalize();

    expect(result.committed).toBe(true);
    expect(materialOf('A')).toBe('backed-up-cert\n');
    expect(fs.readlinkSync(path.join(root, 'live', 'A', 'cert.pem'))).toBe('../../archive/A/cert1.pem');
  });
});

// ──────────────────────────────────────────────
//  Crash recovery
// ──────────────────────────────────────────────
describe('recovering an interrupted restore', () => {
  it.each(['S', 'M1', 'M2', 'M3', 'M4', 'M5'])('rolls back to the original after a crash at %s', (boundary) => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(root, 'A');

    // Reproduce the on-disk state a crash leaves: the transaction stops without
    // the rollback its own error handler would have run.
    stopWithoutRollback('A', boundary);

    const result = recoverInterruptedRestore('A', opts());

    expect(result.action).toBe(boundary === 'S' ? 'discarded' : 'rolled-back');
    expect(snapshot(root, 'A')).toEqual(before);
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });

  it('rolls forward after a crash at M6, keeping the restored lineage', () => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');

    stopWithoutRollback('A', 'M6');

    const result = recoverInterruptedRestore('A', opts());

    expect(result.action).toBe('rolled-forward');
    expect(materialOf('A')).toBe('backed-up-cert\n');
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });

  // M1 always produces displaced/renewal.conf, so this shape cannot come from
  // the transaction. Discarding it would strand the only copy of that material.
  it('refuses to guess at displaced material with no displaced renewal config', () => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    const stranded = path.join(txnDir('A'), 'displaced', 'archive');
    fs.mkdirSync(stranded, { recursive: true });
    fs.writeFileSync(path.join(stranded, 'cert1.pem'), 'irreplaceable\n');

    const result = recoverInterruptedRestore('A', opts());

    expect(result.action).toBe('unrecognised');
    expect(fs.readFileSync(path.join(stranded, 'cert1.pem'), 'utf8')).toBe('irreplaceable\n');
  });

  it('does nothing when there is no transaction directory', () => {
    expect(recoverInterruptedRestore('A', opts())).toEqual({ id: 'A', action: 'none' });
  });

  it.each(['S', 'M1', 'M3', 'M5', 'M6'])('is idempotent after a crash at %s', (boundary) => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');

    stopWithoutRollback('A', boundary);

    recoverInterruptedRestore('A', opts());
    const afterFirst = snapshot(root, 'A');

    expect(recoverInterruptedRestore('A', opts())).toEqual({ id: 'A', action: 'none' });
    expect(snapshot(root, 'A')).toEqual(afterFirst);
  });

  it('converges when recovery itself is interrupted', () => {
    lineage(root, 'A', 'old');
    corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(root, 'A');

    stopWithoutRollback('A', 'M5');

    // Interrupt recovery midway: the displaced originals are still in place but
    // the transaction directory has not been cleared.
    rollbackLineageRestore('A', opts());
    // Running the whole recovery again must be a no-op rather than a second
    // half-undo.
    expect(recoverInterruptedRestore('A', opts())).toEqual({ id: 'A', action: 'none' });
    expect(snapshot(root, 'A')).toEqual(before);
  });
});

// ──────────────────────────────────────────────
//  Several leftovers at once
// ──────────────────────────────────────────────
describe('recoverInterruptedRestores', () => {
  it('returns an empty list when nothing is pending', () => {
    expect(recoverInterruptedRestores(opts())).toEqual([]);
  });

  it('resolves each leftover independently', () => {
    for (const id of ['A', 'B']) {
      lineage(root, id, 'old');
      corrupt(root, id);
      lineage(backup, id, 'backed-up');
    }
    stopWithoutRollback('A', 'M3');   // uncommitted -> rolls back
    stopWithoutRollback('B', 'M6');   // committed   -> rolls forward

    const results = recoverInterruptedRestores(opts());

    expect(results).toEqual([
      { id: 'A', action: 'rolled-back' },
      { id: 'B', action: 'rolled-forward' },
    ]);
    expect(materialOf('A')).toBe('old-cert\n');
    expect(materialOf('B')).toBe('backed-up-cert\n');
  });

  // An unusable leftover is left in place rather than guessed at, and must not
  // stop the others being resolved.
  it('reports an unrecoverable leftover without disturbing the rest', () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A'); lineage(backup, 'A', 'backed-up');
    stopWithoutRollback('A', 'M3');
    // A directory that is not a transaction at all.
    fs.mkdirSync(path.join(transactionRoot(), 'junk'), { recursive: true });

    const results = recoverInterruptedRestores(opts());

    expect(results.find((r) => r.id === 'A').action).toBe('rolled-back');
    expect(materialOf('A')).toBe('old-cert\n');
  });
});

// ──────────────────────────────────────────────
//  Isolation
// ──────────────────────────────────────────────
describe('only the requested lineage is touched', () => {
  const withNeighbour = () => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    lineage(root, 'B', 'healthy');
    lineage(backup, 'B', 'healthy-backup');
    return { live: snapshot(root, 'B'), backup: snapshot(backup, 'B') };
  };

  it('leaves an unrelated lineage untouched on success', () => {
    const before = withNeighbour();

    run('A').finalize();

    expect(snapshot(root, 'B')).toEqual(before.live);
    expect(snapshot(backup, 'B')).toEqual(before.backup);
  });

  it.each(BOUNDARIES)('leaves an unrelated lineage untouched after a failure at %s', (boundary) => {
    const before = withNeighbour();

    expect(() => run('A', { failAfter: boundary })).toThrow();

    expect(snapshot(root, 'B')).toEqual(before.live);
    expect(snapshot(backup, 'B')).toEqual(before.backup);
  });

  it('leaves an unrelated lineage untouched through crash recovery', () => {
    const before = withNeighbour();

    stopWithoutRollback('A', 'M4');
    recoverInterruptedRestore('A', opts());

    expect(snapshot(root, 'B')).toEqual(before.live);
    expect(snapshot(backup, 'B')).toEqual(before.backup);
  });
});

// ──────────────────────────────────────────────
//  Backup immutability
// ──────────────────────────────────────────────
describe('the backup is never modified', () => {
  it.each([
    ['success', () => run('A').finalize()],
    ['rollback after commit', () => run('A').rollback()],
    ['failure at M3', () => { try { run('A', { failAfter: 'M3' }); } catch { /* expected */ } }],
    ['crash recovery', () => { stopWithoutRollback('A', 'M4'); recoverInterruptedRestore('A', opts()); }],
  ])('after %s', (_label, act) => {
    lineage(root, 'A', 'old'); corrupt(root, 'A');
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(backup, 'A');

    act();

    expect(snapshot(backup, 'A')).toEqual(before);
  });
});

// Reproduce the on-disk state a hard crash at `boundary` leaves behind: the
// transaction's own error handler rolls back, but a killed process does not, so
// the steps are replayed here directly against the same paths the module uses.
function stopWithoutRollback(id, boundary) {
  const txn = txnDir(id);
  const staged = (n) => path.join(txn, 'staged', n);
  const displaced = (n) => path.join(txn, 'displaced', n);
  const liveP = { archive: path.join(root, 'archive', id), live: path.join(root, 'live', id), renewal: path.join(root, 'renewal', `${id}.conf`) };
  const backupP = { archive: path.join(backup, 'archive', id), live: path.join(backup, 'live', id), renewal: path.join(backup, 'renewal', `${id}.conf`) };

  fs.mkdirSync(path.join(txn, 'staged'), { recursive: true });
  fs.mkdirSync(path.join(txn, 'displaced'), { recursive: true });
  fs.cpSync(backupP.archive, staged('archive'), { recursive: true, verbatimSymlinks: true });
  fs.cpSync(backupP.live, staged('live'), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(backupP.renewal, staged('renewal.conf'));
  if (boundary === 'S') return;

  fs.renameSync(liveP.renewal, displaced('renewal.conf'));                       if (boundary === 'M1') return;
  if (fs.existsSync(liveP.archive)) fs.renameSync(liveP.archive, displaced('archive'));  if (boundary === 'M2') return;
  fs.renameSync(staged('archive'), liveP.archive);                               if (boundary === 'M3') return;
  if (fs.existsSync(liveP.live)) fs.renameSync(liveP.live, displaced('live'));   if (boundary === 'M4') return;
  fs.renameSync(staged('live'), liveP.live);                                     if (boundary === 'M5') return;
  fs.renameSync(staged('renewal.conf'), liveP.renewal);
}
