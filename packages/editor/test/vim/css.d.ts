/** Pages import stylesheets as text (esbuild `loader: { ".css": "text" }`). */
declare module "*.css" {
  const text: string;
  export default text;
}
