const fs = require("fs");

const { command } = require("../utils.js");

exports.createCert = async (id) => {
  const certs = require("../config.json");

  const { names, email, mode } = certs[id];
  const domains = names.length > 1 ? names.reduce((a, b, index) => {
    return index === 1 ?
      `-d ${a} -d ${b}` :
      `${a} -d ${b}`
  }) : `-d ${names[0]}`;

  let cmd = `certbot certonly ${mode === "letsencrypt-staging" ? '--staging ' : ''} --expand --verbose --noninteractive --standalone --agree-tos --cert-name=${id} --email=${email ? email : process.env.CERTBOT_EMAIL} ${domains}`;

  try {
    await command(cmd);
    return true;
  } catch (err) {
    console.error("manage_certs creation error!", err)
    return false;
  }
}

exports.deleteCert = async (id) => {
  let cmd = `certbot delete --cert-name=${id}`;

  try {
    await command(cmd);
    return true;
  } catch (err) {
    console.error("manage_certs delete error!", err)
    return false;
  }
}

exports.createConf = async (id, { cert_path, cert_key_path, status }) => {
  // ${FULLCHAIN}
  // ${PRIVKEY}
  // ${CHAIN}

  let data = '';
  if (status === 'invalid' && !process.env.FORCE_INVALID_ON_FAIL) {
    console.log(`${id} certificate is invalid... Generating openssl\nYOU CAN DISABLE THIS WITH THE FLAG "FORCE_INVALID_ON_FAIL"`);
    await command(`openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/certs/${id}_privkey.pem -out /etc/ssl/certs/${id}_cert.pem -days 365 -nodes -subj \"/C=UA\" 2>&1`);

    data = fs.readFileSync('./letsencrypt/templates/ssl-letsencrypt-certificate.conf', 'utf8');
    data = data.replace('${FULLCHAIN}', `/etc/ssl/certs/${id}_cert.pem`)
      .replace('${PRIVKEY}', `/etc/ssl/certs/${id}_privkey.pem`)
      .replace('${SSL}', '# ');

  } else if (status !== 'invalid') {
    data = fs.readFileSync('./letsencrypt/templates/ssl-letsencrypt-certificate.conf', 'utf8');
    data = data.replace('${FULLCHAIN}', `/etc/ssl/certs/${id}_fullchain.pem`)
      .replace('${PRIVKEY}', `/etc/ssl/certs/${id}_privkey.pem`)
      .replace('${CHAIN}', `/etc/ssl/certs/${id}_chain.pem`);
  } else {
    console.log(`${id} certificate is invalid. Probably this will fail... (FLAG "FORCE_INVALID_ON_FAIL" ACTIVATED)`);
  }

  await command(`echo "${data}" > /etc/nginx/conf/${id}.conf`);
}
