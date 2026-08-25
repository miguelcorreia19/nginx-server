const fs = require("fs");
const path = require("path");

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
  const templatePath = path.join(__dirname, 'templates/ssl-custom-certificate.conf');
  let data = fs.readFileSync(templatePath, 'utf8');
  data = data
    .replace('${CERT}', `/etc/ssl/certs/${cert_file}`)
    .replace('${PRIVKEY}', `/etc/ssl/certs/${privkey_file}`);

  fs.writeFileSync(`/etc/nginx/conf/${id}.conf`, data);
}