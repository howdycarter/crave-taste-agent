"use strict";
const { getPicks } = require("../lib/qloo");

module.exports = async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const data = await getPicks(body.profiles);
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || "Recommendation failed" });
  }
};
