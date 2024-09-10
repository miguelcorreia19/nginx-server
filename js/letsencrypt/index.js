const { parseCerts, checkCertFiles } = require("./utils.js");
const { command, configFiles } = require("../utils.js");
const { createCert, deleteCert, createConf } = require("./manage_certs.js");

module.exports = async () => {
  const _certs = require("../config.json");

  const certs = { ..._certs };

  for (let id in certs) {
    if (certs[id].mode !== 'letsencrypt-staging' && certs[id].mode !== 'letsencrypt') {
      delete certs[id];
    }
  }

  if (Object.keys(certs).length == 0) return;

  try {
    const certificates = await parseCerts(true);
    // console.log(certificates);
    // certificates = {
    //  id: {
    //    cert_path: string
    //    cert_key_path: string
    //    cert_domains: array
    //    status: 'valid' | 'invalid' | 'staging'
    //    validity: luxon date
    //  }
    // }

    // ################################## //
    //         MANAGE CERTIFICATES
    // ################################## //
    for (let id in certs) {

      if (certificates[id]) {
        console.log(`Certificate ${id} found!`);

        const check = checkCertFiles(id, certificates[id]);

        if (!check) { // have issues?
          console.log(`Certificate ${id} have some issues!\nPreparing to recreate...`);

          const deleted = await deleteCert(id);
          if (deleted) console.log(`Certificate ${id} deleted!`);
          else console.log(`error: Certificate ${id} not deleted!`);

          await command("certbot certificates");

          console.log(`Recreating certificate ${id}...`);

          const created = await createCert(id);

          if (created) console.log(`Certificate ${id} created!`);
          else console.log(`error: Certificate ${id} not created!`);

        }
      } else { // not exists

        console.log(`Certificate ${id} not exists! Preparing to create...`)

        const created = await createCert(id);

        if (created) console.log(`Certificate ${id} created!`)
        else console.log(`error: Certificate ${id} not created!`)
      }

      console.log('');
    }

    // ################################## //
    //       DELETE OLD CERTIFICATES
    // ################################## //
    for (let id in certificates) {
      if (!certs[id]) {
        console.log(`Found old certificate ${id}\nPreparing to remove certificate...\n`);

        const deleted = await deleteCert(id);
        if (deleted) console.log(`Certificate ${id} deleted!`);
        else console.log(`error: Certificate ${id} not deleted!`);
      }
    }

    // ################################## //
    //     VERIFY AND COPY CERT FILES
    // ################################## //
    const final_certificates = await parseCerts();

    console.log("Start mapping certificates...");
    // console.log(final_certificates);

    for (let id in certs) {

      if (final_certificates[id]) {
        const { status, cert_path, cert_key_path } = final_certificates[id];
        if (status !== 'invalid') {
          await command(`cp ${cert_path} /etc/ssl/certs/${id}_fullchain.pem`);
          await command(`cp ${cert_key_path} /etc/ssl/certs/${id}_privkey.pem`);
          await command(`cp ${cert_key_path.replace('privkey', 'chain')} /etc/ssl/certs/${id}_chain.pem`);
        }
        await createConf(id, final_certificates[id]);
      } else {
        await createConf(id, { status: 'invalid', cert_path: '', cert_key_path: '' });
      }
    }

    // ################################## //
    //                PRINT
    // ################################## //
    console.log(`\n#######################################`);
    console.log(`######    Certificates Status    ######`);
    console.log(`#######################################\n`);
    const size = Object.keys(certs).length;
    let count = 0;

    for (let id in certs) {
      count++;
      if (!final_certificates[id]) {
        console.log(` Certificate ${id} - invalid`);
        console.log(` ${certs[id].names.join(', ')}\n`);
      } else {
        const { cert_domains, status } = final_certificates[id];
        console.log(` Certificate ${id} - ${status}`);
        console.log(` ${cert_domains.join(', ')}\n`);
      }
      if (count !== size) console.log(`#######################################\n`);
    }

    if (size === 0) console.log("Certificates not found!\n")
    console.log(`#######################################`);
    console.log(`######    Certificates Status    ######`);
    console.log(`#######################################\n`);


    // ################################## //
    //               BACKUP
    // ################################## //
    if (process.env.CERTBOT_BACKUP && process.env.CERTBOT_BACKUP !== 'false') {
      console.log(`Backup certificates to ${process.env.CERTBOT_BACKUP_PATH}`)
      await command(`cp -rf /etc/letsencrypt/* ${process.env.CERTBOT_BACKUP_PATH}`);
    }

    // ################################## //
    //                RENEW
    // ################################## //
    console.log(`Setting up renewal...`);
    await command(`crontab -l | grep -v '/usr/local/bin/certbot_renew.sh'  | crontab -`)
    const cronjob_regex = /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/;
    let cronjob = "0 5 * * *";
    if (process.env.CERTBOT_RENEW_CRONJOB && cronjob_regex.test(process.env.CERTBOT_RENEW_CRONJOB)) {
      cronjob = process.env.CERTBOT_RENEW_CRONJOB;
    }
    await command(`echo "${cronjob} /bin/bash /usr/local/bin/certbot_renew.sh >> /var/log/certbot/certbot_renew.log" >>/etc/crontabs/root`)

    // ACTIVATE CRONTAB
    await command(`crond -bS -c /var/spool/cron/crontabs`);


    // ################################## //
    //          COPY CONF FILES
    // ################################## //

    // await command('rsync -aP --exclude=dev.conf --exclude=_*.conf /home/nginx/sites/ /etc/nginx/conf.d/ >/dev/null');
    // delete all redirect files from http to https
    await command('rm -f /etc/nginx/conf.d/80/*-http-redirect.conf');
    await command('rm -f /etc/nginx/conf.d/443/*');

    for (let id in certs) {
      const { status, cert_domains } = final_certificates[id];
      await configFiles(id, status, certs[id].http_redirect, cert_domains);
    }

    console.log("NodeJS letsencrypt terminated!")
  } catch (err) {
    console.error("ERROR letsencrypt!", err)
  }
}
