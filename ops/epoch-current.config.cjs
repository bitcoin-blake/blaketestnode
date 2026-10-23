// pm2: rebuild and publish the open epoch every four hours. `pm2 start ops/epoch-current.config.cjs && pm2 save`
const HOME = process.env.HOME;
module.exports = { apps: [{
  name: 'epoch-current-txbt4', cwd: `${HOME}/remote/github.com/bitcoin-blake/blaketestnode`, script: 'ops/publish-current.sh', interpreter: 'bash',
  cron_restart: '0 */4 * * *', autorestart: false, out_file: `${HOME}/.blaketestnode/txbt4/epoch-current.log`, error_file: `${HOME}/.blaketestnode/txbt4/epoch-current.err`, time: true,
}] };
