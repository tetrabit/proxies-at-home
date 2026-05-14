import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appMock = {
  isPackaged: false,
  getPath: vi.fn(() => '/tmp/proxxied-user-data'),
};

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const spawnMock = vi.fn();
let connectSucceeds = true;

class SocketMock extends EventEmitter {
  destroy = vi.fn();

  connect(_port: number, _host: string, callback: () => void) {
    if (connectSucceeds) {
      callback();
    } else {
      this.emit('error', new Error('connection refused'));
    }
    return this;
  }
}

vi.mock('electron', () => ({ app: appMock }));
vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
  },
}));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('net', () => ({ default: { Socket: SocketMock } }));

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    child.killed = signal !== undefined;
    child.emit('exit', 0, signal ?? null);
    return true;
  });
  return child;
}

describe('MicroserviceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation((checkedPath: string) => checkedPath.includes('cache-bin'));
    mkdirSyncMock.mockReturnValue(undefined);
    connectSucceeds = true;
    spawnMock.mockReturnValue(createChildProcess());
    appMock.isPackaged = false;
    appMock.getPath.mockReturnValue('/tmp/proxxied-user-data');
  });

  it('creates the default Scryfall microservice configuration', async () => {
    const { createScryfallMicroservice } = await import('./microservice-manager');

    const manager = createScryfallMicroservice(9090);

    expect(manager.getPort()).toBe(9090);
    expect(manager.isRunning()).toBe(false);
  });

  it('starts the binary with deterministic environment and stops it cleanly', async () => {
    const { MicroserviceManager } = await import('./microservice-manager');
    const manager = new MicroserviceManager({
      name: 'Cache',
      binaryName: 'cache-bin',
      port: 7777,
      healthCheckPath: '/health',
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await expect(manager.start()).resolves.toBe(7777);

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringContaining('cache-bin'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          PORT: '7777',
          RUST_LOG: 'info',
          DATABASE_URL: '/tmp/proxxied-user-data/databases/scryfall-cache.db',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/proxxied-user-data/databases', {
      recursive: true,
    });
    expect(manager.isRunning()).toBe(true);

    await manager.stop();

    expect(manager.isRunning()).toBe(false);
  });

  it('returns the configured port when start is called while already running', async () => {
    const { MicroserviceManager } = await import('./microservice-manager');
    const manager = new MicroserviceManager({
      name: 'Cache',
      binaryName: 'cache-bin',
      port: 7777,
      healthCheckPath: '/health',
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await manager.start();
    await expect(manager.start()).resolves.toBe(7777);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it('fails when the microservice binary is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    const { MicroserviceManager } = await import('./microservice-manager');
    const manager = new MicroserviceManager({
      name: 'Cache',
      binaryName: 'cache-bin',
      port: 7777,
      healthCheckPath: '/health',
      healthCheckInterval: 60_000,
      maxRestarts: 1,
      restartDelay: 10,
    });

    await expect(manager.start()).rejects.toThrow('Cache binary not found at:');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
