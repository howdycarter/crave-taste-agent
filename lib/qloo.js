"use strict";

// Qloo Taste AI client + Crave recommendation logic.
// The API key is read from the environment ONLY (server-side). It is never
// sent to the browser, logged, or embedded in any response.

const BASE = process.env.QLOO_API_BASE || "https://hackathon.api.qloo.com";
const KEY = process.env.QLOO_API_KEY || "";
const RESTAURANT_TAG = "urn:tag:category:place:restaurant";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function qlooGet(path, params, tries = 4) {
  if (!KEY) throw new Error("QLOO_API_KEY is not configured on the server");
  const url = BASE + path + "?" + new URLSearchParams(params).toString();
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { "X-Api-Key": KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* keep null */ }
      if (!resp.ok) {
        const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || ("HTTP " + resp.status);
        const err = new Error("Qloo: " + msg);
        err.status = resp.status;
        if (resp.status >= 400 && resp.status < 500) throw err; // no retry on 4xx
        throw err;
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500) throw e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr || new Error("Qloo request failed");
}

function prettyType(types) {
  if (!Array.isArray(types) || !types.length) return "taste";
  const t = String(types[0]).replace("urn:entity:", "").replace(/_/g, " ");
  return t;
}

async function searchEntities(q) {
  const query = String(q || "").trim();
  if (query.length < 2) return [];
  const resp = await qlooGet("/search", { query });
  const results = Array.isArray(resp.results) ? resp.results : [];
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r.entity_id || seen.has(r.entity_id)) continue;
    seen.add(r.entity_id);
    const desc = (r.properties && r.properties.description) || "";
    out.push({
      id: r.entity_id,
      name: r.name,
      type: prettyType(r.types),
      blurb: desc ? desc.slice(0, 110) : "",
    });
    if (out.length >= 8) break;
  }
  return out;
}

function tagsOfType(entity, type) {
  const tags = Array.isArray(entity.tags) ? entity.tags : [];
  return tags.filter((t) => t.type === type).map((t) => t.name).filter(Boolean);
}

function priceText(p) {
  if (typeof p.price_level === "number" && p.price_level > 0) {
    return "$".repeat(Math.min(4, Math.max(1, Math.round(p.price_level))));
  }
  const pr = p.price_range;
  if (typeof pr === "string" && pr.trim()) return pr.trim();
  if (pr && typeof pr === "object") {
    if (pr.from != null && pr.to != null) return "$" + pr.from + "–$" + pr.to;
    if (pr.from != null) return "from $" + pr.from;
  }
  return "";
}

function slimPick(e) {
  const p = e.properties || {};
  const geo = p.geocode || {};
  let dishes = p.specialty_dishes || "";
  if (Array.isArray(dishes)) {
    dishes = dishes
      .map((d) => (typeof d === "string" ? d : (d && d.name) || ""))
      .map((s) => s.replace(/^And\s+/i, "").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(", ");
  }
  return {
    id: e.entity_id,
    name: e.name,
    affinity: (e.query && e.query.affinity) || 0,
    address: p.address || "",
    neighborhood: p.neighborhood || geo.name || "",
    city: geo.city || "",
    price: priceText(p),
    rating: typeof p.business_rating === "number" ? p.business_rating : null,
    image: (p.image && p.image.url) || (Array.isArray(p.images) && p.images[0] && p.images[0].url) || "",
    cuisines: tagsOfType(e, "urn:tag:cuisine:qloo"),
    ambience: tagsOfType(e, "urn:tag:ambience:qloo").slice(0, 2),
    dishes: typeof dishes === "string" ? dishes : "",
    blurb: (p.short_description || p.cuisine_description || "").slice(0, 180),
  };
}

function tasteCluster(picks) {
  const weights = new Map();
  for (const pick of picks) {
    for (const c of pick.cuisines) {
      weights.set(c, (weights.get(c) || 0) + pick.affinity);
    }
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
}

function explain(pick, cluster, label) {
  const who = label ? label + ", your" : "Your";
  const clusterTxt = cluster.length ? cluster.slice(0, 2).join(" + ") : "your cultural taste";
  const own = pick.cuisines.length ? pick.cuisines.slice(0, 2).join(", ") : "matches your palate";
  const where = pick.neighborhood && pick.neighborhood !== pick.name ? " in " + pick.neighborhood : "";
  const dish = pick.dishes ? " Known for: " + pick.dishes + "." : "";
  return `${who} taste clusters around ${clusterTxt} — ${pick.name} answers with ${own}${where}.${dish}`;
}

async function profilePicks(entityIds) {
  const ids = (entityIds || []).filter(Boolean).slice(0, 6);
  if (!ids.length) throw new Error("No taste favorites selected");
  const resp = await qlooGet("/v2/insights", {
    "filter.type": "urn:entity:place",
    "filter.tags": RESTAURANT_TAG,
    "signal.interests.entities": ids.join(","),
    take: 50,
  });
  const ents = (resp.results && resp.results.entities) || [];
  let picks = ents.map(slimPick).filter((p) => p.affinity > 0);
  picks.sort((a, b) => b.affinity - a.affinity);
  // Dining-grade guard: when enough picks carry real cuisine tags, drop the
  // venue-cafes (museums, malls) that inherit a restaurant category from an
  // in-house cafe but have no cuisine identity of their own.
  const withCuisine = picks.filter((p) => p.cuisines.length > 0);
  if (withCuisine.length >= 6) picks = withCuisine;
  return picks;
}

async function getPicks(profiles) {
  const clean = (profiles || [])
    .filter((p) => p && Array.isArray(p.entityIds) && p.entityIds.length)
    .slice(0, 2);
  if (!clean.length) throw new Error("Add at least one favorite to build a taste profile");

  const perProfile = [];
  for (const prof of clean) {
    const picks = await profilePicks(prof.entityIds);
    const cluster = tasteCluster(picks);
    perProfile.push({ label: prof.label || "You", cluster, picks });
  }

  if (perProfile.length === 1) {
    const { label, cluster, picks } = perProfile[0];
    const top = picks.slice(0, 8).map((p) => ({
      ...p,
      affinities: { [label]: p.affinity },
      shared: true,
      explanation: explain(p, cluster, null),
    }));
    return { mode: "solo", profiles: [{ label, cluster }], picks: top };
  }

  const [a, b] = perProfile;
  const aIds = new Set(a.picks.map((p) => p.id));
  const bMap = new Map(b.picks.map((p) => [p.id, p]));
  const shared = [];
  let aOnly = [];
  let bOnly = [];
  for (const pa of a.picks) {
    const pb = bMap.get(pa.id);
    if (pb) {
      shared.push({
        ...pa,
        score: Math.sqrt(pa.affinity * pb.affinity),
        affinities: { [a.label]: pa.affinity, [b.label]: pb.affinity },
        shared: true,
        owner: null,
      });
    } else {
      aOnly.push({ ...pa, score: pa.affinity, affinities: { [a.label]: pa.affinity }, shared: false, owner: a.label });
    }
  }
  for (const pb of b.picks) {
    if (!aIds.has(pb.id)) {
      bOnly.push({ ...pb, score: pb.affinity, affinities: { [b.label]: pb.affinity }, shared: false, owner: b.label });
    }
  }
  shared.sort((x, y) => y.score - x.score);
  aOnly.sort((x, y) => y.score - x.score);
  bOnly.sort((x, y) => y.score - x.score);
  // If the two profiles name no identical venue, fall back to cuisine-level
  // common ground: picks from either side whose cuisines sit in BOTH taste
  // clusters. Still fully data-derived — it is where the palates converge.
  const commonGround = [];
  const overlapCuisines = a.cluster.filter((c) => b.cluster.includes(c));
  if (shared.length < 3 && overlapCuisines.length) {
    const isCommon = (p) => p.cuisines.some((c) => overlapCuisines.includes(c));
    const cgA = aOnly.filter(isCommon).map((p) => ({ ...p, shared: true, kind: "cuisine" }));
    const cgB = bOnly.filter(isCommon).map((p) => ({ ...p, shared: true, kind: "cuisine" }));
    aOnly = aOnly.filter((p) => !isCommon(p));
    bOnly = bOnly.filter((p) => !isCommon(p));
    let i = 0, j = 0;
    while (i < cgA.length || j < cgB.length) {
      if (i < cgA.length) commonGround.push(cgA[i++]);
      if (j < cgB.length) commonGround.push(cgB[j++]);
    }
  }
  // Shared ground first (capped, so the table still shows each side's own
  // character), then alternate each side's strongest pull so neither
  // palate dominates the table.
  const ordered = [...shared, ...commonGround.slice(0, 4)];
  let i = 0, j = 0;
  while (ordered.length < 8 && (i < aOnly.length || j < bOnly.length)) {
    if (i < aOnly.length) ordered.push(aOnly[i++]);
    if (ordered.length >= 8) break;
    if (j < bOnly.length) ordered.push(bOnly[j++]);
  }
  const clusterOf = { [a.label]: a.cluster, [b.label]: b.cluster };
  const top = ordered.slice(0, 8).map((p) => {
    if (p.shared && p.kind !== "cuisine") {
      return {
        ...p,
        explanation: `Common ground: both taste profiles converge here — ${p.cuisines.slice(0, 2).join(", ") || "a shared palate"}${p.neighborhood && p.neighborhood !== p.name ? " in " + p.neighborhood : ""}.`,
      };
    }
    if (p.shared && p.kind === "cuisine") {
      const sharedCuisines = p.cuisines.filter((c) => overlapCuisines.includes(c));
      return {
        ...p,
        explanation: `Common ground: both palates converge on ${overlapCuisines.join(" + ")} — ${p.name} is one side's strongest expression of it (${sharedCuisines.join(", ") || p.cuisines.slice(0, 2).join(", ")})${p.neighborhood && p.neighborhood !== p.name ? " in " + p.neighborhood : ""}.`,
      };
    }
    const cl = clusterOf[p.owner] || [];
    const where = p.neighborhood && p.neighborhood !== p.name ? " in " + p.neighborhood : "";
    const dish = p.dishes ? " Known for: " + p.dishes + "." : "";
    const ownerTxt = p.owner === "You" ? "Your" : p.owner + "'s";
    return {
      ...p,
      explanation: `${ownerTxt} taste clusters around ${cl.slice(0, 2).join(" + ") || "their own palate"} — ${p.name} answers with ${p.cuisines.slice(0, 2).join(", ") || "a strong match"}${where}.${dish}`,
    };
  });
  return {
    mode: "partner",
    profiles: [{ label: a.label, cluster: a.cluster }, { label: b.label, cluster: b.cluster }],
    picks: top,
  };
}

module.exports = { searchEntities, getPicks };
