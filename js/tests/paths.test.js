const fs = require('fs');
const path = require('path');

// These are the resolved paths that each module now uses via __dirname.
// If a template is moved or renamed this test will catch it immediately.
const TEMPLATE_PATHS = [
  // js/utils.js — httpRedirect
  path.join(__dirname, '../templates/http_redirect.conf'),

  // js/custom/utils.js — createConf
  path.join(__dirname, '../custom/templates/ssl-custom-certificate.conf'),

  // js/letsencrypt/manage_certs.js — createConf
  path.join(__dirname, '../letsencrypt/templates/ssl-letsencrypt-certificate.conf'),

  // js/dev/index.js — cp command
  path.join(__dirname, '../dev/templates/ssl-dev-certificate.conf'),

  // js/http/index.js — cp command
  path.join(__dirname, '../http/templates/http-certificate.conf'),
];

describe('__dirname-based template path resolution', () => {
  it.each(TEMPLATE_PATHS)('%s exists on disk', (templatePath) => {
    expect(fs.existsSync(templatePath)).toBe(true);
  });

  it('every template file is non-empty', () => {
    for (const p of TEMPLATE_PATHS) {
      const stat = fs.statSync(p);
      expect(stat.size).toBeGreaterThan(0);
    }
  });
});
