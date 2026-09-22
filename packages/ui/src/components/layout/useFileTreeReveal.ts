import React from 'react';

import { isPendingRevealCurrent, planFileTreeReveal, revealFileTreeRow } from './fileTreeReveal';

/** The part of a listed row this hook cares about: its path. */
export type FileTreeRevealRow = { path: string };

export type FileTreeRevealParams = {
  /** Workspace root, normalized. Also the key the tree stores are keyed by. */
  root: string | null;
  /** Normalized path of the file in the active editor tab, null for anything else. */
  activeFilePath: string | null;
  /** False while the tree column is hidden — it lists no directories then. */
  enabled: boolean;
  /** True while the search filter replaces the tree with a flat result list. */
  searchActive: boolean;
  /** The element the rows live in; a reveal scrolls inside it. */
  listRef: React.RefObject<HTMLElement | null>;
  /** Listed rows per directory. A new identity means rows may have appeared. */
  childrenByDir: Record<string, readonly FileTreeRevealRow[]>;
  /** Expanded directories. Its identity changing means rows may have appeared. */
  expandedPaths: readonly string[];
  /** Search hits on screen. Dropping back to 0 gives the tree rows back. */
  searchResultCount: number;
  isDirectoryLoaded: (path: string) => boolean;
  loadDirectory: (path: string) => Promise<void>;
  selectPath: (root: string, path: string) => void;
  expandPaths: (root: string, paths: string[]) => void;
};

/**
 * Make the file tree follow the file the editor beside it is showing (#3814):
 * select its row, expand and list the directories leading to it, and scroll
 * the row into view when it is off screen.
 *
 * Lives outside the tree component so the sequencing — which is where the
 * behaviour actually is — can be tested without mounting the tree.
 */
export const useFileTreeReveal = ({
  root,
  activeFilePath,
  enabled,
  searchActive,
  listRef,
  childrenByDir,
  expandedPaths,
  searchResultCount,
  isDirectoryLoaded,
  loadDirectory,
  selectPath,
  expandPaths,
}: FileTreeRevealParams): void => {
  // Last file revealed because the editor switched to it. Reveals are keyed on
  // the active file, not on the selection, so a row the user clicks afterwards
  // stays selected until the editor moves on.
  const revealedFilePathRef = React.useRef<string | null>(null);
  // Identifies the reveal a listing loop belongs to. The loop checks the token
  // rather than a per-effect flag, so an effect re-run for the same file (a
  // callback identity changed) does not abandon a listing half way down the
  // tree — the early return above would never restart it.
  const revealTokenRef = React.useRef(0);
  // The row a reveal still has to scroll to. State rather than a ref: the row
  // is usually already rendered (its directories were expanded on an earlier
  // visit), and then no other render would re-run the scroll effect.
  const [pendingRevealPath, setPendingRevealPath] = React.useState<string | null>(null);

  React.useEffect(() => {
    // A reveal is only meaningful for the root it was computed against.
    revealedFilePathRef.current = null;
    revealTokenRef.current += 1;
    setPendingRevealPath(null);
  }, [root]);

  // Stop any listing loop still walking the tree after unmount.
  React.useEffect(() => () => { revealTokenRef.current += 1; }, []);

  React.useEffect(() => {
    // A hidden tree lists nothing, so leave the reveal for the moment the
    // column is shown again. Search replaces the tree with a flat result list,
    // which has no row to expand towards and no business being scrolled while
    // a query is being typed.
    if (!enabled || searchActive || !root || !activeFilePath) return;

    const plan = planFileTreeReveal(root, activeFilePath);
    if (!plan) return;
    if (revealedFilePathRef.current === plan.selectedPath) return;
    revealedFilePathRef.current = plan.selectedPath;

    selectPath(root, plan.selectedPath);
    if (plan.directoriesToExpand.length > 0) {
      expandPaths(root, plan.directoriesToExpand);
    }
    setPendingRevealPath(plan.selectedPath);

    const token = revealTokenRef.current + 1;
    revealTokenRef.current = token;
    void (async () => {
      // Outermost first: a directory can only be listed once its parent is.
      for (const directory of plan.directoriesToExpand) {
        // A newer reveal, a root change or unmount took over.
        if (revealTokenRef.current !== token) return;
        if (isDirectoryLoaded(directory)) continue;
        await loadDirectory(directory);
      }
    })();
  }, [activeFilePath, enabled, expandPaths, isDirectoryLoaded, loadDirectory, root, searchActive, selectPath]);

  React.useEffect(() => {
    if (!pendingRevealPath) return;

    // The editor has moved on (another tab, a non-file tab, a file outside
    // this root). A row that only renders now — a slow listing landed, or the
    // user unhid files — must not yank the tree to a file nobody is reading.
    if (!isPendingRevealCurrent(pendingRevealPath, activeFilePath)) {
      setPendingRevealPath(null);
      return;
    }

    if (revealFileTreeRow(listRef.current, pendingRevealPath)) {
      setPendingRevealPath(null);
    }
  }, [activeFilePath, childrenByDir, expandedPaths, listRef, pendingRevealPath, searchResultCount]);
};
