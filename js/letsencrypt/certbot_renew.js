const { parseCerts } = require("./utils.js");
const { command } = require("../utils.js");

console.log("NODEJS START RENEWAL");
console.log(new Date().toTimeString())

const start = async () => {
  try {
    console.log(new Date().toTimeString())
    // The challenge will run on port 80
    // await command('certbot renew --noninteractive --quiet --preferred-challenges http');
    await command('certbot renew --noninteractive --preferred-challenges http');

    console.log(new Date().toTimeString())

    const final_certificates = await parseCerts();

    console.log(`\n#######################################`);
    console.log(`######    Certificates Status    ######`);
    console.log(`#######################################\n`);
    const size = Object.keys(final_certificates).length;
    let count = 0;

    for (let id in final_certificates) {
      const { cert_path, cert_key_path, cert_domains, status, validity } = final_certificates[id];

      // TODO: ? status ?

      await command(`cp ${cert_path} /etc/ssl/certs/${id}_fullchain.pem`);
      await command(`cp ${cert_key_path} /etc/ssl/certs/${id}_privkey.pem`);
      await command(`cp ${cert_key_path.replace('privkey', 'chain')} /etc/ssl/certs/${id}_chain.pem`);

      console.log(` Certificate ${id} - ${status}`);
      console.log(` Domains ${cert_domains.join(', ')}`);
      console.log(` Validity ${validity}\n`);
      console.log(` Status ${status}\n`);

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
    console.log("ERROR certbot_renew!", err)
  }
}

start();