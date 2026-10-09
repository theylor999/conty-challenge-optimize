import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CountRow = { n: number };

// One row per (campaign niche, creator niche) pair that is equal, so the
// count is the same as comparing the two arrays pair by pair.
const NICHE_MATCHES = `
  SELECT c.id AS id, c.name AS name, COUNT(*) AS niche_score
  FROM creators c
  JOIN json_each(c.niches_json) creator_niche
  JOIN json_each(?) campaign_niche ON campaign_niche.value = creator_niche.value
  GROUP BY c.id
`;

// Last metric of each account; captured_at ties are broken by id DESC.
const LATEST_REACH = `
  SELECT a.creator_id AS creator_id, SUM(m.views) AS reach
  FROM social_accounts a
  JOIN (
    SELECT account_id, views,
           ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY captured_at DESC, id DESC) AS position
    FROM metrics
  ) m ON m.account_id = a.id AND m.position = 1
  GROUP BY a.creator_id
`;

const PAGE = `
  WITH matches AS (${NICHE_MATCHES}),
  reach AS (${LATEST_REACH}),
  ranked AS (
    SELECT matches.id AS id, matches.name AS name, matches.niche_score AS niche_score,
           COALESCE(reach.reach, 0) AS latest_reach
    FROM matches
    LEFT JOIN reach ON reach.creator_id = matches.id
    ORDER BY niche_score DESC, latest_reach DESC, id ASC
    LIMIT ? OFFSET ?
  )
  SELECT ranked.id AS id, ranked.name AS name, ranked.niche_score AS niche_score,
         ranked.latest_reach AS latest_reach,
         (SELECT COUNT(*) FROM deliveries d
          WHERE d.creator_id = ranked.id AND d.delivered_at >= ?) AS deliveries_90d
  FROM ranked
  ORDER BY niche_score DESC, latest_reach DESC, id ASC
`;

const TOTAL = `SELECT COUNT(*) AS n FROM (${NICHE_MATCHES})`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT id, niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const creators = await all<CreatorMatch>(
    db,
    PAGE,
    campaign.niches_json,
    input.limit,
    input.offset,
    deliveriesSince(),
  );
  const total = await get<CountRow>(db, TOTAL, campaign.niches_json);

  return {
    campaign_id: input.campaignId,
    total: Number(total?.n ?? 0),
    creators: creators.map((creator) => ({
      id: creator.id,
      name: creator.name,
      niche_score: Number(creator.niche_score),
      latest_reach: Number(creator.latest_reach),
      deliveries_90d: Number(creator.deliveries_90d),
    })),
  };
}
