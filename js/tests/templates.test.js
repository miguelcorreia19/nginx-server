const fs = require('fs');
const path = require('path');

const PLACEHOLDER_RE = /\$\{[A-Z_]+\}/;

// ──────────────────────────────────────────────
//  Custom SSL template  (fixes: missing import + ${COMMENT})
// ──────────────────────────────────────────────
describe('custom SSL template placeholder resolution', () => {
  const templatePath = path.join(__dirname, '../custom/templates/ssl-custom-certificate.conf');

  it('template file exists', () => {
    expect(fs.existsSync(templatePath)).toBe(true);
  });

  it('leaves no unresolved placeholders after replacement', () => {
    let data = fs.readFileSync(templatePath, 'utf8');
    data = data
      .replace(/\$\{COMMENT\}/g, '')
      .replace('${CERT}', '/etc/ssl/certs/test.pem')
      .replace('${PRIVKEY}', '/etc/ssl/certs/test.key');

    expect(data).not.toMatch(PLACEHOLDER_RE);
  });

  it('activates ssl_certificate directive (${COMMENT} replaced with empty string)', () => {
    let data = fs.readFileSync(templatePath, 'utf8');
    data = data
      .replace(/\$\{COMMENT\}/g, '')
      .replace('${CERT}', '/etc/ssl/certs/test.pem')
      .replace('${PRIVKEY}', '/etc/ssl/certs/test.key');

    expect(data).toContain('ssl_certificate /etc/ssl/certs/test.pem');
    expect(data).toContain('ssl_certificate_key /etc/ssl/certs/test.key');
  });

  it('does NOT prefix ssl directives with a comment character', () => {
    let data = fs.readFileSync(templatePath, 'utf8');
    data = data
      .replace(/\$\{COMMENT\}/g, '')
      .replace('${CERT}', '/etc/ssl/certs/test.pem')
      .replace('${PRIVKEY}', '/etc/ssl/certs/test.key');

    expect(data).not.toMatch(/^#\s*ssl_certificate/m);
  });
});

// ──────────────────────────────────────────────
//  Letsencrypt SSL template
//
//  The template now has exactly one substitution path. It used to have two:
//  a valid certificate cleared ${SSL} while the self-signed fallback set it to
//  "# " to comment out ssl_trusted_certificate. That fallback is gone — an
//  invalid certificate produces no fragment at all (js/letsencrypt/manage_certs.js)
//  — so ${SSL} has no remaining purpose and must not reappear.
// ──────────────────────────────────────────────
describe('letsencrypt SSL template — valid certificate', () => {
  const templatePath = path.join(__dirname, '../letsencrypt/templates/ssl-letsencrypt-certificate.conf');

  it('template file exists', () => {
    expect(fs.existsSync(templatePath)).toBe(true);
  });

  it('leaves no unresolved placeholders after replacement', () => {
    let data = fs.readFileSync(templatePath, 'utf8');
    data = data
      .replace('${FULLCHAIN}', '/etc/ssl/certs/id_fullchain.pem')
      .replace('${PRIVKEY}', '/etc/ssl/certs/id_privkey.pem')
      .replace('${CHAIN}', '/etc/ssl/certs/id_chain.pem');

    expect(data).not.toMatch(PLACEHOLDER_RE);
  });

  it('enables ssl_trusted_certificate unconditionally', () => {
    let data = fs.readFileSync(templatePath, 'utf8');
    data = data
      .replace('${FULLCHAIN}', '/etc/ssl/certs/id_fullchain.pem')
      .replace('${PRIVKEY}', '/etc/ssl/certs/id_privkey.pem')
      .replace('${CHAIN}', '/etc/ssl/certs/id_chain.pem');

    expect(data).toContain('ssl_trusted_certificate /etc/ssl/certs/id_chain.pem');
    expect(data).not.toMatch(/^#\s*ssl_trusted_certificate/m);
  });

  it('carries no ${SSL} placeholder, so no comment-out path can return', () => {
    const data = fs.readFileSync(templatePath, 'utf8');

    expect(data).not.toContain('${SSL}');
  });
});
