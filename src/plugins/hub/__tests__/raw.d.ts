/** Vite's raw text import, used to read the README from a test in the Node-free worker project. */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
