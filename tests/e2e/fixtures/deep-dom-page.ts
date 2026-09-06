export const deepDomProfiles = {
  normal: { depth: 200, frames: 3, nodes: 10_000, shadowRoots: 20 },
  stress: { depth: 1_000, frames: 3, nodes: 100_000, shadowRoots: 20 },
} as const;

export type DeepDomProfile = keyof typeof deepDomProfiles;

/** Public synthetic page shared by native CDB and direct-Playwright measurements. */
export function deepDomPage(url: URL): string {
  const profile = url.searchParams.get('profile') === 'stress' ? 'stress' : 'normal';
  const settings = deepDomProfiles[profile];
  const frameIndex = Number(url.searchParams.get('frame') ?? 0);
  const requestedShadow = url.searchParams.get('shadow');
  const shadowMode = requestedShadow === 'open' || requestedShadow === 'mixed' ? requestedShadow : 'closed';
  const nextUrl = new URL(url);
  if (url.searchParams.get('frames') !== 'same-origin') nextUrl.hostname = `cdb-frame-${frameIndex + 1}.test`;
  nextUrl.searchParams.set('frame', String(frameIndex + 1));
  return `<!doctype html><html><head><meta charset="utf-8"><title>CDB public deep DOM fixture</title>
    <style>body{margin:4px;font:14px sans-serif}iframe{width:90%;height:450px;border:7px solid #aaa;margin-left:23px;margin-top:17px}button,input{font:inherit}#filler{display:grid;grid-template-columns:repeat(8,1fr)}</style></head><body>
    ${frameIndex === 0 ? '<h1>CDB public browser fixture</h1><output role="status" id="result">Ready</output><button id="toggle-overlay">Cover frames</button><button id="prepare-replacement">Prepare replacement</button><button id="navigate-fixture">Navigate fixture</button>' : ''}
    ${frameIndex < settings.frames ? `<iframe title="Frame ${frameIndex + 1}" src="${nextUrl.href}"></iframe>` : '<main id="fixture"></main><div id="filler"></div>'}
    <script>
    (() => {
      const settings = ${JSON.stringify(settings)};
      const frameIndex = ${frameIndex};
      if (frameIndex === 0) {
        document.querySelector('#navigate-fixture').onclick = () => {
          const destination = new URL(location.href);
          destination.searchParams.set('revision', String(Number(destination.searchParams.get('revision') ?? 0) + 1));
          location.href = destination.href;
        };
        addEventListener('message', event => {
          if (event.data?.kind === 'cdb-fixture-saved') document.querySelector('#result').textContent = 'Saved: ' + event.data.value;
        });
        document.querySelector('#toggle-overlay').onclick = () => {
          const overlay = document.createElement('div');
          overlay.id = 'parent-overlay';
          overlay.textContent = 'Parent overlay';
          Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '999999', background: '#eee' });
          document.body.append(overlay);
        };
        document.querySelector('#prepare-replacement').onclick = () => {
          const holder = document.createElement('div');
          holder.style.marginTop = '2000px';
          const createButton = () => {
            const button = document.createElement('button');
            button.textContent = 'Save replacement';
            button.onclick = () => document.querySelector('#result').textContent = 'Replacement saved';
            return button;
          };
          holder.append(createButton());
          document.body.append(holder);
          addEventListener('scroll', () => holder.replaceChildren(createButton()), { once: true });
        };
      }
      if (frameIndex !== settings.frames) return;
      let container = document.querySelector('#fixture');
      let createdNodes = 0;
      for (let depth = 0; depth < settings.depth; depth += 1) {
        const wrapper = document.createElement('section');
        wrapper.setAttribute('role', 'group');
        wrapper.setAttribute('aria-label', 'Layer ' + depth);
        container.append(wrapper);
        container = wrapper;
        createdNodes += 1;
        if (depth % (settings.depth / settings.shadowRoots) === 0) {
          const host = document.createElement('fixture-shadow');
          container.append(host);
          const shadowMode = '${shadowMode}' === 'mixed' ? (depth / (settings.depth / settings.shadowRoots) % 2 === 0 ? 'open' : 'closed') : '${shadowMode}';
          container = host.attachShadow({ mode: shadowMode });
          createdNodes += 2;
        }
      }
      const input = document.createElement('input');
      input.id = 'deep-value';
      input.setAttribute('aria-label', 'Deep value');
      const button = document.createElement('button');
      button.id = 'deep-save';
      button.textContent = 'Save deep value';
      button.onclick = () => top.postMessage({ kind: 'cdb-fixture-saved', value: input.value }, '*');
      container.append(input, button);
      const filler = document.querySelector('#filler');
      const fragment = document.createDocumentFragment();
      for (let index = createdNodes + 3; index < settings.nodes; index += 2) {
        const node = document.createElement('span');
        if (index + 1 < settings.nodes) node.textContent = 'Synthetic row ' + index;
        fragment.append(node);
      }
      filler.append(fragment);
      document.documentElement.dataset.fixtureReady = 'true';
    })();
    </script></body></html>`;
}
