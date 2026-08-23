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
  // A site with no usable certificate gets no SSL configuration at all, and
  // nothing is written to disk.
  //
  // There is deliberately no self-signed fallback in production. One used to be
  // generated here — an openssl certificate plus a fragment pointing at it —
  // but it could never take effect: a fragment under /etc/nginx/conf/ is only
  // ever loaded through the conf.d/443 symlink configFiles() creates (see
  // ../utils.js), and configFiles() returns early for exactly this status, so
  // the site is never linked and nginx never reads the fragment. The fallback
  // also wrote /etc/ssl/certs/<id>_privkey.pem — the same path the successful
  // export uses — replacing real key material with self-signed material for a
  // site that is not being served.
  //
  // Self-signed certificates remain a development-mode feature (js/dev/index.js);
  // in production a site is served a real certificate or it is not served.
  if (status === 'invalid') {
    warn(`Certificate "${id}" is invalid — no SSL configuration written; this site is not served until a valid certificate is obtained`);
    return;
  }

  const templatePath = path.join(__dirname, 'templates/ssl-letsencrypt-certificate.conf');

  const data = fs.readFileSync(templatePath, 'utf8')
    .replace('${FULLCHAIN}', `/etc/ssl/certs/${id}_fullchain.pem`)
    .replace('${PRIVKEY}', `/etc/ssl/certs/${id}_privkey.pem`)
    .replace('${CHAIN}', `/etc/ssl/certs/${id}_chain.pem`);

  fs.writeFileSync(`/etc/nginx/conf/${id}.conf`, data);
}
