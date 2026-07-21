// Where centralized reconciliation sits in the startup sequence.
//
// Contract:
//   production -> preflight (all entries) -> reconcileGeneratedConfig() -> handlers
//   development -> preflightDev() -> dev()          [no production reconciliation]
//
// js/entrypoint.js has no exports and calls its own start() at module load, so
// its dependencies are mocked and the module is required to run it — the same
// approach as entrypoint-preflight-order.test.js and
// entrypoint-dev-preflight-order.test.js.

jest.mock('../config.json', () => ({
  A: { mode: 'http', names: ['a.example.com'] },
}), { virtual: true });

jest.mock('../letsencrypt', () => jest.fn(() => Promise.resolve()));
jest.mock('../dev', () => jest.fn(() => Promise.resolve()));
jest.mock('../custom', () => jest.fn(() => Promise.resolve()));
jest.mock('../http', () => jest.fn(() => Promise.resolve()));
jest.mock('../fail2ban', () => jest.fn(() => Promise.resolve()));
jest.mock('../letsencrypt/migrate_renewal', () => jest.fn());

jest.mock('../preflight.js', () => ({
  preflightEntry: jest.fn(),
  preflightDev: jest.fn(),
}));
jest.mock('../reconcile.js', () => ({
  reconcileGeneratedConfig: jest.fn(() => ({ removed: 0 })),
}));

jest.mock('../utils.js', () => ({
  command: jest.fn(() => Promise.resolve()),
  mapCustomNginxConf: jest.fn(() => Promise.resolve()),
  validateNginxConfig: jest.fn(() => Promise.resolve()),
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));

const mocks = () => ({
  letsencrypt: require('../letsencrypt'),
  dev: require('../dev'),
  custom: require('../custom'),
  http: require('../http'),
  preflightEntry: require('../preflight.js').preflightEntry,
  preflightDev: require('../preflight.js').preflightDev,
  reconcile: require('../reconcile.js').reconcileGeneratedConfig,
});

let exitSpy;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ENVIRONMENT;
});

describe('entrypoint — production reconciliation ordering', () => {
  it('reconciles after preflight and before every mode handler', async () => {
    process.env.ENVIRONMENT = 'production';
    const m = mocks();

    require('../entrypoint.js');
    await flush();

    expect(m.reconcile).toHaveBeenCalledTimes(1);

    // preflight -> reconcile -> handlers
    expect(m.preflightEntry.mock.invocationCallOrder[0])
      .toBeLessThan(m.reconcile.mock.invocationCallOrder[0]);
    for (const handler of [m.letsencrypt, m.custom, m.http]) {
      expect(handler).toHaveBeenCalled();
      expect(m.reconcile.mock.invocationCallOrder[0])
        .toBeLessThan(handler.mock.invocationCallOrder[0]);
    }
  });

  it('reconciles even though this configuration has zero LE and zero custom entries', async () => {
    process.env.ENVIRONMENT = 'production';
    const m = mocks();

    require('../entrypoint.js');
    await flush();

    // The mocked config holds a single http entry; reconciliation must not be
    // gated on any particular mode having entries.
    expect(m.reconcile).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('aborts fatally and runs no handler when reconciliation fails', async () => {
    process.env.ENVIRONMENT = 'production';
    const m = mocks();
    m.reconcile.mockImplementation(() => { throw new Error('disk on fire'); });

    require('../entrypoint.js');
    await flush();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(m.letsencrypt).not.toHaveBeenCalled();
    expect(m.custom).not.toHaveBeenCalled();
    expect(m.http).not.toHaveBeenCalled();
  });
});

describe('entrypoint — development does not run production reconciliation', () => {
  it('runs the dev preflight and dev handler, never reconcileGeneratedConfig', async () => {
    process.env.ENVIRONMENT = 'development';
    const m = mocks();

    require('../entrypoint.js');
    await flush();

    expect(m.preflightDev).toHaveBeenCalledTimes(1);
    expect(m.dev).toHaveBeenCalledTimes(1);
    // js/dev/index.js owns its own default-vhost semantics (its generated
    // fragment declares the HTTPS default_server), so the production reset
    // must not run on this path.
    expect(m.reconcile).not.toHaveBeenCalled();
  });
});
