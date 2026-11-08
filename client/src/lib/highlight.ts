// The package ships CommonJS whose types declare named exports; the runtime
// value is the module object, so it comes in through the default import.
import mod from '@vscode/tree-sitter-wasm';
import type { Language as TSLanguage, Node as TSNode, Parser as TSParser } from '@vscode/tree-sitter-wasm';
import { segmentsFromTree, type Segment, type SyntaxNode } from './highlight-core';

const { Parser, Language } = mod as unknown as {
  Parser: typeof TSParser;
  Language: typeof TSLanguage;
};

// The runtime, and one grammar per language, as asset URLs: Vite emits them as
// files and the browser fetches only the one a code block actually needs.
import runtimeUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url';
import bashUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm?url';
import cppUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm?url';
import iniUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-ini.wasm?url';
import csharpUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm?url';
import cssUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-css.wasm?url';
import goUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm?url';
import javaUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm?url';
import jsUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm?url';
import phpUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-php.wasm?url';
import pyUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url';
import rubyUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm?url';
import rustUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm?url';
import tsUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm?url';
import tsxUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm?url';

/**
 * Fence language (or alias) → grammar. Anything absent stays plain text, on
 * purpose: an unknown fence must never guess. JSON, YAML and HTML have no
 * grammar in this package (neither do C, HTML, JSON or YAML), so they
 * render uncoloured.
 */
const GRAMMARS: Record<string, string> = {
  bash: bashUrl,
  sh: bashUrl,
  shell: bashUrl,
  zsh: bashUrl,
  cpp: cppUrl,
  'c++': cppUrl,
  cc: cppUrl,
  csharp: csharpUrl,
  'c#': csharpUrl,
  css: cssUrl,
  ini: iniUrl,
  go: goUrl,
  golang: goUrl,
  java: javaUrl,
  js: jsUrl,
  jsx: jsUrl,
  javascript: jsUrl,
  php: phpUrl,
  py: pyUrl,
  python: pyUrl,
  rb: rubyUrl,
  ruby: rubyUrl,
  rs: rustUrl,
  rust: rustUrl,
  ts: tsUrl,
  tsx: tsxUrl,
  typescript: tsUrl,
};

/** Parsed blocks, keyed by language + source: a re-render must not re-parse. */
const MAX_CACHE = 60;
/**
 * How much of a block is worth parsing. Cost is linear in size and dominated
 * by the spans it produces (one per token: a 7 KB block came out at ~1900
 * spans). Colouring the head and leaving the rest plain keeps the worst case
 * near 20ms and ~3k spans no matter how long the block is — an 800-line dump
 * costs the same as a 200-line one, and the text stays byte-identical.
 */
const MAX_HIGHLIGHT_CHARS = 12_000;
const cache = new Map<string, Segment[]>();
const languages = new Map<string, Promise<TSLanguage | null>>();
let parserPromise: Promise<TSParser> | null = null;

async function parser(): Promise<TSParser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      // The runtime wasm is an asset of its own; without this the loader looks
      // for it next to the bundle and fails.
      await Parser.init({ locateFile: () => runtimeUrl });
      return new Parser();
    })().catch((err: unknown) => {
      parserPromise = null;
      throw err;
    });
  }
  return parserPromise;
}

async function languageFor(url: string): Promise<TSLanguage | null> {
  let p = languages.get(url);
  if (!p) {
    p = (async () => {
      await parser(); // the runtime must be loaded before a grammar can be
      return await Language.load(url);
    })().catch(() => null);
    languages.set(url, p);
  }
  return p;
}

function cachePut(key: string, value: Segment[]): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/** Cached lookup, so a component can paint a known block synchronously — no
 *  flash of plain text when a session is reopened or a row re-renders. */
export function cachedHighlight(code: string, language?: string): Segment[] | undefined {
  if (!language) return undefined;
  return cache.get(`${language.toLowerCase()}\u0000${code}`);
}

/**
 * Colour one code block. Resolves to null when the language is unknown or
 * anything about the wasm fails; the caller then renders the plain source,
 * which is always correct — just uncoloured.
 */
export async function highlight(code: string, language?: string): Promise<Segment[] | null> {
  if (!language || !code) return null;
  const key = `${language.toLowerCase()}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url = GRAMMARS[language.toLowerCase()];
  if (!url) return null;

  // Cut at a line boundary so the plain tail never starts mid-token.
  const cut = code.length > MAX_HIGHLIGHT_CHARS ? code.lastIndexOf('\n', MAX_HIGHLIGHT_CHARS) : -1;
  const head = cut > 0 ? code.slice(0, cut) : code;
  const tail = cut > 0 ? code.slice(cut) : '';

  try {
    const [p, lang] = await Promise.all([parser(), languageFor(url)]);
    if (!lang) return null;
    p.setLanguage(lang);
    const tree = p.parse(head);
    if (!tree) return null;
    try {
      const segments = segmentsFromTree(tree.rootNode as unknown as SyntaxNode, head);
      // Everything past the cut stays plain, so the rendered text is still
      // byte-identical to the source.
      if (tail) segments.push({ text: tail });
      cachePut(key, segments);
      return segments;
    } finally {
      tree.delete();
    }
  } catch {
    return null; // decoration must never break the transcript
  }
}

export { classify } from './highlight-core';
export type { Segment, SyntaxNode, TokenKind } from './highlight-core';
export type TSNodeLike = TSNode;
