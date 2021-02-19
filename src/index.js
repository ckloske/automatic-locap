const Binance = require('node-binance-api');
const { mean, std } = require('mathjs');

const binance = new Binance();
binance.options({
  APIKEY: 'f6ocA3hW7u71b1uhJppiVsouQVGIATg3exebVMxZ3AFpbZkAdPsnb2L5PWOu1ecY',
  APISECRET: 'dDBMu52fINkg243sKQLJkLWrAUic5tgAdYFVjE29myB5UTyyxfiGagpGlFNCDxoU',
  useServerTime: true,
  test: false,
});

const STARTING_AMOUNT = 0.001;
const PAIR = process.argv[2] || 'TROYBTC';
const INTERVAL = '1m';
const SAMPLES = 5;
const STD_FACTOR = 1 / 2;

let isLong = false;
let isLocked = false;
let buyPrice = 0;
let buyQuantity = 0;
let availableAmount = STARTING_AMOUNT;
let lastOrderID = 0;

const tradeCallback = (data) => {
  // console.log(data)
  let { x: executionType, s: symbol, p: price, q: quantity, S: side, o: orderType, i: orderId, X: orderStatus } = data;
  if (lastOrderID === orderId) {
    let direction = side === 'BUY' ? -1 : +1;
    if (orderStatus == 'REJECTED') {
      console.log(`${pair}: Order ${orderId} failed. Reason: ${data.r}`);
      isLocked = false;
    } else if (orderStatus === 'CANCELED') {
      console.log(`${pair}: Order ${orderId} canceled manually.`)
      buyPrice = 0;
      buyQuantity = 0;
      isLong = false;
      isLocked = false;
    } else if (orderStatus == 'PARTIALLY_FILLED') {
      availableAmount += direction * (quantity * price);
      console.log(`${pair}: Order ${orderId} partially executed. ${side} ${orderType} ${quantity} @ ${price}. Available: ${availableAmount}.`);
    } else if (orderStatus == 'FILLED') {
      availableAmount += direction * (quantity * price);
      console.log(`${pair}: Order ${orderId} fully executed. ${side} ${orderType} ${quantity} @ ${price}. Available: ${availableAmount}.`);
      buyPrice = side === 'BUY' ? price : 0;
      buyQuantity = side === 'BUY' ? quantity : 0;
      isLong = false;
      isLocked = false;
    }
  }
}

function autoTrade(pair, interval, chart) {
  let tick = binance.last(chart);
  const lastPrices = [chart[tick].open, chart[tick].close]
  const lastClosePrice = chart[tick].close;
  let ohlc = binance.ohlc(chart);

  const FILTERS = global.filters[pair];

  const sampleClose = ohlc.close.slice(ohlc.close.length - SAMPLES);
  const sampleMean = mean(sampleClose);
  const sampleStd = STD_FACTOR * std(sampleClose);
  const hiBand = binance.roundTicks(sampleMean + sampleStd, FILTERS.tickSize);
  const loBand = binance.roundTicks(sampleMean - sampleStd, FILTERS.tickSize);
  const quantity = binance.roundStep(availableAmount / lastClosePrice, FILTERS.stepSize);

  if (
    lastClosePrice < loBand
    && !isLong
    && !isLocked
  ) {
    isLocked = true;
    binance.buy(pair, quantity, lastClosePrice)
      .then((res) => {
        if (res.status === 'NEW') {
          availableAmount -= res.executedQty * res.price;
          lastOrderID = res.orderId;
          console.log(`${pair}: Order ${res.orderId} created. ${res.side} ${res.type} ${res.origQty} @ ${res.price}.`);
        } else if (res.status === 'FILLED') {
          availableAmount -= res.executedQty * res.price;
          isLong = true;
          isLocked = false;
          buyPrice = res.price;
          buyQuantity = res.quantity;
          lastOrderID = 0;
          console.log(`${pair}: Order ${res.orderId} fully executed. ${res.side} ${res.type} ${res.origQty} @ ${res.price}.`);
        } else {
          console.warn(`${pair}: Unexpected status ${res.status}`)
          isLocked = false;
        }

      })
      .catch(console.log);
  } else if (
    lastClosePrice >= hiBand
    && (lastClosePrice / buyPrice) > 1.02
    && isLong
    && !isLocked) {
    isLocked = true;
    binance.sell(pair, buyQuantity, lastClosePrice)
      .then((res) => {
        if (res.status === 'NEW') {
          lastOrderID = res.orderId;
          console.log(`${pair}: Order ${res.orderId} created. ${res.side} ${res.type} ${res.origQty} @ ${res.price}.`);
        } else if (res.status === 'FILLED') {
          availableAmount += res.executedQty * res.price;
          isLong = false;
          isLocked = false;
          buyPrice = 0;
          buyQuantity = 0;
          lastOrderID = 0;
          console.log(`${pair}: Order ${res.orderId} fully executed. ${res.side} ${res.type} ${res.origQty} @ ${res.price}.`);
        } else {
          console.warn(`${pair}: Unexpected status ${res.status}`)
          isLocked = false;
        }

      })
      .catch(console.log);

  } else {
    let message = isLong ? 'Waiting for opportunity to sell' : 'Waiting for opportunity to buy';
    message = isLocked ? 'Waiting order to be executed' : message;
    console.info(`${pair}: ${interval}. ${message}. Close: ${lastClosePrice}, Hi/Lo: ${hiBand}/${loBand}`);
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

  binance.websockets.userData(() => null, tradeCallback)
  binance.websockets.chart(PAIR, INTERVAL, autoTrade);
});