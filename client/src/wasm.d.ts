/** Vite asset imports: the wasm files are emitted as static assets and fetched
 *  only when a language is first used. */
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
