// Verifies every theme token pair used for text meets WCAG AA (4.5:1), non-text indicators 3:1.
import { THEMES, contrast } from '../apps/web/src/styles/themes.ts';
let failures = 0;
for (const t of THEMES) {
  const k = t.tokens;
  const checks: [string, string, string, number][] = [];
  for (const bg of ['surface', 'sunken', 'raised'] as const) {
    for (const fg of ['text', 'text2', 'text3', 'accent', 'danger', 'warn', 'ok'] as const) checks.push([fg, bg, '', 4.5]);
    checks.push(['unread', bg, '', 3]);
    checks.push(['star', bg, '', 3]);
  }
  checks.push(['accentText', 'accent', '', 4.5]);
  for (const [fg, bg, , min] of checks) {
    const r = contrast((k as any)[fg], (k as any)[bg]);
    if (r < min) { failures++; console.log(`${t.id.padEnd(16)} ${fg} on ${bg}: ${r.toFixed(2)} < ${min}`); }
  }
}
console.log(failures ? `${failures} contrast failures` : 'all themes pass WCAG AA');
process.exit(failures ? 1 : 0);
