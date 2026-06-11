// Mocks must be declared before any require of the module under test.
jest.mock('child_process', () => ({ exec: jest.fn(), execFile: jest.fn() }));

const { execFile } = require('child_process');
const { validateNginxConfig } = require('../utils.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('validateNginxConfig — nginx -t wrapper', () => {
  it('invokes "nginx -t" directly without a shell', () => {
    execFile.mockImplementation((bin, args, opts, cb) => cb(null, '', 'test is successful'));

    validateNginxConfig();

    expect(execFile).toHaveBeenCalledWith('nginx', ['-t'], expect.any(Object), expect.any(Function));
  });

  it('resolves on success even though nginx writes its "test is successful" message to stderr', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => {
      cb(null, '', 'nginx: configuration file /etc/nginx/nginx.conf test is successful\n');
    });

    await expect(validateNginxConfig()).resolves.toEqual(
      expect.stringContaining('test is successful')
    );
  });

  it('rejects with the nginx diagnostic message when the config is invalid', async () => {
    const diagnostic = 'nginx: [emerg] unknown directive "boguss" in /etc/nginx/conf.d/443/site.conf:5';
    execFile.mockImplementation((bin, args, opts, cb) => {
      cb(new Error('Command failed: nginx -t'), '', `${diagnostic}\nnginx: configuration file /etc/nginx/nginx.conf test failed\n`);
    });

    await expect(validateNginxConfig()).rejects.toEqual({
      error: expect.stringContaining('unknown directive "boguss"'),
    });
  });

  it('falls back to the exec error message when nginx produces no stderr output', async () => {
    execFile.mockImplementation((bin, args, opts, cb) => {
      cb(new Error('spawn nginx ENOENT'), '', '');
    });

    await expect(validateNginxConfig()).rejects.toEqual({ error: 'spawn nginx ENOENT' });
  });
});
