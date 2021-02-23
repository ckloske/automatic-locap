const pm2 = require('pm2');
const config = require('./config.json');

console.log(config);

pm2.connect(function (err) {
  if (err) {
    console.error(err);
    process.exit(2);
  }

  for (const [key, value] of Object.entries(config)) {

    const args = [key, value.startingAmount, value.interval, value.stdFactor, value.samples, value.minimumPct];

    const options = {
      script: './src/autotrade.js',
      name: key,
      args
    };

    console.log(options);

    pm2.start(options, function (err, apps) {
      pm2.disconnect();   // Disconnects from PM2
      if (err) throw err
      process.exit(2);
    });
  }

  pm2.list((err, list) => {
    console.log(list)
  })

});