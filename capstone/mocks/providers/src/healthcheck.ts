// The image's HEALTHCHECK. Finds the port the same way main.ts does.
import http from "node:http";
import { portFor, serviceFromEnv } from "./services.js";

http
  .get({ host: "127.0.0.1", port: portFor(serviceFromEnv()), path: "/health", timeout: 2000 }, (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1);
  })
  .on("timeout", () => process.exit(1))
  .on("error", () => process.exit(1));
