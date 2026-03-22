import express from "express";
import axios from "axios";
import WebSocket from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

// 内存缓存：latestKlines[symbol][interval] = 最新一根 kline 对象
const latestKlines = {};

function ensureWs(symbol = "BTCUSDT", interval = "1m") {
  const streamName = `${symbol.toLowerCase()}@kline_${interval}`;
  const url = `wss://stream.binance.com:9443/ws/${streamName}`;

  console.log("Connecting WS:", url);
  const ws = new WebSocket(url);

  ws.on("open", () => {
    console.log("WS connected:", streamName);
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.e === "kline" && data.k) {
        const k = data.k;

        if (!latestKlines[symbol]) latestKlines[symbol] = {};
        latestKlines[symbol][interval] = {
          symbol,
          interval,
          openTime: k.t,
          closeTime: k.T,
          open: k.o,
          high: k.h,
          low: k.l,
          close: k.c,
          volume: k.v,
          isFinal: k.x,
        };
      }
    } catch (err) {
      console.error("WS message parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("WS closed, retrying in 3s:", streamName);
    setTimeout(() => ensureWs(symbol, interval), 3000);
  });

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
    ws.close();
  });
}

// 启动时先订阅 BTCUSDT 1m
ensureWs("BTCUSDT", "1m");

// 健康检查
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// 历史 K 线（REST）
app.get("/v1/klines/history", async (req, res) => {
  try {
    const { symbol = "BTCUSDT", interval = "1m", limit = 10 } = req.query;

    const url = "https://api.binance.com/api/v3/klines";
    const params = { symbol, interval, limit };

    const { data } = await axios.get(url, { params });

    res.json({
      symbol,
      interval,
      limit: Number(limit),
      raw: data,
    });
  } catch (err) {
    console.error("Error fetching klines:", err.response?.data || err.message);
    res.status(500).json({
      error: "failed_to_fetch_klines",
      detail: err.response?.data || err.message,
    });
  }
});

// 最新一根 K 线（优先用 WS 缓存）
app.get("/v1/klines/latest", async (req, res) => {
  try {
    const { symbol = "BTCUSDT", interval = "1m" } = req.query;

    const cached =
      latestKlines[symbol]?.[interval] ||
      latestKlines[symbol.toUpperCase()]?.[interval] ||
      latestKlines[symbol.toLowerCase()]?.[interval];

    if (cached) {
      return res.json({
        source: "ws_cache",
        kline: cached,
      });
    }

    // 如果没有缓存，就用 REST 拉一根
    const url = "https://api.binance.com/api/v3/klines";
    const params = { symbol, interval, limit: 1 };
    const { data } = await axios.get(url, { params });
    const [k] = data;

    const kline = {
      symbol,
      interval,
      openTime: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: k[5],
      closeTime: k[6],
      isFinal: true,
    };

    res.json({
      source: "rest_fallback",
      kline,
    });
  } catch (err) {
    console.error("Error fetching latest kline:", err.response?.data || err.message);
    res.status(500).json({
      error: "failed_to_fetch_latest_kline",
      detail: err.response?.data || err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
