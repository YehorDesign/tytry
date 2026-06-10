export {};

declare global {
  interface Window {
    titryNative?: {
      pickFolder: () => Promise<string | null>;
      showInFolder: (path: string) => Promise<void>;
    };
  }
}

declare module "font-list" {
  export function getFonts(options?: { disableQuoting?: boolean }): Promise<string[]>;
}
