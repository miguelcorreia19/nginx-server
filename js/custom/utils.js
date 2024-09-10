const fs = require("fs");

exports.checkCertFiles = (id, { cert_file, privkey_file }) => {
  if (
    !cert_file ||
    !privkey_file ||
    !fs.existsSync(`${process.env.CUSTOM_CERTS_PATH}/${cert_file}`) ||
    !fs.existsSync(`${process.env.CUSTOM_CERTS_PATH}/${privkey_file}`)
  )
    return false;

  return true;
}

exports.createConf = async (id, { cert_file, privkey_file }) => {
  // ${CERT}
  // ${PRIVKEY}

  let data = fs.readFileSync('./custom/templates/ssl-custom-certificate.conf', 'utf8');
  data = data.replace('${CERT}', `/etc/ssl/certs/${cert_file}`)
    .replace('${PRIVKEY}', `/etc/ssl/certs/${privkey_file}`);

  await command(`echo "${data}" > /etc/nginx/conf/${id}.conf`);
}