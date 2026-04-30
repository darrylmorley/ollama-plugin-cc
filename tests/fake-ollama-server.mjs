#!/usr/bin/env node
/**
 * Standalone fake Ollama HTTP server.
 *
 * Spawned as a background child process by installFakeOllama().
 * Reads its behavior from the FAKE_OLLAMA_BEHAVIOR env var.
 * Writes its URL to the file path given in FAKE_OLLAMA_HOST_FILE.
 *
 * Terminates when the parent process exits (detected via stdin EOF or
 * SIGTERM/SIGINT).
 */

import fs from "node:fs";
import http from "node:http";
import process from "node:process";

const behavior = process.env.FAKE_OLLAMA_BEHAVIOR ?? "review-ok";
const hostFile = process.env.FAKE_OLLAMA_HOST_FILE;

if (!hostFile) {
  process.stderr.write("FAKE_OLLAMA_HOST_FILE not set\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Canned response payloads — keyed by behavior name
// ---------------------------------------------------------------------------

const REVIEW_OK = {
  verdict: "approve",
  summary: "Reviewed uncommitted changes.\nNo material issues found.",
  findings: [],
  next_steps: []
};

const REVIEW_OK_BRANCH = (branch) => ({
  verdict: "approve",
  summary: `Reviewed changes against ${branch}.\nNo material issues found.`,
  findings: [],
  next_steps: []
});

const ADVERSARIAL_FINDINGS = {
  verdict: "needs-attention",
  summary: "One adversarial concern surfaced.",
  findings: [
    {
      severity: "high",
      title: "Missing empty-state guard",
      body: "The change assumes data is always present.",
      file: "src/app.js",
      line_start: 4,
      line_end: 6,
      confidence: 0.87,
      recommendation: "Handle empty collections before indexing."
    }
  ],
  next_steps: ["Add an empty-state test."]
};

const ADVERSARIAL_CLEAN = {
  verdict: "approve",
  summary: "No material issues found.",
  findings: [],
  next_steps: []
};

const TASK_OK = "Handled the requested task.\nTask prompt accepted.";
const TASK_RESUMED = "Resumed the prior run.\nFollow-up prompt accepted.";
const TASK_STOP_GATE_BLOCK = "BLOCK: Missing empty-state guard in src/app.js:4-6.";
const TASK_STOP_GATE_ALLOW = "ALLOW: No blocking issues found in the previous turn.";

// ---------------------------------------------------------------------------
// Request classifiers
// ---------------------------------------------------------------------------

function isReviewRequest(body) {
  return body.format != null;
}

function isAdversarialReview(body) {
  const systemMsg = (body.messages ?? []).find((m) => m.role === "system");
  return systemMsg && systemMsg.content && systemMsg.content.includes("Adversarial Review");
}

function extractBranchFromReview(body) {
  const userMsg = (body.messages ?? []).find((m) => m.role === "user");
  if (!userMsg || !userMsg.content) return null;
  const match = userMsg.content.match(/\bagainst\s+([^\s,\.]+)/i);
  return match ? match[1] : null;
}

function isStopGatePrompt(body) {
  const userMsg = (body.messages ?? []).find((m) => m.role === "user");
  return userMsg && userMsg.content &&
    (userMsg.content.includes("Only review the work from the previous Claude turn") ||
     userMsg.content.includes("<compact_output_contract>") ||
     userMsg.content.includes("<task>"));
}

function isResumeTask(body) {
  const userMsg = (body.messages ?? []).find((m) => m.role === "user");
  if (!userMsg || !userMsg.content) return false;
  return userMsg.content.includes("Continue from the current thread state") ||
    userMsg.content.includes("follow up");
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function buildChatResponse(body) {
  if (isReviewRequest(body)) {
    if (behavior === "review-malformed-json") {
      return { type: "json", content: "This is not JSON at all { broken" };
    }
    let reviewData;
    if (isAdversarialReview(body)) {
      reviewData = behavior === "adversarial-clean" ? ADVERSARIAL_CLEAN : ADVERSARIAL_FINDINGS;
    } else {
      const branch = extractBranchFromReview(body);
      reviewData = branch ? REVIEW_OK_BRANCH(branch) : REVIEW_OK;
    }
    return { type: "json", content: JSON.stringify(reviewData) };
  }

  let text;
  if (isStopGatePrompt(body)) {
    text = behavior === "adversarial-clean" ? TASK_STOP_GATE_ALLOW : TASK_STOP_GATE_BLOCK;
  } else if (isResumeTask(body)) {
    text = TASK_RESUMED;
  } else {
    text = TASK_OK;
  }

  if (behavior === "slow-task") {
    return { type: "slow-stream", content: text, delayMs: 400 };
  }
  if (behavior === "interruptible-slow-task") {
    return { type: "slow-stream", content: text, delayMs: 8000 };
  }

  return { type: "stream", content: text };
}

function writeStreamingResponse(res, text) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const words = text.match(/\S+|\s+/g) ?? [text];
  for (const word of words) {
    const chunk = {
      model: "fake-model",
      message: { role: "assistant", content: word },
      done: false
    };
    res.write(JSON.stringify(chunk) + "\n");
  }
  const done = {
    model: "fake-model",
    message: { role: "assistant", content: "" },
    done: true,
    total_duration: 100000000,
    eval_count: words.length
  };
  res.write(JSON.stringify(done) + "\n");
  res.end();
}

function writeJsonResponse(res, content) {
  res.writeHead(200, { "Content-Type": "application/json" });
  const body = {
    model: "fake-model",
    message: { role: "assistant", content },
    done: true,
    total_duration: 100000000,
    eval_count: 50
  };
  res.write(JSON.stringify(body));
  res.end();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const { method, url } = req;

  if (method === "GET" && url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      models: [
        { name: "llama3.1:8b", modified_at: "2024-01-01T00:00:00Z", size: 4000000000 }
      ]
    }));
    return;
  }

  if (method === "POST" && url === "/api/pull") {
    let rawBody = "";
    req.on("data", (chunk) => { rawBody += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const chunks = [
        { status: "pulling manifest" },
        { status: "downloading", completed: 50, total: 100 },
        { status: "success" }
      ];
      for (const chunk of chunks) {
        res.write(JSON.stringify(chunk) + "\n");
      }
      res.end();
    });
    return;
  }

  if (method === "POST" && url === "/api/chat") {
    let rawBody = "";
    req.on("data", (chunk) => { rawBody += chunk; });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }

      const responseSpec = buildChatResponse(body);

      if (responseSpec.type === "json") {
        writeJsonResponse(res, responseSpec.content);
      } else if (responseSpec.type === "stream") {
        writeStreamingResponse(res, responseSpec.content);
      } else if (responseSpec.type === "slow-stream") {
        setTimeout(() => {
          writeStreamingResponse(res, responseSpec.content);
        }, responseSpec.delayMs);
      } else {
        res.writeHead(500);
        res.end("unknown response type");
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const host = `http://127.0.0.1:${port}`;
  // Write URL to the host file so the parent can read it
  fs.writeFileSync(hostFile, host, "utf8");
  // Also signal readiness on stdout
  process.stdout.write(`READY:${host}\n`);
});

// Terminate when parent closes stdin (pipe closed) or sends SIGTERM
process.stdin.resume();
process.stdin.on("end", () => {
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
