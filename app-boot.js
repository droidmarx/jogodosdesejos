(async function() {
  const b64 = (window.__APP_B64_PARTS || []).join('');
  if (!b64) { console.error('app data missing'); return; }
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const stream = new Response(bin).body.pipeThrough(ds);
  const text = await new Response(stream).text();
  (0, eval)(text);
})().catch(e => console.error('app load failed', e));
