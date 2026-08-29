const fs = require("fs");
const { DateTime } = require("luxon");
const { command, commandSafe } = require("../utils.js");
const { validateCertId } = require("../validate.js");
const { exists, removeIfPresent } = require("./lineage_files.js");

const { createLogger } = require("../logger.js");
const { error } = createLogger("letsencrypt");

let COUNT_PROTECTION = 200;

// The single enablement decision for certificate backup, shared by every gate:
// the two per-lineage recovery paths and the fast-path detection in
// hasManagedCertbotState(), and the two write paths (letsencrypt/index.js and
// letsencrypt/certbot_renew.js).
//
// Environment variables are strings, so a bare truthiness test makes the
// documented value CERTBOT_BACKUP=false *enable* the feature. The restore path
// used to do exactly that while the write paths did not, so `false` disabled
// writing but still permitted restoring. All of them now share this predicate.
//
// Deliberately only the exact literal "false" — no "FALSE"/"0"/"no"/"off" —
// matching the documented `true`/`false` values and the exact test the write
// paths already used.
exports.certbotBackupEnabled = certbotBackupEnabled = (value = process.env.CERTBOT_BACKUP) =>
  !!value && value !== 'false';

// Parse the output of `certbot certificates` into the certificate map the rest
// of this module works with. Pure: no command execution, no filesystem, no
// backup behaviour — so the sandbox validator can reuse the one parser rather
// than growing a second reading of the same format.
//
// The image pins certbot=5.6.0-r0 (see Dockerfile), so there is exactly one
// supported output format. Certbot 5.6 labels a certificate's domain list
// "Identifiers:"; older releases called the same field "Domains:", which is
// deliberately not accepted. Output this parser does not recognise fails loudly
// rather than being guessed at.
exports.parseCertbotCertificatesOutput = parseCertbotCertificatesOutput = (output) => {
  // Both callers get this text from a helper that resolves with *no value* when
  // a command exits 0 having written nothing to stdout (command() in
  // ../utils.js for parseCerts below, commandSafe() for the sandbox validator in
  // validate_backup.js). An empty response therefore arrives here as `undefined`
  // rather than as a string, and every scan below would fail on it with a raw
  // TypeError naming `.indexOf` — no use at all to whoever has to act on it.
  //
  // Rejected rather than read as "no certificates": Certbot 5.6.0 says that in
  // words, and every state reproduced against it either exits 0 with output or
  // exits non-zero with none. Silence is outside that contract, so it is
  // evidence of nothing — and this result decides which lineages get deleted or
  // reissued, which is not a decision to make on an answer that never arrived.
  if (typeof output !== 'string' || output.trim() === '') {
    throw new Error(
      'Failed to parse "certbot certificates" output: the command reported success but produced no output ' +
      '(expected a certificate listing or "No certificates found.")'
    );
  }

  const found_certs = {};

  const CERT_NAME = 'Certificate Name:';
  const CERT_IDENTIFIERS = 'Identifiers:';
  const CERT_PATH = 'Certificate Path:';
  const CERT_KEY_PATH = 'Private Key Path:';
  const CERT_VALID = 'Expiry Date:';
  let last_index = 0, index = 0;

  let count = 0;
  while ((last_index = output.indexOf(CERT_NAME, index)) !== -1 && count < COUNT_PROTECTION) {
    count++;
    const new_cert = {};
    let new_line = output.indexOf('\n', last_index);
    const cert_id = output.substring(last_index + CERT_NAME.length + 1/* white space */, new_line)

    // Get cert path
    if ((index = output.indexOf(CERT_PATH, last_index)) !== -1) {
      new_line = output.indexOf('\n', index);
      new_cert.cert_path = output.substring(index + CERT_PATH.length + 1/* white space */, new_line);
    } else {
      error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_PATH}"`);
    }

    // Get cert private key path
    if ((index = output.indexOf(CERT_KEY_PATH, last_index)) !== -1) {
      new_line = output.indexOf('\n', index);
      new_cert.cert_key_path = output.substring(index + CERT_KEY_PATH.length + 1/* white space */, new_line);
    } else {
      error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_KEY_PATH}"`);
    }

    // Get cert domains. The search is bounded to this certificate's own block
    // so a block missing the field can never silently inherit the *next*
    // certificate's identifiers — which would hand checkCertFiles() a wrong
    // domain list instead of a detectable failure.
    const next_name = output.indexOf(CERT_NAME, last_index + CERT_NAME.length);
    const block_end = next_name === -1 ? output.length : next_name;

    const identifiers_index = output.indexOf(CERT_IDENTIFIERS, last_index);

    if (identifiers_index === -1 || identifiers_index >= block_end) {
      // Fail here rather than logging and continuing. Every consumer treats
      // cert_domains as an array (checkCertFiles, configFiles, the status
      // summaries), so letting an incomplete certificate escape turns an
      // unsupported Certbot output format into an unrelated TypeError much
      // further downstream.
      throw new Error(
        `Failed to parse "certbot certificates" output for "${cert_id}": ` +
        `no "${CERT_IDENTIFIERS}" field in its block`
      );
    }

    // Tolerant of the field's indentation and of any run of whitespace between
    // identifiers, but only for the label recognised above.
    new_line = output.indexOf('\n', identifiers_index);
    new_cert.cert_domains = output
      .substring(identifiers_index + CERT_IDENTIFIERS.length, new_line === -1 ? output.length : new_line)
      .trim()
      .split(/\s+/)
      .filter(c => c.length > 0);

    // Get cert status
    if ((index = output.indexOf(CERT_VALID, last_index)) !== -1) {
      new_line = output.indexOf('\n', index);
      const expiry = output.substring(index + CERT_VALID.length + 1/* white space */, new_line);
      // valid | invalid | staging

      new_cert.status = expiry.includes('INVALID') ? expiry.includes('TEST_CERT') ? 'staging' : 'invalid' : 'valid';
    } else {
      error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_VALID}" (status)`);
    }

    // Get cert validity
    if ((index = output.indexOf(CERT_VALID, last_index)) !== -1) {
      new_line = output.indexOf('(', index);
      new_cert.validity = DateTime.fromJSDate(new Date(output.substring(index + CERT_VALID.length + 1/* white space */, new_line - 1)));
      // valid | invalid | staging
    } else {
      error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_VALID}" (validity)`);
    }

    found_certs[cert_id] = new_cert;
  }

  return found_certs;
};

// True when Certbot reported that it holds no certificates at all. Kept beside
// the parser because both read the same output.
exports.certbotReportedNoCertificates = certbotReportedNoCertificates = (output) =>
  /no.*cert.*found/i.test(output);

// Query Certbot and parse what it enumerates. Discovery only: this reads
// state and never changes it.
//
// It used to take a `copy_files` flag that, on a Certbot reporting no
// certificates at all, copied the whole backup over /etc/letsencrypt and
// re-parsed. That bulk restore is gone: recovery is now decided per lineage,
// after classification, from a backup validated in isolation
// (validate_backup.js) and installed by a crash-safe transaction
// (restore_lineage.js, bootstrap_lineage.js). Keeping discovery pure is what
// lets startup call it freely — including to verify a lineage it just
// installed — without a read turning into a write.
exports.parseCerts = parseCerts = async () => {

  let output = undefined;
  try {
    output = await command('certbot certificates');
  } catch (err) {
    throw new Error(`Failed to query certbot certificates: ${err.error || err.message || err}`);
  }

  if (certbotReportedNoCertificates(output)) return {};

  return parseCertbotCertificatesOutput(output);
}

// Cheap local check for "is there any Certbot state the reconciliation below
// could possibly discover or delete?", used to let a startup with zero
// configured letsencrypt/letsencrypt-staging entries skip `certbot
// certificates` entirely — so an http/custom-only deployment does not depend
// on Certbot being healthy just to learn it has nothing to do.
//
// Local state is keyed on /etc/letsencrypt/renewal/*.conf because that is what
// Certbot actually enumerates: verified against this image's Certbot 5.6.0,
// a live/<id> or archive/<id> left behind *without* a renewal config is not
// reported by `certbot certificates`, while a renewal config with no live or
// archive still is Certbot's (and `certbot delete`'s) business. A successful
// `certbot delete` removes the renewal config, so its continued presence is
// also exactly the signal that a previous cleanup has not succeeded yet — which
// keeps failed deletions retryable on the next startup.
//
// Any *.conf entry counts, parseable or not: corrupt/partial renewal state must
// stay on the Certbot path so Certbot can surface it, never be hidden here.
//
// A populated backup deliberately does NOT count. It used to, back when
// discovery could copy the whole backup over /etc/letsencrypt and rediscover
// from it — a backup was then genuinely reachable state. That bulk restore is
// gone, and with zero configured letsencrypt/letsencrypt-staging entries the
// handler returns once cleanup is done, before any backup is read for recovery
// or written. So the slow path can no longer restore, update or discard a
// backup: entering it for one costs a `certbot certificates` call that can
// only report nothing, and makes an http/custom-only deployment fail to start
// whenever Certbot is unhealthy — precisely what the fast path exists to
// avoid. The backup is left untouched either way, and is still available to
// per-lineage recovery the moment a Let's Encrypt site is configured again,
// because a non-empty entry set never consults this function at all.
//
// Deliberately conservative: this answers "must the slow path run?", and every
// uncertain answer is `true`. Skipping cleanup that was needed would be a real
// defect; running discovery that turned out to be unnecessary costs one command.
const RENEWAL_DIR = "/etc/letsencrypt/renewal";

exports.hasManagedCertbotState = (overrides = {}) => {
  const renewalDir = overrides.renewalDir || RENEWAL_DIR;

  try {
    if (fs.existsSync(renewalDir) && fs.readdirSync(renewalDir).some((name) => name.endsWith('.conf'))) {
      return true;
    }
  } catch (err) {
    // Could not prove the directory is empty (permissions, I/O, a racing
    // change). Fall through to the Certbot path rather than assuming absence.
    return true;
  }

  return false;
}

// The renewal configs Certbot enumerates lineages from, by filename stem
// (`A.conf` -> `A`). The stem *is* the Certbot cert-name — verified against the
// pinned Certbot 5.6.0, where `certbot delete --cert-name A` looks for
// /etc/letsencrypt/renewal/A.conf — which is what makes a stem directly usable
// with deleteCert().
//
// Same directory and same `*.conf` rule as hasManagedCertbotState() above, so
// the two can never disagree about what counts as managed renewal state.
//
// Contents are deliberately not parsed here. Whether Certbot can actually *use*
// a renewal config is Certbot's answer to give, and it gives it by enumerating
// the lineage or not; re-deriving that in Node would mean reimplementing
// Certbot's own validity rules.
const RENEWAL_CONF_SUFFIX = '.conf';

exports.renewalConfigPath = (stem, overrides = {}) =>
  `${overrides.renewalDir || RENEWAL_DIR}/${stem}${RENEWAL_CONF_SUFFIX}`;

exports.listRenewalStems = (overrides = {}) => {
  const renewalDir = overrides.renewalDir || RENEWAL_DIR;

  let entries;
  try {
    entries = fs.readdirSync(renewalDir);
  } catch (err) {
    // Certbot creates this directory lazily, so a missing one genuinely means
    // "no lineages". Every other failure leaves the answer unknown and is
    // raised to the caller: treating an unreadable directory as empty would
    // silently downgrade "cannot tell" into "nothing to reconcile".
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return entries
    .filter((name) => name.endsWith(RENEWAL_CONF_SUFFIX))
    .map((name) => name.slice(0, -RENEWAL_CONF_SUFFIX.length));
};

// Is this config.json entry a certificate this image manages?
//
// This is the rule the Let's Encrypt handler applies when it builds its
// effective entry set (js/letsencrypt/index.js): an omitted mode defaults to
// letsencrypt — matching validateConfigEntry in ../validate.js — and only
// letsencrypt/letsencrypt-staging are managed. It lives here so the renewal
// process, which has no access to the handler's in-memory set, can classify a
// lineage the same way rather than inventing its own reading of "desired".
const LETSENCRYPT_MODES = ['letsencrypt', 'letsencrypt-staging'];

exports.isDesiredLetsencryptEntry = (entry) =>
  !!entry && LETSENCRYPT_MODES.includes(entry.mode === undefined ? 'letsencrypt' : entry.mode);

// Copy Certbot state into the backup, leaving protected lineages alone.
//
// A lineage Certbot cannot enumerate but config.json still wants is preserved
// locally rather than deleted (see index.js). The backup write used to copy it
// over its own backed-up counterpart anyway, so one startup was enough to
// replace the last known-good copy with the suspect state — and every restart
// re-did it. Protected lineages are therefore skipped here: whatever the backup
// already holds for them, present or absent, is left exactly as it is.
//
// Protection covers renewal/<id>.conf, live/<id> and archive/<id> together.
// They are one recovery unit; copying the parts that still look healthy would
// leave a lineage whose config and material came from different points in time.
const LETSENCRYPT_DIR = "/etc/letsencrypt";
// Certbot's per-lineage directories. Everything else under /etc/letsencrypt
// (accounts/, renewal-hooks/, ...) is global and is copied wholesale as before.
const LINEAGE_DIRS = ['renewal', 'live', 'archive'];

exports.backupCertbotState = async (options = {}) => {
  const source = options.sourceDir || LETSENCRYPT_DIR;
  const backupPath = 'backupPath' in options ? options.backupPath : process.env.CERTBOT_BACKUP_PATH;
  const protectedLineages = new Set(options.protectedLineages || []);

  // Top-level entries, minus dotfiles. This used to be the shell glob in
  // `cp -rf ${source}/* ${backupPath}`, which never matches dotfiles; the
  // enumeration is done here instead so `backupPath` (CERTBOT_BACKUP_PATH, an
  // operator-supplied path) never reaches a shell. Both branches below skip
  // dotfiles for the same reason the glob did: otherwise the backup would
  // silently start including files it never has, such as migrate_renewal.js's
  // .nginx-server-renewal-schema marker. Only the *top* level is filtered —
  // `cp -rf` still copies whatever is inside a directory it is handed, dotfiles
  // included, exactly as the glob's expansion did.
  //
  // A source with no visible entries copies nothing and succeeds, which is what
  // the protected branch below has always done. The glob spelling failed
  // instead — an unmatched `*` is passed through literally and `cp` cannot stat
  // it — but that state does not arise here: both callers reach a backup write
  // only after a successful `certbot certificates`, and on the pinned Certbot
  // 5.6.0 that call creates /etc/letsencrypt containing renewal-hooks/, so the
  // listing is never empty. Backing up nothing is also the harmless direction
  // for this feature (see the caller in index.js: skipping a write costs an
  // update, overwriting a good copy costs the recovery material).
  const visible = (dir) => fs.readdirSync(dir).filter((name) => !name.startsWith('.'));

  // `--` on every copy below. execFile removes the shell, but not cp(1)'s own
  // option parsing, and `backupPath` is unvalidated operator input: a
  // CERTBOT_BACKUP_PATH beginning with `-` is read as flags by this image's
  // BusyBox 1.37.0 (`cp: unrecognized option: e` for `-dest`). The sources
  // cannot lead with `-` — they are built from LETSENCRYPT_DIR — but the
  // destination is the last operand, so it needs the guard.

  // With nothing to protect this is the same copy it has always been — same
  // binary, same flags, same set of sources — just spelled as one execFile per
  // top-level entry instead of one shell command with a glob.
  if (protectedLineages.size === 0) {
    for (const entry of visible(source)) {
      await commandSafe('cp', ['-rf', '--', `${source}/${entry}`, backupPath]);
    }
    return;
  }

  for (const entry of visible(source)) {
    if (!LINEAGE_DIRS.includes(entry)) {
      // `cp -rf <dir> <backup>` merges into an existing directory of the same
      // name, exactly as the bulk copy did.
      await commandSafe('cp', ['-rf', '--', `${source}/${entry}`, backupPath]);
      continue;
    }

    const destDir = `${backupPath}/${entry}`;
    fs.mkdirSync(destDir, { recursive: true });

    for (const child of visible(`${source}/${entry}`)) {
      // renewal/ holds <id>.conf files; live/ and archive/ hold <id> directories.
      const id = entry === 'renewal' ? child.replace(/\.conf$/, '') : child;
      if (protectedLineages.has(id)) continue;
      // Same `cp -rf` as before, so live/<id>'s symlinks into archive/<id> stay
      // symlinks rather than being dereferenced into regular files.
      await commandSafe('cp', ['-rf', '--', `${source}/${entry}/${child}`, destDir]);
    }
  }
};

// Every artifact one cert-name owns inside a backed-up Certbot tree.
//
// The first three are Certbot's own, and they are the complete set: verified
// against the pinned Certbot 5.6.0, `certbot delete --cert-name X` removes
// renewal/X.conf, live/X and archive/X and nothing else, and storage.py's
// delete_files() does exactly that. The private key is only ever in archive/X —
// constants.KEY_DIR ("keys") still exists in 5.6 but nothing reads it, and
// client.py passes key_dir=None, so issuance writes the key straight into the
// archive rather than into a separate key store.
//
// renewal-backup/X.conf is this project's own: migrate_renewal.js copies a
// renewal config there before rewriting it to webroot, and backupCertbotState
// above copies that directory along with every other top-level entry. It holds
// no key material, but it is lineage-specific and just as stale once the site
// is gone.
const backupLineagePaths = (backupPath, id) => [
  `${backupPath}/renewal/${id}.conf`,
  `${backupPath}/renewal-backup/${id}.conf`,
  `${backupPath}/live/${id}`,
  `${backupPath}/archive/${id}`,
];

// Remove one obsolete lineage from the backup.
//
// Called from the cleanup that has just removed the same lineage from live
// Certbot state (letsencrypt/index.js), so both halves are driven by one
// notion of which lineage is obsolete rather than by a second scan of the
// backup.
//
// Deliberately NOT gated on certbotBackupEnabled(). That flag decides whether
// *current* certificate state is written to the backup; this deletes state
// that is already there. A deployment that took backups and later set
// CERTBOT_BACKUP=false would otherwise keep a removed site's private key —
// and stay able to resurrect its certificate — indefinitely, which is the
// retention this exists to end. Nothing here ever creates a backup tree: with
// no backup configured, or none on disk, there is simply nothing stale to
// remove.
//
// Scoped to exactly one name. validateCertId is the same check config.json
// entries pass, and its pattern (must begin alphanumeric, then only
// alphanumerics, dots, hyphens and underscores) admits no path separator and
// cannot spell "..", so each path below can only ever name one entry inside
// its directory. That is what keeps "main" from touching "main2", "main-old"
// or "domain-main" — no prefix matching, no globbing, no shell.
exports.pruneBackupLineage = pruneBackupLineage = (id, overrides = {}) => {
  const backupPath = 'backupPath' in overrides ? overrides.backupPath : process.env.CERTBOT_BACKUP_PATH;

  if (!backupPath) return { pruned: [], reason: 'no-backup-path' };
  if (!fs.existsSync(backupPath)) return { pruned: [], reason: 'no-backup' };

  validateCertId(id);

  const pruned = [];
  for (const target of backupLineagePaths(backupPath, id)) {
    // `exists` from lineage_files.js rather than a bare existsSync: that one
    // follows symlinks, so a dangling live/<id>/*.pem link — exactly what a
    // half-copied backup leaves behind — would read as absent and be skipped.
    if (!exists(target)) continue;
    // The same removal primitive the lineage transactions use, so pruning and
    // rollback agree on how a lineage is taken off disk.
    removeIfPresent(target);
    pruned.push(target);
  }

  return { pruned, reason: pruned.length > 0 ? 'pruned' : 'nothing-to-prune' };
};

// The lineage-specific locations of a backup, and what a lineage looks like in
// each: renewal/ and renewal-backup/ hold `<id>.conf` files, live/ and archive/
// hold `<id>` directories. Same four places pruneBackupLineage removes, read
// the other way round.
const BACKUP_LINEAGE_SOURCES = [
  { dir: 'renewal', suffix: '.conf' },
  { dir: 'renewal-backup', suffix: '.conf' },
  { dir: 'live', suffix: null },
  { dir: 'archive', suffix: null },
];

// Which lineages an existing backup holds, read from the filesystem alone.
//
// This exists for one case the deletion-time pruning cannot reach: a backup
// written by a release that did not prune. Its stale lineages were never
// deleted from live Certbot state by *this* startup — there is usually no live
// state for them at all any more — so they never pass through the cleanup loops
// that call pruneBackupLineage. Discovering them means reading the backup
// directly.
//
// Certbot is deliberately not involved. A stale name is a directory entry, and
// asking Certbot for it would both be pointless (it does not know about the
// backup) and would couple http/custom-only startups to Certbot being healthy —
// exactly what the fast path in index.js exists to avoid.
//
// The union of all four locations, not just renewal/: the old backup write was
// additive and non-atomic, so a historical backup can hold live/<id> and
// archive/<id> with no renewal config, or a renewal-backup entry on its own.
// Requiring a complete lineage before cleaning up would leave precisely the
// partial residue this is meant to collect.
//
// Names are taken from the entries themselves and then validated, never
// constructed. Anything whose name is not a valid cert-id is reported back
// rather than deleted: the backup path is operator-supplied, and an entry this
// module cannot account for is not something to remove on a guess.
exports.listBackupLineages = listBackupLineages = (overrides = {}) => {
  const backupPath = 'backupPath' in overrides ? overrides.backupPath : process.env.CERTBOT_BACKUP_PATH;

  // No backup configured, or none on disk: nothing to read, and nothing is
  // created to read it.
  if (!backupPath || !fs.existsSync(backupPath)) return { lineages: [], unsafe: [] };

  const lineages = new Set();
  const unsafe = [];

  for (const { dir, suffix } of BACKUP_LINEAGE_SOURCES) {
    const sourceDir = `${backupPath}/${dir}`;

    let entries;
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch (err) {
      // A location this backup simply does not have is not a problem; anything
      // else leaves the answer unknown and is raised, so the caller can report
      // an incomplete cleanup rather than treat "unreadable" as "empty".
      if (err.code === 'ENOENT') continue;
      throw err;
    }

    for (const entry of entries) {
      // Dotfiles are skipped for the same reason backupCertbotState never
      // copies them: they are not lineage material.
      if (entry.name.startsWith('.')) continue;

      let id;
      if (suffix) {
        if (entry.isDirectory() || !entry.name.endsWith(suffix)) continue;
        id = entry.name.slice(0, -suffix.length);
      } else {
        // live/<id> is a directory; a torn backup can leave it a dangling
        // symlink instead, which still names a lineage.
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        id = entry.name;
      }

      try {
        validateCertId(id);
      } catch (_) {
        unsafe.push({ name: entry.name, path: `${sourceDir}/${entry.name}` });
        continue;
      }

      lineages.add(id);
    }
  }

  return { lineages: [...lineages].sort(), unsafe };
};

exports.checkCertFiles = (id, { cert_path, cert_key_path, cert_domains, status }) => {
  const certs = require("../config.json");

  if (!certs[id]) return false;

  if (status === 'invalid') return false;

  if (status === 'staging' && certs[id].mode === 'letsencrypt') return false;

  if (!fs.existsSync(cert_path) || !fs.existsSync(cert_key_path)) return false;

  const delete_domains = cert_domains.filter(c => !certs[id].names.includes(c));
  const create_domains = certs[id].names.filter(c => !cert_domains.includes(c));

  if (delete_domains.length === 0 && create_domains.length === 0) {
    return true;
  }

  return false;

  // return {
  //   delete_domains,
  //   create_domains
  // }
}
