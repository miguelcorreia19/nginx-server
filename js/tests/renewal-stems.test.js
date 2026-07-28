// listRenewalStems() / renewalConfigPath() — the filesystem half of
// undiscoverable-lineage detection (js/letsencrypt/utils.js).
//
// Certbot enumerates lineages from /etc/letsencrypt/renewal/*.conf and the
// filename stem is the cert-name, so these stems are what get compared against
// the parseCerts() result and, for an orphan, handed to deleteCert().
//
// Exercised against a real temp filesystem (same approach as
// certbot-state.test.js and reconcile.test.js) rather than a mocked fs, because
// the contract is about real directory behaviour.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { listRenewalStems, renewalConfigPath } = require('../letsencrypt/utils.js');

let tmp, renewalDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renewal-stems-'));
  renewalDir = path.join(tmp, 'renewal');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const opts = () => ({ renewalDir });
const mk = (name, body = '[renewalparams]\n') => {
  fs.mkdirSync(renewalDir, { recursive: true });
  fs.writeFileSync(path.join(renewalDir, name), body);
};

describe('listRenewalStems — enumeration', () => {
  it('is empty when the renewal directory does not exist', () => {
    // Certbot creates the directory lazily; its absence is a real "no lineages".
    expect(listRenewalStems(opts())).toEqual([]);
  });

  it('is empty when the renewal directory exists but is empty', () => {
    fs.mkdirSync(renewalDir, { recursive: true });

    expect(listRenewalStems(opts())).toEqual([]);
  });

  it('maps A.conf to the stem A', () => {
    mk('A.conf');

    expect(listRenewalStems(opts())).toEqual(['A']);
  });

  it('returns every .conf stem', () => {
    mk('good.conf');
    mk('broken.conf', 'not valid ini');
    mk('example.com.conf');

    expect(listRenewalStems(opts()).sort()).toEqual(['broken', 'example.com', 'good']);
  });

  it('ignores entries that are not .conf', () => {
    mk('A.conf');
    mk('A.conf.bak');
    mk('README');
    mk('notes.txt');

    expect(listRenewalStems(opts())).toEqual(['A']);
  });

  it('preserves the stem exactly, including case and dots', () => {
    mk('Mixed.Case-name_1.conf');

    expect(listRenewalStems(opts())).toEqual(['Mixed.Case-name_1']);
  });

  it('does not read or parse the config contents', () => {
    // Whether Certbot can *use* a renewal config is Certbot's answer to give.
    mk('broken.conf', '!!! not remotely valid ini !!!');

    expect(listRenewalStems(opts())).toEqual(['broken']);
  });
});

describe('listRenewalStems — enumeration failure is not "empty"', () => {
  it('raises an unexpected filesystem error instead of reporting no lineages', () => {
    fs.mkdirSync(renewalDir, { recursive: true });
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    });

    // Silently returning [] would let the caller report cleanup as complete
    // when it could not actually tell.
    expect(() => listRenewalStems(opts())).toThrow(/EACCES/);

    spy.mockRestore();
  });
});

describe('renewalConfigPath', () => {
  it('builds the config path a stem came from', () => {
    expect(renewalConfigPath('A', opts())).toBe(path.join(renewalDir, 'A.conf'));
  });

  it('round-trips with listRenewalStems', () => {
    mk('good.conf');

    const [stem] = listRenewalStems(opts());

    expect(fs.existsSync(renewalConfigPath(stem, opts()))).toBe(true);
  });

  it('defaults to the Certbot renewal directory', () => {
    expect(renewalConfigPath('A')).toBe('/etc/letsencrypt/renewal/A.conf');
  });
});
