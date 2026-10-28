# Crave — Taste Agent

**Tell it what you love. It finds where you should eat.**

Crave is an agentic web demo built on the [Qloo Taste AI API](https://www.qloo.com/) for the
Qloo Agentic Hackathon. It never asks a single food question. You name cultural favorites —
artists, films, shows, places — and the agent:

1. Resolves each favorite to a Qloo entity (`GET /search`).
2. Builds a taste signal from those entities and asks Qloo's taste graph for restaurant
   affinities (`GET /v2/insights`, `filter.type=urn:entity:place`,
   `filter.tags=urn:tag:category:place:restaurant` — the category tag filter is what turns
   a landmark- and museum-skewed places feed into dining-grade picks; the broader genre
   tag was tested and admitted museums and markets, the category tag returns restaurants).
3. Clusters the cuisine tags across the result set to describe your palate in plain words.
4. Returns a ranked shortlist where **every pick carries a one-line explanation** derived
   from that cluster ("Your taste clusters around Neapolitan + Neapolitan pizza culture —
   this place answers with…").
5. **Partner Mode** runs two taste profiles and merges them: identical venues appearing in
   both profiles' result sets come first (scored by geometric mean of the two affinities);
   if the venues don't intersect, it falls back to *cuisine-level* common ground — picks from
   either side whose cuisines sit in both palates' clusters — then alternates each side's
   strongest remaining pull so neither palate dominates the table.

## Why this is an agent, not a search box

The unit of work is *inference → recommendation → explanation*: the system infers a cuisine
profile the user never stated, acts on it against a live taste graph, and then has to justify
each recommendation in the user's own terms. The explanation is the interface.

## Architecture

- `index.html` / `style.css` / `app.js` — zero-framework single-page front end.
- `api/search.js`, `api/picks.js` — Vercel serverless functions (thin wrappers).
- `lib/qloo.js` — all Qloo calls and recommendation logic. **The API key lives only in a
  server-side environment variable** (`QLOO_API_KEY`); it is never shipped to the browser,
  committed, or logged. Event-API flakiness is absorbed with bounded retries and backoff.
- `server.js` — a local dev server exposing the same routes, for running outside Vercel.

## Run it locally

```bash
QLOO_API_KEY=<your hackathon key> node server.js
# → http://localhost:4173
```

No dependencies to install; Node ≥ 18 only.

## Deploy (Vercel)

Import the repo, set the `QLOO_API_KEY` environment variable, deploy. The static page is
served from the project root and the two functions from `/api`.

## Request → result, one real example (redacted)

- Input favorites: *Radiohead* (artist entity) + *Inception* (film entity).
- Insights call: places filtered to the `restaurant` genre tag, signal = both entity IDs.
- Result set: restaurants with affinities ≈ 0.89–0.94, cuisine tags clustered
  (e.g. Neapolitan), each pick rendered with its affinity, cuisine, neighborhood,
  specialty dishes — and its one-line explanation.

## Known limitations

- Affinities are taste-graph correlations, not quality ratings; Crave says so in its footer.
- Qloo's place graph skews toward well-documented cities; rural coverage is thin.
- The event API can be slow in bursts — the server retries with backoff, and the UI keeps
  the user's profile intact if a call fails.
- Explanations are template-composed from returned cuisine/ambience tags (no LLM), chosen
  deliberately: every claim in the explanation traces to data Qloo actually returned.

## License

MIT — see `LICENSE`.
