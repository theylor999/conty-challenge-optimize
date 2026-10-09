import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, FIXTURE_SEED, seed } from "../src/seed.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/page-1.json", import.meta.url), "utf8"),
) as unknown;

function setup() {
  const db = openDatabase(":memory:");
  seed(db, FIXTURE_SEED);
  resetQueryCount();
  return createApp(db);
}

describe("descoberta de criadores", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = setup();
  });

  it("devolve a primeira página combinada com a campanha", async () => {
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fixture);
  });

  it("responde a página de 20 com no máximo 8 queries", async () => {
    resetQueryCount();
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });

  it("responde 404 quando a campanha não existe", async () => {
    const res = await app.request("/campaigns/cmp_missing/creators");
    expect(res.status).toBe(404);
  });

  it("mantém o teto de queries com 600 criadores", async () => {
    const db = openDatabase(":memory:");
    seed(db, { creators: 600, seed: 7 });
    const big = createApp(db);
    resetQueryCount();
    const res = await big.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });
});

type Page = {
  total: number;
  creators: Array<{ id: string; niche_score: number; latest_reach: number; deliveries_90d: number }>;
};

describe("casos de borda da listagem", () => {
  function edgeApp() {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_edge', 'Borda', '["beleza","moda"]');
      INSERT INTO creators VALUES
        ('crt_a', 'Empate', '["beleza"]', ''),
        ('crt_b', 'Sem conta', '["beleza"]', ''),
        ('crt_c', 'Conta sem métrica', '["beleza"]', ''),
        ('crt_d', 'Entrega no limite', '["moda"]', ''),
        ('crt_e', 'Fora do nicho', '["games"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_a', 'crt_a', 'instagram'),
        ('acc_c', 'crt_c', 'instagram'),
        ('acc_e', 'crt_e', 'instagram');
      INSERT INTO metrics VALUES
        ('met_a1', 'acc_a', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_a2', 'acc_a', 99, '2026-05-30T00:00:00.000Z', ''),
        ('met_a0', 'acc_a', 500, '2026-05-01T00:00:00.000Z', ''),
        ('met_e1', 'acc_e', 777, '2026-05-30T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_d1', 'crt_d', '2026-03-03T12:00:00.000Z'),
        ('del_d2', 'crt_d', '2026-03-03T11:59:59.999Z');
    `);
    return createApp(db);
  }

  async function page(app: ReturnType<typeof createApp>, query = ""): Promise<Page> {
    const res = await app.request(`/campaigns/cmp_edge/creators${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  }

  it("desempata a métrica mais recente pelo id decrescente", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_a")?.latest_reach).toBe(99);
  });

  it("lista quem não tem conta ou métrica com alcance zero e deixa de fora score zero", async () => {
    const result = await page(edgeApp());
    expect(result.creators.map((creator) => creator.id)).toEqual(["crt_a", "crt_b", "crt_c", "crt_d"]);
    expect(result.creators.find((creator) => creator.id === "crt_b")?.latest_reach).toBe(0);
    expect(result.creators.find((creator) => creator.id === "crt_c")?.latest_reach).toBe(0);
  });

  it("conta a entrega exatamente no limite dos 90 dias e não a de 1 ms antes", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_d")?.deliveries_90d).toBe(1);
  });

  it("mantém o total quando o offset passa do fim", async () => {
    const result = await page(edgeApp(), "?limit=20&offset=50");
    expect(result.creators).toEqual([]);
    expect(result.total).toBe(4);
  });
});

describe("listagem com volume maior que o seed", () => {
  it("mantém a ordem nos empates, sem repetir nem perder criador entre páginas, e devolve vazio além do fim", async () => {
    const db = openDatabase(":memory:");
    seed(db, { creators: 2000, seed: 7 });
    // Todas as métricas empatam em captured_at e em views: o alcance só depende de quantas contas a pessoa tem.
    db.exec("UPDATE metrics SET views = 1000, captured_at = '2026-05-01T00:00:00.000Z'");
    const app = createApp(db);

    const campaign = db.prepare("SELECT niches_json FROM campaigns WHERE id = ?").get(CAMPAIGN_ID) as { niches_json: string };
    const campaignNiches = JSON.parse(campaign.niches_json) as string[];
    const accountsWithMetric = new Map(
      (
        db
          .prepare(
            "SELECT creator_id, COUNT(*) AS n FROM social_accounts a WHERE EXISTS (SELECT 1 FROM metrics m WHERE m.account_id = a.id) GROUP BY creator_id",
          )
          .all() as { creator_id: string; n: number }[]
      ).map((row) => [row.creator_id, row.n]),
    );
    const expected = (db.prepare("SELECT id, niches_json FROM creators").all() as { id: string; niches_json: string }[])
      .map((creator) => ({
        id: creator.id,
        niche_score: (JSON.parse(creator.niches_json) as string[]).filter((niche) => campaignNiches.includes(niche)).length,
        latest_reach: 1000 * (accountsWithMetric.get(creator.id) ?? 0),
      }))
      .filter((creator) => creator.niche_score > 0)
      .sort((a, b) => b.niche_score - a.niche_score || b.latest_reach - a.latest_reach || (a.id < b.id ? -1 : 1));
    expect(expected.length).toBeGreaterThan(100);

    const listed: { id: string; niche_score: number; latest_reach: number }[] = [];
    for (let offset = 0; ; offset += 50) {
      resetQueryCount();
      const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=50&offset=${offset}`);
      const result = (await res.json()) as Page;
      expect(getQueryCount()).toBeLessThanOrEqual(8);
      expect(result.total).toBe(expected.length);
      if (result.creators.length === 0) break;
      for (const creator of result.creators) {
        listed.push({ id: creator.id, niche_score: creator.niche_score, latest_reach: creator.latest_reach });
      }
    }
    expect(listed).toEqual(expected);
    const total = expected.length;

    const beyond = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=${total + 20}`);
    expect(await beyond.json()).toEqual({ campaign_id: CAMPAIGN_ID, total, creators: [] });
  });
});
