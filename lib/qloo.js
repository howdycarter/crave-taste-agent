"use strict";

// Qloo Taste AI client + Crave recommendation logic.
// The API key is read from the environment ONLY (server-side). It is never
// sent to the browser, logged, or embedded in any response.
//
// Oct 30 upgrade (probe-verified against the live API):
// - feature.explainability=true returns query.explainability
//   ["signal.interests.entities"] = per-favorite contribution scores.
// - filter.location.query=<City> scopes results (signal.location.query
//   hangs the API — never use it).
// - filter.exclude.entities removes vetoed venues server-side.
// - filter.results.entities scores a fixed candidate set for a profile
//   (nominated scoring) — used to give every Partner Mode candidate real
//   evidence for BOTH people, ranked by minimize-the-worse-rank.

const BASE = process.env.QLOO_API_BASE || "https://hackathon.api.qloo.com";
const KEY = process.env.QLOO_API_KEY || "";
const RESTAURANT_TAG = "urn:tag:category:place:restaurant";
const CUISINE_TYPE = "urn:tag:cuisine:qloo";
// Session request budget: profile reads (<=2 rounds x 2 profiles) +
// nominated scoring (2) + repair headroom. Hard cap per /api/picks call.
const CALL_BUDGET = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function qlooGet(path, params, counter, tries = 3) {
  if (!KEY) throw new Error("QLOO_API_KEY is not configured on the server");
  if (counter) {
    if (counter.calls >= CALL_BUDGET) {
      const err = new Error("Request budget exhausted for this session");
      err.budget = true;
      throw err;
    }
    counter.calls++;
  }
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
        throw err;
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500) throw e;
      if (i < tries - 1) await sleep(900 * (i + 1));
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

// Native attribution: which of the profile's favorites drove this pick,
// from Qloo's explainability metadata. favNames maps entity_id -> name.
// Returns null when the API provided no explainability for this entity —
// callers must render the honest "attribution unavailable" state.
function driversOf(e, favNames) {
  const expl = e.query && e.query.explainability;
  const rows = expl && expl["signal.interests.entities"];
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows
    .filter((r) => r && typeof r.score === "number")
    .map((r) => ({ name: (favNames && favNames.get(r.entity_id)) || "a favorite", score: r.score }))
    .sort((a, b) => b.score - a.score);
}

function slimPick(e, favNames) {
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
  const tags = Array.isArray(e.tags) ? e.tags : [];
  return {
    id: e.entity_id,
    name: e.name,
    affinity: (e.query && e.query.affinity) || 0,
    drivers: driversOf(e, favNames),
    address: p.address || "",
    neighborhood: p.neighborhood || geo.name || "",
    city: geo.city || "",
    price: priceText(p),
    rating: typeof p.business_rating === "number" ? p.business_rating : null,
    cuisines: tagsOfType(e, CUISINE_TYPE),
    ambience: tagsOfType(e, "urn:tag:ambience:qloo").slice(0, 2),
    dishes: typeof dishes === "string" ? dishes : "",
    blurb: (p.short_description || p.cuisine_description || "").slice(0, 180),
    // Eligibility evidence: cuisine tags of its own AND place categories
    // that are all dining-primary (see isEligible).
    hasCuisine: tags.some((t) => t.type === CUISINE_TYPE),
    placeCategories: tags.filter((t) => t.type === "urn:tag:category:place").map((t) => t.name).filter(Boolean),
    lat: typeof geo.latitude === "number" ? geo.latitude : (typeof geo.lat === "number" ? geo.lat : null),
    lon: typeof geo.longitude === "number" ? geo.longitude : (typeof geo.lon === "number" ? geo.lon : (typeof geo.lng === "number" ? geo.lng : null)),
  };
}

// STRICT ELIGIBILITY — unconditional. Probe finding (Oct 30): cuisine tags
// alone do NOT exclude malls — Westfield World Trade Center borrows cuisine
// tags from its food tenants. The discriminator is the place-category set:
// a dining venue's categories are ALL dining-primary (restaurant, cafe,
// bar, tapas bar...). A mall also carries retail categories (shopping
// mall, department store, clothing store...); a neighborhood like
// "Little Italy" carries Market / Tourist attraction. Both fail here,
// deliberately: fewer, honest results beat a full screen with junk.
const DINING_CATEGORY = /restaurant|cafe|bar|bakery|food|diner|eatery|grill|bistro|brasserie|tavern|pub|kitchen|cantina|trattoria|osteria|sushi|pizza|tapas|steakhouse|brewery|winery|coffee|dessert|brunch/i;
function isEligible(pick) {
  return (
    pick.hasCuisine &&
    pick.cuisines.length > 0 &&
    pick.placeCategories.length > 0 &&
    pick.placeCategories.every((c) => DINING_CATEGORY.test(c))
  );
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

// One profile read: eligible restaurant picks for a set of favorites.
// opts: { city, excludeIds, take, favNames }
async function profilePicks(entityIds, opts, counter) {
  const ids = (entityIds || []).filter(Boolean).slice(0, 6);
  if (!ids.length) throw new Error("No taste favorites selected");
  const params = {
    "filter.type": "urn:entity:place",
    "filter.tags": RESTAURANT_TAG,
    "signal.interests.entities": ids.join(","),
    "feature.explainability": "true",
    take: Math.min(opts.take || 50, 50), // API hard cap: take must be 1..50
  };
  if (opts.offset) params.offset = opts.offset;
  if (opts.city) params["filter.location.query"] = opts.city;
  const exclude = (opts.excludeIds || []).filter(Boolean);
  if (exclude.length) params["filter.exclude.entities"] = exclude.join(",");
  const resp = await qlooGet("/v2/insights", params, counter);
  const ents = (resp.results && resp.results.entities) || [];
  const all = ents.map((e) => slimPick(e, opts.favNames)).filter((p) => p.affinity > 0);
  const eligible = all.filter(isEligible);
  eligible.sort((a, b) => b.affinity - a.affinity);
  return { picks: eligible, returned: all.length, dropped: all.length - eligible.length };
}

// Nominated scoring: score a fixed candidate set for one profile.
// Returns Map id -> { affinity, drivers }. Location is NOT passed: the
// candidates were already scoped when their own profile read ran.
async function scoreCandidates(candidateIds, entityIds, favNames, counter) {
  const out = new Map();
  const ids = (candidateIds || []).filter(Boolean);
  if (!ids.length) return out;
  const resp = await qlooGet("/v2/insights", {
    "filter.type": "urn:entity:place",
    "signal.interests.entities": (entityIds || []).filter(Boolean).slice(0, 6).join(","),
    "filter.results.entities": ids.join(","),
    "feature.explainability": "true",
    take: Math.max(ids.length, 5),
  }, counter);
  const ents = (resp.results && resp.results.entities) || [];
  for (const e of ents) {
    out.set(e.entity_id, {
      affinity: (e.query && e.query.affinity) || 0,
      drivers: driversOf(e, favNames),
    });
  }
  return out;
}

function explainSolo(pick, cluster) {
  const clusterTxt = cluster.length ? cluster.slice(0, 2).join(" + ") : "your cultural taste";
  const own = pick.cuisines.length ? pick.cuisines.slice(0, 2).join(", ") : "matches your palate";
  const where = pick.neighborhood && pick.neighborhood !== pick.name ? " in " + pick.neighborhood : "";
  const dish = pick.dishes ? " Known for: " + pick.dishes + "." : "";
  return `Your taste clusters around ${clusterTxt} — ${pick.name} answers with ${own}${where}.${dish}`;
}

function cleanProfiles(profiles) {
  return (profiles || [])
    .filter((p) => p && Array.isArray(p.entityIds) && p.entityIds.length)
    .slice(0, 2)
    .map((p) => {
      const favNames = new Map();
      (p.favorites || []).forEach((f) => { if (f && f.id) favNames.set(f.id, f.name || "a favorite"); });
      p.entityIds.forEach((id) => { if (!favNames.has(id)) favNames.set(id, "a favorite"); });
      return { label: p.label || "You", entityIds: p.entityIds.filter(Boolean).slice(0, 6), favNames };
    });
}

async function getPicks(body) {
  const clean = cleanProfiles(body && body.profiles);
  if (!clean.length) throw new Error("Add at least one favorite to build a taste profile");
  const city = body && typeof body.city === "string" && body.city.trim() ? body.city.trim() : null;
  const vetoed = ((body && body.vetoed) || []).filter((v) => v && v.id);
  const vetoIds = new Set(vetoed.map((v) => v.id));
  const counter = { calls: 0 };
  const trace = [];
  const scopeTxt = city ? ` in ${city}` : "";
  if (vetoed.length === 1) {
    trace.push(`Skipped ${vetoed[0].name || "a venue"} — excluded it and re-ranked from the same taste evidence.`);
  } else if (vetoed.length > 1) {
    trace.push(`Skipped ${vetoed.length} venues so far (latest: ${vetoed[vetoed.length - 1].name || "a venue"}) — all excluded, re-ranked from the same taste evidence.`);
  }

  // --- SOLO ---
  if (clean.length === 1) {
    const prof = clean[0];
    let round = await profilePicks(prof.entityIds, { city, excludeIds: [...vetoIds], take: 50, favNames: prof.favNames }, counter);
    trace.push(`Read your taste profile${scopeTxt}: ${round.returned} venues returned, ${round.picks.length} pass the dining test — cuisine evidence of their own and dining-only place categories${round.dropped ? ` (${round.dropped} dropped as non-dining places)` : ""}.`);
    if (round.picks.length < 4) {
      const before = round.picks.length;
      const page2 = await profilePicks(prof.entityIds, { city, excludeIds: [...vetoIds], take: 50, offset: 50, favNames: prof.favNames }, counter);
      const seen = new Set(round.picks.map((p) => p.id));
      const merged = [...round.picks, ...page2.picks.filter((p) => !seen.has(p.id))].sort((a, b) => b.affinity - a.affinity);
      round = { picks: merged, returned: round.returned + page2.returned, dropped: round.dropped + page2.dropped };
      trace.push(`Only ${before} eligible restaurants on the first page — pulled the next page of results under the same rules (eligibility unchanged) and found ${round.picks.length}.`);
    }
    const cluster = tasteCluster(round.picks);
    const top = round.picks.slice(0, 8).map((p) => ({
      ...p, affinities: { [prof.label]: p.affinity }, shared: true,
      driversBy: { [prof.label]: p.drivers },
      explanation: explainSolo(p, cluster),
    }));
    return { mode: "solo", city, profiles: [{ label: prof.label, cluster }], picks: top, decision: null, trace, meta: { calls: counter.calls, evaluated: round.returned, eligible: round.picks.length } };
  }

  // --- PARTNER: parallel profile reads ---
  const [profA, profB] = clean;
  const optsFor = (prof) => ({ city, excludeIds: [...vetoIds], take: 50, favNames: prof.favNames });
  let [roundA, roundB] = await Promise.all([
    profilePicks(profA.entityIds, optsFor(profA), counter),
    profilePicks(profB.entityIds, optsFor(profB), counter),
  ]);
  const unionMap = new Map();
  for (const p of [...roundA.picks, ...roundB.picks]) if (!unionMap.has(p.id)) unionMap.set(p.id, p);
  trace.push(`Read both taste profiles${scopeTxt} in parallel: ${roundA.returned + roundB.returned} venues returned across both reads, ${unionMap.size} unique restaurants pass the dining test — cuisine evidence and dining-only place categories (${roundA.dropped + roundB.dropped} dropped across both reads as non-dining places).`);

  // --- Automatic sparse-result repair: same rules, next page of results ---
  if (unionMap.size < 6) {
    const before = unionMap.size;
    const [pageA, pageB] = await Promise.all([
      profilePicks(profA.entityIds, { ...optsFor(profA), offset: 50 }, counter),
      profilePicks(profB.entityIds, { ...optsFor(profB), offset: 50 }, counter),
    ]);
    for (const p of [...pageA.picks, ...pageB.picks]) if (!unionMap.has(p.id)) unionMap.set(p.id, p);
    trace.push(`Only ${before} eligible restaurants between you on the first page — pulled the next page of results under the same rules (eligibility unchanged) and found ${unionMap.size}.`);
  }

  // --- Shared-candidate scoring: real evidence for BOTH people ---
  const union = [...unionMap.values()].slice(0, 30);
  const [scoreA, scoreB] = await Promise.all([
    scoreCandidates(union.map((p) => p.id), profA.entityIds, profA.favNames, counter),
    scoreCandidates(union.map((p) => p.id), profB.entityIds, profB.favNames, counter),
  ]);
  const scored = union.map((p) => {
    const sa = scoreA.get(p.id);
    const sb = scoreB.get(p.id);
    return {
      ...p,
      affinities: { [profA.label]: sa ? sa.affinity : 0, [profB.label]: sb ? sb.affinity : 0 },
      driversBy: { [profA.label]: sa ? sa.drivers : p.drivers, [profB.label]: sb ? sb.drivers : null },
      evidenceBoth: !!(sa && sb && sa.affinity > 0 && sb.affinity > 0),
    };
  });
  // Ranks per person (1 = strongest), then minimize-the-worse-rank.
  const rankFor = (label) => {
    const sorted = [...scored].sort((x, y) => (y.affinities[label] || 0) - (x.affinities[label] || 0));
    const m = new Map();
    sorted.forEach((p, i) => m.set(p.id, i + 1));
    return m;
  };
  const rankA = rankFor(profA.label);
  const rankB = rankFor(profB.label);
  for (const p of scored) {
    p.ranks = { [profA.label]: rankA.get(p.id), [profB.label]: rankB.get(p.id) };
    p.worseRank = Math.max(p.ranks[profA.label], p.ranks[profB.label]);
    p.shared = p.evidenceBoth;
  }
  scored.sort((x, y) => (x.worseRank - y.worseRank) || ((y.affinities[profA.label] + y.affinities[profB.label]) - (x.affinities[profA.label] + x.affinities[profB.label])));
  const bothCount = scored.filter((p) => p.evidenceBoth).length;
  trace.push(`Scored ${scored.length} shared candidates for each of you individually — ${bothCount} carry taste evidence for both people. Ranked by the worse of the two ranks, so neither palate is sacrificed.`);

  const clusterA = tasteCluster(roundA.picks);
  const clusterB = tasteCluster(roundB.picks);
  const labelOf = { [profA.label]: clusterA, [profB.label]: clusterB };
  const display = scored.slice(0, 8).map((p, idx) => {
    const where = p.neighborhood && p.neighborhood !== p.name ? " in " + p.neighborhood : "";
    let explanation;
    if (p.evidenceBoth) {
      explanation = `The decision: #${p.ranks[profA.label]} of ${scored.length} for ${profA.label}, #${p.ranks[profB.label]} of ${scored.length} for ${profB.label} — the smallest sacrifice either of you makes. ${p.cuisines.slice(0, 2).join(", ") || "A shared palate"}${where}.`;
      if (idx === 0) trace.push(`Primary pick ${p.name}: ranked #${p.ranks[profA.label]} for ${profA.label} and #${p.ranks[profB.label]} for ${profB.label} of ${scored.length} evaluated.`);
    } else {
      const strong = p.affinities[profA.label] >= p.affinities[profB.label] ? profA.label : profB.label;
      const cl = labelOf[strong] || [];
      explanation = `One-sided pull: ${strong === "You" ? "your" : strong + "'s"} taste clusters around ${cl.slice(0, 2).join(" + ") || "its own palate"} — ${p.name} answers with ${p.cuisines.slice(0, 2).join(", ") || "a strong match"}${where}. No taste evidence for the other profile, so it ranks below the shared ground.`;
    }
    return { ...p, explanation };
  });

  const decision = display.length
    ? { primary: display[0], alternatives: display.slice(1, 3) }
    : null;
  if (!display.length) {
    trace.push(city
      ? `No eligible restaurants in ${city} matched either taste profile. Try another city — the agent will not invent venues or relax the dining rule.`
      : "No eligible restaurants matched either taste profile.");
  }
  return {
    mode: "partner",
    city,
    profiles: [
      { label: profA.label, cluster: clusterA },
      { label: profB.label, cluster: clusterB },
    ],
    picks: display,
    decision,
    trace,
    meta: { calls: counter.calls, evaluated: roundA.returned + roundB.returned, eligible: unionMap.size, scored: scored.length },
  };
}

module.exports = { searchEntities, getPicks };
