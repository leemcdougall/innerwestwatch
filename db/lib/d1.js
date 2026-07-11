/**
 * db/lib/d1.js — the D1 REST API call, shared.
 *
 * Every pipeline script used to carry its own copy of this fetch with a subtly different
 * return shape (ingest.js returned the full result array; correct-in-place.js returned the
 * first statement's rows). Extracted here (session 24, issue #83) with BOTH shapes named
 * explicitly so a caller can't grab the wrong one by habit:
 *
 *   d1Query(sql, params) → the full result array (result[0].results holds rows,
 *                          result[0].meta.changes holds the write count)
 *   d1Rows(sql, params)  → just the first statement's rows (the common read case)
 *
 * Reads CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_DATABASE_ID / CLOUDFLARE_D1_TOKEN from the
 * environment at call time — entry scripts load .env before calling.
 */

export async function d1Query(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
  const token = process.env.CLOUDFLARE_D1_TOKEN;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    }
  );

  const data = await res.json();
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
  return data.result;
}

export async function d1Rows(sql, params = []) {
  const result = await d1Query(sql, params);
  return result[0]?.results || [];
}
