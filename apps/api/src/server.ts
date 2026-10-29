import { buildApp } from "./app.ts";
import { createPool } from "./db.ts";

const db = createPool();
const app = buildApp(db);
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
