const fs = require('fs');
const path = require('path');

const PLACEHOLDER_RE = /\$\{[A-Z_]+\}/;

// ──────────────────────────────────────────────
//  Custom SSL template
//
//  The template now has exactly one substitution path: ${CERT} and ${PRIVKEY}.
//  It used to carry a ${COMMENT} prefix on the two ssl_certificate* lines, but
//  js/custom/utils.js always replaced it with an empty string — there was no
//  code path that set it to a comment character — so it has been removed and
//  must not reappear.
// ──────────────────────────────────────────────
describe('custom SSL template placeholder resolution', () => {
  const templatePath = path.join(__dirname, '../custom/templates/ssl-custom-certificate.conf');

  const render = () =>
    fs.readFileSync(templatePath, 'utf8')
      .replace('${CERT}', '/etc/ssl/certs/test.pem')
      .replace('${PRIVKEY}', '/etc/ssl/certs/test.key');

  it('template file exists', () => {
    expect(fs.existsSync(templatePath)).toBe(true);
  });

  it('leaves no unresolved placeholders after replacement', () => {
    expect(render()).not.toMatch(PLACEHOLDER_RE);
  });

  it('carries no ${COMMENT} placeholder, so no comment-out path can return', () => {
    expect(fs.readFileSync(templatePath, 'utf8')).not.toContain('${COMMENT}');
  });

  it('activates the ssl_certificate directives', () => {
    const data = render();

    expect(data).toContain('ssl_certificate /etc/ssl/certs/test.pem');
    expect(data).toContain('ssl_certificate_key /etc/ssl/certs/test.key');
  });

  it('does NOT prefix ssl directives with a comment character', () => {
    expect(render()).not.toMatch(/^#\s*ssl_certificate/m);
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
