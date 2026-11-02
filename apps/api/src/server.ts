import { buildApp } from "./app.ts";
import { createPool } from "./db.ts";
import { startSyncLoop } from "./sync.ts";
import { serveWeb } from "./web.ts";

const db = createPool();
const app = buildApp(db);
// With STAFF_WEB_DIR set to the staff app's web build, this server also serves the app.
if (process.env.STAFF_WEB_DIR) serveWeb(app, process.env.STAFF_WEB_DIR);
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

// Pulls each course's booking provider tee sheet on its schedule.
startSyncLoop(db, (err) => app.log.error(err));
