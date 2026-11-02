declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:buffer" {
  export const Buffer: any;
}
