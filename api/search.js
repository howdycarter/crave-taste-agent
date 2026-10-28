"use strict";
const { searchEntities } = require("../lib/qloo");

module.exports = async (req, res) => {
  try {
    const q = (req.query && req.query.q) || "";
    const results = await searchEntities(q);
    res.status(200).json({ results });
  } catch (e) {
    res.status(502).json({ error: e.message || "Search failed" });
  }
};
