const HOME = process.env.HOME;
module.exports = { apps: [{
  name: 'blaketestnode-txbt4', cwd: `${HOME}/remote/github.com/bitcoin-blake/blaketestnode`, script: 'bin/blaketestnode.mjs',
  args: ['run', '--data', `${HOME}/.blaketestnode/txbt4`, '--api', '3337', '--blocks-url', 'https://example.org/txbt4-blocks', '--webseed', 'https://example.org/utxo-knots-150307.dat'], interpreter: 'node', node_args: '--max-old-space-size=12288',
  kill_timeout: 600000, out_file: `${HOME}/.blaketestnode/txbt4/blaketestnode.log`, error_file: `${HOME}/.blaketestnode/txbt4/blaketestnode.err`, time: true, max_restarts: 20, restart_delay: 15000,
}] };
