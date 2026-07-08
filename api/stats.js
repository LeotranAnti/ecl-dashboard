const { getSheetValues } = require("./sheets_helper");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "application/json");

  const urlObj = new URL(req.url, 'http://localhost');
  const targetMonth = urlObj.searchParams.get("target_month") || "";

  try {
    // 1. Fetch Candidates directly from Vercel candidates API (which reads Google Sheets)
    // To call local serverless API in vercel function: call candidates API directly
    const candidatesModule = require("./candidates");
    
    // Mock req & res for candidates fetch
    let candidatesCSV = "";
    const mockRes = {
      setHeader: () => {},
      status: () => ({
        send: (data) => { candidatesCSV = data; }
      })
    };
    
    // We fetch candidates for all factories to aggregate statistics
    const factories = ["Pegatron", "Brother", "LG", "Usi", "Fox QN"];
    const allCandidates = [];
    
    for (const f of factories) {
      await candidatesModule({ query: { factory: f }, url: `/api/candidates?factory=${f}` }, mockRes);
      if (candidatesCSV) {
        const lines = candidatesCSV.split(/\r?\n/);
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const row = lines[i].split(",").map(c => c.trim().replace(/^"|"$/g, ''));
          if (row.length > 3) {
            row[18] = f; // Map factory
            allCandidates.push(row);
          }
        }
      }
    }

    // 2. Fetch Pricing from Sheets
    const pricingRows = await getSheetValues("Cấu hình Đơn giá!A2:E200");
    const prices = pricingRows.map(r => ({
      factory: r[0] || "",
      price: parseFloat(r[1]) || 0.0,
      start_date: r[2] || "",
      end_date: r[3] || "",
      unit: r[4] || "Ngày"
    }));

    // 3. Fetch Expenses from Sheets
    const expensesRows = await getSheetValues("Chi phí Vận hành!A2:G200");
    const expenses = expensesRows.map(r => {
      const ads = parseFloat(r[1]) || 0.0;
      const salary = parseFloat(r[2]) || 0.0;
      const phone = parseFloat(r[3]) || 0.0;
      const office = parseFloat(r[4]) || 0.0;
      const other = parseFloat(r[5]) || 0.0;
      return {
        month: r[0] || "",
        ads_cost: ads,
        salary_cost: salary,
        phone_cost: phone,
        office_cost: office,
        other_cost: other,
        total_cost: ads + salary + phone + office + other
      };
    });

    // Helper to parse dates
    const parseDate = (dStr) => {
      if (!dStr) return null;
      // Handle format: DD/MM/YY or DD/MM/YYYY or YYYY-MM-DD
      const parts = dStr.split("/");
      if (parts.length >= 2) {
        const d = parseInt(parts[0]);
        const m = parseInt(parts[1]);
        let y = parts[2] ? parseInt(parts[2]) : 2026;
        if (y < 100) y += 2000;
        return new Date(y, m - 1, d);
      }
      const parts2 = dStr.split("-");
      if (parts2.length >= 3) {
        return new Date(parseInt(parts2[0]), parseInt(parts2[1]) - 1, parseInt(parts2[2]));
      }
      return null;
    };

    // Calculate revenue per month based on candidates and pricing configuration
    // Monthly stats generation
    const monthlyStatsMap = {};
    
    // Pre-populate with expense months to make sure we show them even if revenue is 0
    expenses.forEach(e => {
      monthlyStatsMap[e.month] = { month: e.month, revenue: 0.0, cost: e.total_cost, pnl: -e.total_cost };
    });

    // Aggregate monthly revenue based on active days and pricing
    allCandidates.forEach(c => {
      const factory = c[18];
      const bDate = parseDate(c[0]); // registration/boarding date
      if (!bDate) return;
      
      const bMonth = `${bDate.getFullYear()}-${String(bDate.getMonth() + 1).padStart(2, '0')}`;
      
      // Find matching price
      const priceConfig = prices.find(p => p.factory === factory && p.start_date <= c[0] && p.end_date >= c[0]) || 
                          prices.find(p => p.factory === factory) || { price: 0.0, unit: "Ngày" };
                          
      const price = priceConfig.price;
      const unit = priceConfig.unit;

      // Estimate revenue per candidate (simulate standard 22 days for 'Ngày' or 176 hours for 'Giờ')
      let estRevenue = 0.0;
      if (unit === "Giờ làm") {
        estRevenue = 176 * price;
      } else if (unit === "Tháng") {
        estRevenue = price;
      } else {
        estRevenue = 22 * price; // Days
      }

      if (!monthlyStatsMap[bMonth]) {
        monthlyStatsMap[bMonth] = { month: bMonth, revenue: 0.0, cost: 0.0, pnl: 0.0 };
      }
      monthlyStatsMap[bMonth].revenue += estRevenue;
    });

    // Re-calculate P&L
    const monthly_stats = Object.values(monthlyStatsMap).map(s => {
      const expenseItem = expenses.find(e => e.month === s.month);
      const cost = expenseItem ? expenseItem.total_cost : 0.0;
      return {
        month: s.month,
        revenue: Math.round(s.revenue),
        cost: cost,
        pnl: Math.round(s.revenue - cost)
      };
    });

    // Sort descending by month
    monthly_stats.sort((a, b) => b.month.localeCompare(a.month));

    // 4. Calculate Forecast for targetMonth + 1
    let forecastMonth = targetMonth;
    if (!forecastMonth) {
      forecastMonth = monthly_stats.length > 0 ? monthly_stats[0].month : "2026-07";
    }
    
    // Parse target month and add 1 month
    const fParts = forecastMonth.split("-");
    let fYear = parseInt(fParts[0]);
    let fMonth = parseInt(fParts[1]) + 1;
    if (fMonth > 12) {
      fMonth = 1;
      fYear += 1;
    }
    const nextMonthStr = `${fYear}-${String(fMonth).padStart(2, '0')}`;

    // Find active candidates continuing into nextMonthStr
    // Candidates who registered before nextMonthStr end and have no resignation or end_date >= nextMonthStr start
    const startOfNextMonth = new Date(fYear, fMonth - 1, 1);
    const endOfNextMonth = new Date(fYear, fMonth, 0);

    const forecastDetails = [];
    let forecastRevenue = 0.0;
    let forecastCount = 0;

    allCandidates.forEach(c => {
      const bDate = parseDate(c[0]);
      if (!bDate || bDate > endOfNextMonth) return;
      
      const termLimit = (c[18] === "Canon" || c[18] === "CN") ? 180 : 90; // days
      const expectedEnd = new Date(bDate.getTime() + termLimit * 24 * 60 * 60 * 1000);
      
      if (expectedEnd >= startOfNextMonth) {
        forecastCount++;
        const factory = c[18];
        const priceConfig = prices.find(p => p.factory === factory && p.start_date <= c[0] && p.end_date >= c[0]) || 
                            prices.find(p => p.factory === factory) || { price: 0.0, unit: "Ngày" };
        
        let val = 0.0;
        if (priceConfig.unit === "Giờ làm") {
          val = 176 * priceConfig.price;
        } else if (priceConfig.unit === "Tháng") {
          val = priceConfig.price;
        } else {
          val = 22 * priceConfig.price;
        }

        forecastRevenue += val;
        if (forecastDetails.length < 15) {
          forecastDetails.push({ name: c[1], factory: factory, value: Math.round(val) });
        }
      }
    });

    return res.status(200).json({
      monthly_stats,
      forecast: {
        month: nextMonthStr,
        estimated_revenue: Math.round(forecastRevenue),
        candidates_count: forecastCount,
        details: forecastDetails
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
