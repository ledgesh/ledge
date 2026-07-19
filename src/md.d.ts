// Markdown imported `with { type: "text" }` (Bun's text loader) arrives as a
// string — the built-in docs corpus rides this (bun/docsContent.ts). The
// declaration is what lets tsc agree.
declare module "*.md" {
  const text: string;
  export default text;
}
