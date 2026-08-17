const id = '@jeremy9682/dsh-llm-cursor-acp'

export default {
  name: `${id}/client`,
  entry: { client: 'src/client.ts' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
