// Mocks must be declared before any require of the module under test.
jest.mock('child_process', () => ({ exec: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

const { exec } = require('child_process');
const { existsSync } = require('fs');

// Fresh module reference after mocks are wired.
const { mapCustomNginxConf } = require('../utils.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('mapCustomNginxConf — async sequencing', () => {
  it('awaits every symlink before the function resolves', async () => {
    const completed = [];

    exec.mockImplementation((cmd, cb) => {
      // Resolve on next tick so the test can detect premature resolution.
      setImmediate(() => {
        completed.push(cmd);
        cb(null, 'ok', '');
      });
    });
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf', 'http-common.conf'], '/custom/configs');

    // All three commands must have completed by the time await returns.
    expect(completed).toHaveLength(3);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('skips files that do not exist at the given path', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(false);

    await mapCustomNginxConf(['nginx.conf'], '/custom/configs');

    expect(exec).not.toHaveBeenCalled();
  });

  it('creates a symlink for each existing file with the correct command', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf'], '/custom/configs');

    expect(exec).toHaveBeenCalledWith(
      'ln -sf /custom/configs/nginx.conf /etc/nginx/nginx.conf',
      expect.any(Function)
    );
    expect(exec).toHaveBeenCalledWith(
      'ln -sf /custom/configs/proxy.conf /etc/nginx/proxy.conf',
      expect.any(Function)
    );
  });

  it('handles an empty file list without calling exec', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockReturnValue(true);

    await mapCustomNginxConf([], '/custom/configs');

    expect(exec).not.toHaveBeenCalled();
  });

  it('only symlinks files whose path exists', async () => {
    exec.mockImplementation((cmd, cb) => cb(null, 'ok', ''));
    existsSync.mockImplementation((p) => p.includes('nginx.conf'));

    await mapCustomNginxConf(['nginx.conf', 'proxy.conf'], '/custom/configs');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'ln -sf /custom/configs/nginx.conf /etc/nginx/nginx.conf',
      expect.any(Function)
    );
  });
});
