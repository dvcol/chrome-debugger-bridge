export type BrowserControlNotificationColorMode = 'system' | 'light' | 'dark';

export interface BrowserControlNotificationPalette {
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  readonly primary: string;
  readonly primaryHover: string;
  readonly secondaryText: string;
  readonly primaryText: string;
  readonly error: string;
  readonly observe: string;
  readonly inspect: string;
  readonly interact: string;
  readonly debug: string;
  readonly unsafe: string;
}

export interface BrowserControlNotificationTheme {
  readonly light: BrowserControlNotificationPalette;
  readonly dark: BrowserControlNotificationPalette;
  readonly spacing: string;
  readonly radius: string;
  readonly controlRadius: string;
  readonly shadow: string;
  readonly font: string;
  readonly monospaceFont: string;
}

export type BrowserControlNotificationThemeOverrides = Partial<Omit<BrowserControlNotificationTheme, 'light' | 'dark'>> & {
  readonly light?: Partial<BrowserControlNotificationPalette>;
  readonly dark?: Partial<BrowserControlNotificationPalette>;
};

export const defaultBrowserControlNotificationTheme: BrowserControlNotificationTheme = {
  light: {
    surface: '#fff',
    surfaceMuted: '#f5f2ff',
    border: '#c9c1fa',
    text: '#1e1a35',
    textMuted: '#514a68',
    primary: '#6553d8',
    primaryHover: '#5543c7',
    secondaryText: '#4b3e9f',
    primaryText: '#fff',
    error: '#b42318',
    observe: '#1e40af',
    inspect: '#115e59',
    interact: '#92400e',
    debug: '#9a3412',
    unsafe: '#991b1b',
  },
  dark: {
    surface: '#25242c',
    surfaceMuted: '#302e3b',
    border: '#5b537d',
    text: '#f4f1ff',
    textMuted: '#c7c0dc',
    primary: '#7665dc',
    primaryHover: '#8879e6',
    secondaryText: '#e0daff',
    primaryText: '#fff',
    error: '#fda29b',
    observe: '#93c5fd',
    inspect: '#5eead4',
    interact: '#fcd34d',
    debug: '#fdba74',
    unsafe: '#fca5a5',
  },
  spacing: '14px',
  radius: '10px',
  controlRadius: '6px',
  shadow: '0 12px 36px rgba(30, 26, 53, .24)',
  font: 'system-ui, sans-serif',
  monospaceFont: 'ui-monospace, monospace',
};

/** Renderer-only styles; the headless controller never evaluates or installs them. */
export const browserControlNotificationStyles = `
  :host { display:block; color:var(--cdb-text); font:12px/1.4 var(--cdb-font); }
  * { box-sizing:border-box; }
  article { position:relative; margin:8px 0; padding:0 var(--cdb-spacing) 12px; background:var(--cdb-surface); color:var(--cdb-text); border:1px solid var(--cdb-border); border-radius:var(--cdb-radius); box-shadow:var(--cdb-shadow); text-align:right; }
  h2 { margin:0 calc(-1 * var(--cdb-spacing)) 10px; padding:10px 42px 10px var(--cdb-spacing); border-radius:var(--cdb-radius) var(--cdb-radius) 0 0; background:var(--cdb-surface-muted); font:700 13px/1.3 var(--cdb-font); text-align:left; }
  p { margin:0 0 8px; color:var(--cdb-text-muted); text-align:left; overflow-wrap:anywhere; }
  button { border:1px solid var(--cdb-primary); border-radius:var(--cdb-control-radius); padding:7px 11px; font:600 12px/1.2 var(--cdb-font); background:var(--cdb-surface-muted); color:var(--cdb-secondary-text); cursor:pointer; }
  footer { display:flex; justify-content:flex-end; gap:8px; }
  footer button:first-of-type { background:var(--cdb-primary); color:var(--cdb-primary-text); }
  footer button:first-of-type:hover { background:var(--cdb-primary-hover); }
  .dismiss { position:absolute; top:5px; right:6px; background:transparent; color:var(--cdb-text-muted); border:0; padding:5px 8px; font-size:18px; }
  dl { display:flex; flex-wrap:wrap; gap:1px; margin:12px 0; background:var(--cdb-border); border:1px solid var(--cdb-border); border-radius:var(--cdb-control-radius); overflow:hidden; }
  dl > div { flex:1 0 100px; min-width:0; padding:9px 6px; text-align:center; background:var(--cdb-surface-muted); }
  dl > div:first-child { order:1; flex-basis:auto; width:max-content; min-width:100px; max-width:100%; }
  dt { color:var(--cdb-text-muted); font-weight:600; }
  dd { margin:5px 0 0; overflow-wrap:anywhere; }
  code { display:inline-block; padding:3px; background:transparent; font:12px/1.4 var(--cdb-monospace-font); }
  [data-level=observe] { color:var(--cdb-observe); }
  [data-level=inspect] { color:var(--cdb-inspect); }
  [data-level=interact] { color:var(--cdb-interact); }
  [data-level=debug] { color:var(--cdb-debug); }
  [data-level=unsafe] { color:var(--cdb-unsafe); font-weight:700; }
  button:focus-visible { outline:2px solid var(--cdb-primary); outline-offset:2px; }
  button:disabled { opacity:.6; cursor:wait; }
  [role=alert] { color:var(--cdb-error); }
`;

const uppercaseCharacter = /[A-Z]/g;

function variables(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens).map(([name, value]) => `--cdb-${name.replaceAll(uppercaseCharacter, character => `-${character.toLowerCase()}`)}:${value};`).join('');
}

export function notificationThemeStyles(theme: BrowserControlNotificationThemeOverrides = {}, accent?: string): string {
  const { light, dark, ...shared } = defaultBrowserControlNotificationTheme;
  const { light: lightOverrides, dark: darkOverrides, ...sharedOverrides } = theme;
  const branding = accent === undefined ? {} : { primary: accent, primaryHover: accent, accent };
  return `
    :host { ${variables({ ...shared, ...sharedOverrides })} }
    :host, :host([data-color-mode=light]) { color-scheme:light; ${variables({ ...light, ...lightOverrides, ...branding })} }
    :host([data-color-mode=dark]) { color-scheme:dark; ${variables({ ...dark, ...darkOverrides, ...branding })} }
    @media (prefers-color-scheme:dark) {
      :host([data-color-mode=system]) { color-scheme:dark; ${variables({ ...dark, ...darkOverrides, ...branding })} }
    }
  `;
}
