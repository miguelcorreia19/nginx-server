const { parseCerts } = require("./utils.js");
const { command, commandSafe } = require("../utils.js");
const migrateRenewalConfigs = require("./migrate_renewal");

// Logged with explicit timestamps (rather than relying on Docker's log
// timestamps): this script's stdout is captured by certbot_renew.sh, whose
// own output is redirected by cron straight into a file
// (/var/log/certbot/certbot_renew.log) — outside Docker's logging pipeline.
console.log(`[certbot_renew.js] Starting certificate renewal — ${new Date().toISOString()}`);

const start = async () => {
  try {
    // Defensively ensure every renewal config uses webroot before renewing
    // (also done at container startup). In-place + non-fatal; the original is
    // preserved on any failure. Renewal correctness does not depend on this:
    // the certbot command below forces webroot explicitly.
    migrateRenewalConfigs({ apply: true });

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
    // certbot's own renewal report (which certs were due, skipped, renewed,
    // or failed) was previously discarded — surface it for troubleshooting.
    if (renewOutput) console.log(renewOutput);

    console.log(`[certbot_renew.js] certbot renew finished — ${new Date().toISOString()}`);

    const final_certificates = await parseCerts();

    console.log(`\n#######################################`);
    console.log(`######    Certificates Status    ######`);
    console.log(`#######################################\n`);
    const size = Object.keys(final_certificates).length;
    let count = 0;

    for (let id in final_certificates) {
      const { cert_path, cert_key_path, cert_domains, status, validity } = final_certificates[id];

      // TODO: ? status ?

      await commandSafe('cp', [cert_path, `/etc/ssl/certs/${id}_fullchain.pem`]);
      await commandSafe('cp', [cert_key_path, `/etc/ssl/certs/${id}_privkey.pem`]);
      await commandSafe('cp', [cert_key_path.replace('privkey', 'chain'), `/etc/ssl/certs/${id}_chain.pem`]);

      console.log(` Certificate ${id} - ${status}`);
      console.log(` Domains ${cert_domains.join(', ')}`);
      console.log(` Validity ${validity}\n`);

      if (count !== size) console.log(`#######################################\n`);
    }

    if (size === 0) console.log("Certificates not found!\n")
    console.log(`#######################################`);
    console.log(`######    Certificates Status    ######`);
    console.log(`#######################################\n`);

    // ############################### //
    //              BACKUP
    // ############################### //
    if (process.env.CERTBOT_BACKUP && process.env.CERTBOT_BACKUP !== 'false') {
      console.log(`Backup certificates to ${process.env.CERTBOT_BACKUP_PATH}`)
      await command(`cp -rf /etc/letsencrypt/* ${process.env.CERTBOT_BACKUP_PATH}`);
    }
  } catch (err) {
    console.error("Fatal: certbot renewal failed —", err);
    process.exit(1);
  }
}

start();