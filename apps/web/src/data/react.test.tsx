// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeProject, sampleBoard } from '../test/board.js';
import type { BoardClient } from './client.js';
import { BoardProvider, FrozenBoard, useBoard } from './react.js';
import { selectProjectCount } from './selectors.js';
import { type BoardStore, createBoardStore } from './store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const client = {} as BoardClient;
let renders = 0;

function Count() {
  renders += 1;
  return <span>{useBoard(selectProjectCount)}</span>;
}

function render(store: BoardStore, frozen: boolean) {
  act(() =>
    root.render(
      <BoardProvider client={client} store={store}>
        <FrozenBoard frozen={frozen}>
          <Count />
        </FrozenBoard>
      </BoardProvider>,
    ),
  );
}

function addProject(store: BoardStore, id: string) {
  act(() => {
    const board = store.getState().board;
    const project = makeProject(id, id);
    store.getState().replaceBoard({ ...board, projects: { ...board.projects, [id]: project } });
  });
}

describe('FrozenBoard', () => {
  it('follows the board while thawed, holds it while frozen, and catches up after', () => {
    const store = createBoardStore();
    store.getState().replaceBoard(sampleBoard());
    const start = Object.keys(store.getState().board.projects).length;

    render(store, false);
    expect(container.textContent).toBe(String(start));
    addProject(store, 'tidal-maps');
    expect(container.textContent).toBe(String(start + 1));

    render(store, true);
    renders = 0;
    addProject(store, 'quill-notes');
    addProject(store, 'harbor-ci');
    expect(container.textContent).toBe(String(start + 1));
    expect(renders).toBe(0);

    render(store, false);
    expect(container.textContent).toBe(String(start + 3));
    addProject(store, 'ember-chat');
    expect(container.textContent).toBe(String(start + 4));
  });
});
