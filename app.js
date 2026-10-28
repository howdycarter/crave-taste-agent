"use strict";

const state = {
  mode: "solo",
  profiles: [
    { label: "You", picks: [] },
    { label: "Your partner", picks: [] },
  ],
};

const $profiles = document.getElementById("profiles");
const $go = document.getElementById("go");
const $status = document.getElementById("status");
const $results = document.getElementById("results");
const $cards = document.getElementById("cards");
const $cluster = document.getElementById("cluster-line");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function activeProfiles() {
  return state.mode === "solo" ? state.profiles.slice(0, 1) : state.profiles.slice(0, 2);
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
  list.forEach((prof, idx) => {
    const card = document.createElement("div");
    card.className = "profile-card";
    card.innerHTML = `
      <h2>${esc(prof.label)}</h2>
      <p class="hint">Name 2–5 favorites — artists, films, shows, places. No food questions.</p>
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

function renderResults(data) {
  const profs = data.profiles || [];
  if (data.mode === "solo") {
    const c = profs[0] && profs[0].cluster && profs[0].cluster.length ? profs[0].cluster.join(" · ") : "your cultural taste";
    $cluster.innerHTML = `Your taste clusters around <strong>${esc(c)}</strong> — here is where that palate eats:`;
  } else {
    const parts = profs.map((p) => `<strong>${esc(p.label)}</strong>: ${esc((p.cluster || []).join(" · ") || "—")}`);
    $cluster.innerHTML = `Two palates, one table. ${parts.join(" &nbsp;×&nbsp; ")}<br>Shared ground first, then each side's strongest pull:`;
  }
  $cards.innerHTML = "";
  (data.picks || []).forEach((p) => {
    const aff = Object.entries(p.affinities || {}).map(([k, v]) => `${esc(k)} ${pct(v)}`).join(" · ");
    const card = document.createElement("article");
    card.className = "card";
    const bandTags = [...(p.cuisines || []).slice(0, 2), ...(p.ambience || []).slice(0, 1)];
    card.innerHTML = `
      <div class="card-band">${bandTags.map((t) => `<span class="band-tag">${esc(t)}</span>`).join("") || `<span class="band-tag">Taste match</span>`}</div>
      <div class="card-body">
        <div class="card-top"><h3>${esc(p.name)}</h3><span class="affinity ${p.shared ? "shared" : ""}">${data.mode === "partner" ? (p.shared ? (p.kind === "cuisine" ? "Common ground" : "Shared pick") : (p.owner === "You" ? "Your pick" : esc(p.owner || "") + "'s pick")) : pct(p.affinity)}</span></div>
        <div class="meta">${esc([p.cuisines.slice(0, 3).join(", "), p.price, p.neighborhood || p.city].filter(Boolean).join(" · "))}</div>
        ${aff && data.mode === "partner" ? `<div class="meta">Taste match — ${aff}</div>` : ""}
        <p class="explain">${esc(p.explanation || "")}</p>
        <div class="addr">${esc(p.address || "")}</div>
      </div>`;
    $cards.appendChild(card);
  });
  $results.hidden = false;
  $results.scrollIntoView({ behavior: "smooth", block: "start" });
}

$go.addEventListener("click", async () => {
  const profiles = activeProfiles()
    .filter((p) => p.picks.length)
    .map((p) => ({ label: p.label, entityIds: p.picks.map((x) => x.id) }));
  if (!profiles.length || profiles.some((p) => p.entityIds.length < 1)) {
    setStatus("Add at least one favorite first — an artist, a film, a place you love.", true);
    return;
  }
  $go.disabled = true;
  setStatus("Reading the taste graph…", false);
  try {
    const r = await fetch("/api/picks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profiles }),
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
});

document.getElementById("mode-solo").addEventListener("click", () => {
  state.mode = "solo";
  document.getElementById("mode-solo").classList.add("active");
  document.getElementById("mode-partner").classList.remove("active");
  renderProfiles();
});
document.getElementById("mode-partner").addEventListener("click", () => {
  state.mode = "partner";
  document.getElementById("mode-partner").classList.add("active");
  document.getElementById("mode-solo").classList.remove("active");
  renderProfiles();
});

renderProfiles();
