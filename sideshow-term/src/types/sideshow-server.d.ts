declare module "sideshow/dist/server/app.js" {
  export function createApp(deps: Record<string, unknown>): any;
}

declare module "sideshow/dist/server/storage.js" {
  export class JsonFileStore {
    constructor(filename: string);
  }
}
