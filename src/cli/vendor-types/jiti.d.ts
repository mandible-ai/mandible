// PURPOSE: Minimal type stub for optional jiti dependency.
// Real types come from the package itself when installed.

declare module 'jiti' {
  interface JitiOptions {
    interopDefault?: boolean;
    [key: string]: unknown;
  }
  function jiti(filename: string, options?: JitiOptions): (id: string) => any;
  export default jiti;
}
