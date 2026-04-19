# memelli-contact-service

Standalone CRM contact-service for memelli.io. Owns /contacts CRUD on the shared platform Postgres DB.

## Endpoints

- `GET  /health` - liveness
- `GET  /contacts?q=&tag=&lifecycle=&limit=&offset=` - search / list
- `GET  /contacts/:id` - fetch
- `POST /contacts` - create
- `PATCH /contacts/:id` - update
- `DELETE /contacts/:id` - soft delete
- `POST /contacts/:id/tags` - `{ tag, op: 'add'|'remove' }`
- `POST /contacts/import` - `{ rows: [...] }` bulk insert

## Required env

- `PORT` (default 8080)
- `MEMELLI_CORE_DATABASE_URL` (or `DATABASE_URL`)

## Tenant auth

Gateway must forward `X-Tenant-Id` header. Production TODO: verify JWT claim, don't trust proxy header blindly.
