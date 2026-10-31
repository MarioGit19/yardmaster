// @vitest-environment happy-dom
import type { Project } from '@yardmaster/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardClient, BoardProvider, type BoardStore, createBoardStore } from '../data/index.js';
import { makeProject, sampleBoard } from '../test/board.js';
import { projectOrder, useProjectOrder } from './projectOrder.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let store: BoardStore;
let client: BoardClient;
const renders: (readonly string[])[] = [];

function Order() {
  renders.push(useProjectOrder());
  return null;
}

const project = (id: string, lastActivityAt: number) => ({
  ...makeProject(id, id),
  lastActivityAt,
});

const setProjects = (...projects: Project[]) =>
  act(() =>
    store.getState().replaceBoard({
      ...sampleBoard(),
      projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    }),
  );

beforeEach(() => {
  renders.length = 0;
  store = createBoardStore();
  client = new BoardClient({ url: 'ws://127.0.0.1:1/ws', store });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useProjectOrder', () => {
  it('re-renders nothing when projects only overtake each other in recency', () => {
    setProjects(project('order-a', 20), project('order-b', 10));
    act(() =>
      root.render(
        <BoardProvider client={client} store={store}>
          <Order />
        </BoardProvider>,
      ),
    );
    const settled = renders.length;
    const order = renders.at(-1);
    expect(order).toEqual(['order-a', 'order-b']);

    setProjects(project('order-a', 20), project('order-b', 30));
    setProjects(project('order-a', 40), project('order-b', 30));

    expect(renders.length).toBe(settled);
  });

  it('gives a newcomer a place at the end, however recent it is', () => {
    setProjects(project('new-a', 20), project('new-b', 10));
    act(() =>
      root.render(
        <BoardProvider client={client} store={store}>
          <Order />
        </BoardProvider>,
      ),
    );

    setProjects(project('new-a', 20), project('new-b', 10), project('new-c', 99));

    expect(renders.at(-1)).toEqual(['new-a', 'new-b', 'new-c']);
    expect(projectOrder.get()).toContain('new-c');
  });
});
