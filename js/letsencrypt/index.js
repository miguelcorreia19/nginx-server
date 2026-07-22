const { parseCerts, checkCertFiles } = require("./utils.js");
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

  if (Object.keys(certs).length == 0) return;

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

    // Delete certificates that are no longer in config.json
    for (let id in certificates) {
      if (!certs[id]) {
        log(`Removing old certificate ${id} (no longer in config.json)`);

        const deleted = await deleteCert(id);
        if (deleted) log(`Certificate ${id} deleted`);
        else error(`Certificate ${id} deletion failed`);
      }
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
    if (process.env.CERTBOT_BACKUP && process.env.CERTBOT_BACKUP !== 'false') {
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
