const { parseCerts, checkCertFiles, hasManagedCertbotState, certbotBackupEnabled, listRenewalStems, renewalConfigPath } = require("./utils.js");
const fs = require("fs");
const { command, commandSafe, configFiles } = require("../utils.js");
const { validateCronExpression } = require("../validate.js");
const { createCert, deleteCert, createConf } = require("./manage_certs.js");

const { createLogger } = require("../logger.js");
const { log, warn, error, fatal } = createLogger("letsencrypt");

module.exports = async () => {
  await command(`mkdir -p ${process.env.CERTBOT_BACKUP_PATH}`);
  const _certs = require("../config.json");

  const certs = { ..._certs };

  for (let id in certs) {
    // Only an *omitted* mode defaults to letsencrypt, matching validateConfigEntry
    // in ../validate.js — central validation has already rejected every other
    // falsy value (e.g. "", null, false, 0) as fatal, so this can never see one.
    if (certs[id].mode === undefined) {
      certs[id].mode = 'letsencrypt';
    }
    if (certs[id].mode !== 'letsencrypt-staging' && certs[id].mode !== 'letsencrypt') {
      delete certs[id];
    }
  }

  // Wildcard names can never reach this point: startup config validation
  // (validateConfigEntry in ../validate.js) already rejects a wildcard name
  // combined with mode "letsencrypt"/"letsencrypt-staging" before any handler
  // runs, since this image's built-in Let's Encrypt flow only implements
  // http-01 (no DNS-01).

  // NOTE: there is deliberately no early return here. config.json is the
  // source of truth for the Certbot lineages this project manages, so a
  // lineage with no matching letsencrypt/letsencrypt-staging entry has to be
  // deleted even when that leaves zero configured entries — otherwise
  // removing the *last* LE site would keep its lineage forever, while
  // removing one of two already deletes it. The zero-entry return now sits
  // after that cleanup (see below); everything past it needs actual current
  // entries, so it stays gated.

  // The one exception, and only when the local filesystem *proves* the cleanup
  // below could find nothing: no renewal config for Certbot to enumerate and no
  // backup that would be restored. Then `certbot certificates` can only report
  // nothing, so running it would be pure ceremony — and it would make an
  // http/custom-only deployment fail to start whenever Certbot is unhealthy.
  // Every uncertain case (any renewal *.conf, a populated backup, an
  // unreadable directory) keeps the full path below.
  if (Object.keys(certs).length === 0 && !hasManagedCertbotState()) {
    log("No Let's Encrypt sites configured and no Certbot state to reconcile");
    return;
  }

  try {
    const certificates = await parseCerts(true);
    // certificates = {
    //  id: {
    //    cert_path: string
    //    cert_key_path: string
    //    cert_domains: array
    //    status: 'valid' | 'invalid' | 'staging'
    //    validity: luxon date
    //  }
    // }

    // Renewal configs Certbot did not enumerate. Certbot lists lineages from
    // /etc/letsencrypt/renewal/*.conf, so a stem with no matching discovery
    // result is managed state the reconciliation below can never see — it is
    // absent from `certificates`, which is what every existing loop iterates.
    //
    // Called "undiscoverable" rather than "corrupt" on purpose: the set
    // difference proves only that Certbot did not enumerate the lineage, not
    // why. Every audited example is an unparseable renewal config, but the
    // detection makes no claim beyond non-enumeration.
    //
    // Deliberately computed *after* parseCerts(true): that call can restore a
    // certificate backup and so change the renewal directory. Snapshotting the
    // stems beforehand would miss whatever this startup restored.
    let undiscoverable = [];
    // Unresolved managed state still present after this pass.
    let cleanupIncomplete = false;
    // Renewal metadata gone, but Certbot reported failure and inert files may
    // remain. Nothing is left to reconcile, so this is not "incomplete" — but
    // the summary should not read as an unqualified success either.
    let cleanupPartial = false;
    try {
      undiscoverable = listRenewalStems().filter((stem) => !certificates[stem]);
    } catch (err) {
      // Absence was not proven, so nothing may be deleted on this evidence.
      // The discovered-lineage workflow below is unaffected and still runs.
      cleanupIncomplete = true;
      warn(`Could not enumerate renewal configs (${err.message}) — skipping undiscoverable-lineage cleanup this startup`);
    }

    // Split by the same source-of-truth rule the discovered lineages use:
    // `certs` is already the effective letsencrypt/letsencrypt-staging set,
    // with an omitted mode defaulted to letsencrypt above. A stem can only fall
    // into one of these branches, and never into the discovered-lineage cleanup
    // further down, which iterates the parse result these stems are absent from.
    for (const stem of undiscoverable) {
      if (certs[stem]) {
        // Still configured for Let's Encrypt. The lineage may well be sitting
        // on usable certificate material, so deleting it here would destroy
        // state the operator still wants and force a fresh issuance. Surface
        // it instead — making the condition visible is the whole remit.
        cleanupIncomplete = true;
        warn(`Certificate "${stem}" has a renewal config (${renewalConfigPath(stem)}) that Certbot did not enumerate, so it is invisible to certificate reconciliation`);
        warn(`  Left in place: "${stem}" is still configured as mode "${certs[stem].mode}". Startup continues with the normal flow for this site below.`);
        continue;
      }

      log(`Removing undiscoverable certificate ${stem} (no longer in config.json)`);

      const deleted = await deleteCert(stem);
      if (deleted) {
        log(`Certificate ${stem} deleted`);
        continue;
      }

      // Certbot 5.6 fails on a structurally unparseable renewal config yet
      // still removes that config, leaving live/ and archive/ behind. Those are
      // inert once the renewal config is gone — Certbot no longer enumerates
      // them — so they are deliberately left alone rather than removed by hand.
      if (!fs.existsSync(renewalConfigPath(stem))) {
        cleanupPartial = true;
        warn(`Certificate ${stem} deletion reported failure, but its renewal config was removed — inert files may remain under /etc/letsencrypt/{live,archive}/${stem}`);
      } else {
        cleanupIncomplete = true;
        error(`Certificate ${stem} deletion failed and its renewal config remains — cleanup will be retried on the next startup`);
      }
    }

    // Manage certificates
    for (let id in certs) {

      if (certificates[id]) {
        log(`Certificate ${id} found`);

        const check = checkCertFiles(id, certificates[id]);

        if (!check) { // have issues?
          log(`Certificate ${id} has issues — recreating`);

          const deleted = await deleteCert(id);
          if (deleted) log(`Certificate ${id} deleted`);
          else error(`Certificate ${id} deletion failed`);

          await command("certbot certificates");

          log(`Recreating certificate ${id}`);

          const created = await createCert(id);

          if (created) log(`Certificate ${id} created`);
          else error(`Certificate ${id} creation failed`);

        }
      } else { // not exists

        log(`Certificate ${id} does not exist — creating`);

        const created = await createCert(id);

        if (created) log(`Certificate ${id} created`);
        else error(`Certificate ${id} creation failed`);
      }
    }

    // Delete certificates that are no longer in config.json. `certs` holds only
    // the current letsencrypt/letsencrypt-staging entries, so this covers both
    // modes and can only ever match a lineage certbot itself issued — custom
    // and http sites never have one.
    for (let id in certificates) {
      if (!certs[id]) {
        log(`Removing old certificate ${id} (no longer in config.json)`);

        const deleted = await deleteCert(id);
        if (deleted) log(`Certificate ${id} deleted`);
        else error(`Certificate ${id} deletion failed`);
      }
    }

    // Certificate lifecycle is now reconciled. With no configured LE site left
    // there is nothing to issue, export, generate config for, or renew — and
    // nginx state is rebuilt by production startup itself (../reconcile.js),
    // not here — so stop before all of that.
    if (Object.keys(certs).length === 0) {
      if (cleanupIncomplete) warn("No Let's Encrypt sites configured; certificate cleanup incomplete (see warnings above)");
      else if (cleanupPartial) log("No Let's Encrypt sites configured; certificate cleanup completed with warnings");
      else log("No Let's Encrypt sites configured; certificate cleanup completed");
      return;
    }

    // Verify and export certificate files
    const final_certificates = await parseCerts();

    log("Building certificate map...");

    for (let id in certs) {

      if (final_certificates[id]) {
        const { status, cert_path, cert_key_path } = final_certificates[id];
        if (status !== 'invalid') {
          await commandSafe('cp', [cert_path, `/etc/ssl/certs/${id}_fullchain.pem`]);
          await commandSafe('cp', [cert_key_path, `/etc/ssl/certs/${id}_privkey.pem`]);
          await commandSafe('cp', [cert_key_path.replace('privkey', 'chain'), `/etc/ssl/certs/${id}_chain.pem`]);
        }
        await createConf(id, final_certificates[id]);
      } else {
        await createConf(id, { status: 'invalid', cert_path: '', cert_key_path: '' });
      }
    }

    // Certificate status summary
    const ids = Object.keys(certs);
    log(`Certificate status summary: ${ids.length} certificate(s)`);
    for (const id of ids) {
      if (!final_certificates[id]) {
        log(`- ${id}: invalid`);
        log(`  domains: ${certs[id].names.join(', ')}`);
      } else {
        const { cert_domains, status } = final_certificates[id];
        log(`- ${id}: ${status}`);
        log(`  domains: ${cert_domains.join(', ')}`);
      }
    }

    // Back up Let's Encrypt state (optional)
    if (certbotBackupEnabled()) {
      log(`Backing up Let's Encrypt state to ${process.env.CERTBOT_BACKUP_PATH}`);
      await command(`cp -rf /etc/letsencrypt/* ${process.env.CERTBOT_BACKUP_PATH}`);
      log('Backup completed');
    }

    // Set up automatic renewal
    log('Setting up automatic renewal...');
    await command(`crontab -l | grep -v '/usr/local/bin/certbot_renew.sh'  | crontab -`)
    let cronjob = "0 5 * * *";
    if (process.env.CERTBOT_RENEW_CRONJOB) {
      try {
        validateCronExpression(process.env.CERTBOT_RENEW_CRONJOB);
        cronjob = process.env.CERTBOT_RENEW_CRONJOB;
      } catch (err) {
        warn(`Invalid CERTBOT_RENEW_CRONJOB: ${err.message}. Using default: ${cronjob}`);
      }
    }
    const cronLine = `${cronjob} /bin/bash /usr/local/bin/certbot_renew.sh >> /var/log/certbot/certbot_renew.log\n`;
    fs.appendFileSync('/etc/crontabs/root', cronLine);

    // ACTIVATE CRONTAB
    await command(`crond -bS -c /var/spool/cron/crontabs`);


    // Link nginx site configs. This handler is purely additive here: production
    // startup has already cleared /etc/nginx/conf.d/{80,443} and restored both
    // default vhosts (reconcileProductionConfig in ../reconcile.js), so there is
    // nothing to clean up and no default vhost to put back. Previously this
    // handler wiped both directories on behalf of every mode — but only when it
    // had at least one entry of its own, which left removed custom/http/LE
    // sites still being served after a restart of the same container.
    if(Object.keys(final_certificates).length > 0)
      for (let id in certs) {
        if (!final_certificates[id]) continue;
        const { status, cert_domains } = final_certificates[id];
        await configFiles(id, status, certs[id].http_redirect, cert_domains);
      }

    log("Let's Encrypt startup completed");
  } catch (err) {
    fatal("setup failed —", err);
    throw err;
  }
}
