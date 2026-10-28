# Ark adapter

The Ark is a Dark Bio device that keeps the owner's genome on the hardware.
TwinLLM never copies VCF, FASTA or GFF files off the device. It requests a FHIR
export of the panel sites the owner approves on their phone. An older Ark
uses an app report that the owner reviews and releases instead.

Pinned: **Ark CLI 0.5.0**, **ArkOS firmware 0.13.1 or newer**. CLI 0.5.0 refuses
older firmware with `firmware-outdated` (exit 5); the owner updates it with
`ark firmware update` in a terminal, never from TwinLLM. JSON field additions
are allowed; this adapter uses Zod `looseObject` and pins the tool version here.

The export flow requires a CLI that supports `ark export`. With that CLI, an
Ark that does not know export returns `unknown` and uses the app fallback.
An older CLI's usage error does not trigger fallback.

Install the CLI from Dark Bio's own release, nothing else:
[github.com/dark-bio/cli/releases](https://github.com/dark-bio/cli/releases).
Each release lists a SHA-256 per file (and macOS users get the same files from
the `dark-bio/tap` Homebrew tap). On Linux, download `ark-0.5.0-linux-amd64`,
check it against the release's digest, and install it user-local, for example
`install -m 755 ark-0.5.0-linux-amd64 ~/.local/bin/ark` (the release's
`ark-installer.sh` does the same). The emulator is
[github.com/dark-bio/emulator](https://github.com/dark-bio/emulator/releases)
0.4.0, which bundles ArkOS 0.13.1.

## What changed with ArkOS 0.13.1 and CLI 0.5.0

- `ark app run FILE` is gone; running an app is `ark run FILE`.
- The genome tree is built around places: `rsids/`, `positions/<chr>/<pos>/`,
  `regions/<chr>/<start>-<end>/` and `genes/<gene>/`, each with `changes/` and
  `copies/`, plus `datasets/<slot>` and `files/<slot>/`. The rsID leaves this
  app reads, `v1/genome/rsids/<rsid>/{chromosome,position,reference,genotype}`,
  are still there; `end` is new.
- Six slots: `reference-genome`, `gene-annotations`, `small-variants`
  (was `snp-indel-calls`), `structural-variants`, `copy-number-variants`,
  `variant-catalog`. `ark data list --json` gives each slot's `build`
  (such as `GRCh38.p14`) and the catalog's dbSNP `version` (such as 157).
- After the update, stored small variants and the variant catalog must be
  added again: `ark data upload calls.vcf.gz` (approved on the phone), then
  `ark data fetch --all` (no approval; the catalog alone takes an hour or more).
- App manifests are TOML, `manifest = 1`, with `[app]`, `[reads]` (`paths` and
  `optional`) and `[output]`. The Ark refuses a misspelled or ungrantable path,
  and a required path whose data is missing, naming it, before the owner is asked.

## TwinLLM wiring

`packages/ark-adapter` spawns `ark <argv> --json` with a fixed argv array (no
shell) via `node:child_process` so it runs under Next's Node runtime.
`GENOME_SOURCE` is `none` by default and refuses to spawn. Set
`GENOME_SOURCE=ark` to allow it. Optional `ARK_DEVICE` is a locator (`hardware:…`,
`emulator:…`, or a serial). Ark data is personal: keep `DATA_MODE=personal`.

Methods: `status()` (works unpaired or locked, and on a self-signed emulator
whose serial and model are null), `doctor()` (check names and results only),
`dataList()` / `dataPaths()` (paired and unlocked; inventories only),
`exportFhir(ctx, { paths, optional, timeout })`, which spawns
`ark export PATH... --optional PATH ... --json`, and
`appRun({ app, grants, timeout })`, which spawns `ark run`. App grants are
audit-only; the Ark mounts what the app's manifest names. TwinLLM never passes
`--unlock`, and never spawns `data upload`, `fetch`, `delete`, `repair`, `pair`,
`unlock` or `firmware`.

Inventory calls append audit rows (`ark.status`, `ark.doctor`, `ark.data.list`,
`ark.data.paths`) with hashed argv and hashed parsed JSON,
`row_count` 0. The `ark.app.run` row hashes the run's metadata, how many grants
the Ark mounted and the report's length, never the report text or which sites
were mounted. Eleven genotypes or eleven switches have few enough values that
a hash of them could be reversed.

`ark.export` audits only counts. Its arguments contain `paths_requested`,
including required dataset gates. Its result contains `paths_exported`,
`entry_count` and `bundle_bytes`, all zero on failure. It never hashes or stores
the argv, exported path selection, Bundle, genotype, resource identifiers or
error text in the audit row. `row_count` stays 0.

The `genome.report.store` audit names `source` as `ark-export` or `ark-app`
and records the grant count. It includes `app: rsid-genotypes` only for an
app run. Its result keeps the report id and counts, never report content.

## Approval, outcomes and concurrency

An export has **one phone step**, within **5 minutes**. The owner switches on
each optional site and approves sending a copy to this computer as FHIR.
The output reaches the computer in plaintext. No report review follows.

If export returns `outdated`, TwinLLM falls back to `ark run`. It waits on the
phone **twice**:

1. The owner approves the run in Ark Companion within **5 minutes**, seeing the
   app's name, version and every grant, and switches on the optional sites.
2. Once the app ends, the owner reviews the report and releases it within
   **10 minutes**, or declines, which drops it from the Ark.

`--timeout` bounds machine waits, never an approval. The export host cap is
`--timeout` plus the single 5-minute window plus 90 seconds of slack. The app
cap includes both windows plus five minutes. Killing `ark` cancels its task.
No refused, timed-out or undelivered export is retried as an app run.

| CLI outcome                                                                                   | Exit | Adapter state        |
| --------------------------------------------------------------------------------------------- | ---- | -------------------- |
| approved export or released report                                                            | 0    | `ok`                 |
| `approval-denied` (export, run or report declined)                                            | 6    | `refused`            |
| `approval-timeout` (a window ran out)                                                         | 6    | `awaiting_approval`  |
| `approval-undelivered`                                                                        | 4    | `undelivered`        |
| `firmware-outdated`                                                                           | 5    | `outdated`           |
| `unknown` (Ark does not know export)                                                          | 5    | `outdated`           |
| `unknown` from any other command                                                              | 5    | `error`              |
| `export-limit`, `export-path-unknown`, `export-path-not-exportable` and other export refusals | 5    | `rejected`           |
| `ark` (the Ark refused the app or a grant)                                                    | 5    | `rejected`           |
| `locked`, `not-paired`                                                                        | 5    | `locked`, `unpaired` |
| `device-busy`                                                                                 | 3    | `busy`               |
| `app-failed`                                                                                  | 8    | `app_failed`         |

Close the Ark Hub browser tab before any CLI command. A second `ark` process or
an open Hub tab returns `device-busy` (exit 3). Run one command at a time.

## What the Connectors card shows

When `GENOME_SOURCE=ark`, the Connectors page calls `GET /api/ark/status` as
the signed-in app actor. The card shows device state, hardware / firmware /
trust, paired and unlocked, the six genome slots as empty or filled, and how
many readable paths the inventory listed (and whether they all sit under
`v1/genome`). It never shows pubkey, identity, path names, or dataset bytes.

When `GENOME_SOURCE=none` the route answers `{ enabled: false }` and the card
stays hidden. Busy, locked, unpaired, outdated and other failures stay 200 with
`state` and `error.code` only. Busy also hints to close the Ark Hub tab;
outdated says "Ark firmware too old: run `ark firmware update`".

## What the Digital Twin genome dashboard shows

When `GENOME_SOURCE=ark` and status is enabled, Digital Twin shows a decorative
helix (no sequence, VCF, or FASTA), the same slot inventory as empty or filled
plus optional build and catalog version, and the last twenty `ark.*` and `genome.*` audit rows
for the signed-in actor as `{ seq, tool, ts, hash8 }`. The audit route never
returns args, result, subject, actor, session, or the full hash. When
`GENOME_SOURCE=none` the page stays on the existing coming-soon placeholder.

With `DATA_MODE=personal`, **Run on Ark** posts to `/api/genome/run`. It exports
the eleven optional rsIDs with the required public gate
`v1/genome/datasets/small-variants`. The card shows **Approve the export on your
phone** (5 minutes). If the Ark cannot export, a streamed flow notice switches
the card to the app's two steps. These notices name the chosen command only;
they do not poll the phone or reveal an approval's state.

The result is parsed strictly and stored as a `GenomeReport`. Its nullable
`source` is `ark-export` or `ark-app`; older rows stay null. `report` contains
compact Bundle JSON for exports and the released text for apps. Exports name
their build in the resources, checked against `data list`; disagreement gives
`BUILD_MISMATCH` without storing the result. The table and downstream tools use
the same rows. A reload reads `/api/genome/report` without asking the Ark again.

### The FHIR panel

`ark export --json` returns `task`, `paths`, `media`, `bundle_bytes`, `bundle`
and `duration_seconds`. Media is `application/fhir+json; fhirVersion=4.0`.
`paths` lists the places as exported, omitting public gates. A requested site
absent from that list is `not granted`. A granted site without resources is
`no call`. An explicitly uncalled Genotype, such as `./.`, is also `no call`.

The compact `collection` Bundle uses the FHIR R4 Genomics Reporting IG STU3
Genotype and Variant profiles. Entries use UUID URLs. Genotype code `84413-4`
carries the stored genotype text and `derivedFrom` links to Variant code
`69548-6`. Components name chromosome (`48000-4`, answers from `LL2938-0`),
assembly (`62374-4`), RefSeq accession (`48013-7`), 1-based coordinates
(`92822-6`) and exact start and end (`81254-5`). Variants carry the reference
(`69547-8`); Present ones add an alternate (`69551-0`) and may add allelic
state (`53034-5`). A fully reference call derives an Absent Variant.

An rsID-requested site's Variants carry that dbSNP identifier in `81252-9`, on
Present and Absent results. Every Variant of a site must agree on the rsID set.
The parser requires exactly one granted panel entry in that set and keeps the
Ark's coordinates even when they differ from the panel. A Genotype without
Variants carries no rsID component. The parser matches its id against UUIDv5
in the URL namespace of each granted `v1/genome/rsids/<rsid>/fhir/genotype`
path, without a leading slash. Variant ids use
`v1/genome/rsids/<rsid>/fhir/variant/<index>`, starting at 1.
Coordinates are never the primary match.
The GRCh38 coordinates in `RSID_PANEL` are a cross-check, with the Ark's values
taking precedence. Tests compare the panel against the synthetic catalog;
personal requests never read that catalog.

The parser refuses no-call ids with no granted rsID, duplicate Genotypes, missing
links, orphan Variants and a linked Variant at another site. Reference comes
from the Variants, or the public panel when there is none. Assembly text is
preserved, with its LOINC code as fallback. Only GRCh38 is supported. An empty
Bundle names no build.

Unlike `@open-twin/genomics-vcf`, this adapter receives an owner-approved
collection instead of reading a VCF. It uses Genotype text and linked site
Variants, preserving the Ark's codes rather than translating its output to
another producer's shape. It does not read files from the Ark.

The export fixture is synthetic, generated by `scripts/genome-synth/fhir.ts`.
See [genome-synthetic.md](genome-synthetic.md). The live `RUN_ARK=1` tests cover
export as well as the app fallback and require the owner's phone decisions.
No live output belongs in a fixture.

## Apps

`apps/ark/rsid-genotypes` (0.2.0) is a WASI preview 1 module. Its closed panel
is eleven public CPIC / PharmGKB star-allele defining rsIDs. Its manifest pass
prints:

```toml
manifest = 1

[app]
name = "rsid-genotypes"
version = "0.2.0"

[reads]
paths = ["v1/genome/datasets/small-variants"]
optional = ["v1/genome/rsids/rs4244285", "…eleven sites in report order…"]

[output]
report = "text/markdown"
```

The one required grant is public (the owner never sees it) and makes the Ark
refuse the run until small variants are loaded. Each site is optional, so one
missing site never refuses the run; the owner switches each on at approval.
TwinLLM `appRun` records the eleven site paths as audit grants.

The report pass prints a TSV of recorded fields (`rsid`, `chromosome`,
`position`, `reference`, then the genotype, `no call` or `not granted`) and this
footer:

`Research use only; genotypes as recorded in the loaded call file.`

A site whose directory is not mounted prints `not granted` with empty fields: a
declined optional grant and a site the Ark has no data for look the same to the
app. A missing genotype file is `no call`. Neither is a homozygous-reference
fill. Genotypes print as the Ark serves them (`A/G`, `A|G`, `|A|G`, `./.`, `T/*`,
`<DEL>`); a breakend is refused as unreadable by the parser. Any other I/O error
exits 1 with no report. The app does not interpret genotypes and does not name
a product.

Citation (allele definition tables, 2026-09-28):
https://cpicpgx.org/guidelines/ and
https://www.pharmgkb.org/page/cyp2c19RefMaterials

Synthetic genomes for testing the app and the slot end to end (a VCF for
`small-variants` and the report the app should print for it) are described in
`docs/genome-synthetic.md`.

Build with `bun run ark:build` (wasm stays gitignored; rustup's `cargo` must be
first on `PATH`, since the build needs the `wasm32-wasip1` target). Fixture
goldens: `bun run ark:test`, which also runs the two passes under wasmtime when
it is installed, mounting `optional` grants only where the fixture has them.
Fixtures (`present`, `unanswered`, `declined`, `eio`) follow the 0.13 rsID
layout from Dark Bio's example fixtures and use forward-strand GRCh38
coordinates and alleles; `tests/grch38_panel.rs` checks every panel site
(rsid, chromosome, position, end, reference, alternate) against the panel rows
of `scripts/genome-synth/variants.tsv`. The app prints whatever the Ark reports,
so on a real run the device's own variant catalog is authoritative. A live
`appRun` is `RUN_ARK=1` after that build and both phone steps. Close Hub first.
The Digital Twin card's fallback runs the module at
`apps/ark/rsid-genotypes/build/rsid-genotypes.wasm` unless
`ARK_RSID_GENOTYPES_WASM` names another path.

## Emulator

Ark Emulator 0.4.0 (ArkOS 0.13.1) runs headless on Linux with KVM:

```sh
ark-emulator start --headless --json   # prints the locator, e.g. emulator:18181
ark --device emulator:18181 status --json
ark --device emulator:18181 doctor --json
ark-emulator stop
```

A fresh emulator is self-signed: `ark status` reports `trust: self-signed` with
serial, model, environment and realm null. Before any data or app command it
must be enrolled at Ark Hub in a browser (`ark enroll` prints the address), then
paired with Ark Companion (`ark pair`), then unlocked on the phone. It is then
filled from a public 1000 Genomes sample, never a person's own calls:
`ark data samples --all` (pick one at random), `ark data fetch --sample NAME`
(three phone approvals), `ark data fetch --all`.

Tested on 2026-10-27 with CLI 0.5.0 and emulator 0.4.0 on Linux: `ark-emulator
doctor`, `ark-emulator start --headless`, `ark devices`, `ark status`,
`ark doctor`, `ark enroll` (prints the Hub address, exit 1
`enrollment-required`), and `ark data list` / `ark data paths` (exit 5
`not-paired`). The adapter fixtures `status-emulator-unenrolled.json` and
`doctor-emulator.json` are those documents, with the identity replaced. Enrolling,
pairing, filling a sample and `ark run` need a browser sign-in and a phone, so
they were not run; the rsID layout comes from the 0.5.0 manual and Dark Bio's
published example fixtures, and from a structure-only check on hardware.

## Operations

See `docs/runbook.md` for `bun test packages/ark-adapter` and the local-only
`RUN_ARK=1` smoke (close Hub, one command at a time).
