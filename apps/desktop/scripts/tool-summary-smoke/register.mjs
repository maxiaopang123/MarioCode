/** Entry point for `node --import`. Registers the `.js → .ts` resolve hook
 *  (see resolve-ts.mjs) so a smoke test can import renderer `.ts` modules. */
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
