import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const client = new Anthropic();
const r = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 16,
  messages: [{ role: "user", content: "Say OK" }],
});
const text = r.content.find((b) => b.type === "text");
console.log("API key OK — model replied:", text?.text ?? r.stop_reason);
