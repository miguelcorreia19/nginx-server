// bootstrapLineageFromBackup() — installing a validated backup lineage into an
// empty cert-name slot, crash-safely.
//
// This is the counterpart to restore-lineage.test.js, not a variation of it.
// The replacement transaction displaces an existing renewal config and proves a
// transaction started by its presence under displaced/; bootstrap has no
// original to displace, so it gets its own namespace and its own recovery rule.
// What the two share is the commit model: material first, renewal config last,
// so a single rename decides visibility.
//
// Real temp trees, real renames, real symlinks — no mocked fs. Failure is
// injected only at mutation boundaries.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  bootstrapLineageFromBackup,
  recoverInterruptedBootstrap,
  recoverInterruptedBootstraps,
  rollbackLineageBootstrap,
} = require('../letsencrypt/bootstrap_lineage.js');

let tmp, root, backup;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lineage-'));
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
const run = (id, extra = {}) => bootstrapLineageFromBackup(id, opts(extra));

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
    '',
  ].join('\n'));
};

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

const ABSENT = { renewal: null, live: null, archive: null };
const txnDir = (id) => path.join(root, '.nginx-server-bootstrap', id);
const BOUNDARIES = ['B1', 'B2', 'B3'];

// Reproduce the on-disk state a hard crash at `boundary` leaves: a killed
// process does not run the transaction's own rollback.
function stopWithoutRollback(id, boundary) {
  const txn = txnDir(id);
  const staged = (n) => path.join(txn, 'staged', n);
  const live = { archive: path.join(root, 'archive', id), live: path.join(root, 'live', id), renewal: path.join(root, 'renewal', `${id}.conf`) };
  const from = { archive: path.join(backup, 'archive', id), live: path.join(backup, 'live', id), renewal: path.join(backup, 'renewal', `${id}.conf`) };

  fs.mkdirSync(path.join(txn, 'staged'), { recursive: true });
  fs.cpSync(from.archive, staged('archive'), { recursive: true, verbatimSymlinks: true });
  fs.cpSync(from.live, staged('live'), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(from.renewal, staged('renewal.conf'));
  if (boundary === 'S') return;

  fs.renameSync(staged('archive'), live.archive);      if (boundary === 'B1') return;
  fs.renameSync(staged('live'), live.live);            if (boundary === 'B2') return;
  fs.renameSync(staged('renewal.conf'), live.renewal);
}

// ──────────────────────────────────────────────
//  Success
// ──────────────────────────────────────────────
describe('installing into an empty slot', () => {
  beforeEach(() => lineage(backup, 'A', 'backed-up'));

  it('installs the backup material and config', () => {
    const result = run('A');

    expect(result.committed).toBe(true);
    expect(fs.readFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'utf8')).toBe('backed-up-cert\n');
    expect(fs.readFileSync(path.join(root, 'renewal', 'A.conf'), 'utf8'))
      .toBe(fs.readFileSync(path.join(backup, 'renewal', 'A.conf'), 'utf8'));
  });

  it('keeps live entries as relative symlinks into the installed archive', () => {
    run('A').finalize();

    const link = path.join(root, 'live', 'A', 'cert.pem');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Absolute targets here would point back into the backup mount.
    expect(fs.readlinkSync(link)).toBe('../../archive/A/cert1.pem');
    expect(fs.readFileSync(link, 'utf8')).toBe('backed-up-cert\n');
  });

  it('finalize removes the transaction state and its shared parent', () => {
    const result = run('A');
    expect(fs.existsSync(txnDir('A'))).toBe(true);

    result.finalize();

    expect(fs.existsSync(txnDir('A'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.nginx-server-bootstrap'))).toBe(false);
  });

  it('uses a namespace distinct from the replacement transaction', () => {
    // The two recovery rules assign different meanings to their directory
    // shapes, so they must never share one.
    run('A');

    expect(fs.existsSync(path.join(root, '.nginx-server-bootstrap', 'A'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.nginx-server-restore'))).toBe(false);
  });

  // The intended case is a container that has never run Certbot, where
  // /etc/letsencrypt does not exist yet — the fresh image ships without it.
  it('creates the Certbot directories when the tree does not exist at all', () => {
    fs.rmSync(root, { recursive: true, force: true });

    const result = run('A');

    expect(result.committed).toBe(true);
    expect(fs.readFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'utf8')).toBe('backed-up-cert\n');
    expect(fs.readlinkSync(path.join(root, 'live', 'A', 'cert.pem'))).toBe('../../archive/A/cert1.pem');
    expect(fs.existsSync(path.join(root, 'renewal', 'A.conf'))).toBe(true);
  });

  it('leaves the backup byte-identical', () => {
    const before = snapshot(backup, 'A');

    run('A').finalize();

    expect(snapshot(backup, 'A')).toEqual(before);
  });
});

// ──────────────────────────────────────────────
//  Preconditions
// ──────────────────────────────────────────────
describe('preconditions reject before any mutation', () => {
  const untouched = () => {
    expect(snapshot(root, 'A')).toEqual(ABSENT);
    expect(fs.existsSync(path.join(root, '.nginx-server-bootstrap'))).toBe(false);
  };

  it.each([
    ['renewal', () => fs.rmSync(path.join(backup, 'renewal', 'A.conf'))],
    ['live', () => fs.rmSync(path.join(backup, 'live', 'A'), { recursive: true })],
    ['archive', () => fs.rmSync(path.join(backup, 'archive', 'A'), { recursive: true })],
  ])('rejects a backup missing %s', (part, breakIt) => {
    lineage(backup, 'A', 'backed-up');
    breakIt();

    expect(run('A')).toEqual({ committed: false, reason: `backup-${part}-missing` });
    untouched();
  });

  it('rejects a backup renewal config with non-canonical paths', () => {
    lineage(backup, 'A', 'backed-up', { renewalRoot: '/somewhere/else' });

    expect(run('A')).toEqual(expect.objectContaining({ committed: false, reason: 'non-canonical-backup-paths' }));
    untouched();
  });

  it('rejects when no backup path is configured', () => {
    expect(bootstrapLineageFromBackup('A', { letsencryptDir: root, backupPath: undefined }))
      .toEqual({ committed: false, reason: 'no-backup-path' });
  });
});

// ──────────────────────────────────────────────
//  The slot must be genuinely empty
// ──────────────────────────────────────────────
describe('an occupied slot is refused, never overwritten', () => {
  beforeEach(() => lineage(backup, 'A', 'backed-up'));

  // What to do about local residue is a policy question this primitive
  // deliberately leaves to the caller, so it neither overwrites, moves aside
  // nor deletes anything it finds.
  it.each([
    ['a renewal config', () => fs.writeFileSync(path.join(root, 'renewal', 'A.conf'), 'existing\n'), 'renewal/A.conf'],
    ['live residue', () => fs.mkdirSync(path.join(root, 'live', 'A'), { recursive: true }), 'live/A'],
    ['archive residue', () => fs.mkdirSync(path.join(root, 'archive', 'A'), { recursive: true }), 'archive/A'],
  ])('refuses when the slot already has %s', (_label, occupy, detail) => {
    occupy();
    const before = snapshot(root, 'A');

    const result = run('A');

    expect(result).toEqual({ committed: false, reason: 'local-slot-not-empty', detail });
    expect(snapshot(root, 'A')).toEqual(before);
    expect(fs.existsSync(path.join(root, '.nginx-server-bootstrap'))).toBe(false);
  });

  it('names every occupied path when several are present', () => {
    fs.mkdirSync(path.join(root, 'live', 'A'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive', 'A'), { recursive: true });

    expect(run('A').detail).toBe('live/A, archive/A');
  });

  it('does not touch residue it refused', () => {
    fs.mkdirSync(path.join(root, 'archive', 'A'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'irreplaceable\n');

    run('A');

    expect(fs.readFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'utf8')).toBe('irreplaceable\n');
  });
});

// ──────────────────────────────────────────────
//  Rollback
// ──────────────────────────────────────────────
describe('a failure returns the slot to absence', () => {
  beforeEach(() => lineage(backup, 'A', 'backed-up'));

  it.each(BOUNDARIES)('rolls back after a failure at %s', (boundary) => {
    expect(() => run('A', { failAfter: boundary })).toThrow(/rolled back/);

    // There is no original to put back — absence is the correct end state.
    expect(snapshot(root, 'A')).toEqual(ABSENT);
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });

  it('leaves nothing behind when staging fails', () => {
    expect(() => run('A', { failAfter: 'S' })).toThrow(/Could not stage/);

    expect(snapshot(root, 'A')).toEqual(ABSENT);
    expect(fs.existsSync(path.join(root, '.nginx-server-bootstrap'))).toBe(false);
  });

  it('rolls back a committed bootstrap when the caller rejects it', () => {
    // Post-commit rollback stays possible, which is why finalize is the
    // caller's call — a future verification step runs between the two.
    const result = run('A');
    expect(result.committed).toBe(true);

    result.rollback();

    expect(snapshot(root, 'A')).toEqual(ABSENT);
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  Crash recovery
// ──────────────────────────────────────────────
describe('recovering an interrupted bootstrap', () => {
  beforeEach(() => lineage(backup, 'A', 'backed-up'));

  it.each(['S', 'B1', 'B2'])('returns the slot to absence after a crash at %s', (boundary) => {
    stopWithoutRollback('A', boundary);

    const result = recoverInterruptedBootstrap('A', opts());

    expect(result.action).toBe('rolled-back');
    expect(snapshot(root, 'A')).toEqual(ABSENT);
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });

  it('keeps the installed lineage after a crash at B3', () => {
    stopWithoutRollback('A', 'B3');

    const result = recoverInterruptedBootstrap('A', opts());

    expect(result.action).toBe('rolled-forward');
    expect(fs.readFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'utf8')).toBe('backed-up-cert\n');
    expect(fs.readlinkSync(path.join(root, 'live', 'A', 'cert.pem'))).toBe('../../archive/A/cert1.pem');
    expect(fs.existsSync(txnDir('A'))).toBe(false);
  });

  it('does nothing when there is no transaction directory', () => {
    expect(recoverInterruptedBootstrap('A', opts())).toEqual({ id: 'A', action: 'none' });
  });

  it.each(['S', 'B1', 'B2', 'B3'])('is idempotent after a crash at %s', (boundary) => {
    stopWithoutRollback('A', boundary);

    recoverInterruptedBootstrap('A', opts());
    const afterFirst = snapshot(root, 'A');

    expect(recoverInterruptedBootstrap('A', opts())).toEqual({ id: 'A', action: 'none' });
    expect(snapshot(root, 'A')).toEqual(afterFirst);
  });

  it('converges when recovery itself is interrupted', () => {
    stopWithoutRollback('A', 'B2');

    // Interrupt recovery midway, then run the whole thing again.
    rollbackLineageBootstrap('A', opts());

    expect(recoverInterruptedBootstrap('A', opts())).toEqual({ id: 'A', action: 'none' });
    expect(snapshot(root, 'A')).toEqual(ABSENT);
  });
});

// ──────────────────────────────────────────────
//  Leftovers this transaction cannot have produced
// ──────────────────────────────────────────────
describe('an unrecognised leftover is left alone', () => {
  it('refuses a transaction directory with no staged directory', () => {
    // Every bootstrap creates staged/ before touching anything canonical.
    fs.mkdirSync(txnDir('A'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive', 'A'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'not ours\n');

    const result = recoverInterruptedBootstrap('A', opts());

    expect(result.action).toBe('unrecognised');
    expect(fs.readFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'utf8')).toBe('not ours\n');
  });

  it('refuses when no renewal config is either staged or installed', () => {
    // Neither B3-completed nor B3-pending: the transaction cannot say whether
    // the canonical material is its own, so it will not guess.
    fs.mkdirSync(path.join(txnDir('A'), 'staged'), { recursive: true });
    fs.mkdirSync(path.join(root, 'archive', 'A'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'unexplained\n');

    const result = recoverInterruptedBootstrap('A', opts());

    expect(result.action).toBe('unrecognised');
    expect(fs.readFileSync(path.join(root, 'archive', 'A', 'cert1.pem'), 'utf8')).toBe('unexplained\n');
  });
});

// ──────────────────────────────────────────────
//  Several leftovers
// ──────────────────────────────────────────────
describe('recoverInterruptedBootstraps', () => {
  it('returns an empty list when nothing is pending', () => {
    expect(recoverInterruptedBootstraps(opts())).toEqual([]);
  });

  it('resolves each leftover independently', () => {
    for (const id of ['A', 'B']) lineage(backup, id, 'backed-up');
    stopWithoutRollback('A', 'B1');   // uncommitted -> back to absence
    stopWithoutRollback('B', 'B3');   // committed   -> kept

    const results = recoverInterruptedBootstraps(opts());

    expect(results).toEqual([
      { id: 'A', action: 'rolled-back' },
      { id: 'B', action: 'rolled-forward' },
    ]);
    expect(snapshot(root, 'A')).toEqual(ABSENT);
    expect(fs.readFileSync(path.join(root, 'archive', 'B', 'cert1.pem'), 'utf8')).toBe('backed-up-cert\n');
  });

  it('an unrecognised leftover does not disturb a valid one', () => {
    lineage(backup, 'A', 'backed-up');
    stopWithoutRollback('A', 'B1');
    fs.mkdirSync(txnDir('junk'), { recursive: true });

    const results = recoverInterruptedBootstraps(opts());

    expect(results.find((r) => r.id === 'A').action).toBe('rolled-back');
    expect(results.find((r) => r.id === 'junk').action).toBe('unrecognised');
    expect(snapshot(root, 'A')).toEqual(ABSENT);
  });
});

// ──────────────────────────────────────────────
//  Isolation
// ──────────────────────────────────────────────
describe('only the requested lineage is touched', () => {
  const withNeighbour = () => {
    lineage(backup, 'A', 'backed-up');
    lineage(root, 'OTHER', 'healthy');
    lineage(backup, 'OTHER', 'healthy-backup');
    return { live: snapshot(root, 'OTHER'), backup: snapshot(backup, 'OTHER') };
  };

  it('leaves an unrelated lineage untouched on success', () => {
    const before = withNeighbour();

    run('A').finalize();

    expect(snapshot(root, 'OTHER')).toEqual(before.live);
    expect(snapshot(backup, 'OTHER')).toEqual(before.backup);
  });

  it.each(BOUNDARIES)('leaves an unrelated lineage untouched after a failure at %s', (boundary) => {
    const before = withNeighbour();

    expect(() => run('A', { failAfter: boundary })).toThrow();

    expect(snapshot(root, 'OTHER')).toEqual(before.live);
    expect(snapshot(backup, 'OTHER')).toEqual(before.backup);
  });

  it('leaves an unrelated lineage untouched through crash recovery', () => {
    const before = withNeighbour();

    stopWithoutRollback('A', 'B2');
    recoverInterruptedBootstrap('A', opts());

    expect(snapshot(root, 'OTHER')).toEqual(before.live);
    expect(snapshot(backup, 'OTHER')).toEqual(before.backup);
  });
});

// ──────────────────────────────────────────────
//  Backup immutability
// ──────────────────────────────────────────────
describe('the backup is never modified', () => {
  it.each([
    ['success', () => run('A').finalize()],
    ['rollback after commit', () => run('A').rollback()],
    ['a failure at B2', () => { try { run('A', { failAfter: 'B2' }); } catch { /* expected */ } }],
    ['crash recovery', () => { stopWithoutRollback('A', 'B1'); recoverInterruptedBootstrap('A', opts()); }],
  ])('after %s', (_label, act) => {
    lineage(backup, 'A', 'backed-up');
    const before = snapshot(backup, 'A');

    act();

    expect(snapshot(backup, 'A')).toEqual(before);
  });
});
