import fs from "node:fs";
import path from "node:path";

/**
 * JSONL execution trace. One file per run; one line per event.
 * Events: run_start, turn (assistant text + thinking summary), tool_call,
 * tool_result, state_snapshot, user_answer, final_report, run_end, error.
 */
export class Trace {
  readonly filePath: string;
  private stream: fs.WriteStream;

  constructor(dir = "traces") {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(dir, `run-${stamp}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  log(type: string, data: Record<string, unknown>): void {
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n");
  }

  close(): void {
    this.stream.end();
  }
}

/** Truncate large payloads before writing them to the trace. */
export function clip(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max} chars]` : s;
}
