const fs = require("fs");
const { DateTime } = require("luxon");
const { command, commandSafe } = require("../utils.js");

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
// Deliberately conservative: this answers "must the slow path run?", and every
// uncertain answer is `true`. Skipping cleanup that was needed would be a real
// defect; running discovery that turned out to be unnecessary costs one command.
const RENEWAL_DIR = "/etc/letsencrypt/renewal";

exports.hasManagedCertbotState = (overrides = {}) => {
  const renewalDir = overrides.renewalDir || RENEWAL_DIR;
  // Runs the raw value through the same certbotBackupEnabled() predicate every
  // other backup gate uses, so they can never disagree about whether a backup
  // would actually be used.
  const backupEnabled = certbotBackupEnabled(
    'backupEnabled' in overrides ? overrides.backupEnabled : process.env.CERTBOT_BACKUP
  );
  const backupPath = 'backupPath' in overrides ? overrides.backupPath : process.env.CERTBOT_BACKUP_PATH;

  // Local renewal configs.
  try {
    if (fs.existsSync(renewalDir) && fs.readdirSync(renewalDir).some((name) => name.endsWith('.conf'))) {
      return true;
    }
  } catch (err) {
    // Could not prove the directory is empty (permissions, I/O, a racing
    // change). Fall through to the Certbot path rather than assuming absence.
    return true;
  }

  // Backup state: same enablement predicate, same live/ requirement, same
  // README filter as the recovery paths — and when backup is disabled there is
  // nothing to restore, so it cannot block the fast path.
  if (backupEnabled && backupPath) {
    try {
      if (fs.existsSync(backupPath) && fs.existsSync(`${backupPath}/live`)) {
        const entries = fs.readdirSync(`${backupPath}/live`);
        if (entries.filter((name) => name !== 'README').length > 0) return true;
      }
    } catch (err) {
      return true;
    }
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

  // With nothing to protect this is byte-for-byte the copy it has always been,
  // so the ordinary path keeps its exact previous semantics.
  if (protectedLineages.size === 0) {
    await command(`cp -rf ${source}/* ${backupPath}`);
    return;
  }

  // `${source}/*` above is a shell glob, which never matches dotfiles. The walk
  // below skips them for the same reason: otherwise enabling protection would
  // silently start backing up files the bulk copy never included, such as
  // migrate_renewal.js's .nginx-server-renewal-schema marker.
  const visible = (dir) => fs.readdirSync(dir).filter((name) => !name.startsWith('.'));

  for (const entry of visible(source)) {
    if (!LINEAGE_DIRS.includes(entry)) {
      // `cp -rf <dir> <backup>` merges into an existing directory of the same
      // name, exactly as the bulk copy did.
      await commandSafe('cp', ['-rf', `${source}/${entry}`, backupPath]);
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
      await commandSafe('cp', ['-rf', `${source}/${entry}/${child}`, destDir]);
    }
  }
};

exports.checkCertFiles = (id, { cert_path, cert_key_path, cert_domains, status }) => {
  const certs = require("../config.json");

  if (!certs[id]) return false;

  if (status === 'invalid') return false;

  if (status === 'staging' && certs[id].mode === 'letsencrypt') return false;

  if (status === 'valid' && certs[id].mode === 'letsencrypt-staging' && process.env.FORCE_VALID2STAGING) return false;

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
