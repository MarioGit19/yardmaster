/// <reference lib="webworker" />
// Syntax highlighting off the main thread: grammars compile here, so a code block scrolling
// into view never costs the UI a long task. Colors are `var(--shiki-*)`, mapped to our tokens.

import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { HighlightRequest, HighlightResponse, Lang, TokenLine } from './highlight.js';

const LANGS: Record<Lang, () => LanguageInput> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
};

const THEME = createCssVariablesTheme({ name: 'yardmaster', variablePrefix: '--shiki-' });

let highlighter: Promise<HighlighterCore> | null = null;
const loading = new Map<Lang, Promise<void>>();

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [THEME],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

async function ready(lang: Lang): Promise<HighlighterCore> {
  const h = await core();
  let load = loading.get(lang);
  if (!load) {
    load = h.loadLanguage(LANGS[lang]());
    loading.set(lang, load);
  }
  await load;
  return h;
}

async function highlight({ id, code, lang }: HighlightRequest): Promise<HighlightResponse> {
  try {
    const h = await ready(lang);
    const { tokens } = h.codeToTokens(code, { lang, theme: 'yardmaster' });
    const lines: TokenLine[] = tokens.map((line) =>
      line.map((t) => {
        const style = t.fontStyle ? t.fontStyle : 0;
        return style
          ? [t.content, t.color ?? '', style]
          : t.color
            ? [t.content, t.color]
            : [t.content];
      }),
    );
    return { id, lines };
  } catch {
    return { id, lines: null };
  }
}

self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  void highlight(event.data).then((response) => self.postMessage(response));
};
