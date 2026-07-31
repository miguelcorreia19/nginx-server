// Is the backed-up state for one lineage usable recovery material?
//
// This answers that question WITHOUT touching anything real. It copies only the
// requested lineage into a throwaway Certbot tree, points that tree's renewal
// config at itself, and asks the pinned Certbot to enumerate it there. Nothing
// under /etc/letsencrypt or CERTBOT_BACKUP_PATH is read as lineage material or
// written at any point.
//
// It is a standalone primitive: nothing calls it yet. Per-lineage restore is a
// separate decision, and this deliberately stops at "yes/no, and why".
//
// Why the sandbox needs a rewrite step: a backup is produced by copying
// /etc/letsencrypt wholesale, so its renewal configs still carry absolute
// /etc/letsencrypt paths. Handing that config to `certbot certificates
// --config-dir <sandbox>` makes Certbot read the *live* files and report on
// them instead — verified against Certbot 5.6, where destroying live material
// made an intact backup fail validation. Rewriting the sandbox copy's paths is
// what makes the isolation real.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { commandSafe } = require("../utils.js");
const {
  parseCertbotCertificatesOutput,
  certbotReportedNoCertificates,
  checkCertFiles,
  isDesiredLetsencryptEntry,
} = require("./utils.js");

const { createLogger } = require("../logger.js");
const { warn } = createLogger("letsencrypt");

// The renewal-config keys whose values are absolute paths into the Certbot
// tree. Only these are rewritten; every other line — server, authenticator,
// webroot_path, account, comments, blank lines — is passed through untouched,
// the same line-preserving approach migrate_renewal.js uses.
const PATH_KEYS = ['archive_dir', 'cert', 'privkey', 'chain', 'fullchain'];
const PATH_LINE = new RegExp(`^(\\s*)(${PATH_KEYS.join('|')})(\\s*=\\s*)(.*)$`);

// Repoint a renewal config at `configDir`, whatever Certbot tree it was written
// for. Values look like <root>/archive/<id> or <root>/live/<id>/cert.pem, so the
// segment from archive/ or live/ onward is kept and only the root is replaced.
const rewriteRenewalPaths = (content, configDir) =>
  content
    .split('\n')
    .map((line) => {
      const match = line.match(PATH_LINE);
      if (!match) return line;
      const [, indent, key, separator, value] = match;
      return `${indent}${key}${separator}${value.replace(/^.*?\/(archive|live)\//, `${configDir}/$1/`)}`;
    })
    .join('\n');

exports.rewriteRenewalPaths = rewriteRenewalPaths;

const invalid = (reason, detail) => (detail ? { valid: false, reason, detail } : { valid: false, reason });

exports.validateBackupLineage = async (id, overrides = {}) => {
  const backupPath = 'backupPath' in overrides ? overrides.backupPath : process.env.CERTBOT_BACKUP_PATH;
  const tmpRoot = overrides.tmpRoot || os.tmpdir();
  // config.json is the current desired configuration, and reading it here keeps
  // one interpretation of "desired" shared with checkCertFiles() below.
  const certs = require("../config.json");
  const entry = certs[id];

  if (!isDesiredLetsencryptEntry(entry)) return invalid('not-desired');
  if (!backupPath) return invalid('no-backup-path');

  const source = {
    renewal: `${backupPath}/renewal/${id}.conf`,
    live: `${backupPath}/live/${id}`,
    archive: `${backupPath}/archive/${id}`,
  };

  // A lineage is one recovery unit: all three parts or nothing. Missing pieces
  // are never manufactured, and live state is never used to fill them in.
  for (const [part, from] of Object.entries(source)) {
    if (!fs.existsSync(from)) return invalid(`backup-${part}-missing`);
  }

  let sandbox;
  try {
    sandbox = fs.mkdtempSync(path.join(tmpRoot, 'certbot-validate-'));
  } catch (err) {
    // Being unable to validate is an operational failure, not a verdict on the
    // backup — it must not be reported as "this backup is unusable".
    throw new Error(`Could not create a validation sandbox for "${id}": ${err.message}`);
  }

  const configDir = path.join(sandbox, 'config');
  const workDir = path.join(sandbox, 'work');
  const logsDir = path.join(sandbox, 'logs');

  try {
    for (const dir of [path.join(configDir, 'renewal'), path.join(configDir, 'live'),
                       path.join(configDir, 'archive'), workDir, logsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // `cp -rf` keeps live/<id>'s symlinks into archive/<id> as symlinks; Certbot
    // rejects a lineage whose live entries are regular files.
    await commandSafe('cp', ['-rf', source.archive, path.join(configDir, 'archive', id)]);
    await commandSafe('cp', ['-rf', source.live, path.join(configDir, 'live', id)]);

    // The rewrite happens on the sandbox copy only — the backup's own renewal
    // config is read and never written.
    fs.writeFileSync(
      path.join(configDir, 'renewal', `${id}.conf`),
      rewriteRenewalPaths(fs.readFileSync(source.renewal, 'utf8'), configDir)
    );

    let output;
    try {
      output = await commandSafe('certbot', [
        'certificates',
        '--config-dir', configDir,
        '--work-dir', workDir,
        '--logs-dir', logsDir,
      ]);
    } catch (err) {
      // `certbot certificates` exits 0 for every enumeration outcome, including
      // a config it cannot read, so a non-zero exit means Certbot itself could
      // not run — again an operational failure rather than a verdict.
      throw new Error(`Could not run certbot to validate "${id}": ${err.error || err.message || err}`);
    }

    if (certbotReportedNoCertificates(output)) return invalid('not-enumerated');

    const found = parseCertbotCertificatesOutput(output);
    const cert = found[id];

    if (!cert) {
      // A lineage under any other name is not recovery material for this site:
      // the project's reconciliation keys on site id == cert-name, so adopting
      // a differently named certificate would immediately look like an orphan.
      const others = Object.keys(found);
      return others.length > 0
        ? invalid('wrong-cert-name', others.join(', '))
        : invalid('not-enumerated');
    }

    // Environment. Certbot derives its TEST_CERT marker — which parseCerts maps
    // to status "staging" — from the renewal config's `server` line, so the
    // parsed status is the environment marker without hardcoding endpoint URLs
    // anywhere. Checked in both directions: recovery material from the wrong
    // environment is rejected rather than silently restored.
    const wantStaging = entry.mode === 'letsencrypt-staging';
    if (cert.status === 'invalid') return invalid('certificate-invalid');
    if (wantStaging !== (cert.status === 'staging')) {
      return invalid('environment-mismatch', `wanted ${wantStaging ? 'staging' : 'production'}, backup is ${cert.status}`);
    }

    // Identifier compatibility, attributed for the caller. checkCertFiles()
    // below remains the authority — this repeats its comparison only so the
    // reason can name what failed.
    const missing = entry.names.filter((name) => !cert.cert_domains.includes(name));
    const extra = cert.cert_domains.filter((name) => !entry.names.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      return invalid('identifier-mismatch', `backup covers ${cert.cert_domains.join(', ')}`);
    }

    // The application's own final say on whether a parsed certificate is usable
    // for this site — status, environment, file presence and exact name match.
    // Its file checks resolve inside the sandbox, because the paths Certbot
    // reported are the rewritten ones.
    if (!checkCertFiles(id, cert)) return invalid('rejected-by-certificate-checks');

    return { valid: true, cert_domains: cert.cert_domains, status: cert.status, validity: cert.validity };
  } finally {
    // Always: a sandbox holds a copy of a private key and must not outlive the
    // check, whatever the verdict was.
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch (err) {
      warn(`Could not remove the validation sandbox ${sandbox}: ${err.message}`);
    }
  }
};
