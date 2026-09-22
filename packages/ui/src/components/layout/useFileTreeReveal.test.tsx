import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { FileTreeRevealParams } from './useFileTreeReveal';

type Scenario = {
  root: string | null;
  activeFilePath: string | null;
  enabled: boolean;
  searchActive: boolean;
  searchResultCount: number;
  /** Directory → the row paths currently rendered under it. */
  childrenByDir: Record<string, string[]>;
  expandedPaths: string[];
  loadedDirs: string[];
};

type Harness = {
  scrolls: string[];
  selected: Array<[string, string]>;
  expanded: Array<[string, string[]]>;
  listed: string[];
  /** Resolve a pending loadDirectory call by rendering its children. */
  resolveListing: (directory: string, rowPaths: string[]) => Promise<void>;
  render: (next: Partial<Scenario>) => Promise<void>;
  teardown: () => void;
};

const baseScenario: Scenario = {
  root: '/repo',
  activeFilePath: null,
  enabled: true,
  searchActive: false,
  searchResultCount: 0,
  childrenByDir: {},
  expandedPaths: [],
  loadedDirs: [],
};

const setupHarness = async (initial: Partial<Scenario> = {}): Promise<Harness> => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const scrolls: string[] = [];
  // Recording on the prototype captures whichever row the reveal picked,
  // instead of the test having to guess it in advance.
  dom.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolls.push(this.getAttribute('data-tree-path') ?? '');
  };

  const selected: Array<[string, string]> = [];
  const expanded: Array<[string, string[]]> = [];
  const listed: string[] = [];
  const pendingListings = new Map<string, () => void>();

  let scenario: Scenario = { ...baseScenario, ...initial };
  const loadedDirs = new Set(scenario.loadedDirs);

  const { createRoot } = await import('react-dom/client');
  const { useFileTreeReveal } = await import('./useFileTreeReveal');

  // The globals above are installed, so these are happy-dom nodes typed as
  // the standard DOM by TypeScript.
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  const listRef = React.createRef<HTMLUListElement>();

  const Harness: React.FC = () => {
    const rowsByDir = Object.fromEntries(
      Object.entries(scenario.childrenByDir).map(([dir, paths]) => [dir, paths.map((path) => ({ path }))]),
    );
    const params: FileTreeRevealParams = {
      root: scenario.root,
      activeFilePath: scenario.activeFilePath,
      enabled: scenario.enabled,
      searchActive: scenario.searchActive,
      searchResultCount: scenario.searchResultCount,
      listRef,
      childrenByDir: rowsByDir,
      expandedPaths: scenario.expandedPaths,
      isDirectoryLoaded: (path) => loadedDirs.has(path),
      loadDirectory: (path) => {
        listed.push(path);
        return new Promise<void>((resolve) => {
          pendingListings.set(path, () => {
            loadedDirs.add(path);
            resolve();
          });
        });
      },
      selectPath: (root, path) => { selected.push([root, path]); },
      expandPaths: (root, paths) => { expanded.push([root, paths]); },
    };
    useFileTreeReveal(params);

    const rowPaths = Object.values(scenario.childrenByDir).flat();
    return (
      <ul ref={listRef}>
        {rowPaths.map((path) => (
          <li key={path}><button type="button" data-tree-path={path} /></li>
        ))}
      </ul>
    );
  };

  const render = async (next: Partial<Scenario>) => {
    scenario = { ...scenario, ...next };
    await act(async () => {
      reactRoot.render(<Harness />);
    });
  };

  const resolveListing = async (directory: string, rowPaths: string[]) => {
    const resolve = pendingListings.get(directory);
    if (!resolve) throw new Error(`no pending listing for ${directory}`);
    pendingListings.delete(directory);
    await act(async () => {
      resolve();
    });
    // The real tree re-renders with the new children once the listing lands.
    await render({
      childrenByDir: { ...scenario.childrenByDir, [directory]: rowPaths },
      expandedPaths: scenario.expandedPaths.includes(directory)
        ? scenario.expandedPaths
        : [...scenario.expandedPaths, directory],
    });
  };

  await render({});

  return {
    scrolls,
    selected,
    expanded,
    listed,
    resolveListing,
    render,
    teardown: () => {
      act(() => { reactRoot.unmount(); });
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

test('scrolls to a row that is already rendered', async () => {
  // The common case, and the one a retry keyed only on listings/expansion
  // misses entirely: switching to a tab whose folders are already open makes
  // no directory land and no expansion change, yet the row can still be far
  // off screen.
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/src'], '/repo/src': ['/repo/src/a.ts', '/repo/src/b.ts'] },
    expandedPaths: ['/repo/src'],
    loadedDirs: ['/repo', '/repo/src'],
  });
  try {
    await harness.render({ activeFilePath: '/repo/src/b.ts' });

    expect(harness.scrolls).toEqual(['/repo/src/b.ts']);
    expect(harness.selected).toEqual([['/repo', '/repo/src/b.ts']]);
    expect(harness.listed).toEqual([]);
  } finally {
    harness.teardown();
  }
});

test('expands and lists the ancestors outermost first, then scrolls once the row renders', async () => {
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/packages'] },
    loadedDirs: ['/repo'],
  });
  try {
    await harness.render({ activeFilePath: '/repo/packages/ui/src/main.tsx' });

    expect(harness.expanded).toEqual([['/repo', ['/repo/packages', '/repo/packages/ui', '/repo/packages/ui/src']]]);
    // Only the outermost unlisted directory is requested first: the next one
    // cannot be listed before its parent is known.
    expect(harness.listed).toEqual(['/repo/packages']);
    expect(harness.scrolls).toEqual([]);

    await harness.resolveListing('/repo/packages', ['/repo/packages/ui']);
    expect(harness.listed).toEqual(['/repo/packages', '/repo/packages/ui']);

    await harness.resolveListing('/repo/packages/ui', ['/repo/packages/ui/src']);
    await harness.resolveListing('/repo/packages/ui/src', ['/repo/packages/ui/src/main.tsx']);

    expect(harness.scrolls).toEqual(['/repo/packages/ui/src/main.tsx']);
  } finally {
    harness.teardown();
  }
});

test('skips directories that are already listed', async () => {
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/src'], '/repo/src': ['/repo/src/deep'] },
    loadedDirs: ['/repo', '/repo/src'],
  });
  try {
    await harness.render({ activeFilePath: '/repo/src/deep/a.ts' });

    expect(harness.listed).toEqual(['/repo/src/deep']);
  } finally {
    harness.teardown();
  }
});

test('leaves the tree alone once the user selects another row under the same tab', async () => {
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/a.ts', '/repo/b.ts'] },
    loadedDirs: ['/repo'],
  });
  try {
    await harness.render({ activeFilePath: '/repo/a.ts' });
    expect(harness.scrolls).toEqual(['/repo/a.ts']);

    // A later render (git status, a refresh) must not re-yank the tree to the
    // active file after the user clicked elsewhere in it.
    await harness.render({ childrenByDir: { '/repo': ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'] } });

    expect(harness.scrolls).toEqual(['/repo/a.ts']);
    expect(harness.selected).toEqual([['/repo', '/repo/a.ts']]);
  } finally {
    harness.teardown();
  }
});

test('drops a reveal whose row only appears after the editor moved on', async () => {
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/src'] },
    loadedDirs: ['/repo'],
  });
  try {
    await harness.render({ activeFilePath: '/repo/src/slow.ts' });
    expect(harness.scrolls).toEqual([]);

    // The user switches to a non-file tab (a diff, the plan) before the
    // listing lands; the row that appears now belongs to nothing on screen.
    await harness.render({ activeFilePath: null });
    await harness.resolveListing('/repo/src', ['/repo/src/slow.ts']);

    expect(harness.scrolls).toEqual([]);
  } finally {
    harness.teardown();
  }
});

test('waits while the tree column is hidden and reveals when it is shown', async () => {
  const harness = await setupHarness({
    enabled: false,
    childrenByDir: { '/repo': ['/repo/a.ts'] },
    loadedDirs: ['/repo'],
  });
  try {
    await harness.render({ activeFilePath: '/repo/a.ts' });
    expect(harness.scrolls).toEqual([]);
    expect(harness.selected).toEqual([]);

    await harness.render({ enabled: true });

    expect(harness.scrolls).toEqual(['/repo/a.ts']);
  } finally {
    harness.teardown();
  }
});

test('holds the reveal while search replaces the tree, then reveals when the results clear', async () => {
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/a.ts'] },
    loadedDirs: ['/repo'],
  });
  try {
    await harness.render({ searchActive: true, searchResultCount: 3, activeFilePath: '/repo/a.ts' });
    expect(harness.scrolls).toEqual([]);

    await harness.render({ searchActive: false, searchResultCount: 0 });

    expect(harness.scrolls).toEqual(['/repo/a.ts']);
  } finally {
    harness.teardown();
  }
});

test('ignores a file that is not inside the root', async () => {
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/a.ts'] },
    loadedDirs: ['/repo'],
  });
  try {
    await harness.render({ activeFilePath: '/elsewhere/a.ts' });

    expect(harness.scrolls).toEqual([]);
    expect(harness.selected).toEqual([]);
    expect(harness.expanded).toEqual([]);
  } finally {
    harness.teardown();
  }
});
