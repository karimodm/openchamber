import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  fileTreeRowSelector,
  isPendingRevealCurrent,
  planFileTreeReveal,
  revealFileTreeRow,
} from './fileTreeReveal';

const domWindow = new Window();
Object.assign(globalThis, { document: domWindow.document });

describe('planFileTreeReveal (#3814)', () => {
  test('expands every directory between the root and the file, outermost first', () => {
    // Order matters: the caller lists these in sequence and a directory
    // cannot be listed before its parent is known.
    expect(planFileTreeReveal('/repo', '/repo/packages/ui/src/main.tsx')).toEqual({
      selectedPath: '/repo/packages/ui/src/main.tsx',
      directoriesToExpand: ['/repo/packages', '/repo/packages/ui', '/repo/packages/ui/src'],
    });
  });

  test('a file directly under the root needs no expansion', () => {
    expect(planFileTreeReveal('/repo', '/repo/README.md')).toEqual({
      selectedPath: '/repo/README.md',
      directoriesToExpand: [],
    });
  });

  test('a filesystem root does not produce a doubled separator', () => {
    expect(planFileTreeReveal('/', '/srv/app/index.ts')).toEqual({
      selectedPath: '/srv/app/index.ts',
      directoriesToExpand: ['/srv', '/srv/app'],
    });
  });

  test('a Windows drive root is handled like any other root', () => {
    expect(planFileTreeReveal('C:/Repo', 'C:/Repo/src/a.ts')).toEqual({
      selectedPath: 'C:/Repo/src/a.ts',
      directoriesToExpand: ['C:/Repo/src'],
    });
  });

  test('a file outside the root reveals nothing', () => {
    // The context panel can hold a tab for a file outside the workspace; the
    // tree has no row for it, so the current selection must stay put.
    expect(planFileTreeReveal('/repo', '/elsewhere/a.ts')).toBeNull();
  });

  test('a sibling root sharing a name prefix is not treated as inside the root', () => {
    expect(planFileTreeReveal('/repo', '/repo-two/a.ts')).toBeNull();
  });

  test('the root itself is not a revealable file', () => {
    expect(planFileTreeReveal('/repo', '/repo')).toBeNull();
    expect(planFileTreeReveal('/repo', '/repo/')).toBeNull();
  });

  test('un-normalized paths are rejected rather than producing phantom ancestors', () => {
    expect(planFileTreeReveal('/repo', '/repo/src//a.ts')).toBeNull();
    expect(planFileTreeReveal('/repo', '/repo/src/../a.ts')).toBeNull();
  });

  test('a missing root or file reveals nothing', () => {
    expect(planFileTreeReveal('', '/repo/a.ts')).toBeNull();
    expect(planFileTreeReveal('/repo', null)).toBeNull();
  });
});

describe('fileTreeRowSelector', () => {
  test('escapes quotes and backslashes so odd file names stay valid selectors', () => {
    expect(fileTreeRowSelector('/repo/a"b.ts')).toBe('[data-tree-path="/repo/a\\"b.ts"]');
    expect(fileTreeRowSelector('/repo/a\\b.ts')).toBe('[data-tree-path="/repo/a\\\\b.ts"]');
  });
});

describe('isPendingRevealCurrent', () => {
  test('a reveal waiting for its row is current while the editor still shows that file', () => {
    expect(isPendingRevealCurrent('/repo/src/a.ts', '/repo/src/a.ts')).toBe(true);
  });

  test('a reveal is dropped once the editor moved to another file', () => {
    // The row can appear much later (a slow listing, or the user unhiding
    // files); scrolling then would move the tree to a file nobody is reading.
    expect(isPendingRevealCurrent('/repo/src/a.ts', '/repo/src/b.ts')).toBe(false);
  });

  test('a reveal is dropped when the active tab is no longer a file in this root', () => {
    expect(isPendingRevealCurrent('/repo/src/a.ts', null)).toBe(false);
  });

  test('nothing pending is never current', () => {
    expect(isPendingRevealCurrent(null, null)).toBe(false);
    expect(isPendingRevealCurrent(null, '/repo/src/a.ts')).toBe(false);
  });
});

describe('revealFileTreeRow', () => {
  const buildTree = (paths: string[]) => {
    const container = document.createElement('ul');
    const rows = new Map<string, HTMLButtonElement>();
    for (const path of paths) {
      const row = document.createElement('button');
      row.setAttribute('data-tree-path', path);
      container.appendChild(row);
      rows.set(path, row);
    }
    return { container, rows };
  };

  const stubScroll = (row: HTMLButtonElement) => {
    const calls: Array<boolean | ScrollIntoViewOptions | undefined> = [];
    row.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { calls.push(options); };
    return calls;
  };

  test('scrolls the row for the path into view with block: nearest', () => {
    // 'nearest' keeps an already-visible row exactly where it is, so merely
    // switching tabs never yanks the tree around.
    const { container, rows } = buildTree(['/repo/a.ts', '/repo/b.ts']);
    const target = rows.get('/repo/b.ts');
    if (!target) throw new Error('row not built');
    const calls = stubScroll(target);

    expect(revealFileTreeRow(container, '/repo/b.ts')).toBe(true);
    expect(calls).toEqual([{ block: 'nearest', inline: 'nearest' }]);
  });

  test('leaves the other rows alone', () => {
    const { container, rows } = buildTree(['/repo/a.ts', '/repo/b.ts']);
    const other = rows.get('/repo/a.ts');
    const target = rows.get('/repo/b.ts');
    if (!other || !target) throw new Error('rows not built');
    const otherCalls = stubScroll(other);
    stubScroll(target);

    revealFileTreeRow(container, '/repo/b.ts');

    expect(otherCalls).toEqual([]);
  });

  test('reports false while the row is not rendered yet', () => {
    // The caller keeps the reveal pending and retries once the directories it
    // asked for have finished listing.
    const { container } = buildTree(['/repo/a.ts']);

    expect(revealFileTreeRow(container, '/repo/deep/b.ts')).toBe(false);
  });

  test('a missing container or empty path is a no-op', () => {
    expect(revealFileTreeRow(null, '/repo/a.ts')).toBe(false);
    expect(revealFileTreeRow(buildTree(['/repo/a.ts']).container, '')).toBe(false);
  });
});
