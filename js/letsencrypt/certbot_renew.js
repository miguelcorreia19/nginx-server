const { parseCerts, certbotBackupEnabled } = require("./utils.js");
const { command, commandSafe } = require("../utils.js");
const migrateRenewalConfigs = require("./migrate_renewal");

// Consistent, container-friendly logging via the shared logger. This script's
// stdout is captured by certbot_renew.sh, whose output is redirected by cron
// straight into /var/log/certbot/certbot_renew.log (outside Docker's log
// pipeline), so every line carries its own "<ISO timestamp> [certbot_renew.js]"
// prefix rather than relying on Docker's own log timestamps.
const { createLogger } = require("../logger.js");
const { log, warn, error } = createLogger("certbot_renew.js");

// Human-readable expiry derived from the parsed Luxon validity. Logging only —
// no behavior depends on this, and an unparseable/missing validity is tolerated.
const formatValidity = (validity) => {
  if (!validity || !validity.isValid) return 'unknown';
  const days = Math.round(validity.diffNow('days').days);
  if (days > 0) return `expires in ${days} day${days === 1 ? '' : 's'}`;
  if (days === 0) return 'expires today';
  return `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
};

const start = async () => {
  try {
    log('Starting certificate renewal');

    // Defensively ensure every renewal config uses webroot before renewing
    // (also done at container startup). In-place + non-fatal; the original is
    // preserved on any failure. Renewal correctness does not depend on this:
    // the certbot command below forces webroot explicitly.
    migrateRenewalConfigs();

    // Renew using the webroot authenticator, serving the http-01 challenge from
    // the shared webroot that nginx keeps available on port 80. The explicit
    // `--webroot -w` overrides any stored authenticator for this run, so even a
    // not-yet-migrated config renews via webroot (never standalone) — port 80 is
    // never disabled. (Verified: `certbot renew --webroot -w <path>` selects the
    // webroot authenticator regardless of the renewal config's authenticator.)
    //
    // `--deploy-hook` is Certbot's supported "a certificate was renewed and
    // deployed" signal: it runs ONLY for certificates that are actually renewed
    // in this run (never on a "not yet due" no-op). The hook touches a flag file;
    // certbot_renew.sh reloads nginx only if that flag exists afterward, so nginx
    // is reloaded only when at least one certificate actually changed. The flag
    // path is an internal value supplied by certbot_renew.sh.
    const renewedFlag = process.env.CERTBOT_RENEWED_FLAG || '/tmp/certbot-renewed.flag';
    const renewOutput = await command(
      `certbot renew --webroot -w /var/www/certbot --noninteractive --deploy-hook "touch '${renewedFlag}'"`
    );
    // Surface certbot's own renewal report (which certs were due, skipped,
    // renewed, or failed) verbatim for troubleshooting.
    if (renewOutput) console.log(renewOutput);

    log('certbot renew finished');

    const final_certificates = await parseCerts();
    const ids = Object.keys(final_certificates);

    log(`Certificate status summary: ${ids.length} certificate(s)`);
    if (ids.length === 0) {
      warn('no certificates found after renewal');
    }

    for (const id of ids) {
      const { cert_path, cert_key_path, cert_domains, status, validity } = final_certificates[id];

      // Export the certificate material to the well-known paths nginx reads
      // (behavior unchanged). Only file paths are logged — never key contents.
      const fullchainDest = `/etc/ssl/certs/${id}_fullchain.pem`;
      const privkeyDest = `/etc/ssl/certs/${id}_privkey.pem`;
      const chainDest = `/etc/ssl/certs/${id}_chain.pem`;
      await commandSafe('cp', [cert_path, fullchainDest]);
      await commandSafe('cp', [cert_key_path, privkeyDest]);
      await commandSafe('cp', [cert_key_path.replace('privkey', 'chain'), chainDest]);

      log(`- ${id}: ${status}`);
      log(`  domains: ${cert_domains.join(', ')}`);
      log(`  validity: ${formatValidity(validity)}`);
      log(`  exported:`);
      log(`    fullchain: ${fullchainDest}`);
      log(`    privkey:   ${privkeyDest}`);
      log(`    chain:     ${chainDest}`);
    }

    // Backup Let's Encrypt state if enabled (behavior unchanged).
    if (certbotBackupEnabled()) {
      log(`Backing up Let's Encrypt state to ${process.env.CERTBOT_BACKUP_PATH}`);
      await command(`cp -rf /etc/letsencrypt/* ${process.env.CERTBOT_BACKUP_PATH}`);
      log('Backup completed');
    }
  } catch (err) {
    error(`certbot renewal failed: ${err.error || err.message || err}`);
    process.exit(1);
  }
};

module.exports = { formatValidity };

// Run only when invoked directly (`node letsencrypt/certbot_renew.js`) so the
// module can be required by tests without triggering a real renewal.
if (require.main === module) {
  start();
}
