import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import net from 'net';

interface MicroserviceConfig {
    name: string;
    binaryName: string;
    port: number;
    healthCheckPath: string;
    healthCheckInterval: number;
    maxRestarts: number;
    restartDelay: number;
}

export class MicroserviceManager {
    private process: ChildProcess | null = null;
    private config: MicroserviceConfig;
    private restartCount = 0;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private isShuttingDown = false;

    constructor(config: MicroserviceConfig) {
        this.config = config;
    }

    async start(): Promise<number> {
        if (this.process) {
            console.log(`[${this.config.name}] Already running`);
            return this.config.port;
        }

        const binaryPath = this.getBinaryPath();
        
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`${this.config.name} binary not found at: ${binaryPath}`);
        }

        console.log(`[${this.config.name}] Starting from: ${binaryPath}`);

        const env = {
            ...process.env,
            PORT: this.config.port.toString(),
            RUST_LOG: 'info',
            DATABASE_URL: this.getDatabasePath(),
        };

        this.process = spawn(binaryPath, [], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (data) => {
            console.log(`[${this.config.name}] ${data.toString().trim()}`);
        });

        this.process.stderr?.on('data', (data) => {
            console.error(`[${this.config.name}] ERROR: ${data.toString().trim()}`);
        });

        this.process.on('exit', (code, signal) => {
            console.log(`[${this.config.name}] Exited with code ${code}, signal ${signal}`);
            this.process = null;

            if (!this.isShuttingDown && this.restartCount < this.config.maxRestarts) {
                this.restartCount++;
                console.log(`[${this.config.name}] Attempting restart ${this.restartCount}/${this.config.maxRestarts}`);
                setTimeout(() => {
                    this.start().catch(err => {
                        console.error(`[${this.config.name}] Restart failed:`, err);
                    });
                }, this.config.restartDelay);
            }
        });

        await this.waitForHealthy();
        this.startHealthCheck();
        this.restartCount = 0;

        console.log(`[${this.config.name}] Started successfully on port ${this.config.port}`);
        return this.config.port;
    }

    async stop(): Promise<void> {
        this.isShuttingDown = true;
        
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }

        if (!this.process) {
            return;
        }

        console.log(`[${this.config.name}] Stopping...`);

        return new Promise((resolve) => {
            if (!this.process) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                if (this.process) {
                    console.log(`[${this.config.name}] Force killing after timeout`);
                    this.process.kill('SIGKILL');
                }
                resolve();
            }, 5000);

            this.process.once('exit', () => {
                clearTimeout(timeout);
                this.process = null;
                console.log(`[${this.config.name}] Stopped`);
                resolve();
            });

            this.process.kill('SIGTERM');
        });
    }

    private getBinaryPath(): string {
        const isDev = !app.isPackaged;
        
        if (isDev) {
            const ext = process.platform === 'win32' ? '.exe' : '';
            return path.join(__dirname, '../../..', 'scryfall-cache-microservice', 'target', 'release', `${this.config.binaryName}${ext}`);
        } else {
            const ext = process.platform === 'win32' ? '.exe' : '';
            return path.join(process.resourcesPath, 'microservices', `${this.config.binaryName}${ext}`);
        }
    }

    private getDatabasePath(): string {
        const userDataPath = app.getPath('userData');
        const dbDir = path.join(userDataPath, 'databases');
        
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        return path.join(dbDir, 'scryfall-cache.db');
    }

    private async waitForHealthy(timeout = 30000): Promise<void> {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            if (await this.checkHealth()) {
                return;
            }
            await this.sleep(500);
        }
        
        throw new Error(`${this.config.name} failed to become healthy within ${timeout}ms`);
    }

    private async checkHealth(): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            const timer = setTimeout(() => {
                socket.destroy();
                resolve(false);
            }, 2000);

            socket.connect(this.config.port, 'localhost', () => {
                clearTimeout(timer);
                socket.destroy();
                resolve(true);
            });

            socket.on('error', () => {
                clearTimeout(timer);
                resolve(false);
            });
        });
    }

    private startHealthCheck(): void {
        this.healthCheckTimer = setInterval(async () => {
            if (!await this.checkHealth()) {
                console.error(`[${this.config.name}] Health check failed`);
                if (this.process && this.restartCount < this.config.maxRestarts) {
                    console.log(`[${this.config.name}] Restarting due to failed health check`);
                    this.process.kill('SIGTERM');
                }
            }
        }, this.config.healthCheckInterval);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isRunning(): boolean {
        return this.process !== null && !this.process.killed;
    }

    getPort(): number {
        return this.config.port;
    }
}

export function createScryfallMicroservice(port = 8080): MicroserviceManager {
    return new MicroserviceManager({
        name: 'Scryfall Cache',
        binaryName: 'scryfall-cache',
        port,
        healthCheckPath: '/health',
        healthCheckInterval: 30000,
        maxRestarts: 3,
        restartDelay: 2000,
    });
}
