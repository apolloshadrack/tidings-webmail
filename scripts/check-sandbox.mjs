// Guards the two invariants that keep untrusted mail from running code in our origin:
//  1. the message iframe sandbox never gains allow-scripts (or other dangerous tokens)
//  2. dangerouslySetInnerHTML is not used anywhere in the web client
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('../apps/web/src/', import.meta.url).pathname;
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(tsx?|ts)$/.test(f) && files.push(p); } };
walk(root);
let fail = 0;
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  if (/allow-scripts|allow-top-navigation|allow-forms|allow-modals/.test(s)) { console.error(`forbidden sandbox token in ${f}`); fail++; }
  if (/dangerouslySetInnerHTML/.test(s)) { console.error(`dangerouslySetInnerHTML in ${f}`); fail++; }
}
const sanitize = readFileSync(join(root, 'lib/sanitize.ts'), 'utf8');
if (!sanitize.includes("export const IFRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';")) { console.error('IFRAME_SANDBOX changed'); fail++; }
if (!/script-src 'none'/.test(sanitize)) { console.error('message CSP lost script-src none'); fail++; }
console.log(fail ? `${fail} sandbox violations` : `sandbox guard ok (${files.length} files)`);
process.exit(fail ? 1 : 0);
