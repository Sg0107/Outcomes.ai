# Outcomes

Node.js service that accepts clinical encounter updates, keeps the latest version of a visit, and produces a summary in the background. Summaries are generated in-process from the transcription length. There is no external AI call.

## Stack

- Node.js, Express 4
- MongoDB via Mongoose 8
- `dotenv` for config, `nodemon` for local reload

## Run

MongoDB must be running locally (default database `Outcomes`).

```bash
cp .env.example .env
npm install
npm run dev
```

`npm start` runs the same server without reload. Default port is `5001` when `.env` is present, otherwise `3000`.

- Health check: `GET /health` returns `{ "status": "OK", "message": "Outcomes API is running" }`.
- Browser tester: open `http://localhost:5001/` (or whatever `PORT` is). The page posts events and reads summary and history against this server.

## Ingest

`POST /v1/encounters/events`

The body is camelCase. Transcription lives under `payload`.

```json
{
  "eventId": "evt-501",
  "patientId": "pat-33",
  "encounterType": "Appointment",
  "version": 1,
  "payload": {
    "transcription": "Nurse: Good morning..."
  }
}
```

Required fields: `eventId`, `patientId`, `version`, `encounterType`, `payload`. Missing any of those returns `400` with `{ "error": { "message": "..." } }`.

`encounterId` is optional. Omit it to create a visit. The server assigns an id and stores the event. Send `encounterId` on later versions of that same visit.

The handler returns `201` before the summary is ready. Poll the summary route.

| Outcome | HTTP | `code` | What happens |
| --- | --- | --- | --- |
| New visit (`encounterId` omitted) | 201 | `ACCEPTED` | A document is created with a generated `encounterId`, the transcription, and a `PENDING` summary. Summary generation starts immediately. |
| Newer version of an existing visit | 201 | `ACCEPTED` | `version` and `transcription` move forward. `latestSummaryData` resets to `PENDING`. A new summary run starts for the new version. |
| Same `eventId` as a previously accepted event | 200 | `DUPLICATE` | Nothing is written. |
| Same `(encounterId, version)` under a different `eventId` | 200 | `DUPLICATE` | Nothing is written. |
| `encounterId` that does not exist | 404 | `NOT_FOUND` | Nothing is written. |
| `version` less than or equal to the stored version | 200 | `STALE_IGNORED` | Nothing is written. The visit does not move backward. |
| Same `encounterId`, different `patientId` | 422 | — | Request is rejected. Visit state is unchanged. |
| Same `encounterId`, different `encounterType` | 422 | — | Request is rejected. Visit state is unchanged. |

`201` and `200` bodies look like `{ "status", "code", "message", "data": { "encounterId", "version" } }`. `data` is only present on `ACCEPTED`. On a brand-new visit, `data.encounterId` is the id the server generated for that visit.

Every accepted event is recorded in `ProcessedEvent` with a unique `eventId` and a unique `(encounterId, version)` pair. Retries of the same `eventId`, or a second event for the same version under a different `eventId`, return `DUPLICATE`.

`encounterType` is required, and it is stored on create. A later event for the same `encounterId` must send that same type. A different type is rejected with `422`, the same way a different `patientId` is.

## Summary

`GET /v1/encounters/:encounterId/summary`

On success, returns `{ "data": { "status", "summaryText", "errorMessage", "queuedAt", "completedAt", "slaBreached", "slaBreachedAt" } }`.

Generation picks a delay from 5 seconds up to just under 15 seconds. The run is not awaited by the ingest handler, and it is not resumed after a process restart. A visit left in `PENDING` stays there.

If the simulated delay exceeds 10 seconds, the run waits 10 seconds, sets `slaBreached` to `true`, records the timeout in history, and retries up to 3 times with backoff (2s, 4s, 8s). The visit stays `PENDING` during retries. After all retries are exhausted, `status` becomes `FAILED`. Updates always match `encounterId` and this run’s `version`, so a newer version already stored on the visit is left alone.

Otherwise the run waits the full delay, then builds `summaryText` as `Summary text of the payload whose length is <n>` and reads the visit’s stored `version`.

| Stored version | What is written |
| --- | --- |
| Newer than this run | The text is saved to summary history only. `latestSummaryData` on the visit is not touched — the newer version keeps its current status. |
| Still this run’s version | `summaryText`, `status` `COMPLETED`, and `completedAt` are written on the visit, and a history row is inserted. |

The status enum is `PENDING`, `COMPLETED`, `FAILED`, `SUPERSEDED`. A successful run writes `COMPLETED`. A timeout writes `FAILED`.

If the visit does not exist, the route returns `404` with `{ "error": { "message": "Encounter not found" } }`.

## Summary history

`GET /v1/encounters/:patientId/summary-history?encounterType=...&encounterId=...`

Returns stored summaries for that patient. Optional query params `encounterType` and `encounterId` narrow the results.

```json
{
  "status": 200,
  "code": "SUCCESS",
  "message": "Summary history fetched successfully",
  "data": [
    {
      "encounterId": "…",
      "version": 1,
      "summaryText": "Summary text of the payload whose length is 86",
      "errorMessage": null
    }
  ]
}
```

A timed-out version is included in that list with `summaryText` null and `errorMessage` `Timeout generating summary text`.

No rows returns HTTP `404` with `code` `NOT_FOUND`.

## Data stored

`Encounter` — one document per visit. Fields: `eventId`, `encounterId`, `patientId`, `encounterType`, `version`, `transcription`, and embedded `latestSummaryData` (`status`, `summaryText`, `errorMessage`, `queuedAt`, `completedAt`, `slaBreached`, `slaBreachedAt`). Versions are updated in place, so the collection keeps the latest version only.

`ProcessedEvent` — one document per accepted event. Fields: `eventId`, `encounterId`, `version`, `patientId`, `encounterType`. Unique index on `eventId` and on `(encounterId, version)`.

`SummaryHistory` — one document per summary run, including a timeout. Fields: `patientId`, `encounterType`, `encounterId`, `version`, `summaryText`, `errorMessage`, `queuedAt`, `completedAt`, `retryCount`. `summaryText` is null when the run times out. Unique index on `(encounterId, version)`.

## Layout

```
server.js                          connect Mongo, then listen
src/app.js                         Express app, health check, /v1 routes, tester page, error JSON
src/config/env.js                  PORT, MONGO_URI, NODE_ENV
src/config/db.js                   mongoose.connect
src/routes/encounterRoutes.js      ingest, summary, summary history
src/controllers/encounterController.js
src/services/encounterService.js   idempotency, stale check, patient mismatch, summary generation
src/models/Encounter.js
src/models/ProcessedEvent.js
src/models/summaryHistory.js
public/index.html                  local page for exercising the API
```

Errors thrown from the service go through the handler in `src/app.js` and return `{ "error": { "message" } }`. Ingest outcomes that return a `code` are sent directly by the controller.

## Still open

- Request body from the assignment brief (`event_id`, snake_case fields). The API is camelCase, with transcription under `payload`.
- Pickup of `PENDING` jobs after a process restart (Phase 2).
- Persistent `SummaryJob` queue and background worker (Phase 2).
- SLA breach as operational signal separate from failure (Phase 2).
- Tests for duplicate, stale, out-of-order, concurrent, and crash/retry cases (Phase 3).
- Design submission document (Phase 4).

## Credits

- Initial structure: Gemini
- README: Cursor AI
