// Stands in for Electron's `process.parentPort` over Node's IPC channel, so that plain Node can run the
// server the way the desktop app runs it (`node --import ./parent-port.mjs server.mjs`, forked with an
// IPC channel). Used by scripts/smoke.ts and test/parent.test.ts.
if (process.send) {
  process.parentPort = {
    postMessage: (message) => process.send?.(message),
    on: (event, listener) => {
      if (event === 'message') process.on('message', (data) => listener({ data }));
    },
  };
}
