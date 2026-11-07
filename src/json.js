/** Conservative preflight bound prevents JSON escaping/output amplification. */
export function boundedJson(value, maxBytes = 16 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid JSON budget');
  let budget = maxBytes;
  function charge(n) { budget -= n; if (budget < 0) throw new RangeError('JSON output limit exceeded; narrow the query'); }
  function visit(v) {
    if (typeof v === 'string') { charge(v.length * 6 + 2); return; }
    if (v === null || typeof v !== 'object') { charge(32); return; }
    charge(2);
    if (Array.isArray(v)) { for (const item of v) { charge(1); visit(item); } }
    else { for (const [key,item] of Object.entries(v)) { charge(key.length * 6 + 4); visit(item); } }
  }
  visit(value);
  return JSON.stringify(value);
}
