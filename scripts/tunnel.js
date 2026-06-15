import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const localConfig = path.join(os.homedir(), '.cloudflared', 'config.yml');

let exe = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
if (!fs.existsSync(exe)) {
    exe = "C:\\botvlix\\cloudflared.exe";
}

if (!fs.existsSync(exe)) {
    console.error(`[ERROR] cloudflared.exe tidak ditemukan di C:\\Program Files (x86)\\cloudflared atau C:\\botvlix`);
    process.exit(1);
}

console.log(`Starting Cloudflare Tunnel using ${exe}...`);
console.log(`Config file: ${localConfig}`);

const args = ['tunnel', '--config', localConfig, '--protocol', 'http2', 'run'];
const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', (data) => {
    process.stdout.write(data);
});

child.stderr.on('data', (data) => {
    process.stderr.write(data);
});

child.on('close', (code) => {
    console.log(`Cloudflare Tunnel process exited with code ${code}`);
    process.exit(code);
});

child.on('error', (err) => {
    console.error(`Failed to start Cloudflare Tunnel:`, err);
    process.exit(1);
});
