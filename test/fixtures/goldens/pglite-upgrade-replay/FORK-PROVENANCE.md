# Fork upgrade fixture

This fixture was built with production source `92e06c6c2cc307b4d617c75e9081dfe485c244fa`
(v0.50.0.0, schema157), in the isolated staging sandbox on 2026-10-03.
It uses the existing synthetic corpus builder and fingerprint queries, with engine,
gateway and migration imports directed to that old source. It was not built with
the candidate schema. The pre-boot catalog was captured before any upgrade.

The upstream v0.60.11/schema178 fixture belongs to a different migration lineage:
its local migration IDs do not include this fork's eight retained migrations.
The original is preserved by upstream commit2d8801b4 and locally under
`/root/gbrain-maintenance/2026-10-02-v06031/artifacts/upstream-pglite-fixture`.
It failed catalog parity and is not evidence of support for cross-lineage adoption.
Exact builder and execution log: maintenance `scripts/build-old-fork-fixture.ts`
and `logs/old-fork-fixture.log`. The manifest records source and command.
