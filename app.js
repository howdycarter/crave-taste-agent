"use strict";

const state = {
  mode: "solo",
  profiles: [
    { label: "You", picks: [] },
    { label: "Your partner", picks: [] },
  ],
};

// Partner Mode decision session: vetoes accumulate, a "Works for me"
// acceptance is sticky, and every replan re-runs the agent with the
// vetoed venues excluded server-side.
const session = {
  vetoed: [], // [{id, name}]
  acceptedId: null,
  lastData: null,
};

const $profiles = document.getElementById("profiles");
const $go = document.getElementById("go");
const $status = document.getElementById("status");
const $results = document.getElementById("results");
const $cards = document.getElementById("cards");
const $cluster = document.getElementById("cluster-line");
const $city = document.getElementById("city");
const $trace = document.getElementById("trace");
const $decision = document.getElementById("decision");
const $moreHead = document.getElementById("more-head");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function activeProfiles() {
  return state.mode === "solo" ? state.profiles.slice(0, 1) : state.profiles.slice(0, 2);
}

function resetSession() {
  session.vetoed = [];
  session.acceptedId = null;
  session.lastData = null;
}

const EXAMPLES = [
  { label: "Radiohead + Inception", terms: ["Radiohead", "Inception"] },
  { label: "Björk + Studio Ghibli", terms: ["Björk", "Studio Ghibli"] },
  { label: "The Bear + Kendrick Lamar", terms: ["The Bear", "Kendrick Lamar"] },
];

function renderProfiles() {
  const list = activeProfiles();
  $profiles.className = "profiles" + (list.length === 2 ? " two" : "");
  $profiles.innerHTML = "";
  list.forEach((prof) => {
    const card = document.createElement("div");
    card.className = "profile-card";
    card.innerHTML = `
      <h2>${esc(prof.label)}</h2>
      <p class="hint">Name 1–6 favorites — artists, films, shows, places. No food questions.</p>
      <div class="search-wrap">
        <input class="search-input" type="text" placeholder="Try &quot;Radiohead&quot;, &quot;Inception&quot;, &quot;Kyoto&quot;…" autocomplete="off" aria-label="Search your taste">
        <div class="search-results" hidden></div>
      </div>
      <div class="chips"></div>
      <div class="examples"><span>Quick start</span></div>`;
    const input = card.querySelector(".search-input");
    const box = card.querySelector(".search-results");
    const chips = card.querySelector(".chips");
    const examples = card.querySelector(".examples");

    const renderChips = () => {
      chips.innerHTML = "";
      prof.picks.forEach((p, i) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.innerHTML = `${esc(p.name)} <button type="button" aria-label="Remove ${esc(p.name)}">×</button>`;
        chip.querySelector("button").addEventListener("click", () => {
          prof.picks.splice(i, 1);
          renderChips();
        });
        chips.appendChild(chip);
      });
    };

    const addPick = (item) => {
      if (prof.picks.some((p) => p.id === item.id)) return;
      if (prof.picks.length >= 6) {
        setStatus("Six favorites is plenty — the taste graph has what it needs.", false);
        return;
      }
      prof.picks.push(item);
      renderChips();
    };

    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
      timer = setTimeout(async () => {
        try {
          const r = await fetch("/api/search?q=" + encodeURIComponent(q));
          const data = await r.json();
          if (!data.results || !data.results.length) {
            box.innerHTML = `<button type="button" disabled>No matches — try another spelling</button>`;
            box.hidden = false;
            return;
          }
          box.innerHTML = "";
          data.results.forEach((item) => {
            const b = document.createElement("button");
            b.type = "button";
            b.innerHTML = `${esc(item.name)}<span class="rtype">${esc(item.type)}</span>${item.blurb ? `<span class="rblurb">${esc(item.blurb)}</span>` : ""}`;
            b.addEventListener("click", () => {
              addPick(item);
              input.value = "";
              box.hidden = true;
              input.focus();
            });
            box.appendChild(b);
          });
          box.hidden = false;
        } catch (e) {
          box.innerHTML = `<button type="button" disabled>Search hiccup — try again</button>`;
          box.hidden = false;
        }
      }, 260);
    });
    input.addEventListener("blur", () => setTimeout(() => { box.hidden = true; }, 180));

    EXAMPLES.forEach((ex) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "example-btn";
      b.textContent = ex.label;
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          for (const term of ex.terms) {
            const r = await fetch("/api/search?q=" + encodeURIComponent(term));
            const data = await r.json();
            if (data.results && data.results[0]) addPick(data.results[0]);
          }
        } finally { b.disabled = false; }
      });
      examples.appendChild(b);
    });

    renderChips();
    $profiles.appendChild(card);
  });
  $go.textContent = state.mode === "solo" ? "Find my table" : "Find our table";
}

function setStatus(msg, isError) {
  $status.textContent = msg || "";
  $status.className = "status" + (isError ? " error" : "");
}

function pct(x) { return Math.round((x || 0) * 100) + "%"; }

function driversLine(drivers) {
  if (!drivers || !drivers.length) return `<div class="drivers unavailable">Attribution unavailable for this pick — Qloo returned no per-favorite breakdown.</div>`;
  const txt = drivers.slice(0, 3).map((d) => `${esc(d.name)} ${pct(d.score)}`).join(" · ");
  return `<div class="drivers">Driven by: ${txt}</div>`;
}

function mapHref(p) {
  if (typeof p.lat === "number" && typeof p.lon === "number") {
    return "https://www.google.com/maps/search/?api=1&query=" + p.lat + "," + p.lon;
  }
  if (p.address) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(p.name + " " + p.address);
  }
  return "";
}

function evidencePanel(p, data) {
  const labels = (data.profiles || []).map((x) => x.label);
  const rows = labels.map((label) => {
    const aff = p.affinities ? p.affinities[label] : null;
    const rank = p.ranks ? p.ranks[label] : null;
    const total = data.meta && data.meta.scored ? data.meta.scored : null;
    const head = rank && total
      ? `<strong>${esc(label)}</strong> — #${rank} of ${total} · match ${pct(aff)}`
      : `<strong>${esc(label)}</strong> — match ${pct(aff)}`;
    const drivers = p.driversBy ? p.driversBy[label] : p.drivers;
    return `<div class="evidence-row">${head}${driversLine(drivers)}</div>`;
  }).join("");
  return `<div class="evidence"><div class="evidence-title">Why this fits each of you</div>${rows}</div>`;
}

function buildCard(p, data, opts) {
  const card = document.createElement("article");
  card.className = "card" + (opts.primary ? " primary" : "") + (session.acceptedId === p.id ? " accepted" : "");
  const bandTags = [...(p.cuisines || []).slice(0, 2), ...(p.ambience || []).slice(0, 1)];
  let badge;
  if (opts.primary) badge = "The decision";
  else if (data.mode === "partner") badge = p.evidenceBoth ? "Shared evidence" : "One-sided pull";
  else badge = pct(p.affinity);
  const map = mapHref(p);
  const decided = session.acceptedId !== null;
  card.innerHTML = `
    <div class="card-band">${bandTags.map((t) => `<span class="band-tag">${esc(t)}</span>`).join("") || `<span class="band-tag">Taste match</span>`}</div>
    <div class="card-body">
      <div class="card-top"><h3>${esc(p.name)}</h3><span class="affinity ${opts.primary || p.evidenceBoth ? "shared" : ""}">${esc(badge)}</span></div>
      <div class="meta">${esc([p.cuisines.slice(0, 3).join(", "), p.price, p.neighborhood || p.city].filter(Boolean).join(" · "))}</div>
      <p class="explain">${esc(p.explanation || "")}</p>
      ${data.mode === "partner" ? evidencePanel(p, data) : driversLine(p.drivers)}
      <div class="addr">${esc(p.address || "")}${map ? ` · <a href="${esc(map)}" target="_blank" rel="noopener">Map</a>` : ""}</div>
      ${data.mode === "partner" ? `<div class="card-actions">
        <button type="button" class="act accept" ${decided ? "disabled" : ""}>${session.acceptedId === p.id ? "✓ Decided" : "Works for me"}</button>
        <button type="button" class="act skip" ${decided ? "disabled" : ""}>Skip</button>
      </div>` : ""}
    </div>`;
  if (data.mode === "partner") {
    card.querySelector(".accept").addEventListener("click", () => {
      session.acceptedId = p.id;
      renderResults(session.lastData);
      setStatus(`Decided: ${p.name}. The evidence on the card is why.`, false);
    });
    card.querySelector(".skip").addEventListener("click", () => {
      if (!session.vetoed.some((v) => v.id === p.id)) session.vetoed.push({ id: p.id, name: p.name });
      runPicks(`Not ${p.name} — excluding it and re-deciding…`);
    });
  }
  return card;
}

function renderResults(data) {
  session.lastData = data;
  const profs = data.profiles || [];
  if (data.mode === "solo") {
    const c = profs[0] && profs[0].cluster && profs[0].cluster.length ? profs[0].cluster.join(" · ") : "your cultural taste";
    $cluster.innerHTML = `Your taste clusters around <strong>${esc(c)}</strong>${data.city ? ` — eating in <strong>${esc(data.city)}</strong>` : ""}. Every pick below is a restaurant with cuisine evidence of its own:`;
  } else {
    const parts = profs.map((p) => `<strong>${esc(p.label)}</strong>: ${esc((p.cluster || []).join(" · ") || "—")}`);
    $cluster.innerHTML = `Different tastes. One dinner decision.${data.city ? ` Eating in <strong>${esc(data.city)}</strong>.` : ""} ${parts.join(" &nbsp;×&nbsp; ")}`;
  }

  if (data.trace && data.trace.length) {
    $trace.innerHTML = `<div class="trace-title">How the agent worked this out</div>` +
      data.trace.map((t) => `<div class="trace-line">${esc(t)}</div>`).join("");
    $trace.hidden = false;
  } else {
    $trace.hidden = true;
  }

  $decision.innerHTML = "";
  $cards.innerHTML = "";
  const picks = data.picks || [];
  if (data.mode === "partner" && data.decision) {
    const head = document.createElement("div");
    head.className = "decision-head";
    head.textContent = session.acceptedId ? "Decided" : "The agent's decision — one pick, two alternatives";
    $decision.appendChild(head);
    const row = document.createElement("div");
    row.className = "decision-row";
    row.appendChild(buildCard(data.decision.primary, data, { primary: true }));
    data.decision.alternatives.forEach((p) => row.appendChild(buildCard(p, data, {})));
    $decision.appendChild(row);
    $decision.hidden = false;
    const rest = picks.slice(1 + data.decision.alternatives.length);
    $moreHead.hidden = rest.length === 0;
    rest.forEach((p) => $cards.appendChild(buildCard(p, data, {})));
  } else {
    $decision.hidden = true;
    $moreHead.hidden = true;
    picks.forEach((p) => $cards.appendChild(buildCard(p, data, {})));
  }
  if (!picks.length) {
    $cards.innerHTML = `<div class="empty">No eligible restaurants matched. The agent will not relax the dining rule or invent venues — try another city or different favorites.</div>`;
  }
  $results.hidden = false;
  $results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildPayload() {
  const profiles = activeProfiles().map((p) => ({
    label: p.label,
    entityIds: p.picks.map((x) => x.id),
    favorites: p.picks.map((x) => ({ id: x.id, name: x.name })),
  }));
  return { profiles, city: $city.value || null, vetoed: session.vetoed };
}

async function runPicks(statusMsg) {
  const payload = buildPayload();
  if (state.mode === "partner" && payload.profiles.some((p) => !p.entityIds.length)) {
    setStatus("Partner Mode needs favorites on BOTH profiles — that's what makes it a decision between two tastes.", true);
    return;
  }
  if (payload.profiles.every((p) => !p.entityIds.length)) {
    setStatus("Add at least one favorite first — an artist, a film, a place you love.", true);
    return;
  }
  $go.disabled = true;
  setStatus(statusMsg || "Reading the taste graph…", false);
  try {
    const r = await fetch("/api/picks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "The taste graph hiccuped");
    renderResults(data);
    setStatus("", false);
  } catch (e) {
    setStatus((e.message || "Something went wrong") + " — the Qloo event API can be flaky; one more try usually lands it.", true);
  } finally {
    $go.disabled = false;
  }
}

$go.addEventListener("click", () => { resetSession(); runPicks(); });
$city.addEventListener("change", resetSession);

document.getElementById("mode-solo").addEventListener("click", () => {
  state.mode = "solo";
  document.getElementById("mode-solo").classList.add("active");
  document.getElementById("mode-partner").classList.remove("active");
  resetSession();
  renderProfiles();
});
document.getElementById("mode-partner").addEventListener("click", () => {
  state.mode = "partner";
  document.getElementById("mode-partner").classList.add("active");
  document.getElementById("mode-solo").classList.remove("active");
  resetSession();
  renderProfiles();
});

renderProfiles();
