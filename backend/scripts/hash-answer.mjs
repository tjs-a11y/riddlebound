#!/usr/bin/env node
// Prints the hashed_answer for a book_assets row:
//   RIDDLEBOUND_ANSWER_PEPPER=... node scripts/hash-answer.mjs <book-id> <asset-id> "<answer>"
// Same normalization and HMAC as src/lib/answers.ts. Run it on a trusted machine; never log answers.
import { createHmac } from "node:crypto";

const [bookId, assetId, answer] = process.argv.slice(2);
const pepper = process.env.RIDDLEBOUND_ANSWER_PEPPER ?? "";
if (!bookId || !assetId || answer === undefined) {
  console.error('usage: node scripts/hash-answer.mjs <book-id> <asset-id> "<answer>"');
  process.exit(2);
}
if (pepper.length < 32) {
  console.error("Set RIDDLEBOUND_ANSWER_PEPPER (at least 32 characters) first.");
  process.exit(2);
}
const normalized = answer.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
console.log(createHmac("sha256", pepper).update(`${bookId}:${assetId}:${normalized}`).digest("hex"));
