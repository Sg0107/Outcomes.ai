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
| Newer version of an existing visit | 201 | `ACCEPTED` | `version` and `transcription` move forward. The previous summary is marked `SUPERSEDED`. A new summary run starts for the new version. |
| Same `eventId` as one already stored on a visit | 200 | `DUPLICATE` | Nothing is written. |
| `encounterId` that does not exist | 404 | `NOT_FOUND` | Nothing is written. |
| `version` less than or equal to the stored version | 200 | `STALE_IGNORED` | Nothing is written. The visit does not move backward. |
| Same `encounterId`, different `patientId` | 422 | — | Request is rejected. Visit state is unchanged. |

`201` and `200` bodies look like `{ "status", "code", "message", "data": { "encounterId", "version" } }`. `data` is only present on `ACCEPTED`. On a brand-new visit, `data.encounterId` echoes the request field, which was omitted, so the generated id is only in MongoDB.

Follow-up events do not replace the stored `eventId`. The duplicate check only matches the `eventId` saved when the visit was created.

`encounterType` is required, and it is stored on create. A later event with a different type is not rejected and does not change the stored type.

## Summary

`GET /v1/encounters/:encounterId/summary`

On success, returns `{ "data": { "status", "summaryText", "errorMessage", "queuedAt", "completedAt" } }`.

Generation picks a delay from 5 seconds up to just under 15 seconds. The run is not awaited by the ingest handler, and it is not resumed after a process restart. A visit left in `PENDING` stays there.

If the delay is over 10 seconds, the run waits 10 seconds, sets `status` to `FAILED` with `errorMessage` `Timeout generating summary text`, and stops. That update matches `encounterId` and this run’s `version`, so a newer version already stored on the visit is left alone. No history row is written.

Otherwise the run waits the full delay, then builds `summaryText` as `Summary text of the payload whose length is <n>` and reads the visit’s stored `version`.

| Stored version | What is written |
| --- | --- |
| Newer than this run | The text is saved to summary history only. `latestSummaryData.status` becomes `SUPERSEDED` and `errorMessage` becomes `Newer version of the encounter has been received`. `summaryText` on the visit is not replaced. |
| Still this run’s version | `summaryText`, `status` `COMPLETED`, and `completedAt` are written on the visit, and a history row is inserted. |

The schema enum is `PENDING`, `PROCESSING`, `READY`, `FAILED`, `SUPERSEDED`. A successful run writes `COMPLETED`, which is outside that enum. Updates do not run validators, so the value is stored. Nothing in the current path sets `PROCESSING` or `READY`.

If the visit does not exist, the service throws 404 and the controller catch turns that into `500` with `{ "error": { "message": "Error getting encounter summary" } }`.

## Summary history

`GET /v1/encounters/:patientId/summary-history`

Returns every stored summary for that patient:

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

No rows returns HTTP `200` with `code` `NOT_FOUND`. The route only reads `patientId`. `encounterType` and `encounterId` are not applied as filters.

## Data stored

`Encounter` — one document per visit. Fields: `eventId`, `encounterId`, `patientId`, `encounterType`, `version`, `transcription`, and embedded `latestSummaryData` (`status`, `summaryText`, `errorMessage`, `queuedAt`, `completedAt`). Unique index on `(encounterId, version)`. Versions are updated in place, so the collection keeps the latest version only.

`SummaryHistory` — one document per completed summary run. Fields: `patientId`, `encounterType`, `encounterId`, `version`, `summaryText`, `errorMessage`, `queuedAt`, `completedAt`. Unique index on `(encounterId, version)`.

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
src/models/summaryHistory.js
public/index.html                  local page for exercising the API
```

Errors thrown from the service go through the handler in `src/app.js` and return `{ "error": { "message" } }`. Ingest outcomes that return a `code` are sent directly by the controller.

## Still open

- Request body from the assignment brief (`event_id`, snake_case fields). The API is camelCase, with transcription under `payload`.
- Returning the generated `encounterId` when the client omits it.
- Treating `encounterType` as fixed for an `encounterId`, the way `patientId` already is.
- A durable worker: timeouts that can fail, retries, and pickup of `PENDING` jobs after a crash.
- Duplicate detection for event ids received after the first version.
- Summary status aligned with the schema (`READY` or `FAILED` instead of `COMPLETED`).
- `404` from the summary route for an unknown visit, instead of `500`.
- History filters for encounter type and encounter id.
- Tests for duplicate, stale, out-of-order, concurrent, and crash/retry cases.

## Credits

- Initial structure: Gemini
- README: Cursor AI
