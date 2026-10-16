#!/usr/bin/env node
// Prints the SQL that makes a redeemable code live, for a dossier already in book_assets:
//   RIDDLEBOUND_ANSWER_PEPPER=... node scripts/add-code.mjs <code> <book-id> <asset-id>
// Paste the output into Supabase → SQL Editor. Same normalization and HMAC as src/lib/answers.ts.
import { createHmac } from "node:crypto";

const [code, bookId, assetId] = process.argv.slice(2);
const pepper = process.env.RIDDLEBOUND_ANSWER_PEPPER ?? "";
const ID = /^[a-z0-9-]{1,64}$/;
if (!code || !ID.test(bookId ?? "") || !ID.test(assetId ?? "")) {
  console.error("usage: node scripts/add-code.mjs <code> <book-id> <asset-id>   (ids: a-z, 0-9, dashes)");
  process.exit(2);
}
if (pepper.length < 32) {
  console.error("Set RIDDLEBOUND_ANSWER_PEPPER (the same value the server uses, at least 32 characters) first.");
  process.exit(2);
}
const normalized = code.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const hash = createHmac("sha256", pepper).update(`code:${normalized}`).digest("hex");
console.log(`insert into public.redeem_codes (code_hash, book_id, asset_id) values ('${hash}', '${bookId}', '${assetId}') on conflict (code_hash) do update set book_id = excluded.book_id, asset_id = excluded.asset_id, active = true;`);
