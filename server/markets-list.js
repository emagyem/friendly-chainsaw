/* ------------------------------------------------------------------
   The instruments on the Markets page and in the Virtual Exchange.
   Shared by scripts/markets.mjs (daily history), functions/api/quotes.js
   (delayed live prices; only these symbols and the companies on the site
   can be requested) and the app.
------------------------------------------------------------------- */

export const MARKET_GROUPS = [
  { k: "us", l: "US stocks", items: [
    ["^GSPC", "S&P 500"], ["^DJI", "Dow Jones Industrial Average"], ["^IXIC", "Nasdaq Composite"], ["^RUT", "Russell 2000"], ["^VIX", "VIX (volatility)"],
  ] },
  { k: "bio", l: "Health care & biotech", items: [
    ["^NBI", "Nasdaq Biotechnology Index"], ["XBI", "SPDR S&P Biotech ETF"], ["IBB", "iShares Biotechnology ETF"], ["XLV", "Health Care Select Sector ETF"],
  ] },
  { k: "world", l: "World", items: [
    ["^STOXX50E", "Euro Stoxx 50"], ["^FTSE", "FTSE 100"], ["^GDAXI", "DAX"], ["^N225", "Nikkei 225"], ["^HSI", "Hang Seng"],
  ] },
  { k: "rates", l: "US Treasury yields", unit: "%", items: [
    ["^IRX", "13-week bill"], ["^FVX", "5-year note"], ["^TNX", "10-year note"], ["^TYX", "30-year bond"],
  ] },
  { k: "commod", l: "Commodities", items: [
    ["CL=F", "Crude oil (WTI), $/barrel"], ["BZ=F", "Brent crude, $/barrel"], ["NG=F", "Natural gas, $/MMBtu"], ["GC=F", "Gold, $/oz"], ["SI=F", "Silver, $/oz"], ["HG=F", "Copper, $/lb"], ["ZC=F", "Corn, ¢/bushel"],
  ] },
  { k: "fx", l: "Currencies", items: [
    ["DX-Y.NYB", "US Dollar Index"], ["EURUSD=X", "Euro in dollars"], ["GBPUSD=X", "Pound in dollars"], ["JPY=X", "Dollar in yen"], ["CNY=X", "Dollar in yuan"], ["CAD=X", "Dollar in Canadian dollars"],
  ] },
  { k: "crypto", l: "Crypto", items: [
    ["BTC-USD", "Bitcoin"], ["ETH-USD", "Ether"], ["SOL-USD", "Solana"], ["XRP-USD", "XRP"],
  ] },
];

// Funds anyone can trade in the Virtual Exchange, besides the companies on the site.
export const TRADABLE_FUNDS = [
  ["SPY", "SPDR S&P 500 ETF"], ["QQQ", "Invesco QQQ (Nasdaq-100)"], ["DIA", "SPDR Dow Jones ETF"], ["IWM", "iShares Russell 2000 ETF"],
  ["XBI", "SPDR S&P Biotech ETF"], ["IBB", "iShares Biotechnology ETF"], ["XLV", "Health Care Select Sector ETF"],
  ["TLT", "iShares 20+ Year Treasury Bond ETF"], ["GLD", "SPDR Gold Shares"], ["VTI", "Vanguard Total Stock Market ETF"],
];

export const MARKET_SYMBOLS = [...new Set([...MARKET_GROUPS.flatMap((g) => g.items.map(([s]) => s)), ...TRADABLE_FUNDS.map(([s]) => s)])];
