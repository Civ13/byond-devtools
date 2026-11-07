// Webview side of the read-only BYOND map preview. Talks to the extension by messages only.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let summary = null, region = null, iconSize = 32;
  const state = vscode.getState() || {};
  const send = m => vscode.postMessage(m);
  function render() {
    const size = Number($('size').value), x = Number($('x').value) || 1, y = Number($('y').value) || 1, z = Number($('z').value) || 1;
    $('status').textContent = 'Rendering...';
    vscode.setState({ x, y, z, size });
    send({ type: 'render', view: { x1: x, y1: y, x2: x + size - 1, y2: y + size - 1, z } });
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
  $('image').addEventListener('load', e => send({ type: 'displayed', width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }));
  $('image').addEventListener('error', () => { $('status').textContent = 'The rendered image could not be displayed in this webview.'; send({ type: 'displayed', error: 'image failed to load' }); });
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'summary') {
      summary = m.summary;
      $('z').innerHTML = summary.levels.map(z => `<option>${z}</option>`).join('');
      if (state.z) { $('z').value = state.z; $('x').value = state.x; $('y').value = state.y; $('size').value = state.size; }
      $('report').textContent = `world ${summary.world.maxX}x${summary.world.maxY}x${summary.world.maxZ}, ${summary.cellCount} cells, ${summary.dictionaryEntries} entries` +
        (summary.diagnostics.length ? `\n${summary.diagnostics.length} parser diagnostics` : '');
      render();
    } else if (m.type === 'image') {
      region = m.region;
      if (m.error) { $('status').textContent = m.error; $('image').removeAttribute('src'); return; }
      iconSize = m.iconSize; show(m.png);
      $('status').textContent = m.drawn === 0 ? 'Nothing in this view could be drawn: no icon resolved (see Report).'
        : `(${m.region.x1},${m.region.y1})-(${m.region.x2},${m.region.y2}) z${m.region.z} - ${m.drawn} sprites, ${m.truthLayer}, not a client screenshot`;
      $('report').textContent = (m.diagnostics.length ? m.diagnostics.map(d => `${d.code} ${d.detail} x${d.count}`).join('\n') : 'Everything drawn exactly.');
    } else if (m.type === 'cell') {
      const c = m.cell;
      $('cell').textContent = `(${c.x},${c.y},${c.z}) key ${c.key ?? '-'}\n` + (c.atoms.map(a => a.path + (a.overrides || '')).join('\n') || 'no authored cell');
    } else if (m.type === 'error') $('status').textContent = m.message;
  });
  $('go').addEventListener('click', render);
  $('image').addEventListener('click', e => {
    if (!region) return;
    const img = e.currentTarget, scale = img.naturalWidth / img.clientWidth;
    const tx = Math.floor(e.offsetX * scale / iconSize), ty = Math.floor(e.offsetY * scale / iconSize);
    send({ type: 'inspect', x: region.x1 + tx, y: region.y2 - ty, z: region.z });
  });
  send({ type: 'ready' });
})();
