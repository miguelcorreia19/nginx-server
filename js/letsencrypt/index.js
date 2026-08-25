const { parseCerts, checkCertFiles, hasManagedCertbotState, certbotBackupEnabled, listRenewalStems, renewalConfigPath, backupCertbotState } = require("./utils.js");
const fs = require("fs");
const path = require("path");
const { command, commandSafe, configFiles } = require("../utils.js");
const { validateCronExpression } = require("../validate.js");
const { createCert, deleteCert, createConf } = require("./manage_certs.js");
const { validateBackupLineage } = require("./validate_backup.js");
const { restoreLineageFromBackup, recoverInterruptedRestores } = require("./restore_lineage.js");
const { bootstrapLineageFromBackup, recoverInterruptedBootstraps } = require("./bootstrap_lineage.js");
const { exists, localLineagePaths } = require("./lineage_files.js");

const { createLogger } = require("../logger.js");
const { log, warn, error, fatal } = createLogger("letsencrypt");

module.exports = async () => {
  // execFile, not a shell string: CERTBOT_BACKUP_PATH is operator-supplied, so
  // interpolating it would word-split on whitespace and interpret any shell
  // metacharacter it contains. Same binary and same flag as before.
  //
  // `--` because dropping the shell does not stop mkdir(1) from parsing its own
  // argv, and nothing validates this path: `CERTBOT_BACKUP_PATH=-mybackup` is
  // read as flags by this image's BusyBox 1.37.0 (`mkdir: invalid mode
  // 'ybackup'`, since -m takes the next characters as a mode). `--` ends option
  // parsing, so the path is treated as the directory to create.
  await commandSafe('mkdir', ['-p', '--', process.env.CERTBOT_BACKUP_PATH]);
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

  // Resolve any restore transaction a previous startup left half-applied. This
  // has to be the first thing that reads Certbot state at all: a crash partway
  // through a restore leaves renewal/<id>.conf absent while the original
  // lineage sits safely in the transaction directory, and every check below —
  // the fast path and discovery alike — would read that as "this lineage does
  // not exist".
  //
  // Both transaction namespaces are independent, so their leftovers cannot
  // interact; replacement is resolved first only because it is the older of the
  // two and nothing depends on the order.
  let recovered;
  try {
    recovered = [...recoverInterruptedRestores(), ...recoverInterruptedBootstraps()];
  } catch (err) {
    fatal("could not resolve an interrupted certificate transaction —", err);
    throw err;
  }

  // A leftover the recovery rule cannot classify is an integrity problem, not
  // an ordinary missing-backup one. Continuing could issue against a partially
  // moved lineage or overwrite the only remaining copy of its material, so
  // startup stops here — before discovery, issuance, the backup write or cron.
  const unresolved = recovered.filter(({ action }) => action === 'unrecognised' || action === 'failed');
  if (unresolved.length > 0) {
    for (const { id, error: reason, transactionDir } of unresolved) {
      error(`Interrupted certificate transaction for "${id}" could not be resolved${reason ? `: ${reason}` : ''}; its state is preserved at ${transactionDir}`);
    }
    const err = new Error(
      `Unresolved certificate transaction state for: ${unresolved.map(({ id }) => id).join(', ')}. ` +
      `Refusing to continue — the preserved copy may be the only one left.`
    );
    fatal("setup failed —", err);
    throw err;
  }

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
    // Pure discovery: parseCerts() reads Certbot state and changes nothing.
    // Recovery from a backup is decided per-lineage below, after
    // classification, against a validated source — rather than by copying the
    // whole backup over whatever is here.
    let certificates = await parseCerts();
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
    // Computed after discovery so the two describe the same moment. Discovery
    // no longer mutates anything, but per-lineage recovery below does, and it
    // reads this classification.
    let undiscoverable = [];
    // Lineages Certbot could not enumerate that config.json still wants. This
    // one set drives two decisions: their existing backup is preserved rather
    // than overwritten with this state, and issuance for them is suppressed
    // (see the loop below for why reissuing cannot repair them).
    const desiredUndiscoverable = [];
    // False once renewal configs could not be enumerated: the protected set is
    // then unknown, and a backup write could overwrite good state for a lineage
    // that was never checked.
    let lineagesClassified = true;
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
      lineagesClassified = false;
      warn(`Could not enumerate renewal configs (${err.message}) — skipping undiscoverable-lineage cleanup this startup`);
    }

    // Split by the same source-of-truth rule the discovered lineages use:
    // `certs` is already the effective letsencrypt/letsencrypt-staging set,
    // with an omitted mode defaulted to letsencrypt above. A stem can only fall
    // into one of these branches, and never into the discovered-lineage cleanup
    // further down, which iterates the parse result these stems are absent from.
    for (const stem of undiscoverable) {
      if (certs[stem]) {
        // Still configured for Let's Encrypt. Never deleted: the lineage may be
        // sitting on usable certificate material. Recovery from the backup is
        // attempted below, and only what is still broken afterwards is warned
        // about — warning here would contradict a restore that then succeeds.
        desiredUndiscoverable.push(stem);
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

    // One classification, two lifetimes. Backup protection stays frozen as it
    // was at discovery — a lineage restored during this startup keeps its
    // previous backup copy untouched until a later, cleanly healthy startup
    // updates it. Issuance suppression is lifted the moment a restore is
    // verified, so the site can be served in this same startup.
    const backupProtectedLineages = [...desiredUndiscoverable];
    const suppressed = new Set(desiredUndiscoverable);

    // Recover a still-configured lineage from its protected backup, but only
    // when the backup feature is on: CERTBOT_BACKUP is the single opt-in for
    // both keeping backups and using them. Nothing here mutates live state
    // unless the backup has first been proven, in isolation, to be a usable
    // replacement for this exact site.
    for (const id of desiredUndiscoverable) {
      if (!certbotBackupEnabled()) break;

      let verdict;
      try {
        verdict = await validateBackupLineage(id);
      } catch (err) {
        // Being unable to check is not a verdict on the backup, and it happens
        // before any live mutation — degrade this site and carry on.
        error(`Certificate ${id}: could not check the backup (${err.message})`);
        continue;
      }

      if (!verdict.valid) {
        warn(`Certificate ${id}: backup is not usable recovery material (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''})`);
        continue;
      }

      log(`Certificate ${id}: valid backup found — attempting recovery`);

      let transaction;
      try {
        transaction = restoreLineageFromBackup(id);
      } catch (err) {
        // The transaction rolls itself back before throwing. If its rollback
        // also failed it says so and leaves deterministic state behind, which
        // the next startup's recovery resolves — never cleaned up by hand here.
        error(`Certificate ${id}: restore failed — ${err.message}`);
        continue;
      }

      if (!transaction.committed) {
        warn(`Certificate ${id}: restore not attempted (${transaction.reason}${transaction.detail ? `: ${transaction.detail}` : ''})`);
        continue;
      }

      // Verify what was actually installed, against the live tree and the
      // application's own rules. Safe to re-run because discovery is pure: a
      // verification can never itself change what it is verifying.
      let restored;
      try {
        restored = await parseCerts();
        if (!restored[id]) throw new Error(`Certbot did not enumerate "${id}" after restore`);
        if (!checkCertFiles(id, restored[id])) throw new Error('the restored certificate does not satisfy this site\'s configuration');
      } catch (err) {
        try {
          transaction.rollback();
          error(`Certificate ${id}: the backup validated in isolation but the installed lineage failed verification (${err.message}) — the original lineage has been put back`);
        } catch (rollbackErr) {
          error(`Certificate ${id}: verification failed (${err.message}) and the rollback failed (${rollbackErr.message}) — state is preserved at ${transaction.transactionDir} and will be resolved on the next startup`);
        }
        // Either way the site stays suppressed and backup-protected, so nothing
        // downstream can issue for it or overwrite its backup.
        continue;
      }

      const { finalized, transactionDir } = transaction.finalize();
      if (!finalized) {
        // A verified lineage is not un-restored over inert leftovers.
        warn(`Certificate ${id}: restored, but its transaction state at ${transactionDir} could not be removed; the next startup will clean it up`);
      }

      log(`Certificate ${id}: restored from the Certbot backup`);
      // The fresh discovery is authoritative for everything downstream — no
      // synthetic entry is spliced into the previous result.
      certificates = restored;
      suppressed.delete(id);
    }

    // Whatever is still undiscoverable after recovery is preserved and left
    // alone, exactly as before automatic restore existed.
    for (const id of desiredUndiscoverable) {
      if (!suppressed.has(id)) continue;
      cleanupIncomplete = true;
      warn(`Certificate "${id}" has a renewal config (${renewalConfigPath(id)}) that Certbot did not enumerate, so it is invisible to certificate reconciliation`);
      warn(`  Left in place: "${id}" is still configured as mode "${certs[id].mode}", so its certificate files are preserved and its existing backup is protected.`);
      warn(`  Issuance suppressed: Certbot cannot reissue into a cert-name whose renewal config it cannot read — it would create "${id}-0001" instead, which this image would then delete as an orphan. Repair or restore ${renewalConfigPath(id)} to resume normal operation.`);
    }

    // The remaining desired sites have no certificate in the discovery result
    // and no renewal config either. They split by what the cert-name slot
    // actually holds, which decides whether issuing into it is even possible:
    //
    //   locally absent  nothing at all -> may bootstrap, else issue normally
    //   local residue   live/ or archive/ present -> neither is safe
    //
    // Classified straight from the filesystem rather than from the renewal
    // stems, so a site is still placed correctly even when stem enumeration
    // failed above.
    const locallyAbsent = [];
    const localResidue = new Set();
    for (const id in certs) {
      if (certificates[id] || suppressed.has(id)) continue;
      const slot = localLineagePaths(id);
      if (exists(slot.renewal)) {
        // A renewal config Certbot did not enumerate, found without the stem
        // list — same condition as above, so the same conservative answer.
        suppressed.add(id);
        cleanupIncomplete = true;
        warn(`Certificate "${id}" has a renewal config (${renewalConfigPath(id)}) that Certbot did not enumerate — issuance suppressed`);
        continue;
      }
      if (exists(slot.live) || exists(slot.archive)) localResidue.add(id);
      else locallyAbsent.push(id);
    }

    // Residue: certificate files under this cert-name with no renewal config to
    // describe them. Verified against the pinned Certbot 5.6 — issuing here
    // completes the ACME exchange and only *then* fails to store the result
    // ("archive directory exists for <id>"), spending a certificate that cannot
    // be kept, and leaving behind a zero-byte renewal config Certbot itself
    // then rejects. So neither issuance nor bootstrap is attempted, and the
    // files are left exactly as they are: they may be the only copy of a key.
    //
    // Deliberately stricter than Certbot, which tolerates an *empty* archive
    // directory: any existing path counts, rather than re-deriving Certbot's
    // internal emptiness test.
    for (const id of localResidue) {
      suppressed.add(id);
      const slot = localLineagePaths(id);
      const present = [
        exists(slot.live) ? slot.live : null,
        exists(slot.archive) ? slot.archive : null,
      ].filter(Boolean).join(', ');
      warn(`Certificate "${id}" has leftover certificate files (${present}) but no renewal config, so Certbot does not manage it`);
      warn(`  Issuance suppressed: Certbot would obtain a certificate and then fail to store it, because those paths already occupy the name "${id}" — the certificate would be spent and lost.`);
      warn(`  Recovery from backup was not attempted either, so nothing here is overwritten. Inspect those paths, keep anything you still need, then remove or rename them to return "${id}" to the normal issuance path.`);
    }

    // Bootstrap: a desired site with a completely empty slot may take its
    // certificate from the backup instead of asking the CA for a new one —
    // the container-replacement case. Gated on CERTBOT_BACKUP like every other
    // use of the backup, and only ever from a backup proven valid in isolation.
    // Unlike the undiscoverable path, a site that cannot be bootstrapped falls
    // through to ordinary issuance: an empty slot is exactly what a brand-new
    // site looks like.
    for (const id of locallyAbsent) {
      if (!certbotBackupEnabled()) break;

      const slotStillEmpty = () => {
        const slot = localLineagePaths(id);
        return !exists(slot.renewal) && !exists(slot.live) && !exists(slot.archive);
      };

      let verdict;
      try {
        verdict = await validateBackupLineage(id);
      } catch (err) {
        error(`Certificate ${id}: could not check the backup (${err.message})`);
        // Validation does not mutate, but only issue if that is still provable.
        if (!slotStillEmpty()) suppressed.add(id);
        continue;
      }

      if (!verdict.valid) {
        log(`Certificate ${id}: no usable backup (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''}) — continuing with normal issuance`);
        continue;
      }

      log(`Certificate ${id}: valid backup found — installing it instead of requesting a new certificate`);

      let transaction;
      try {
        transaction = bootstrapLineageFromBackup(id);
      } catch (err) {
        error(`Certificate ${id}: could not install the backup — ${err.message}`);
        // The transaction rolls itself back before throwing; issue only if the
        // slot really is empty again, never into partially installed material.
        if (!slotStillEmpty()) {
          suppressed.add(id);
          warn(`Certificate ${id}: its cert-name is not in a known state, so issuance is suppressed until the next startup resolves it`);
        }
        continue;
      }

      if (!transaction.committed) {
        // Something occupies the slot that was empty a moment ago. Reclassify
        // from what is actually there rather than assuming issuance is safe.
        warn(`Certificate ${id}: backup not installed (${transaction.reason}${transaction.detail ? `: ${transaction.detail}` : ''})`);
        if (!slotStillEmpty()) suppressed.add(id);
        continue;
      }

      // Verify what was installed, against live state and the application's own
      // rules. Safe to re-run because discovery is pure.
      let refreshed;
      try {
        refreshed = await parseCerts();
        if (!refreshed[id]) throw new Error(`Certbot did not enumerate "${id}" after installing the backup`);
        if (!checkCertFiles(id, refreshed[id])) throw new Error('the installed certificate does not satisfy this site\'s configuration');
      } catch (err) {
        try {
          transaction.rollback();
          // The slot is empty again, so this site is simply a new one.
          error(`Certificate ${id}: the backup validated in isolation but the installed lineage failed verification (${err.message}) — removed again; continuing with normal issuance`);
        } catch (rollbackErr) {
          error(`Certificate ${id}: verification failed (${err.message}) and the rollback failed (${rollbackErr.message}) — state is preserved at ${transaction.transactionDir} and will be resolved on the next startup`);
          suppressed.add(id);
        }
        continue;
      }

      const { finalized, transactionDir } = transaction.finalize();
      if (!finalized) {
        warn(`Certificate ${id}: installed from backup, but its transaction state at ${transactionDir} could not be removed; the next startup will clean it up`);
      }

      log(`Certificate ${id}: installed from the Certbot backup`);
      certificates = refreshed;
    }

    // Verified against the pinned Certbot 5.6: `certonly --cert-name <id>` on a
    // lineage whose renewal config cannot be read does not repair it. Certbot
    // cannot construct the existing lineage, so it takes the new-certificate
    // path, finds <id>.conf already occupying the name, and persists the result
    // as <id>-0001 — which matches no configured site and is deleted as an
    // orphan on the next startup. Issuing therefore spends a real certificate
    // to produce something this image immediately throws away, so these sites
    // are skipped until their lineage is repaired or restored.
    //
    // Manage certificates
    for (let id in certs) {

      // Only ever true for a site absent from `certificates`, since that
      // absence is what put it in the set — the branch below cannot apply.
      if (suppressed.has(id)) continue;

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
          // chain.pem sits beside the private key Certbot reported, so it is
          // derived from that file's directory. It used to be
          // `cert_key_path.replace('privkey', 'chain')`, which rewrites the
          // FIRST occurrence of "privkey" in the whole path — not necessarily
          // the basename. A cert id containing "privkey" (all of "privkey",
          // "privkeys", "site-privkey" are accepted by validateCertId) had its
          // *directory* rewritten instead: live/site-privkey/privkey.pem became
          // live/site-chain/privkey.pem, a path that does not exist, so the copy
          // failed and took startup down with it.
          await commandSafe('cp', [path.join(path.dirname(cert_key_path), 'chain.pem'), `/etc/ssl/certs/${id}_chain.pem`]);
        }
        await createConf(id, final_certificates[id]);
      } else if (suppressed.has(id)) {
        // Nothing is written: the site has real certificate material on disk
        // that Certbot cannot currently see, so any fragment written here would
        // misrepresent what is actually there — and it would not be served
        // either, since nothing links this site while it has no parsed
        // certificate.
      } else {
        // No certificate was obtained for a site that is not suppressed.
        // createConf() writes nothing for an invalid status; the call is what
        // reports it (see ./manage_certs.js), and the summary below records it.
        await createConf(id, { status: 'invalid', cert_path: '', cert_key_path: '' });
      }
    }

    // Certificate status summary
    const ids = Object.keys(certs);
    log(`Certificate status summary: ${ids.length} certificate(s)`);
    for (const id of ids) {
      if (!final_certificates[id]) {
        log(`- ${id}: ${localResidue.has(id)
          ? 'leftover files, no renewal config — issuance suppressed'
          : suppressed.has(id)
            ? 'undiscoverable — issuance suppressed, existing lineage preserved'
            : 'invalid'}`);
        log(`  domains: ${certs[id].names.join(', ')}`);
      } else {
        const { cert_domains, status } = final_certificates[id];
        log(`- ${id}: ${status}`);
        log(`  domains: ${cert_domains.join(', ')}`);
      }
    }

    // Back up Let's Encrypt state (optional)
    if (certbotBackupEnabled()) {
      if (!lineagesClassified) {
        // Which lineages need protecting is unknown, and a backup is an
        // optimisation — skipping one write is harmless, while overwriting the
        // last good copy of a lineage that could not be checked is not.
        warn('Skipping backup: renewal configs could not be enumerated, so the existing backup cannot be updated safely');
      } else {
        log(`Backing up Let's Encrypt state to ${process.env.CERTBOT_BACKUP_PATH}`);
        if (backupProtectedLineages.length > 0) {
          log(`Preserving the existing backup for ${backupProtectedLineages.length} lineage(s) Certbot could not enumerate at startup: ${backupProtectedLineages.join(', ')}`);
        }
        await backupCertbotState({ protectedLineages: backupProtectedLineages });
        log('Backup completed');
      }
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
