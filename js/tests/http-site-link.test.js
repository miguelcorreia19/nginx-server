// http mode — F3 regression: the site file must be linked, not copied.
//
// js/http/index.js used to `cp` the mounted /home/nginx/sites/<id>.conf into
// /etc/nginx/conf.d/80 at startup. reload.sh watches the mounted source
// directory and reloads nginx on every change, but nginx re-reads the stale
// copy, so edits never took effect. The fix symlinks the destination to the
// mounted source instead, matching the convention every SSL-backed mode
// already gets via configFiles() in ../utils.js.
//
// configFiles() itself is deliberately not reused (it targets conf.d/443,
// writes an SSL http_redirect file, and treats a missing site as a non-fatal
// skip) — see the comment in js/http/index.js. This suite confirms the local
// symlink logic preserves the existing fatal-on-missing behavior, since
// `ln -sf` (unlike `cp`) succeeds even when its source is missing.
//
// Mocking mirrors http-propagation.test.js, with fs added so both branches of
// the existence check can be exercised.

const mockConfig = {};
jest.mock('../config.json', () => mockConfig, { virtual: true });

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve()),
  commandSafe: jest.fn(() => Promise.resolve()),
}));

jest.mock('fs', () => ({ existsSync: jest.fn() }));

const fs = require('fs');
const { command, commandSafe } = require('../utils.js');
const httpMode = require('../http/index.js');

const setConfig = (entries) => {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, entries);
};

const commandSafeCalls = () => commandSafe.mock.calls.map(([bin, args]) => ({ bin, args }));

beforeEach(() => {
  jest.clearAllMocks();
  fs.existsSync.mockReturnValue(true);
});

describe('http mode — links (does not copy) the mounted site file', () => {
  beforeEach(() => {
    setConfig({ site1: { mode: 'http', names: ['example.com'] } });
  });

  it('symlinks /etc/nginx/conf.d/80/<id>.conf to the mounted source', async () => {
    await httpMode();

    expect(commandSafe).toHaveBeenCalledWith(
      'ln',
      ['-sf', '/home/nginx/sites/site1.conf', '/etc/nginx/conf.d/80/site1.conf']
    );
  });

  it('no longer copies the site file into conf.d/80', async () => {
    await httpMode();

    const copiedSiteFile = commandSafeCalls().some(
      ({ bin, args }) => bin === 'cp' && args.includes('/home/nginx/sites/site1.conf')
    );
    expect(copiedSiteFile).toBe(false);
  });

  it('still generates the HTTP listen fragment from the template', async () => {
    await httpMode();

    expect(commandSafe).toHaveBeenCalledWith(
      'cp',
      [expect.stringContaining('templates/http-certificate.conf'), '/etc/nginx/conf/site1.conf']
    );
  });
});

describe('http mode — missing site file stays fatal (no dangling symlink)', () => {
  it('rejects instead of linking when the mounted site file is absent', async () => {
    setConfig({ site1: { mode: 'http', names: ['example.com'] } });
    fs.existsSync.mockReturnValue(false);

    await expect(httpMode()).rejects.toBeDefined();

    expect(commandSafe).not.toHaveBeenCalledWith('ln', expect.anything());
  });
});

// The default :80 vhost is no longer this handler's responsibility: production
// startup restores it centrally before any handler runs (js/reconcile.js), so
// it is present whether or not HTTP sites exist. The handler must now be
// purely additive — with no HTTP sites it should do nothing at all.
describe('http mode — no longer owns the default port-80 vhost', () => {
  it('does nothing when there are no HTTP sites', async () => {
    setConfig({});

    await httpMode();

    expect(commandSafe).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('never restores the default :80 vhost itself', async () => {
    setConfig({ site1: { mode: 'http', names: ['example.com'] } });

    await httpMode();

    expect(command).not.toHaveBeenCalledWith(
      expect.stringContaining('nginx.vh.default.80.conf')
    );
  });
});
