import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_JSON_BYTES = 10 * 1024 * 1024;

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolvePathWithin(root, input) {
  const rootPath = resolve(root);
  const target = resolve(rootPath, input);
  if (!isInside(rootPath, target)) {
    throw new Error('File path must stay inside B24_WORKSPACE_DIR.');
  }
  return target;
}

function workspaceRoot() {
  const configured = (process.env.B24_WORKSPACE_DIR || '').trim();
  const root = resolve(configured || join(process.cwd(), 'data'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return realpathSync(root);
}

export function resolveWorkspaceFile(input, { defaultName, mustExist = false } = {}) {
  const raw = (input || defaultName || '').trim();
  if (!raw) throw new Error('File name is required.');

  const root = workspaceRoot();
  const candidate = resolvePathWithin(root, raw);

  if (mustExist) {
    const actual = realpathSync(candidate);
    if (!isInside(root, actual) || !lstatSync(actual).isFile()) {
      throw new Error('File path must point to a regular file inside B24_WORKSPACE_DIR.');
    }
    return actual;
  }

  const parent = dirname(candidate);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const actualParent = realpathSync(parent);
  if (!isInside(root, actualParent)) {
    throw new Error('File path must stay inside B24_WORKSPACE_DIR.');
  }

  if (existsSync(candidate)) {
    const actual = realpathSync(candidate);
    if (!isInside(root, actual) || !lstatSync(actual).isFile()) {
      throw new Error('File path must point to a regular file inside B24_WORKSPACE_DIR.');
    }
  }
  return join(actualParent, basename(candidate));
}

export function readWorkspaceJson(input) {
  const filePath = resolveWorkspaceFile(input, { mustExist: true });
  const stat = lstatSync(filePath);
  if (stat.size > MAX_JSON_BYTES) {
    throw new Error('JSON file exceeds the 10 MiB workspace limit.');
  }
  return { filePath, data: JSON.parse(readFileSync(filePath, 'utf8')) };
}

export function writeWorkspaceJson(input, value, { defaultName } = {}) {
  const filePath = resolveWorkspaceFile(input, { defaultName });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw error;
  }
  return filePath;
}
