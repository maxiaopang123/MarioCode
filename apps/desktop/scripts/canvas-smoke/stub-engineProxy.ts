/** engineFetch → plain global fetch (the smoke's "network" is a local server). */
export const engineFetch: typeof fetch = (...args) => fetch(...args);
