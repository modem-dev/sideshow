interface SideshowServerApp {
  fetch: any;
}

declare module "sideshow/server" {
  export function createApp(deps: Record<string, unknown>): SideshowServerApp;

  export class JsonFileStore {
    constructor(filename: string);
  }
}

declare module "sideshow/dist/server/app.js" {
  export function createApp(deps: Record<string, unknown>): SideshowServerApp;
}

declare module "sideshow/dist/server/storage.js" {
  export class JsonFileStore {
    constructor(filename: string);
  }
}
