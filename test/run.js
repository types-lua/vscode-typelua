'use strict';
// Test runner: grammar tokenization + LSP contract. No VS Code instance needed.
async function main() {
  await require('./meta.test.js')();
  await require('./grammar.test.js')();
  await require('./lsp.test.js')();
  await require('./client.test.js')();
  console.log('ALL TESTS PASSED');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
