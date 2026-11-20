import { startMock } from "./engine.js";
import { portFor, serviceFromEnv } from "./services.js";

try {
  const service = serviceFromEnv();
  startMock(service, portFor(service), process.env.MOCK_CONFIG);
} catch (err) {
  console.error(`[mock] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
