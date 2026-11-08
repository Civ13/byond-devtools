// Webview side of the BYOND map editor. Talks to the extension by messages only; every change
// is sent as an edit request and the extension applies it (with undo) through the safe-edit core.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
  let summary = null, region = null, iconSize = 32, tool = 'select', selected = null, cell = null, draft = null, stamp = null, moving = null, painting = null;
  const state = vscode.getState() || {};
  const send = m => vscode.postMessage(m);
  const status = text => { $('status').textContent = text; };
  const view = () => { const size = Number($('size').value), x = Number($('x').value) || 1, y = Number($('y').value) || 1, z = Number($('z').value) || 1; return { x1: x, y1: y, x2: x + size - 1, y2: y + size - 1, z, size }; };
  function render() {
    const v = view(); status('Rendering...');
    const kinds = ['turf', 'obj', 'mob', 'area'].filter(k => $(`k-${k}`).checked), focus = $('focus').value.trim(), animate = $('animate').checked;
    vscode.setState({ x: v.x1, y: v.y1, z: v.z, size: v.size, tool, brush: $('brush').value, kinds, focus, animate });
    if (animate) status('Rendering 8 frames...');
    send({ type: 'render', view: { x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2, z: v.z, kinds, focus, animate } });
  }
  // The PNG goes in as a blob: URL (no data: URL length limits), and the extension hears back
  // whether it actually displayed, so a blank view always comes with a reason.
  let objectUrl = null;
  function show(base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    $('image').src = objectUrl;
  }
  const img = $('image'), overlay = $('overlay');
  img.addEventListener('load', e => { send({ type: 'displayed', width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }); drawOverlay(); });
  img.addEventListener('error', () => { status('The rendered image could not be displayed in this webview.'); send({ type: 'displayed', error: 'image failed to load' }); });
  new ResizeObserver(drawOverlay).observe(img);

  // Tile under the pointer, in map coordinates (y counts up from the bottom of the view).
  function tileAt(e) {
    if (!region || !img.naturalWidth) return null;
    const r = img.getBoundingClientRect(), scale = img.naturalWidth / r.width;
    const tx = Math.floor((e.clientX - r.left) * scale / iconSize), ty = Math.floor((e.clientY - r.top) * scale / iconSize);
    const x = region.x1 + tx, y = region.y2 - ty;
    return x < region.x1 || x > region.x2 || y < region.y1 || y > region.y2 ? null : { x, y, z: region.z };
  }
  function drawOverlay() {
    const r = img.getBoundingClientRect();
    overlay.width = Math.round(r.width); overlay.height = Math.round(r.height);
    overlay.style.width = `${r.width}px`; overlay.style.height = `${r.height}px`;
    const g = overlay.getContext('2d'); g.clearRect(0, 0, overlay.width, overlay.height);
    if (!region || !img.naturalWidth) return;
    const t = iconSize * r.width / img.naturalWidth;
    const box = (c, stroke, fill) => {
      if (c.z !== region.z || c.x < region.x1 || c.x > region.x2 || c.y < region.y1 || c.y > region.y2) return;
      const px = (c.x - region.x1) * t, py = (region.y2 - c.y) * t;
      if (fill) { g.fillStyle = fill; g.fillRect(px, py, t, t); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2; g.strokeRect(px + 1, py + 1, t - 2, t - 2); }
    };
    if (painting) for (const c of painting.cells.values()) box(c, null, tool === 'erase' ? 'rgba(255,60,60,0.4)' : 'rgba(80,160,255,0.4)');
    if (moving) box(moving, '#3cf');
    if (selected) box(selected, '#fd0');
  }

  // Painting tools collect every tile the pointer crosses and send one edit on release.
  img.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const c = tileAt(e); if (!c) return;
    e.preventDefault();
    if (moving) { const from = moving; moving = null; send({ type: 'edit', op: 'move', from, index: from.index, to: c }); select(c); return; }
    if (tool === 'select') { select(c); return; }
    if (tool === 'place' && !$('brush').value.trim()) { status('Type or pick a type path to place first.'); return; }
    if (tool === 'stamp' && !stamp) { status('Select a tile and press "Use as stamp" first.'); return; }
    painting = { cells: new Map([[`${c.x},${c.y}`, c]]) }; drawOverlay();
  });
  img.addEventListener('mousemove', e => {
    if (!painting) return;
    const c = tileAt(e); if (!c || painting.cells.has(`${c.x},${c.y}`)) return;
    painting.cells.set(`${c.x},${c.y}`, c); drawOverlay();
  });
  window.addEventListener('mouseup', () => {
    if (!painting) return;
    const cells = [...painting.cells.values()]; painting = null;
    if (tool === 'place') send({ type: 'edit', op: 'place', cells, atom: $('brush').value.trim() });
    else if (tool === 'erase') send({ type: 'edit', op: 'erase', cells });
    else if (tool === 'stamp') send({ type: 'edit', op: 'stamp', cells, atoms: stamp.atoms });
    drawOverlay();
  });
  img.addEventListener('dragstart', e => e.preventDefault());
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && (moving || painting)) { moving = null; painting = null; status('Cancelled.'); drawOverlay(); } });

  function setTool(name) {
    tool = name;
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === name);
    $('brushbar').hidden = name !== 'place';
    $('stampinfo').hidden = name !== 'stamp';
    vscode.setState({ ...(vscode.getState() || {}), tool });
  }
  for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

  function select(c) { selected = c; draft = null; send({ type: 'inspect', ...c }); drawOverlay(); }

  // Cell editor: a draft copy of the stack that "Apply" sends as one whole-stack edit.
  const atomText = a => a.vars.length ? `${a.path}{${a.vars.map(v => `${v.key} = ${v.value}`).join('; ')}}` : a.path;
  const varLists = new Map();
  function varList(path) {
    const id = `vars-${varLists.size}`;
    if (!varLists.has(path)) { varLists.set(path, id); document.body.append(el('datalist', { id })); send({ type: 'vars', path }); }
    return varLists.get(path);
  }
  function drawCell() {
    const box = $('cell'); box.replaceChildren();
    if (!cell) { box.append('Click a tile.'); return; }
    box.append(el('div', { className: 'where' }, `(${cell.x},${cell.y},${cell.z}) key ${cell.key ?? '-'}`));
    if (!cell.key) { box.append(el('div', {}, 'No authored cell here; cells outside the map\'s grid blocks cannot be added.')); return; }
    const atoms = draft ?? cell.atoms;
    atoms.forEach((a, i) => {
      // Copy the stack into the draft on the first change and enable Apply/Discard without a redraw (keeps focus).
      const touch = () => { draft ??= cell.atoms.map(x => ({ path: x.path, vars: x.vars.map(v => ({ ...v })) })); for (const id of ['apply', 'discard']) { const b = $(id); if (b) b.disabled = false; } return draft[i]; };
      const card = el('div', { className: 'atom' });
      const path = el('input', { className: 'path', value: a.path, spellcheck: false });
      path.setAttribute('list', 'types');
      path.addEventListener('change', () => { touch().path = path.value.trim(); drawCell(); });
      const btn = (label, title, fn) => { const b = el('button', { textContent: label, title, className: 'small' }); b.addEventListener('click', fn); return b; };
      const move = (d) => () => { touch(); const j = i + d; if (j < 0 || j >= draft.length) return; [draft[i], draft[j]] = [draft[j], draft[i]]; drawCell(); };
      card.append(el('div', { className: 'row' }, path,
        btn('↑', 'Move up in the stack', move(-1)), btn('↓', 'Move down in the stack', move(1)),
        btn('✕', 'Remove from this tile', () => { touch(); draft.splice(i, 1); drawCell(); }),
        ...(/^\/(obj|mob)(\/|\{|$)/.test(a.path) ? [btn('Move', 'Move this object to another tile: click the destination next', () => {
          if (draft) { status('Apply or discard your changes before moving an object.'); return; }
          moving = { ...cell, index: i }; drawOverlay(); status(`Click the tile to move ${a.path} to (Escape cancels).`);
        })] : []),
        btn('Brush', 'Use this atom with the Place tool', () => { $('brush').value = atomText(a); setTool('place'); })));
      const list = varList(a.path);
      a.vars.forEach((v, k) => {
        const key = el('input', { className: 'key', value: v.key, spellcheck: false }), value = el('input', { className: 'value', value: v.value, spellcheck: false });
        key.setAttribute('list', list);
        key.addEventListener('change', () => { touch().vars[k].key = key.value.trim(); });
        value.addEventListener('change', () => { touch().vars[k].value = value.value; });
        card.append(el('div', { className: 'row var' }, key, '=', value, btn('✕', 'Remove this override', () => { touch().vars.splice(k, 1); drawCell(); })));
      });
      card.append(el('div', { className: 'row var' }, btn('+ var', 'Override a variable', () => { touch().vars.push({ key: '', value: '' }); drawCell(); })));
      box.append(card);
    });
    const add = el('input', { className: 'path', placeholder: 'add a type path, e.g. /obj/item', spellcheck: false });
    add.setAttribute('list', 'types');
    add.addEventListener('change', () => { if (!add.value.trim()) return; draft ??= cell.atoms.map(x => ({ path: x.path, vars: x.vars.map(v => ({ ...v })) })); draft.unshift({ path: add.value.trim(), vars: [] }); drawCell(); });
    box.append(el('div', { className: 'row' }, add));
    const actions = el('div', { className: 'row actions' });
    const apply = el('button', { id: 'apply', textContent: 'Apply', disabled: !draft, title: 'Write this stack to the tile (undo with Ctrl+Z)' });
    apply.addEventListener('click', () => {
      const atoms = draft.map(a => ({ ...a, vars: a.vars.filter(v => v.key) }));
      if (atoms.some(a => !a.path)) { status('Every atom needs a type path.'); return; }
      send({ type: 'edit', op: 'set', x: cell.x, y: cell.y, z: cell.z, atoms: atoms.map(atomText) });
    });
    const discard = el('button', { id: 'discard', textContent: 'Discard', disabled: !draft, className: 'secondary' });
    discard.addEventListener('click', () => { draft = null; drawCell(); });
    const useStamp = el('button', { textContent: 'Use as stamp', className: 'secondary', title: 'Copy this whole stack for the Stamp tool' });
    useStamp.addEventListener('click', () => { stamp = { atoms: cell.atoms.map(a => a.raw), from: `${cell.x},${cell.y},${cell.z}` }; $('stampinfo').textContent = `Stamp: ${stamp.atoms.length} atoms from (${stamp.from})`; setTool('stamp'); });
    actions.append(apply, discard, useStamp);
    box.append(actions);
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'summary') {
      summary = m.summary;
      $('z').innerHTML = summary.levels.map(z => `<option>${z}</option>`).join('');
      if (state.z) { $('z').value = state.z; $('x').value = state.x; $('y').value = state.y; $('size').value = state.size; }
      if (state.brush) $('brush').value = state.brush;
      if (state.kinds) for (const k of ['turf', 'obj', 'mob', 'area']) $(`k-${k}`).checked = state.kinds.includes(k);
      if (state.focus) $('focus').value = state.focus;
      if (state.animate) $('animate').checked = true;
      $('report').textContent = `world ${summary.world.maxX}x${summary.world.maxY}x${summary.world.maxZ}, ${summary.cellCount} cells, ${summary.dictionaryEntries} entries` +
        (summary.diagnostics.length ? `\n${summary.diagnostics.length} parser diagnostics` : '');
      render();
    } else if (m.type === 'types') {
      $('types').replaceChildren(...m.paths.map(p => el('option', { value: p })));
    } else if (m.type === 'vars') {
      const id = varLists.get(m.path); if (id) $(id).replaceChildren(...m.vars.map(v => el('option', { value: v })));
    } else if (m.type === 'image') {
      region = m.region;
      if (m.error) { status(m.error); img.removeAttribute('src'); drawOverlay(); return; }
      iconSize = m.iconSize; show(m.png);
      status(m.drawn === 0 ? 'Nothing in this view could be drawn: no icon resolved (see Report).'
        : `(${m.region.x1},${m.region.y1})-(${m.region.x2},${m.region.y2}) z${m.region.z} - ${m.drawn} sprites, ${m.truthLayer}${m.animation ? `, animated (${m.animation.frames} frames)` : ''}${m.focus ? `, highlighting ${m.focus}` : ''}, not a client screenshot`);
      $('report').textContent = (m.diagnostics.length ? m.diagnostics.map(d => `${d.code} ${d.detail} x${d.count}`).join('\n') : 'Everything drawn exactly.');
    } else if (m.type === 'cell') {
      if (!selected || m.cell.x !== selected.x || m.cell.y !== selected.y || m.cell.z !== selected.z) return;
      cell = m.cell; draft = null; drawCell();
    } else if (m.type === 'changed') {
      // The map changed (an edit, undo, redo, revert or reload): redraw the view and the selected tile.
      if (m.summary) summary = m.summary;
      render(); if (selected) send({ type: 'inspect', ...selected });
      if (m.message) status(m.message);
    } else if (m.type === 'error') status(m.message);
  });
  $('go').addEventListener('click', render);
  for (const id of ['k-turf', 'k-obj', 'k-mob', 'k-area', 'animate']) $(id).addEventListener('change', render);
  $('focus').addEventListener('change', render);
  $('undo').addEventListener('click', () => send({ type: 'undo' }));
  $('redo').addEventListener('click', () => send({ type: 'redo' }));
  setTool(state.tool || 'select');
  send({ type: 'ready' });
})();
