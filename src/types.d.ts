declare const WEBAPP_VERSION: string | undefined;

declare module "*.html" {
  const value: Response;
  export default value;
}

declare module "*.css" {
  const value: string;
  export default value;
}
