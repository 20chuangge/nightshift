/**
 * realpath.mjs - where a path really leads (SEC-18).
 *
 * A symlink or a Windows junction inside the workspace can point anywhere, so
 * "is it inside?" is answered on real paths. The file itself may not exist
 * yet (a new file to write): resolve the deepest part that does, and put the
 * rest back on.
 */

import fs from 'node:fs';
import path from 'node:path';

export function realPathOf(p) {
  let current = path.resolve(String(p));
  const rest = [];
  for (let i = 0; i < 256; i += 1) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(String(p));
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(String(p));
}
