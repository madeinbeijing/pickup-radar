/**
 * Straight-on rear renders of each product, drawn to the real hardware's proportions.
 *
 * Geometry was measured from Apple's own finish-select imagery (iPhone 18 Pro, Sept 2026;
 * iPhone Duo, Sept 2026) and normalised to each viewBox; colours were sampled from the
 * same images. Both renders share one scale — 1 viewBox unit ≈ 0.49 mm on 18 Pro Max and
 * 0.42 mm on Duo, which `heightMm` corrects for — so the Duo really looks shorter.
 */

// Simple Icons "Apple" glyph (CC0), 24×24 box centred on (12, 12).
const APPLE = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701';

/** Colours sampled from Apple's renders: aluminium, plateau highlight, glass top/bottom, edge, logo. */
const PRO_FINISHES = {
  silver:         { metal: '#e4e4e2', lit: '#f2f2f1', edge: '#f7f7f6', side: '#cfcfcd', glassTop: '#e3e3e1', glassBottom: '#d5d5d3', logo: '#ececeb', ring: ['#ffffff', '#8f8f8d'], dark: false },
  'glacier-blue': { metal: '#bcc9da', lit: '#d3dae5', edge: '#d8e0ec', side: '#a7b4c6', glassTop: '#b9c6d8', glassBottom: '#a3b0c3', logo: '#c9d3e3', ring: ['#eef3fa', '#7c8aa0'], dark: false },
  burgundy:       { metal: '#653742', lit: '#80545d', edge: '#8d636b', side: '#4f2830', glassTop: '#58333b', glassBottom: '#47282e', logo: '#69434b', ring: ['#c79aa3', '#4a2229'], dark: true },
  black:          { metal: '#2c2c2e', lit: '#434345', edge: '#58585a', side: '#1c1c1e', glassTop: '#27272a', glassBottom: '#1c1c1e', logo: '#343437', ring: ['#9a9a9d', '#2a2a2c'], dark: true }
};

const DUO_FINISHES = {
  starwhite: { back: '#ecebe8', backBottom: '#e1dfda', pill: '#f4f3f1', pillShade: '#dcdad5', frame: ['#fbfaf8', '#b9b6af', '#e9e6e0'], logo: '#dddcd8', ring: ['#ffffff', '#8e8c87'], dark: false },
  nightsky:  { back: '#343c47', backBottom: '#2a323d', pill: '#3d4550', pillShade: '#262d36', frame: ['#6b7c95', '#1f2833', '#4a5a70'], logo: '#232a33', ring: ['#a9b6c9', '#27303c'], dark: true }
};

function lens(cx, cy, r, ring, id) {
  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}-ring)"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.85}" fill="#0e0f11"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.72}" fill="url(#${id}-lens)"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.3}" fill="#141a26"/>
    <circle cx="${cx - r * 0.1}" cy="${cy - r * 0.08}" r="${r * 0.13}" fill="#3b4d7a" opacity=".55"/>
    <circle cx="${cx - r * 0.3}" cy="${cy - r * 0.32}" r="${r * 0.09}" fill="#fff" opacity=".5"/>`;
}

function lensDefs(id, ring) {
  return `
    <linearGradient id="${id}-ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ring[0]}"/><stop offset=".55" stop-color="${ring[1]}"/><stop offset="1" stop-color="${ring[0]}"/>
    </linearGradient>
    <radialGradient id="${id}-lens" cx=".4" cy=".35" r=".75">
      <stop offset="0" stop-color="#2a3346"/><stop offset=".6" stop-color="#0c0f16"/><stop offset="1" stop-color="#050608"/>
    </radialGradient>`;
}

function logo(cx, cy, height, fill) {
  const s = height / 24;
  return `<path d="${APPLE}" fill="${fill}" transform="translate(${cx - 12 * s} ${cy - 12 * s}) scale(${s})"/>`;
}

/** iPhone 18 Pro Max — 78.0 × 163.4 mm, full-width aluminium camera plateau over a glass back. */
function proMax(f, colorId) {
  const id = `pm-${colorId}`;
  const W = 160, H = 335;
  return {
    heightMm: 163.4,
    viewBox: `0 0 ${W} ${H}`,
    ratio: W / H,
    body: `
      <defs>
        <linearGradient id="${id}-metal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="${f.edge}"/><stop offset=".06" stop-color="${f.metal}"/><stop offset=".94" stop-color="${f.metal}"/><stop offset="1" stop-color="${f.edge}"/>
        </linearGradient>
        <linearGradient id="${id}-plateau" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${f.lit}"/><stop offset=".5" stop-color="${f.metal}"/><stop offset="1" stop-color="${f.metal}"/>
        </linearGradient>
        <linearGradient id="${id}-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${f.glassTop}"/><stop offset="1" stop-color="${f.glassBottom}"/>
        </linearGradient>
        <filter id="${id}-lift" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity="${f.dark ? .45 : .18}"/>
        </filter>
        ${lensDefs(id, f.ring)}
      </defs>
      <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="25" fill="url(#${id}-metal)" stroke="${f.dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)'}"/>
      <rect x="8" y="99.5" width="144" height="227.5" rx="14" fill="url(#${id}-glass)"/>
      <rect x="8" y="99.5" width="144" height="227.5" rx="14" fill="none" stroke="${f.dark ? 'rgba(0,0,0,.35)' : 'rgba(0,0,0,.06)'}"/>
      <rect x="6" y="6" width="148" height="86" rx="17" fill="${f.side}" filter="url(#${id}-lift)"/>
      <rect x="6" y="4.5" width="148" height="86" rx="17" fill="url(#${id}-plateau)"/>
      <rect x="6.6" y="5.1" width="146.8" height="84.8" rx="16.4" fill="none" stroke="${f.edge}" stroke-opacity=".7" stroke-width=".9"/>
      ${lens(30.6, 29.6, 16.2, f.ring, id)}
      ${lens(30.6, 69.9, 16.2, f.ring, id)}
      ${lens(68.5, 49.7, 16.2, f.ring, id)}
      <circle cx="133.3" cy="27" r="6.2" fill="#f4eed8" stroke="rgba(0,0,0,.22)" stroke-width=".8"/>
      <circle cx="132" cy="25.8" r="2" fill="#fff" opacity=".7"/>
      <circle cx="132.3" cy="47.6" r="1" fill="rgba(0,0,0,.45)"/>
      <circle cx="133.3" cy="69.9" r="6.8" fill="#1c1c1e" stroke="rgba(0,0,0,.3)" stroke-width=".6"/>
      <circle cx="131.6" cy="68.3" r="1.6" fill="#fff" opacity=".18"/>
      ${logo(80, 202.5, 40, f.logo)}`
  };
}

/** Rounded rect with radius `rl` on the left corners and `rr` on the right (hinge) corners. */
function shell(x, y, w, h, rl, rr) {
  return `M${x + rl} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h - rr}Q${x + w} ${y + h} ${x + w - rr} ${y + h}H${x + rl}`
    + `A${rl} ${rl} 0 0 1 ${x} ${y + h - rl}V${y + rl}A${rl} ${rl} 0 0 1 ${x + rl} ${y}Z`;
}

/** iPhone Duo, folded — 84.1 × 117.8 mm, titanium frame, horizontal camera pill, hinge on the right. */
function duo(f, colorId) {
  const id = `duo-${colorId}`;
  const W = 200, H = 280;
  return {
    heightMm: 117.8,
    viewBox: `0 0 ${W} ${H}`,
    ratio: W / H,
    body: `
      <defs>
        <linearGradient id="${id}-frame" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${f.frame[0]}"/><stop offset=".45" stop-color="${f.frame[1]}"/><stop offset=".7" stop-color="${f.frame[2]}"/><stop offset="1" stop-color="${f.frame[1]}"/>
        </linearGradient>
        <linearGradient id="${id}-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${f.back}"/><stop offset="1" stop-color="${f.backBottom}"/>
        </linearGradient>
        <linearGradient id="${id}-pill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${f.pill}"/><stop offset="1" stop-color="${f.pillShade}"/>
        </linearGradient>
        <linearGradient id="${id}-hinge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="${f.frame[1]}"/><stop offset=".5" stop-color="${f.frame[0]}"/><stop offset="1" stop-color="${f.frame[1]}"/>
        </linearGradient>
        <filter id="${id}-lift" x="-10%" y="-20%" width="120%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="${f.dark ? .5 : .16}"/>
        </filter>
        ${lensDefs(id, f.ring)}
      </defs>
      <path d="${shell(.5, .5, W - 1, H - 1, 24, 9)}" fill="url(#${id}-frame)" stroke="${f.dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.18)'}"/>
      <path d="${shell(3, 3, W - 8.5, H - 6, 21.5, 4)}" fill="url(#${id}-back)"/>
      <rect x="${W - 5.2}" y="8" width="4.4" height="${H - 16}" rx="2.2" fill="url(#${id}-hinge)"/>
      <line x1="${W - 5.5}" y1="10" x2="${W - 5.5}" y2="${H - 10}" stroke="rgba(0,0,0,${f.dark ? .5 : .16})" stroke-width=".7"/>
      <rect x="10.6" y="10.8" width="137.8" height="51" rx="25.5" fill="url(#${id}-pill)" filter="url(#${id}-lift)"/>
      <rect x="11.1" y="11.3" width="136.8" height="50" rx="25" fill="none" stroke="${f.dark ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.9)'}" stroke-width=".8"/>
      ${lens(35.7, 36.2, 19.5, f.ring, id)}
      ${lens(80.1, 36.2, 19.5, f.ring, id)}
      <rect x="117.5" y="23.8" width="7.8" height="3.3" rx="1.65" fill="${f.dark ? '#151a21' : '#6d6c68'}"/>
      <circle cx="120.8" cy="46.5" r="4.4" fill="#efe6cf" stroke="rgba(0,0,0,.2)" stroke-width=".7"/>
      <circle cx="119.9" cy="45.6" r="1.4" fill="#fff" opacity=".75"/>
      ${logo(98, 142.6, 46, f.logo)}`
  };
}

/**
 * Build the SVG for a product/colour. `maxHeight` is the pixel height of the tallest
 * product (18 Pro Max); other products are scaled by their real height in millimetres.
 */
export function deviceArt(productId, colorId, maxHeight = 184) {
  // Gradient ids are document-global, so they carry the finish to stay unique per render.
  const art = productId === 'iphone-duo'
    ? duo(DUO_FINISHES[colorId] || DUO_FINISHES.starwhite, DUO_FINISHES[colorId] ? colorId : 'starwhite')
    : proMax(PRO_FINISHES[colorId] || PRO_FINISHES.silver, PRO_FINISHES[colorId] ? colorId : 'silver');
  const height = Math.round(maxHeight * (art.heightMm / 163.4));
  const width = Math.round(height * art.ratio);
  return `<svg viewBox="${art.viewBox}" width="${width}" height="${height}" role="img" aria-hidden="true">${art.body}</svg>`;
}
