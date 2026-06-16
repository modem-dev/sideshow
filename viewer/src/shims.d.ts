// `@wterm/dom/css` is a side-effect stylesheet import resolved by Vite; its
// package-subpath specifier doesn't end in `.css`, so vite/client's `*.css`
// ambient doesn't cover it. Declare it so tsc accepts the import.
declare module "@wterm/dom/css";
