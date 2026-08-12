/**
 * Contrast checker for the console's design tokens.
 *
 * Parses the OKLCH values straight out of src/index.css and computes the WCAG
 * ratio for every pairing the UI actually ships — including tinted pills,
 * where the effective background is the status fill composited at low alpha
 * over its surface, not the fill itself. Eyeballing that composite is exactly
 * how "muted gray on a tinted near-white" ships at 3.9:1.
 *
 *   node scripts/contrast.mjs          # both themes, failures exit non-zero
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

/** Pulls `--name: oklch(L C H)` declarations out of one CSS block. */
function readTokens(blockSelector) {
  const start = CSS.indexOf(blockSelector);
  if (start === -1) throw new Error(`block not found: ${blockSelector}`);
  const open = CSS.indexOf('{', start);
  const end = CSS.indexOf('\n}', open);
  const block = CSS.slice(open, end);
  const tokens = {};
  for (const [, name, l, c, h] of block.matchAll(
    /--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g,
  )) {
    tokens[name] = [Number(l), Number(c), Number(h)];
  }
  return tokens;
}

/** OKLCH -> linear sRGB (Björn Ottosson's matrices), clamped to gamut. */
function oklchToLinearRgb([L, C, H]) {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
}

const luminance = (linearRgb) =>
  0.2126 * linearRgb[0] + 0.7152 * linearRgb[1] + 0.0722 * linearRgb[2];

function ratio(fg, bg) {
  const [a, b] = [luminance(fg) + 0.05, luminance(bg) + 0.05].sort((x, y) => y - x);
  return a / b;
}

/** Alpha-composites a fill over a surface in linear light — what `bg-ok/12` renders as. */
const composite = (fill, surface, alpha) =>
  fill.map((channel, i) => channel * alpha + surface[i] * (1 - alpha));

function check(themeName, selector) {
  const t = readTokens(selector);
  const rgb = (name) => oklchToLinearRgb(t[name]);
  const white = [1, 1, 1];

  const surfaces = ['canvas', 'panel', 'panel-2'];
  const pairs = [];

  // Body / label ink on every surface it can land on.
  for (const ink of ['ink', 'ink-2', 'ink-3']) {
    for (const surface of surfaces) {
      pairs.push([`${ink} on ${surface}`, rgb(ink), rgb(surface), 4.5]);
    }
  }

  // White label on the brand fill (buttons, active states).
  pairs.push(['white on brand', white, rgb('brand'), 4.5]);
  pairs.push(['white on brand-hover', white, rgb('brand-hover'), 4.5]);
  pairs.push(['brand-bright on panel', rgb('brand-bright'), rgb('panel'), 4.5]);
  pairs.push(['brand-bright on canvas', rgb('brand-bright'), rgb('canvas'), 4.5]);

  // Status pills: `text-<x>-text` over `bg-<x>/12` composited on each surface.
  for (const status of ['ok', 'warn', 'danger', 'info']) {
    for (const surface of ['panel', 'canvas', 'panel-2']) {
      const tint = composite(rgb(status), rgb(surface), 0.15);
      pairs.push([`${status}-text on ${status}/15 over ${surface}`, rgb(`${status}-text`), tint, 4.5]);
    }
  }

  // Hairlines must stay visible against the surfaces they divide (non-text: 3:1
  // is the meaningful bar for a UI boundary, and we only warn below it).
  pairs.push(['line vs panel', rgb('line'), rgb('panel'), 1.15]);
  pairs.push(['line-2 vs panel', rgb('line-2'), rgb('panel'), 1.3]);

  let failed = 0;
  console.log(`\n${themeName}`);
  for (const [label, fg, bg, min] of pairs) {
    const value = ratio(fg, bg);
    const ok = value >= min;
    if (!ok) failed += 1;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${value.toFixed(2).padStart(6)}:1  (min ${min})  ${label}`,
    );
  }
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = check('LIGHT (:root)', ':root {\n  color-scheme: light') + check('DARK (.dark)', '.dark {');
  if (failures > 0) {
    console.error(`\n${failures} pairing(s) below threshold.`);
    process.exit(1);
  }
  console.log('\nAll pairings clear their thresholds.');
}
