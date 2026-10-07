import ssh2 from "ssh2";
import { generateKeyPairSync, createHash } from "node:crypto";
const { Server, utils } = ssh2;
export async function startSshFixture() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const fingerprint = `SHA256:${createHash("sha256").update(utils.parseKey(keys.privateKey).getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  const commands = []; const authentications = []; const clients = new Set();
  const server = new Server({ hostKeys: [keys.privateKey] }, client => {
    clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => {});
    client.on("authentication", ctx => {
      authentications.push(ctx.method);
      if (ctx.username === "fixture" && ((ctx.method === "password" && ctx.password === "ssh-test-password") || ctx.method === "publickey")) ctx.accept(); else ctx.reject();
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept(); session.on("exec", (acceptExec, _reject, info) => {
        commands.push(info.command); const stream = acceptExec(); stream.on("error", () => {});
        if (info.command === "hang") return;
        if (info.command === "large") stream.write("X".repeat(100000)); else stream.write(`executed: ${info.command}\n`);
        stream.stderr.write("fixture stderr\n"); stream.exit(info.command === "fail" ? 7 : 0); stream.end();
      });
    }));
  });
  server.on("error", () => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, fingerprint, commands, authentications, privateKey: keys.privateKey,
    close: async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); } };
}
