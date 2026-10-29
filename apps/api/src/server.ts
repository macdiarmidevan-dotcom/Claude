import { buildApp } from "./app.ts";
import { createPool } from "./db.ts";
import { startSyncLoop } from "./sync.ts";

const db = createPool();
const app = buildApp(db);
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

// Pulls each course's booking provider tee sheet on its schedule.
startSyncLoop(db, (err) => app.log.error(err));
