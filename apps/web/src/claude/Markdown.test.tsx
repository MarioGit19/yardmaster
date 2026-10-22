// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { langFor } from './highlight.js';
import { Markdown } from './Markdown.js';

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

const render = (text: string, streaming = false) =>
  act(() => root.render(<Markdown text={text} streaming={streaming} />));

describe('Markdown', () => {
  it('renders GFM and drops raw HTML', () => {
    render(
      '**Changed**\n\n- `src/a.ts`\n- [docs](https://example.com)\n\n<img src=x onerror=alert(1)><b>raw</b>\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(container.querySelector('strong')?.textContent).toBe('Changed');
    expect(container.querySelector('li code')?.textContent).toBe('src/a.ts');
    const link = container.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('neutralizes javascript: links', () => {
    render('[click](javascript:alert(1))');
    expect(container.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript');
  });

  it('renders fenced code as a code block with its language', () => {
    render('```ts\nconst a = 1;\n```');
    expect(container.querySelector('.md-code pre')?.textContent).toBe('const a = 1;');
    expect(container.querySelector('.md-code')?.textContent).toContain('ts');
  });

  it('marks the streaming tail for the caret', () => {
    render('Writing', true);
    expect(container.querySelector('.md')?.hasAttribute('data-streaming')).toBe(true);
  });
});

describe('langFor', () => {
  it('maps fence names to grammars', () => {
    expect(langFor('ts')).toBe('typescript');
    expect(langFor('Bash')).toBe('shellscript');
    expect(langFor('rb')).toBe('ruby');
    expect(langFor('brainfuck')).toBeNull();
    expect(langFor('')).toBeNull();
  });
});
