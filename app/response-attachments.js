'use strict';
const path = require('node:path');
// Consume only server-observed model output, never renderer-supplied paths.
// A link is a candidate, not authority: AttachmentStore still checks roots, links, type and hash.
function collectResponseAttachments({ text, store, sessionId, sourceId, roots, cwd }) {
  if (!sessionId || !sourceId || !Array.isArray(roots) || !roots.length) return [];
  const result = [], seen = new Set();
  // Deliberately bounded: no remote URLs, plain text path guessing, or whole-workspace scan.
  const pattern = /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^\r\n]*["'])?\s*\)/g;
  let match;
  while ((match = pattern.exec(String(text || '').slice(0, 1024 * 1024))) && result.length < 20) {
    let target = match[1] || match[2];
    if (/^(?:https?|data|javascript|file|sandbox):/i.test(target) || target.startsWith('#')) continue;
    target = target.replace(/#L\d+(?:-L?\d+)?$/, '');
    try { target = decodeURIComponent(target); } catch { continue; }
    if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) continue;
    const resolved = path.resolve(cwd || roots[0], target);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const registered = store.register({ filePath: resolved, allowedRoots: roots, sessionId, sourceId });
    if (registered.ok) result.push(registered.attachment);
  }
  return result;
}
module.exports = { collectResponseAttachments };
