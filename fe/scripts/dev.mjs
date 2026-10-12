import { spawn, spawnSync } from 'node:child_process';
// Both bundles must exist before Chrome can load dist; watch only after that build.
if (spawnSync('npm', ['run', 'build:dev'], { stdio: 'inherit' }).status !== 0) process.exit(1);
const children = [[], ['--config', 'vite.content.config.ts']].map(args =>
  spawn('npm', ['exec', '--', 'vite', 'build', '--watch', '--mode', 'development', ...args], { stdio: 'inherit' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { children.forEach(child => child.kill(signal)); });
