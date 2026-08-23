// Crash-safe installation of one Certbot lineage into an *empty* cert-name slot.
//
// This is the counterpart to restore_lineage.js, not a generalisation of it, and
// the two deliberately stay apart:
//
//   replacement (restore_lineage.js): a lineage already exists locally, so the
//     old renewal config is displaced first and its presence under displaced/
//     is what proves a transaction started.
//
//   bootstrap (here): nothing exists locally, so there is nothing to displace
//     and no such proof is available. Making displaced/renewal.conf optional in
//     the replacement rule would destroy the very distinction that makes its
//     recovery decision total, so bootstrap gets its own namespace and its own
//     rule instead.
//
// What they share is the visibility model, because Certbot enumerates lineages
// from renewal/<id>.conf: the material goes in first and that config goes in
// last, so a single rename is the commit and nothing partial is ever visible.
//
// It runs no Certbot command and touches no network. js/letsencrypt/index.js
// calls it for a desired site whose cert-name slot is provably empty — the
// container-replacement case — and calls recoverInterruptedBootstraps() at the
// top of startup, alongside the replacement transaction's own recovery.

const fs = require("fs");
const path = require("path");

const {
  LETSENCRYPT_DIR,
  checkCanonicalPaths,
  copyTree,
  exists,
  removeIfPresent,
} = require("./lineage_files.js");

const { createLogger } = require("../logger.js");
const { log, warn } = createLogger("letsencrypt");

const BOOTSTRAP_DIR = ".nginx-server-bootstrap";

const paths = (id, overrides = {}) => {
  const root = overrides.letsencryptDir || LETSENCRYPT_DIR;
  const backup = 'backupPath' in overrides ? overrides.backupPath : process.env.CERTBOT_BACKUP_PATH;
  const txn = path.join(root, BOOTSTRAP_DIR, id);
  return {
    root,
    bootstrapRoot: path.join(root, BOOTSTRAP_DIR),
    txn,
    stagedRoot: path.join(txn, 'staged'),
    staged: {
      archive: path.join(txn, 'staged', 'archive'),
      live: path.join(txn, 'staged', 'live'),
      renewal: path.join(txn, 'staged', 'renewal.conf'),
    },
    live: {
      archive: path.join(root, 'archive', id),
      live: path.join(root, 'live', id),
      renewal: path.join(root, 'renewal', `${id}.conf`),
    },
    backup: backup && {
      archive: path.join(backup, 'archive', id),
      live: path.join(backup, 'live', id),
      renewal: path.join(backup, 'renewal', `${id}.conf`),
    },
  };
};

const discardTransaction = (id, overrides = {}) => {
  const p = paths(id, overrides);
  removeIfPresent(p.txn);
  try {
    if (fs.readdirSync(p.bootstrapRoot).length === 0) fs.rmdirSync(p.bootstrapRoot);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
};

// Undo an uncommitted (or caller-rejected) bootstrap by returning the slot to
// absence. There is no displaced original to put back — the slot was provably
// empty when the transaction began, which is what makes removing these paths
// safe at all.
//
// Ownership is read off the staged entries rather than guessed: staged/<part>
// still being present means the matching install step never ran, so nothing of
// ours is at the canonical path and it must be left alone.
const rollback = (id, overrides = {}) => {
  const p = paths(id, overrides);

  if (!exists(p.staged.renewal)) removeIfPresent(p.live.renewal);
  if (!exists(p.staged.live)) removeIfPresent(p.live.live);
  if (!exists(p.staged.archive)) removeIfPresent(p.live.archive);

  discardTransaction(id, overrides);
};

exports.rollbackLineageBootstrap = rollback;

// Install a validated backup lineage into an empty slot. The caller is expected
// to have proven the backup usable (validate_backup.js); this adds only the
// structural preconditions installation itself depends on.
//
// Precondition failures return { committed: false, reason } having touched
// nothing at all. A failure during staging or the commit sequence rolls back and
// throws, so a half-applied transaction never reaches the caller.
exports.bootstrapLineageFromBackup = (id, overrides = {}) => {
  const p = paths(id, overrides);
  // Test-only seam: stop immediately after the named step to exercise a
  // mutation boundary. Never set in production.
  const failAfter = overrides.failAfter;
  const boundary = (step) => { if (failAfter === step) throw new Error(`injected failure after ${step}`); };

  if (!p.backup) return { committed: false, reason: 'no-backup-path' };
  for (const part of ['renewal', 'live', 'archive']) {
    if (!exists(p.backup[part])) return { committed: false, reason: `backup-${part}-missing` };
  }

  // The slot must be genuinely empty. Anything already there — a renewal config,
  // or inert live/archive residue — belongs to a different decision: a lineage
  // with a renewal config is the replacement transaction's job, and what to do
  // about residue is a policy question this primitive deliberately does not
  // answer. Nothing here overwrites, moves aside or deletes what it finds.
  const occupied = ['renewal', 'live', 'archive'].filter((part) => exists(p.live[part]));
  if (occupied.length > 0) {
    return {
      committed: false,
      reason: 'local-slot-not-empty',
      detail: occupied.map((part) => (part === 'renewal' ? `renewal/${id}.conf` : `${part}/${id}`)).join(', '),
    };
  }

  const renewalContent = fs.readFileSync(p.backup.renewal, 'utf8');
  const canonical = checkCanonicalPaths(renewalContent, id, p.root);
  if (!canonical.ok) return { committed: false, reason: 'non-canonical-backup-paths', detail: canonical.detail };

  // ---- stage: nothing canonical is touched ----
  try {
    // The intended case is a container that has never run Certbot, where
    // /etc/letsencrypt may not exist at all — so the three parents the install
    // renames into have to be created first. Certbot itself creates them with
    // mode 0700 (storage.py new_lineage), and matching that keeps a
    // bootstrapped tree indistinguishable from one Certbot made. Creating an
    // empty parent directory is not a mutation of any lineage.
    for (const part of ['renewal', 'live', 'archive']) {
      fs.mkdirSync(path.join(p.root, part), { recursive: true, mode: 0o700 });
    }

    removeIfPresent(p.txn);
    fs.mkdirSync(p.stagedRoot, { recursive: true });
    copyTree(p.backup.archive, p.staged.archive);
    copyTree(p.backup.live, p.staged.live);
    fs.copyFileSync(p.backup.renewal, p.staged.renewal);
    boundary('S');
  } catch (err) {
    try { discardTransaction(id, overrides); } catch (cleanupErr) {
      warn(`Could not discard bootstrap staging for "${id}" at ${p.txn}: ${cleanupErr.message}`);
    }
    throw new Error(`Could not stage the backup for "${id}": ${err.message}`);
  }

  // ---- install: same-filesystem renames into free names ----
  try {
    // Archive first: live/<id>'s symlinks are relative and would otherwise
    // resolve to nothing.
    fs.renameSync(p.staged.archive, p.live.archive);   boundary('B1');
    fs.renameSync(p.staged.live, p.live.live);         boundary('B2');
    // The commit. Until this rename lands there is no renewal config, so
    // Certbot cannot enumerate the lineage however complete the material is.
    fs.renameSync(p.staged.renewal, p.live.renewal);   boundary('B3');
  } catch (err) {
    try {
      rollback(id, overrides);
    } catch (rollbackErr) {
      throw new Error(
        `Bootstrap of "${id}" failed (${err.message}) and rollback failed (${rollbackErr.message}); ` +
        `transaction state is preserved at ${p.txn} and will be retried on the next startup`
      );
    }
    throw new Error(`Bootstrap of "${id}" failed and was rolled back: ${err.message}`);
  }

  return {
    committed: true,
    transactionDir: p.txn,
    // Call once the installed lineage has been verified; until then rollback()
    // can still return the slot to absence.
    finalize: () => {
      try {
        discardTransaction(id, overrides);
        return { finalized: true };
      } catch (err) {
        // A verified lineage is not uninstalled over inert leftovers.
        warn(`Bootstrap of "${id}" succeeded but its transaction state at ${p.txn} could not be removed: ${err.message}`);
        return { finalized: false, transactionDir: p.txn };
      }
    },
    rollback: () => rollback(id, overrides),
  };
};

// Resolve a leftover bootstrap transaction. As with the replacement rule the
// answer is read off the filesystem, with renewal/<id>.conf as the commit
// marker — but the uncommitted branch removes what was installed rather than
// putting an original back, because there was no original.
//
// Idempotent: every branch ends with no transaction directory, so re-running
// after a crash mid-recovery repeats the same decision.
exports.recoverInterruptedBootstrap = (id, overrides = {}) => {
  const p = paths(id, overrides);
  if (!exists(p.txn)) return { id, action: 'none' };

  // Every bootstrap creates staged/ before touching anything canonical, so a
  // leftover without it did not come from this transaction. Guessing could
  // delete a real lineage's material, so it is left for inspection.
  if (!exists(p.stagedRoot)) {
    warn(`Unrecognised bootstrap state for "${id}" at ${p.txn}: no staged directory. Leaving it untouched for inspection.`);
    return { id, action: 'unrecognised', transactionDir: p.txn };
  }

  if (exists(p.live.renewal)) {
    // B3 completed: the lineage is installed and stays.
    discardTransaction(id, overrides);
    return { id, action: 'rolled-forward' };
  }

  // With no renewal config either canonically or staged, this transaction
  // cannot say whether B3 ever ran, so it will not remove canonical material on
  // a guess.
  if (!exists(p.staged.renewal)) {
    warn(`Unrecognised bootstrap state for "${id}" at ${p.txn}: no renewal config staged or installed. Leaving it untouched for inspection.`);
    return { id, action: 'unrecognised', transactionDir: p.txn };
  }

  rollback(id, overrides);
  return { id, action: 'rolled-back' };
};

exports.recoverInterruptedBootstraps = (overrides = {}) => {
  const root = overrides.letsencryptDir || LETSENCRYPT_DIR;
  const bootstrapRoot = path.join(root, BOOTSTRAP_DIR);

  let entries;
  try {
    entries = fs.readdirSync(bootstrapRoot);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    warn(`Could not read ${bootstrapRoot}: ${err.message}`);
    return [];
  }

  const results = [];
  for (const id of entries.sort()) {
    try {
      const result = exports.recoverInterruptedBootstrap(id, overrides);
      if (result.action !== 'none') log(`Interrupted certificate bootstrap for "${id}": ${result.action}`);
      results.push(result);
    } catch (err) {
      // One unusable leftover must not stop the others being resolved.
      const transactionDir = path.join(bootstrapRoot, id);
      warn(`Could not recover the interrupted bootstrap for "${id}" at ${transactionDir}: ${err.message}`);
      results.push({ id, action: 'failed', error: err.message, transactionDir });
    }
  }
  return results;
};
