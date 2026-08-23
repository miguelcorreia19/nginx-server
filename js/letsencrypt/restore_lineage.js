// Crash-safe replacement of one Certbot lineage from an already-validated backup.
//
// This is a filesystem primitive: it runs no Certbot command and makes no
// decision about whether a restore *should* happen. Validation is
// validate_backup.js's job; deciding is the caller's. js/letsencrypt/index.js
// is that caller — it uses this for a still-configured lineage Certbot cannot
// enumerate, and calls recoverInterruptedRestores() at the very top of startup,
// before discovery, so a half-applied transaction is never read as an absent
// lineage.
//
// The safety property, and the whole reason for the step order below:
//
//   Certbot enumerates lineages from renewal/<id>.conf. Displace that file
//   first and the lineage is invisible no matter what archive/ and live/
//   contain; install it last and that single rename is the commit.
//
// Verified against the pinned Certbot 5.6: with the renewal config moved aside,
// the lineage is not enumerated at any point between M1 and M6. Doing it the
// other way round leaks — installing material while a *parseable* old config is
// still in place makes Certbot enumerate the lineage early, under the old
// config's metadata.
//
// No transaction log, journal or state file. Recovery reads the answer off the
// filesystem: `displaced/renewal.conf` means a transaction started, and
// `renewal/<id>.conf` means it committed. Within a transaction the staged
// entries are equally load-bearing — `staged/live` still existing means M5 has
// not run, so live/<id> is still the original. That is what lets rollback tell
// "originally absent" from "not yet displaced" without recording anything.

const fs = require("fs");
const path = require("path");

const { createLogger } = require("../logger.js");
const { log, warn } = createLogger("letsencrypt");

const {
  LETSENCRYPT_DIR,
  checkCanonicalPaths,
  copyTree,
  exists,
  removeIfPresent,
} = require("./lineage_files.js");

const TRANSACTION_DIR = ".nginx-server-restore";

const paths = (id, overrides = {}) => {
  const root = overrides.letsencryptDir || LETSENCRYPT_DIR;
  const backup = 'backupPath' in overrides ? overrides.backupPath : process.env.CERTBOT_BACKUP_PATH;
  const txn = path.join(root, TRANSACTION_DIR, id);
  return {
    root,
    transactionRoot: path.join(root, TRANSACTION_DIR),
    txn,
    staged: { archive: path.join(txn, 'staged', 'archive'), live: path.join(txn, 'staged', 'live'), renewal: path.join(txn, 'staged', 'renewal.conf') },
    displaced: { archive: path.join(txn, 'displaced', 'archive'), live: path.join(txn, 'displaced', 'live'), renewal: path.join(txn, 'displaced', 'renewal.conf') },
    live: { archive: path.join(root, 'archive', id), live: path.join(root, 'live', id), renewal: path.join(root, 'renewal', `${id}.conf`) },
    backup: backup && { archive: path.join(backup, 'archive', id), live: path.join(backup, 'live', id), renewal: path.join(backup, 'renewal', `${id}.conf`) },
  };
};

// Restore the pre-transaction state from whatever the filesystem currently holds.
//
// Which of live/<id> and archive/<id> are *ours* to remove is read off the
// staged entries: staged/<part> still present means the matching install step
// never ran, so the canonical path still holds the original and must be left
// alone. Anything genuinely displaced comes back from displaced/; a part that
// was absent before the transaction has no displaced copy, so absence is
// restored by simply not putting anything back.
const rollback = (id, overrides = {}) => {
  const p = paths(id, overrides);

  if (!exists(p.staged.renewal)) removeIfPresent(p.live.renewal);
  if (!exists(p.staged.live)) removeIfPresent(p.live.live);
  if (!exists(p.staged.archive)) removeIfPresent(p.live.archive);

  if (exists(p.displaced.archive)) fs.renameSync(p.displaced.archive, p.live.archive);
  if (exists(p.displaced.live)) fs.renameSync(p.displaced.live, p.live.live);
  if (exists(p.displaced.renewal)) fs.renameSync(p.displaced.renewal, p.live.renewal);

  discardTransaction(id, overrides);
};

// Remove the transaction directory, and the shared parent once it is empty so a
// completed restore leaves nothing behind at all.
const discardTransaction = (id, overrides = {}) => {
  const p = paths(id, overrides);
  removeIfPresent(p.txn);
  try {
    if (fs.readdirSync(p.transactionRoot).length === 0) fs.rmdirSync(p.transactionRoot);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
};

exports.rollbackLineageRestore = rollback;

// Stage the backup, then install it with six renames. Returns a handle whose
// displaced originals survive until the caller has verified the result — so a
// verification failure is still recoverable.
//
// Precondition failures return { committed: false, reason } having touched
// nothing. A failure during staging or the commit sequence rolls back and
// throws, so a half-applied transaction never escapes to the caller.
exports.restoreLineageFromBackup = (id, overrides = {}) => {
  const p = paths(id, overrides);
  // Test-only seam: stop immediately after the named step to exercise a
  // mutation boundary. Never set in production.
  const failAfter = overrides.failAfter;
  const boundary = (step) => { if (failAfter === step) throw new Error(`injected failure after ${step}`); };

  if (!p.backup) return { committed: false, reason: 'no-backup-path' };
  for (const part of ['renewal', 'live', 'archive']) {
    if (!exists(p.backup[part])) return { committed: false, reason: `backup-${part}-missing` };
  }
  // The live renewal config is the commit marker, so the transaction is only
  // well-defined when one exists to displace. A lineage without it is not the
  // desired-undiscoverable case this primitive serves.
  if (!exists(p.live.renewal)) return { committed: false, reason: 'live-renewal-missing' };

  const renewalContent = fs.readFileSync(p.backup.renewal, 'utf8');
  const canonical = checkCanonicalPaths(renewalContent, id, p.root);
  if (!canonical.ok) return { committed: false, reason: 'non-canonical-backup-paths', detail: canonical.detail };

  // ---- stage: no live mutation ----
  try {
    removeIfPresent(p.txn);
    fs.mkdirSync(path.join(p.txn, 'staged'), { recursive: true });
    fs.mkdirSync(path.join(p.txn, 'displaced'), { recursive: true });
    copyTree(p.backup.archive, p.staged.archive);
    copyTree(p.backup.live, p.staged.live);
    fs.copyFileSync(p.backup.renewal, p.staged.renewal);
    boundary('S');
  } catch (err) {
    // Nothing live was touched, so discarding the staging area is a full undo.
    try { discardTransaction(id, overrides); } catch (cleanupErr) {
      warn(`Could not discard staging for "${id}" at ${p.txn}: ${cleanupErr.message}`);
    }
    throw new Error(`Could not stage the backup for "${id}": ${err.message}`);
  }

  // ---- commit: same-filesystem renames, in this order ----
  try {
    fs.renameSync(p.live.renewal, p.displaced.renewal);            boundary('M1');
    if (exists(p.live.archive)) fs.renameSync(p.live.archive, p.displaced.archive); boundary('M2');
    fs.renameSync(p.staged.archive, p.live.archive);               boundary('M3');
    if (exists(p.live.live)) fs.renameSync(p.live.live, p.displaced.live);          boundary('M4');
    fs.renameSync(p.staged.live, p.live.live);                     boundary('M5');
    fs.renameSync(p.staged.renewal, p.live.renewal);               boundary('M6');
  } catch (err) {
    try {
      rollback(id, overrides);
    } catch (rollbackErr) {
      // Do not destroy the displaced originals — the next startup's recovery
      // retries the same reversal from the same deterministic location.
      throw new Error(
        `Restore of "${id}" failed (${err.message}) and rollback failed (${rollbackErr.message}); ` +
        `original state is preserved under ${p.txn} and will be retried on the next startup`
      );
    }
    throw new Error(`Restore of "${id}" failed and was rolled back: ${err.message}`);
  }

  return {
    committed: true,
    transactionDir: p.txn,
    // Call once the restored lineage has been verified; until then the
    // originals stay available for rollback().
    finalize: () => {
      try {
        discardTransaction(id, overrides);
        return { finalized: true };
      } catch (err) {
        // A verified lineage is not un-restored over inert leftovers.
        warn(`Restore of "${id}" succeeded but its transaction state at ${p.txn} could not be removed: ${err.message}`);
        return { finalized: false, transactionDir: p.txn };
      }
    },
    rollback: () => rollback(id, overrides),
  };
};

// Resolve a leftover transaction directory. The rule is total and needs no
// stored state: displaced/renewal.conf says a transaction started, and
// renewal/<id>.conf says it committed.
//
// Idempotent — every branch converges on "no transaction directory", and
// re-running after a crash mid-recovery repeats the same decision.
exports.recoverInterruptedRestore = (id, overrides = {}) => {
  const p = paths(id, overrides);
  if (!exists(p.txn)) return { id, action: 'none' };

  if (!exists(p.displaced.renewal)) {
    // M1 always runs first and always produces displaced/renewal.conf, so
    // displaced material without it cannot arise from this transaction. Rather
    // than guess — and strand the only copy of that material — leave it alone
    // and say so.
    if (exists(p.displaced.archive) || exists(p.displaced.live)) {
      warn(`Unrecognised restore state for "${id}" at ${p.txn}: displaced material without a displaced renewal config. Leaving it untouched for inspection.`);
      return { id, action: 'unrecognised', transactionDir: p.txn };
    }
    // Never reached M1, so no live path was touched.
    discardTransaction(id, overrides);
    return { id, action: 'discarded' };
  }

  if (exists(p.live.renewal)) {
    // M6 completed: the restored lineage is live and stays.
    discardTransaction(id, overrides);
    return { id, action: 'rolled-forward' };
  }

  rollback(id, overrides);
  return { id, action: 'rolled-back' };
};

exports.recoverInterruptedRestores = (overrides = {}) => {
  const root = overrides.letsencryptDir || LETSENCRYPT_DIR;
  const transactionRoot = path.join(root, TRANSACTION_DIR);

  let entries;
  try {
    entries = fs.readdirSync(transactionRoot);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // Cannot tell what is there; touching nothing is the safe answer.
    warn(`Could not read ${transactionRoot}: ${err.message}`);
    return [];
  }

  const results = [];
  for (const id of entries.sort()) {
    try {
      const result = exports.recoverInterruptedRestore(id, overrides);
      if (result.action !== 'none') log(`Interrupted certificate restore for "${id}": ${result.action}`);
      results.push(result);
    } catch (err) {
      // One unusable leftover must not stop the others being resolved, and it
      // is left in place rather than guessed at.
      const transactionDir = path.join(transactionRoot, id);
      warn(`Could not recover the interrupted restore for "${id}" at ${transactionDir}: ${err.message}`);
      results.push({ id, action: 'failed', error: err.message, transactionDir });
    }
  }
  return results;
};
