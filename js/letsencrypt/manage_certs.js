const fs = require("fs");
const path = require("path");
const { commandSafe } = require("../utils.js");

const { createLogger } = require("../logger.js");
const { warn, error } = createLogger("letsencrypt");

exports.createCert = async (id) => {
  const certs = require("../config.json");

  const { names, email, mode } = certs[id];
  const args = [
    'certonly',
    ...(mode === 'letsencrypt-staging' ? ['--staging'] : []),
    '--expand', '--verbose', '--noninteractive', '--standalone', '--agree-tos',
    '--cert-name', id,
    '--email', email || process.env.CERTBOT_EMAIL,
    ...names.flatMap(name => ['-d', name]),
  ];

  try {
    await commandSafe('certbot', args);
    return true;
  } catch (err) {
    error(`Certificate creation failed for "${id}" (domains: ${names.join(', ')}): ${err.error || err.message || err}`);
    return false;
  }
}

exports.deleteCert = async (id) => {
  try {
    await commandSafe('certbot', ['delete', '--cert-name', id]);
    return true;
  } catch (err) {
    error(`Certificate deletion failed for "${id}": ${err.error || err.message || err}`);
    return false;
  }
}

exports.createConf = async (id, { cert_path, cert_key_path, status }) => {
  const templatePath = path.join(__dirname, 'templates/ssl-letsencrypt-certificate.conf');

  let data = '';
  if (status === 'invalid' && !process.env.FORCE_INVALID_ON_FAIL) {
    warn(`Certificate "${id}" is invalid — generating a self-signed fallback certificate (set FORCE_INVALID_ON_FAIL to disable this fallback)`);
    // execFile, not a shell string: no shell feature (piping, redirection,
    // globbing) was ever needed here — the only interpolated value is `id`,
    // and it reaches validateCertId() (js/validate.js) for every config.json
    // entry before any handler runs, which requires it to start with an
    // alphanumeric character and contain only letters, digits, dots, hyphens
    // and underscores. It can never begin with `-` or carry a shell
    // metacharacter, so no `--` guard is needed on the two operands it feeds.
    await commandSafe('openssl', [
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', `/etc/ssl/certs/${id}_privkey.pem`,
      '-out', `/etc/ssl/certs/${id}_cert.pem`,
      '-days', '365',
      '-nodes',
      '-subj', '/C=UA',
    ]);

    data = fs.readFileSync(templatePath, 'utf8');
    data = data
      .replace('${FULLCHAIN}', `/etc/ssl/certs/${id}_cert.pem`)
      .replace('${PRIVKEY}', `/etc/ssl/certs/${id}_privkey.pem`)
      .replace('${SSL}', '# ')
      .replace('${CHAIN}', '');

  } else if (status !== 'invalid') {
    data = fs.readFileSync(templatePath, 'utf8');
    data = data
      .replace('${SSL}', '')
      .replace('${FULLCHAIN}', `/etc/ssl/certs/${id}_fullchain.pem`)
      .replace('${PRIVKEY}', `/etc/ssl/certs/${id}_privkey.pem`)
      .replace('${CHAIN}', `/etc/ssl/certs/${id}_chain.pem`);
  } else {
    warn(`Certificate "${id}" is invalid — proceeding without a fallback because FORCE_INVALID_ON_FAIL is set; nginx may fail to start for this site`);
  }

  fs.writeFileSync(`/etc/nginx/conf/${id}.conf`, data);
}
