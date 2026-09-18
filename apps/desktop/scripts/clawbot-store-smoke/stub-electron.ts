import { join } from "node:path";
export const app = { getPath: () => join(process.env.CLAWBOT_STORE_SMOKE_DIR!, "user-data") };
