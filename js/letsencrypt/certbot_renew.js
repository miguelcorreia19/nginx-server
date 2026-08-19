const { parseCerts, certbotBackupEnabled, listRenewalStems, isDesiredLetsencryptEntry, backupCertbotState } = require("./utils.js");
const fs = require("fs");
const path = require("path");
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

// ---- Reload readiness -----------------------------------------------------
// The renewed flag and this marker answer two different questions, and only
// the pair of them together authorises an nginx reload:
//
//   renewed flag   Certbot's deploy hook ran, so at least one certificate was
//                  actually renewed. Written by Certbot, before this script
//                  has done anything with the new material.
//   reload-ready   this script finished every required post-renewal step —
//                  discovery, export to /etc/ssl/certs, and the backup when it
//                  is enabled. Written here, last.
//
// nginx serves the exported copies under /etc/ssl/certs, not the lineage under
// /etc/letsencrypt/live, so a renewal whose export failed has changed nothing
// nginx can see: reloading on the flag alone would be reloading onto the old
// files at best, and onto a half-written export at worst. Hence the second
// signal, and hence its position at the very end of the flow.
//
// certbot_renew.sh owns the path: it points this at a fixed filename inside
// the renewal lock directory it just created, and exports it unconditionally,
// overwriting whatever the environment held. That is deliberate — unlike
// CERTBOT_RENEWED_FLAG, this is not an operator-settable override, and an
// inherited value cannot redirect the marker anywhere. It is not configuration
// and is not documented as such; it exists only so these two processes can
// name the same private file. The lock directory is created fresh for each run
// and released (marker included) by the script's EXIT trap, so the marker
// cannot be stale and cannot outlive the run that wrote it.
//
// Absent when this module is run outside certbot_renew.sh (the tests that
// drive it directly, an operator invoking it by hand): there is no shell
// waiting on the signal, so there is nothing to raise.
const RELOAD_READY_MARKER_VALUE = 'reload-ready-v1';

const signalReloadReady = () => {
  const marker = process.env.CERTBOT_INTERNAL_RELOAD_READY;
  if (!marker) return;
  // Deliberately not swallowed: a marker that cannot be written means the
  // reload cannot be authorised, which is a failed run rather than a silently
  // skipped reload. It reaches the caller's catch like any other failure.
  fs.writeFileSync(marker, `${RELOAD_READY_MARKER_VALUE}\n`);
};

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
  // Set when `certbot renew` exited non-zero *and* the deploy-hook flag proves
  // at least one certificate renewed anyway — a partial renewal. The failure is
  // held here rather than raised, so the certificates that did renew still go
  // through the one post-processing path below, and is re-raised as a non-zero
  // exit once that path has completed. See the branch that sets it.
  let partialRenewalFailure = null;

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
    try {
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
    } catch (err) {
      // `certbot renew` renews every due certificate it can and exits non-zero
      // if *any* of them failed, so its exit status alone cannot tell "nothing
      // renewed" from "one lineage is broken and the rest renewed fine". One
      // unrenewable lineage used to abort the whole run here, which threw away
      // the certificates that had just been renewed successfully: they stayed
      // in /etc/letsencrypt/live and were never exported to the /etc/ssl/certs
      // copies nginx actually reads, so nginx kept serving the old ones until
      // a later run happened to succeed outright.
      //
      // The deploy-hook flag settles which of the two it was. Certbot touches
      // it only for a certificate it actually renewed and deployed, so its
      // presence is direct evidence of work worth keeping, independent of the
      // exit status. Absent, this is a total failure and stays fail-fast.
      if (!fs.existsSync(renewedFlag)) throw err;

      partialRenewalFailure = err;
      warn(`certbot renew failed, but its deploy hook recorded at least one successful renewal: ${err.error || err.message || err}`);
      // Indented continuation as a plain line, matching this file's other
      // multi-line reports (and certbot_renew.sh's): the severity belongs to
      // the WARNING above it, not repeated on every line of the same message.
      log('  continuing with export and post-processing so the certificates that did renew are applied; this run will still be reported as failed');
    }

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
      // Same sibling derivation as the startup export in ./index.js: chain.pem
      // lives in the directory Certbot reported the private key in. The former
      // `cert_key_path.replace('privkey', 'chain')` rewrote the first match
      // anywhere in the path, so a cert id containing "privkey" corrupted the
      // directory component instead of the filename.
      await commandSafe('cp', [path.join(path.dirname(cert_key_path), 'chain.pem'), chainDest]);

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

    // Everything the renewal run has to do is done and succeeded. Only now may
    // nginx be told to pick the exported certificates up — see the comment on
    // signalReloadReady above for why the renewed flag alone is not enough.
    signalReloadReady();
  } catch (err) {
    // Reached by a failure in any required step: discovery, export, backup, or
    // the readiness signal itself. The marker is written last and only on the
    // success path, so it is necessarily absent here and nginx will not be
    // reloaded. A partial renewal that then failed in post-processing is
    // reported through this same path — the exit status is non-zero either
    // way, and the partial-renewal warning above is already in the log.
    error(`certbot renewal failed: ${err.error || err.message || err}`);
    process.exit(1);
  }

  if (partialRenewalFailure) {
    // Post-processing completed, so the renewed certificates have been exported
    // and nginx may reload — but certbot itself failed, and the run is reported
    // as failed so monitoring still sees an unhealthy renewal.
    error('Partial renewal: the certificates that did renew were exported successfully, but certbot renew failed for at least one other certificate — reporting this run as failed');
    process.exit(1);
  }
};

module.exports = { formatValidity, shellQuote };

// Run only when invoked directly (`node letsencrypt/certbot_renew.js`) so the
// module can be required by tests without triggering a real renewal.
if (require.main === module) {
  start();
}
