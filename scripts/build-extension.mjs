import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = new URL(process.env.WRITEFOOL_APP_URL || 'http://localhost:5183');
if (app.username || app.password || app.search || app.hash || app.pathname !== '/') throw new Error('WRITEFOOL_APP_URL must be an origin, without path, credentials, query or fragment.');
if (app.protocol !== 'https:' && !(app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname))) throw new Error('Use HTTPS for Writefool, or HTTP for localhost development.');
const outdir = resolve(root, 'extension/dist');
await mkdir(outdir, { recursive: true });
await build({ entryPoints: ['background', 'content', 'popup'].map((entry) => resolve(root, `extension/${entry}.ts`)), outdir, bundle: true, format: 'iife', target: 'chrome120', define: { WRITEFOOL_APP_URL: JSON.stringify(app.origin) } });
for (const name of ['popup.html', 'popup.css']) await writeFile(resolve(outdir, name), await readFile(resolve(root, 'extension', name)));
await writeFile(resolve(outdir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Writefool · Kindle highlights', version: '0.2.0', description: 'Bring your Kindle highlights to your private Writefool library.', minimum_chrome_version: '120', permissions: ['storage', 'alarms', 'cookies'], incognito: 'not_allowed', host_permissions: ['https://read.amazon.com/*', 'https://www.amazon.com/*', 'https://amazon.com/*', `${app.origin}/*`], background: { service_worker: 'background.js' }, action: { default_title: 'Writefool · Kindle', default_popup: 'popup.html' }, content_scripts: [{ matches: ['https://read.amazon.com/notebook*'], js: ['content.js'], run_at: 'document_idle', all_frames: false }], content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" } }, null, 2));
console.log(`Extension built in extension/dist for ${app.origin}. Load that directory as an unpacked Chrome extension.`);
