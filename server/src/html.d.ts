// A página de assistir (dist-web/watch.html) entra no Worker como texto.
declare module "*.html" {
  const html: string;
  export default html;
}
