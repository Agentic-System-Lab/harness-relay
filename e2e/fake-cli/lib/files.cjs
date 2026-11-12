'use strict';
/*
 * Files and folders as the fakes see them: where a write step goes, whether a path is inside the
 * folders a CLI may use, a folder's listing, and the skills a CLI finds by itself.
 */
const fs = require('node:fs');
const path = require('node:path');

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A path by its real location, also when it does not exist yet (its nearest existing folder's). */
function realLocation(p) {
  let at = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) break;
    rest.unshift(path.basename(at));
    at = up;
  }
  let real = at;
  try {
    real = fs.realpathSync.native(at);
  } catch {
    /* as it is */
  }
  const full = path.join(real, ...rest);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** Whether `file` is inside one of `dirs` (null: anywhere, as with full access). */
function inside(file, dirs) {
  if (dirs === null) return true;
  const f = realLocation(file);
  return dirs.some((d) => {
    const r = realLocation(d);
    return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

/**
 * The file a write step goes to, or none for a write in another working directory when the CLI was
 * given none. `others`: the working directories it was given besides its own.
 */
function targetOf(step, cwd, others) {
  if (step.other && !others.length) return undefined;
  return path.resolve(step.other ? others[0] : cwd, step.path);
}

/** Folders a turn may also use that are not working directories: the chat's attachments. */
const notAWorkingDirectory = (dir) => /[\\/]attachments[\\/]/.test(dir + path.sep);

/** A folder's entries, one a line (`.git` left out), or why it could not be read. */
function safeList(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n !== '.git').sort().join('\n') || '(empty)';
  } catch (err) {
    return String(err.message || err);
  }
}

/**
 * The skills a CLI loads by itself from one of its skills folders (its home's, a project's): a
 * `<name>/SKILL.md` each, with the description its front matter gives.
 */
function ownSkills(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name, 'SKILL.md');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return [{ name, description: ((/^description:\s*(.+)$/m.exec(text) || [])[1] || '').trim(), path: file }];
  });
}

module.exports = { writeFile, realLocation, inside, targetOf, notAWorkingDirectory, safeList, ownSkills };
