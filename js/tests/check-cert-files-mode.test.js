// checkCertFiles() in js/letsencrypt/utils.js — the staging/production
// reconciliation decision.
//
// checkCertFiles() answers "is the certificate Certbot reported acceptable for
// this site exactly as it is?". Only two status/mode combinations force a
// recreation: an 'invalid' certificate, and a 'staging' certificate for a site
// configured as plain 'letsencrypt'.
//
// It used to have a third, gated on the undocumented FORCE_VALID2STAGING
// environment variable: a production ('valid') certificate for a
// 'letsencrypt-staging' site was rejected so it would be reissued against the
// staging CA. That override is removed — a real production certificate is
// strictly better than a staging one, so it is kept regardless of the mode
// string — and these tests pin the behaviour that remains.

const path = require('path');
const fs = require('fs');

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readdirSync: jest.fn(),
}));

jest.mock('../config.json', () => ({
  prod: { names: ['example.com'], mode: 'letsencrypt' },
  staging: { names: ['example.com'], mode: 'letsencrypt-staging' },
}), { virtual: true });

const { checkCertFiles } = require('../letsencrypt/utils.js');

const cert = (status) => ({
  cert_path: '/etc/letsencrypt/live/x/fullchain.pem',
  cert_key_path: '/etc/letsencrypt/live/x/privkey.pem',
  cert_domains: ['example.com'],
  status,
});

beforeEach(() => {
  jest.clearAllMocks();
  fs.existsSync.mockReturnValue(true);
  delete process.env.FORCE_VALID2STAGING;
});

describe('checkCertFiles — production certificate on a staging site', () => {
  it('keeps a valid production certificate for a letsencrypt-staging site', () => {
    expect(checkCertFiles('staging', cert('valid'))).toBe(true);
  });

  it('keeps it even if the removed FORCE_VALID2STAGING variable is set', () => {
    process.env.FORCE_VALID2STAGING = 'true';
    expect(checkCertFiles('staging', cert('valid'))).toBe(true);
  });
});

describe('checkCertFiles — normal staging/production reconciliation', () => {
  it('accepts a staging certificate for a letsencrypt-staging site', () => {
    expect(checkCertFiles('staging', cert('staging'))).toBe(true);
  });

  it('rejects a staging certificate for a plain letsencrypt site', () => {
    expect(checkCertFiles('prod', cert('staging'))).toBe(false);
  });

  it('accepts a valid certificate for a plain letsencrypt site', () => {
    expect(checkCertFiles('prod', cert('valid'))).toBe(true);
  });

  it('rejects an invalid certificate in either mode', () => {
    expect(checkCertFiles('prod', cert('invalid'))).toBe(false);
    expect(checkCertFiles('staging', cert('invalid'))).toBe(false);
  });

  it('rejects when the certificate files are missing on disk', () => {
    fs.existsSync.mockReturnValue(false);
    expect(checkCertFiles('prod', cert('valid'))).toBe(false);
  });

  it('rejects when the reported domains do not match the configured names', () => {
    expect(checkCertFiles('prod', { ...cert('valid'), cert_domains: ['other.example.com'] })).toBe(false);
  });
});

describe('js/letsencrypt/utils.js — the FORCE_VALID2STAGING override is gone', () => {
  it('no longer references the variable anywhere in the module', () => {
    const source = jest.requireActual('fs')
      .readFileSync(path.join(__dirname, '..', 'letsencrypt', 'utils.js'), 'utf8');
    expect(source).not.toMatch(/FORCE_VALID2STAGING/);
  });
});
