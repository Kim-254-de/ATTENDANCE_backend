-- A small profile photo, stored inline: this API is 100% JSON with no file
-- upload infrastructure, so a base64 data URL keeps the same request/response
-- shape as everything else instead of adding multer/static-serving/object
-- storage for one small image. Kept out of the hot auth-session query path
-- (see auth.controller.ts me()) so it never rides along on every API call.
-- Apply with `npm run db:migrate`.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data_url TEXT;
