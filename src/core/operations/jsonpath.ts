/**
 * A small JSONPath engine used by the built-in `json.query` operation.
 *
 * It supports the subset that shows up in practice:
 *   $            root
 *   .key         child
 *   ['key']      child
 *   [0]          index
 *   [*] / .*     wildcard
 *   ..key        recursive descent
 *   [?(@.k=='v')] simple filters
 */

type Segment =
  | { type: 'child'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }
  | { type: 'recurse' }
  | { type: 'filter'; expr: string };

function tokenize(path: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  const text = path.trim();

  if (text.startsWith('$')) i = 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '.') {
      if (text[i + 1] === '.') {
        // recursive descent
        i += 2;
        let name = '';
        while (i < text.length && /[A-Za-z0-9_\-]/.test(text[i]!)) name += text[i++];
        if (name) segments.push({ type: 'recurse' }, { type: 'child', name });
        else segments.push({ type: 'recurse' });
        continue;
      }
      i++;
      if (text[i] === '*') {
        i++;
        segments.push({ type: 'wildcard' });
        continue;
      }
      let name = '';
      while (i < text.length && /[A-Za-z0-9_\-\s]/.test(text[i]!)) {
        if (/\s/.test(text[i]!) && !/^['"]/.test(text.slice(i))) break;
        name += text[i++];
      }
      name = name.trim().replace(/^['"]|['"]$/g, '');
      if (name) segments.push({ type: 'child', name });
      continue;
    }

    if (ch === '[') {
      const end = text.indexOf(']', i);
      if (end === -1) break;
      const inner = text.slice(i + 1, end).trim();
      i = end + 1;

      if (inner === '*') {
        segments.push({ type: 'wildcard' });
      } else if (inner.startsWith('?')) {
        segments.push({ type: 'filter', expr: inner.slice(1).trim() });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ type: 'index', index: Number(inner) });
      } else {
        segments.push({ type: 'child', name: inner.replace(/^['"]|['"]$/g, '') });
      }
      continue;
    }

    // Bare leading key, e.g. "items[0].name"
    let name = '';
    while (i < text.length && /[A-Za-z0-9_\-]/.test(text[i]!)) name += text[i++];
    if (name) segments.push({ type: 'child', name });
    else i++;
  }

  return segments;
}

function children(node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  if (node && typeof node === 'object') return Object.values(node as Record<string, unknown>);
  return [];
}

function collectRecurse(node: unknown, segments: Segment[], index: number, out: unknown[]): void {
  out.push(node);
  if (index >= segments.length) return;
  for (const child of children(node)) {
    collectRecurse(child, segments, index, out);
  }
}

function evaluateFilter(node: unknown, expr: string): boolean {
  const cleaned = expr.replace(/^\(/, '').replace(/\)$/, '').trim();
  const match = /^@\.?([A-Za-z0-9_\.]*)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/.exec(cleaned);
  if (!match) return false;

  const [, rawPath = '', operator = '==', rawValue = ''] = match;
  const path = rawPath.replace(/\.$/, '');
  let value: unknown = node;

  if (path) {
    for (const part of path.split('.')) {
      if (value && typeof value === 'object') {
        value = (value as Record<string, unknown>)[part];
      } else {
        return false;
      }
    }
  }

  let expected: unknown = rawValue.trim().replace(/^['"]|['"]$/g, '');
  if (/^-?\d+(\.\d+)?$/.test(String(expected))) expected = Number(expected);
  if (rawValue.trim() === 'true') expected = true;
  if (rawValue.trim() === 'false') expected = false;
  if (rawValue.trim() === 'null') expected = null;

  switch (operator) {
    case '==':
      return value === expected;
    case '!=':
      return value !== expected;
    case '>':
      return Number(value) > Number(expected);
    case '<':
      return Number(value) < Number(expected);
    case '>=':
      return Number(value) >= Number(expected);
    case '<=':
      return Number(value) <= Number(expected);
    case 'contains':
      return String(value).includes(String(expected));
    default:
      return false;
  }
}

function walk(node: unknown, segments: Segment[], index: number, out: unknown[]): void {
  if (index >= segments.length) {
    out.push(node);
    return;
  }

  const segment = segments[index]!;

  switch (segment.type) {
    case 'child': {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        const value = (node as Record<string, unknown>)[segment.name];
        if (value !== undefined) walk(value, segments, index + 1, out);
      }
      return;
    }
    case 'index': {
      if (Array.isArray(node)) {
        const idx = segment.index < 0 ? node.length + segment.index : segment.index;
        if (idx >= 0 && idx < node.length) walk(node[idx], segments, index + 1, out);
      }
      return;
    }
    case 'wildcard': {
      for (const child of children(node)) walk(child, segments, index + 1, out);
      return;
    }
    case 'recurse': {
      // Collect every match of the remaining segments anywhere below this node.
      const collected: unknown[] = [];
      const descend = (current: unknown): void => {
        const matches: unknown[] = [];
        walk(current, segments, index + 1, matches);
        collected.push(...matches);
        for (const child of children(current)) descend(child);
      };
      descend(node);
      out.push(...collected);
      return;
    }
    case 'filter': {
      for (const child of children(node)) {
        if (evaluateFilter(child, segment.expr)) walk(child, segments, index + 1, out);
      }
      return;
    }
  }
}

/** Evaluate a JSONPath expression and return every match. */
export function jsonPath(root: unknown, path: string): unknown[] {
  const segments = tokenize(path);
  if (segments.length === 0) return [root];
  const out: unknown[] = [];
  walk(root, segments, 0, out);
  return out;
}

/** Common aggregate helpers that make the builtin query feel jq-like. */
export function applyAggregate(node: unknown, name: string): unknown {
  switch (name) {
    case 'length':
      if (Array.isArray(node)) return node.length;
      if (typeof node === 'string') return node.length;
      if (node && typeof node === 'object') return Object.keys(node).length;
      return 0;
    case 'keys':
      if (Array.isArray(node)) return node.map((_, index) => index);
      if (node && typeof node === 'object') return Object.keys(node);
      return [];
    case 'values':
      if (Array.isArray(node)) return node;
      if (node && typeof node === 'object') return Object.values(node);
      return [];
    case 'type':
      if (Array.isArray(node)) return 'array';
      if (node === null) return 'null';
      return typeof node;
    case 'add':
      return Array.isArray(node) ? node.reduce<number>((sum, item) => sum + Number(item), 0) : 0;
    case 'sort':
      return Array.isArray(node) ? [...node].sort() : node;
    case 'reverse':
      return Array.isArray(node) ? [...node].reverse() : node;
    case 'unique':
      return Array.isArray(node) ? [...new Set(node)] : node;
    case 'min':
      return Array.isArray(node) && node.length ? node.reduce((a, b) => (a < b ? a : b)) : undefined;
    case 'max':
      return Array.isArray(node) && node.length ? node.reduce((a, b) => (a > b ? a : b)) : undefined;
    default:
      return undefined;
  }
}
