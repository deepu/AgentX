const { chromium } = require('playwright');
const fs = require('fs');
const files = {};
for (const f of fs.readdirSync('project').filter(f => f.endsWith('.dc.html'))) {
  const s = fs.readFileSync('project/' + f, 'utf8');
  const inner = s.match(/<x-dc>([\s\S]*)<\/x-dc>/)[1].replace(/<\/?helmet>/g, '');
  const code = s.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  files[f.replace('.dc.html', '')] = { inner, code };
}
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  for (const name of process.argv.slice(2)) {
    await p.setContent('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body><div id="root"></div></body></html>');
    await p.evaluate(({ files, name }) => {
      class DCLogic { constructor(props) { this.props = props; } }
      const look = (scope, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
      const interp = (str, scope) => str.replace(/\{\{([\w.]+)\}\}/g, (_, p) => { const v = look(scope, p); return v == null ? '' : String(v); });
      function comp(nm, props) {
        const f = files[nm]; const C = new Function('DCLogic', f.code + '; return Component;')(DCLogic);
        const vals = new C(props).renderVals();
        const t = document.createElement('template'); t.innerHTML = f.inner;
        const frag = t.content; walk(frag, vals); return frag;
      }
      function walk(node, scope) {
        for (const ch of Array.from(node.childNodes)) {
          if (ch.nodeType === 3) { ch.textContent = interp(ch.textContent, scope); continue; }
          if (ch.nodeType !== 1) continue;
          const tag = ch.tagName.toLowerCase();
          if (tag === 'sc-for') {
            const m = ch.getAttribute('list').match(/\{\{([\w.]+)\}\}/); const list = look(scope, m[1]) || []; const as = ch.getAttribute('as');
            const out = document.createDocumentFragment();
            for (const item of list) { const c = document.createElement('div'); c.innerHTML = ch.innerHTML; walk(c, { ...scope, [as]: item }); while (c.firstChild) out.appendChild(c.firstChild); }
            ch.replaceWith(out); continue;
          }
          if (tag === 'sc-if') {
            const m = ch.getAttribute('value').match(/\{\{([\w.]+)\}\}/); const v = look(scope, m[1]);
            if (v) { const c = document.createElement('div'); c.innerHTML = ch.innerHTML; walk(c, scope); const out = document.createDocumentFragment(); while (c.firstChild) out.appendChild(c.firstChild); ch.replaceWith(out); } else ch.remove();
            continue;
          }
          if (tag === 'dc-import') {
            const props = {}; for (const a of ch.attributes) if (!['name', 'hint-size'].includes(a.name)) props[a.name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = a.value === 'true' ? true : a.value === 'false' ? false : a.value;
            ch.replaceWith(comp(ch.getAttribute('name'), props)); continue;
          }
          for (const a of Array.from(ch.attributes)) if (a.value.includes('{{')) ch.setAttribute(a.name, interp(a.value, scope));
          walk(ch, scope);
        }
      }
      document.getElementById('root').appendChild(comp(name, {}));
    }, { files, name });
    await p.screenshot({ path: 'render/' + name + '.png' });
    console.log(name);
  }
  await b.close();
})();
