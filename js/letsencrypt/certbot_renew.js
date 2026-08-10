const { parseCerts, certbotBackupEnabled, listRenewalStems, isDesiredLetsencryptEntry, backupCertbotState } = require("./utils.js");
const { commandSafe } = require("../utils.js");
const migrateRenewalConfigs = require("./migrate_renewal");

// Consistent, container-friendly logging via the shared logger. This script's
// stdout is captured by certbot_renew.sh, whose output is redirected by cron
// straight into /var/log/certbot/certbot_renew.log (outside Docker's log
// pipeline), so every line carries its own "<ISO timestamp> [certbot_renew.js]"
// prefix rather than relying on Docker's own log timestamps.
const { createLogger } = require("../logger.js");
const { log, warn, error } = createLogger("certbot_renew.js");

// POSIX single-quoting, for the one value that unavoidably crosses a shell
// boundary.
//
// The certbot invocation itself is an argument vector now (commandSafe below),
// so nothing in it is shell-interpreted. --deploy-hook is the exception:
// Certbot has no argv form for hooks — it stores the hook as a string and runs
// it through a shell when a certificate is actually deployed — so the flag path
// is inside a command string no matter how certbot is invoked.
//
// Single quotes make every character in between literal, which is what removes
// the injection/quoting fragility: a path containing spaces, `;`, `$(...)`,
// backticks or `&&` is passed to touch(1) as one literal filename. The single
// quote is the only character that cannot appear inside single quotes, so it is
// closed, escaped and reopened with the standard '\'' idiom.
//
// Quoting is not the whole job: it settles what the *shell* does with the
// value, not what touch(1) then does with its own argv. A quoted '-d' is still
// one word, and still an option to touch — verified against the pinned
// runtime's BusyBox 1.37.0, which answers `touch: unrecognized option: x` for
// '-x'. CERTBOT_RENEWED_FLAG is an operator-settable override (certbot_renew.sh
// documents it and exports whatever it is given), so the hook below ends touch's
// options with `--` before the quoted path.
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

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
    //
    // Invoked with commandSafe (execFile): certbot's own arguments are passed as
    // an argument vector, so CERTBOT_RENEWED_FLAG cannot break out of the
    // command line the way it could when the whole invocation was one shell
    // string. Every element of that vector is a fixed literal except the hook,
    // which always begins "touch ", so none of them can be read as an
    // unintended certbot option. The hook value is still a command string
    // because Certbot runs hooks through a shell, so the path is single-quoted
    // by shellQuote above and guarded from touch's own option parsing with
    // `--` — see that comment for the remaining, unavoidable trust boundary.
    const renewedFlag = process.env.CERTBOT_RENEWED_FLAG || '/tmp/certbot-renewed.flag';
    const renewOutput = await commandSafe('certbot', [
      'renew',
      '--webroot', '-w', '/var/www/certbot',
      '--noninteractive',
      '--deploy-hook', `touch -- ${shellQuote(renewedFlag)}`,
    ]);
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

    // Backup Let's Encrypt state if enabled.
    //
    // This runs from cron, so it repeats daily for as long as a damaged lineage
    // exists — it poisons a healthy backup just as the startup write did, and
    // more often. It has no access to the handler's in-memory entry set, so the
    // protected lineages are recomputed here from the same three inputs the
    // handler uses: the renewal stems, this run's discovery result, and
    // config.json read through the shared desired-entry rule.
    if (certbotBackupEnabled()) {
      let protectedLineages = null;
      try {
        const configured = require("../config.json");
        protectedLineages = listRenewalStems().filter(
          (stem) => !final_certificates[stem] && isDesiredLetsencryptEntry(configured[stem])
        );
      } catch (err) {
        // Same stance as startup: an unknown protected set means the backup
        // cannot be updated safely, and skipping one write is the harmless half
        // of that trade.
        warn(`Skipping backup: could not determine which lineages to protect (${err.message})`);
      }

      if (protectedLineages) {
        log(`Backing up Let's Encrypt state to ${process.env.CERTBOT_BACKUP_PATH}`);
        if (protectedLineages.length > 0) {
          log(`Preserving the existing backup for ${protectedLineages.length} lineage(s) Certbot could not enumerate: ${protectedLineages.join(', ')}`);
        }
        await backupCertbotState({ protectedLineages });
        log('Backup completed');
      }
    }
  } catch (err) {
    error(`certbot renewal failed: ${err.error || err.message || err}`);
    process.exit(1);
  }
};

module.exports = { formatValidity, shellQuote };

// Run only when invoked directly (`node letsencrypt/certbot_renew.js`) so the
// module can be required by tests without triggering a real renewal.
if (require.main === module) {
  start();
}
