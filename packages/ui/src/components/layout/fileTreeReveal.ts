/**
 * "Reveal the file the editor is showing" support for the context-panel file
 * tree (issue #3814).
 *
 * The tree's selection lives in `useFilesViewTabsStore` and used to be written
 * only by a click on a tree row, so the highlight drifted away from the file
 * the editor beside it was actually showing: switching tabs, or opening a file
 * from chat / search / a diff, left the tree pointing somewhere else with the
 * target's ancestors collapsed. In a large repository that makes the open file
 * unfindable in the tree.
 *
 * The path math lives here rather than in the component so it can be tested
 * without mounting the tree, and so the DOM lookup has a single definition of
 * the row attribute.
 */

/**
 * Attribute every file tree row renders (`SidebarFilesTree`), so a reveal can
 * find the row for a path without threading a ref through the memoized rows.
 */
export const FILE_TREE_ROW_PATH_ATTRIBUTE = 'data-tree-path';

export type FileTreeRevealPlan = {
  /** The row the tree should mark as selected. */
  selectedPath: string;
  /**
   * Directories between the root (exclusive) and the file (exclusive),
   * outermost first. The root itself is never included: its children are
   * always rendered, and it has no row to expand. The order matters because
   * the caller lists them in sequence — a directory cannot be listed before
   * its parent is known.
   */
  directoriesToExpand: string[];
};

/**
 * Work out what has to be expanded for `filePath` to have a visible row.
 *
 * Both arguments must already be normalized the way the tree normalizes paths
 * (forward slashes, no repeated or trailing separator); this function does no
 * normalizing of its own so the caller and the rendered rows cannot disagree
 * on the string identity of a path.
 *
 * Returns `null` when there is nothing to reveal: no root, no file, a file
 * that is not inside the root, the root itself, or a path that still carries
 * `.`/`..` segments (which would produce ancestors that match no row).
 */
export const planFileTreeReveal = (
  root: string | null | undefined,
  filePath: string | null | undefined,
): FileTreeRevealPlan | null => {
  if (!root || !filePath) return null;

  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  if (!filePath.startsWith(rootPrefix)) return null;

  const relative = filePath.slice(rootPrefix.length);
  if (!relative) return null;

  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }

  // `rootPrefix` without its separator, so a root of '/' yields '/src' rather
  // than '//src'.
  const base = rootPrefix.slice(0, -1);
  const directoriesToExpand: string[] = [];
  let current = base;
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    directoriesToExpand.push(current);
  }

  return { selectedPath: filePath, directoriesToExpand };
};

const escapeAttributeValue = (value: string): string => (
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
);

/** CSS selector matching the tree row for `path`. */
export const fileTreeRowSelector = (path: string): string => (
  `[${FILE_TREE_ROW_PATH_ATTRIBUTE}="${escapeAttributeValue(path)}"]`
);

/**
 * Scroll the row for `path` into view inside `container`, if it is rendered.
 *
 * `block: 'nearest'` is deliberate: a row that is already on screen must not
 * move, otherwise merely switching tabs would yank the tree around.
 *
 * Returns false when the row is not in the DOM yet — the caller retries after
 * the directories it asked for have been listed.
 */
export const revealFileTreeRow = (
  container: ParentNode | null | undefined,
  path: string,
): boolean => {
  if (!container || !path) return false;

  const row = container.querySelector(fileTreeRowSelector(path));
  if (!row) return false;

  // SAFETY: the attribute is only rendered on the tree's row <button>s, so a
  // match is an HTMLElement; the assertion recovers the element type that
  // querySelector widens to Element.
  (row as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
};
