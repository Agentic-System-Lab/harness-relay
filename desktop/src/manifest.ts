/** The package.json of the app folder Electron runs (written by scripts/build.ts). */
export function appManifest(root: { version: string; description?: string; license?: string }) {
  return {
    name: 'harness-relay',
    // Electron names the user-data folder after it: ~/Library/Application Support/Harness Relay on macOS.
    productName: 'Harness Relay',
    version: root.version,
    description: root.description ?? 'Harness Relay',
    license: root.license,
    author: 'ChihYu Yeh',
    private: true,
    main: 'main.cjs',
  };
}
