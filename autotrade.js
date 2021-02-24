const Binance = require('node-binance-api');
const chalk = require('chalk');
const io = require('@pm2/io')
const { mean, std } = require('mathjs');

const y = chalk.yellow;

const binance = new Binance();
binance.options({
  APIKEY: 'f6ocA3hW7u71b1uhJppiVsouQVGIATg3exebVMxZ3AFpbZkAdPsnb2L5PWOu1ecY',
  APISECRET: 'dDBMu52fINkg243sKQLJkLWrAUic5tgAdYFVjE29myB5UTyyxfiGagpGlFNCDxoU',
  useServerTime: true,
  test: false,
});

const accumulatedProfitMetric = io.metric({
  name: 'Accumulated Profit',
  id: 'app/profit',
})

const availableAmountMetric = io.metric({
  name: 'Available Amount',
  id: 'app/amount',
})

const sellCyclesMetric = io.counter({
  name: 'Sell Cycles',
  id: 'app/sales'
});

const lastPriceMetric = io.metric({
  name: 'Last Price',
  id: 'app/price'
});


const PAIR = process.argv[2] || 'BNBBUSD';
const STARTING_AMOUNT = process.argv[3] || 1;
const INTERVAL = '1m';
const STD_FACTOR = process.argv[4] || 2;
const SAMPLES = process.argv[5] || 10;
const SELL_LIMIT_PCT = process.argv[6] || 1;

let isLong = false;
let isLocked = false;
let buyPrice = 0;
let buyQuantity = 0;
let availableAmount = parseFloat(STARTING_AMOUNT);
let lastOrderID = 0;

const log = (message) => {
  const now = new Date();
  console.log(chalk.blueBright(now), `${y(PAIR)}: `, message);
}

const tradeCallback = (data) => {
  // log(data)
  let { x: executionType, s: symbol, p: price, q: quantity, S: side, o: orderType, i: orderId, X: orderStatus, l: lastQuantity, L: lastPrice } = data;
  if (lastOrderID === orderId) {
    let direction = side === 'BUY' ? -1 : +1;
    if (orderStatus == 'REJECTED') {
      log(`Order ${orderId} failed. Reason: ${data.r}`);
      isLocked = false;
    } else if (orderStatus === 'CANCELED') {
      log(`Order ${orderId} canceled manually`)
      buyPrice = 0;
      buyQuantity = 0;
      isLong = false;
      isLocked = false;
    } else if (orderStatus == 'PARTIALLY_FILLED') {
      log(`Order ${orderId} partially executed. ${side} ${orderType} ${quantity} @ ${price}.`);
    } else if (orderStatus == 'FILLED') {
      availableAmount = availableAmount + (direction * (quantity * price));
      log(`Order ${orderId} fully executed. ${side} ${orderType} ${quantity} @ ${price}.`);
      availableAmountMetric.set(availableAmount);
      if (side === 'SELL') {
        const profit = ((availableAmount / STARTING_AMOUNT) - 1) * 100;
        sellCyclesMetric.inc();
        accumulatedProfitMetric.set(profit);
        log(`Profit: ${profit}%. Available: ${availableAmount}`);
      }
      buyPrice = side === 'BUY' ? price : 0;
      buyQuantity = side === 'BUY' ? quantity : 0;
      isLong = side === 'BUY';
      isLocked = false;
    } else if (orderStatus == 'NEW') {
      log(`Order ${res.orderId} in book`);
    } else {
      log(`Ignored status ${orderStatus}`)
    }
  }
}

function autoTrade(pair, interval, chart) {
  let tick = binance.last(chart);
  const lastPrices = [chart[tick].open, chart[tick].close];
  const lastClosePrice = chart[tick].close;
  let ohlc = binance.ohlc(chart);

  lastPriceMetric.set(lastClosePrice);

  const FILTERS = global.filters[pair];

  const sampleClose = ohlc.close.slice(ohlc.close.length - SAMPLES);
  const sampleMean = mean(sampleClose);
  const sampleStd = STD_FACTOR * std(sampleClose);
  const hiBand = binance.roundTicks(sampleMean + sampleStd, FILTERS.tickSize);
  const loBand = binance.roundTicks(sampleMean - sampleStd, FILTERS.tickSize);
  const quantity = binance.roundStep(availableAmount / lastClosePrice, FILTERS.stepSize);

  if (
    quantity >= FILTERS.minQty
    && quantity <= FILTERS.maxQty
    && quantity * lastClosePrice >= FILTERS.minNotional
    && lastClosePrice < loBand
    && !isLong
    && !isLocked
  ) {
    isLocked = true;
    binance.buy(pair, quantity, lastClosePrice)
      .then((res) => {
        // log(res);
        log(`Order ${res.orderId} created. ${res.side} ${res.type} ${res.origQty} @ ${res.price}`);
        if (res.status === 'NEW') {
          lastOrderID = res.orderId;
          log(`Order ${res.orderId} in book`);
        } else if (res.status === 'FILLED') {
          availableAmount = availableAmount - res.executedQty * res.price;
          isLong = true;
          isLocked = false;
          buyPrice = res.price;
          buyQuantity = res.executedQty;
          lastOrderID = 0;

          const profit = ((availableAmount / STARTING_AMOUNT) - 1) * 100;
          sellCyclesMetric.inc();
          accumulatedProfitMetric.set(profit);

          log(`Order ${res.orderId} fully executed. Available: ${availableAmount}`);
        } else if (orderStatus == 'PARTIALLY_FILLED') {
          log(`Order ${orderId} partially executed. ${side} ${orderType} ${quantity} @ ${price}. Available: ${availableAmount}`);
        } else {
          log(`Ignored status ${res.status}`)
          isLocked = false;
        }

      })
      .catch(log);
  } else if (
    lastClosePrice >= hiBand
    && (lastClosePrice / buyPrice) > (SELL_LIMIT_PCT / 100) + 1
    && isLong
    && !isLocked) {
    isLocked = true;
    binance.sell(pair, buyQuantity, lastClosePrice)
      .then((res) => {
        // log(res);
        log(`Order ${res.orderId} created. ${res.side} ${res.type} ${res.origQty} @ ${res.price}`);
        if (res.status === 'NEW') {
          lastOrderID = res.orderId;
          log(`Order ${res.orderId} in book`);
        } else if (res.status === 'FILLED') {
          availableAmount = availableAmount + res.executedQty * res.price;
          isLong = false;
          isLocked = false;
          buyPrice = 0;
          buyQuantity = 0;
          lastOrderID = 0;
          availableAmountMetric.set(availableAmount);
          sellCyclesMetric.inc();
          log(`Order ${res.orderId} fully executed. Available: ${availableAmount}`);
        } else if (orderStatus == 'PARTIALLY_FILLED') {
          log(`Order ${orderId} partially executed. ${side} ${orderType} ${quantity} @ ${price}. Available: ${availableAmount}`);
        } else {
          log(`Unexpected status ${res.status}`)
          isLocked = false;
        }
      })
      .catch(log);

  } else {
    let message = isLong ? 'Waiting for opportunity to sell' : 'Waiting for opportunity to buy';
    message = isLocked ? 'Waiting order to be executed' : message;
  }

};

binance.exchangeInfo(function (error, data) {
  let minimums = {};
  for (let obj of data.symbols) {
    let filters = { status: obj.status };
    for (let filter of obj.filters) {
      if (filter.filterType == "MIN_NOTIONAL") {
        filters.minNotional = filter.minNotional;
      } else if (filter.filterType == "PRICE_FILTER") {
        filters.minPrice = filter.minPrice;
        filters.maxPrice = filter.maxPrice;
        filters.tickSize = filter.tickSize;
      } else if (filter.filterType == "LOT_SIZE") {
        filters.stepSize = filter.stepSize;
        filters.minQty = filter.minQty;
        filters.maxQty = filter.maxQty;
      }
    }
    filters.orderTypes = obj.orderTypes;
    filters.icebergAllowed = obj.icebergAllowed;
    minimums[obj.symbol] = filters;
  }
  global.filters = minimums;

  log(`
  ${y(PAIR)} started
  with amount ${STARTING_AMOUNT}, 
  interval ${INTERVAL}, 
  stdv-factr ${STD_FACTOR}, 
  ${SAMPLES} samples, 
  minimum profit ${SELL_LIMIT_PCT}%`)

  binance.websockets.userData(() => null, tradeCallback)
  binance.websockets.chart(PAIR, INTERVAL, autoTrade);
});