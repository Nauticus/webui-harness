/**
 * Turning a tree-sitter syntax tree into coloured text spans.
 *
 * Deliberately free of any tree-sitter or wasm import: the tree is read through
 * the small structural type below, so the rules that decide colours — the part
 * worth testing — can be tested without loading a grammar.
 */

/** The part of a tree-sitter `Node` this module uses. */
export interface SyntaxNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly isNamed: boolean;
  readonly isError: boolean;
  readonly children: readonly SyntaxNode[];
}

/**
 * A dark-theme palette in the spirit of the surrounding UI: colour what means
 * something, leave identifiers and arguments alone so the code stays readable.
 */
export const TOKEN_CLASS = {
  comment: 'text-slate-500 italic',
  string: 'text-emerald-300',
  escape: 'text-emerald-200',
  number: 'text-amber-300',
  constant: 'text-amber-300',
  keyword: 'text-violet-400',
  operator: 'text-slate-400',
  property: 'text-sky-300',
  type: 'text-teal-300',
  error: 'text-rose-400',
} as const;

export type TokenKind = keyof typeof TOKEN_CLASS;

export interface Segment {
  text: string;
  /** Which token this is; undefined means "plain text". */
  cls?: TokenKind;
}

const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONSTANTS = /^(this|super|true|false|null|undefined|none|nil|self|Self)$/;
/** Operators are worth a shade of their own; brackets, commas and dots are not
 *  — leaving them plain lets them merge into the surrounding text instead of
 *  becoming one span per character. */
const OPERATORS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '==', '===', '!==', '!=', '<', '<=', '>', '>=',
  '&&', '||', '??', '=>', '?', '+', '-', '*', '/', '%', '!', '&', '|', '^', '~',
  '<<', '>>', '++', '--', '@',
]);

/**
 * Which colour a node gets.
 *
 * Grammars do not ship a shared semantic vocabulary, so this keys off node
 * type names (which do follow conventions across grammars: `string_content`,
 * `property_identifier`, `type_identifier`, …) plus one structural trick: an
 * *unnamed* node whose text is a bare word is a keyword token, because in a
 * tree-sitter grammar the word-like anonymous tokens are exactly the keywords —
 * punctuation and operators are anonymous too, but not word-shaped. That keeps
 * the mapping grammar-driven instead of a keyword list per language.
 */
export function classify(node: SyntaxNode): TokenKind | undefined {
  if (node.isError) return 'error';
  const t = node.type;
  if (t.includes('comment')) return 'comment';
  if (t.includes('escape')) return 'escape';
  if (t.includes('string') || t === 'raw_string') return 'string';
  if (/(^|_)(number|integer|float)(_|$)/.test(t)) return 'number';
  if (CONSTANTS.test(t)) return 'constant';
  if (!node.isNamed) {
    // An anonymous node's type IS its literal text, so a word-shaped one is a
    // keyword; among the rest only operators get a colour, the rest stays plain.
    if (WORD.test(t)) return 'keyword';
    return OPERATORS.has(t) ? 'operator' : undefined;
  }
  if (t.includes('property') || t === 'attribute') return 'property';
  if (t.startsWith('type_') || t === 'type' || t === 'type_identifier') return 'type';
  return undefined;
}

/**
 * Flatten a tree into source-ordered segments.
 *
 * Terminals (including the anonymous keyword and punctuation tokens) carry the
 * colour; everything between them — whitespace, mostly — is emitted plain so the
 * rendered text is byte-identical to the original.
 */
export function segmentsFromTree(root: SyntaxNode, source: string): Segment[] {
  const out: Segment[] = [];
  const push = (text: string, cls?: TokenKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };

  let pos = 0;
  const visit = (n: SyntaxNode) => {
    if (n.children.length === 0) {
      if (n.startIndex > pos) push(source.slice(pos, n.startIndex));
      push(source.slice(n.startIndex, n.endIndex), classify(n));
      if (n.endIndex > pos) pos = n.endIndex;
      return;
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  if (pos < source.length) push(source.slice(pos));
  return out;
}

/** Segments as plain text — used to assert that colouring loses nothing. */
export function segmentsText(segments: Segment[]): string {
  return segments.map((s) => s.text).join('');
}

/**
 * Which grammar a file path implies, by extension. Returns the same names a
 * markdown fence would use, so both paths reach one table. Unknown extensions
 * mean plain text — a file is never shown wrong because of a guess.
 */
const BY_EXTENSION: Record<string, string> = {
  bash: 'bash',
  cjs: 'js',
  css: 'css',
  cts: 'ts',
  go: 'go',
  hpp: 'cpp',
  ini: 'ini',
  java: 'java',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  php: 'php',
  ps1: 'powershell',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  ts: 'ts',
  tsx: 'tsx',
};

export function languageFromPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? '';
  // Dotfiles like `.bashrc` and `.zshrc` have no extension worth trusting.
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return BY_EXTENSION[ext];
}
