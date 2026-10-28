# Genome track: Ark report to Carbon-X

The genome track lets an Ark owner export selected panel sites to this machine
after one phone decision, and ask Carbon-X, a local DNA
research model, about one variant at a time. Issue #105, research track #58.
An older Ark uses the `rsid-genotypes` app with approval and report review.
Device details: [ark.md](ark.md). Research use only; nothing here is clinical
advice.

## Flow

```text
 Digital Twin page                     this machine                         Ark device
 ─────────────────                     ────────────                         ──────────
 [Run on Ark] ── POST /api/genome/run ─▶ packages/ark-adapter
                                         ark export (eleven optional rsIDs) -------> selected sites
 "Approve the export on your phone" (5 min)                    owner approves, switches sites on
                                         <-------------- approved FHIR collection
                                         ark data list (build cross-check) --------> slots
                                         join by rsID, or rsID-path id for no-calls
                                         if outdated: ark run rsid-genotypes.wasm
 "Approve on your phone" (5 min)                               owner approves the fallback run
 "Review and release the report" (10 min)                      owner releases the app report
                                         <-------------- released TSV, strictly parsed
                                         GenomeReport row (Postgres, personal)
 table: rsID, gene, allele, genotype ◀── audit genome.report.store (counts only)

 Chat (/genome or a question) ── local Ollama model
                                   genome_report ─▶ stored report
                                   dna_ask({rsid}) ─▶ stored row (genotype)
                                                    build check (GRCh38 only)
                                                    GENOME_REFERENCE_DIR (public GRCh38 FASTA)
                                                      ref allele must match, else refuse
                                                      ref window ± 256 bp, alt window
                                                    POST 127.0.0.1:8090/v1/chat/completions
                                                      model carbon-x, DNA inside <dna>…</dna>
                                                    dosing sentences withheld
                                   ◀─ "Carbon-X (research model)" answer
                                   audit genome.dna_ask (rsID, report id, outcome)
```

## Privacy rules

These are enforced in code, not only by convention.

1. **Genome data stays on this machine and the Ark.** The Ark keeps the genome.
   TwinLLM receives only the export the owner approves or the fallback app
   report they review and release. The result is stored in local Postgres.
2. **Only approved panel data is used.** The table and tools read rsID,
   chromosome, position, reference allele and genotype (or `no call`) for the
   eleven sites, from the approved export or released report. The stored
   Bundle also holds those sites' FHIR codes, assembly and Variant links.
   A site absent from the exported paths is `not granted`; a granted site
   without a record and an explicitly uncalled site are both `no call`.
3. **DNA sequence context is public.** The windows sent to Carbon-X come from
   the public GRCh38 reference in `GENOME_REFERENCE_DIR`, never from the
   device. The only personal part of a Carbon-X prompt is the recorded genotype,
   which picks the alternate allele.
4. **Carbon-X is local only.** `CARBON_X_URL` must be loopback
   (`127.0.0.1`, `localhost` or `[::1]`); any other value stops the boot, and
   the client refuses again before each request.
5. **Genome requests need all of:** `DATA_MODE=personal`, `GENOME_SOURCE=ark`,
   `LLM_PROVIDER=ollama` with Ollama on loopback, and the local Carbon-X
   (`permitGenomeRequest` in `infrastructure/data-mode-policy.ts`). Otherwise
   the genome tools are not on the turn at all, and they refuse again if called
   in a synthetic scope.
6. **No genotype goes to a hosted provider**, the consented Exoscale pilot
   included, nor to OpenRouter, the remote GPU, Infomaniak, GBD or any MCP
   server. The rule holds per thread, not only per question: a thread where
   `genome_report` or `dna_ask` ran (a stored tool part or a genome audit
   row), or whose history shows a `/genome` prompt or a Carbon-X answer, is
   genome-personal. Every later turn in it runs only on Ollama on loopback;
   any other model is refused before the history is sent, the answer is
   stored as refused with "This thread used your genome report, so it only
   runs on local models.", and `genome.thread.refused` is audited with the
   provider and a SHA-256 of the thread id. A second check just before the
   history goes to a model refuses again if a genome thread got that far
   (`infrastructure/genome-thread-policy.ts`). An export of a genome-personal
   thread (`/report`, #44, not built yet) must use `permitGenomeThreadExport`
   and goes only to a recipient on this machine. Starting a new thread is the
   way to use a hosted model again. The genome tools are left out of the eval
   harness and the MCP manifest. Training data offers them only with `--genome`, on synthetic
   genomes with stand-in answers, never a person's report
   (`docs/genome-synthetic.md`). Analytics send nothing in personal mode.
7. **Every step is audited, without genotypes.** `ark.data.list`, `ark.export`, `ark.app.run`,
   `genome.report.store`, `genome.report` and `genome.dna_ask` each append to
   the hash chain. Their arguments and results hold rsIDs, ids, counts and
   outcome codes only: no genotype, no report text, no answer, and no hash of
   any of them. A genotype has so few possible values that a plain hash could
   be reversed by trying them all, so the `ark.app.run` row keeps the report's
   length instead of its text. The export audit keeps only counts of paths
   requested, paths exported, entries and bytes. It never hashes the Bundle
   or the exported path selection.
8. **Carbon-X is research only.** Every answer is labelled
   "Carbon-X (research model)". Its system message asks for a description of
   what the variant is known to affect; any sentence about doses or about
   starting, stopping or changing a medicine is withheld before anyone reads
   it. The panel sites are pharmacogenomic: TwinLLM describes, it never doses.

## Build mismatch

The report's positions must be on GRCh38, the build of the reference windows.
A GRCh37 (hg19) position points at different bases. The build comes from the
export's assembly component, preferring its text over its code. The parser
accepts only GRCh38 builds. It cross-checks `data list --json` (the
`small-variants` slot's `build`, else `reference-genome`'s); disagreement
refuses storage with `BUILD_MISMATCH`. Two named patch versions must agree.
An empty Bundle names no build. The fallback app uses `data list` for its build.
On ArkOS 0.13.1 the slot names its build, so `GENOME_ASSUME_BUILD` is only for
an Ark that names none:

| Ark names        | Result                                                  |
| ---------------- | ------------------------------------------------------- |
| `GRCh38`, `hg38` | Windows built                                           |
| `GRCh37`, `hg19` | Refused (`BUILD_MISMATCH`), even with an assumption set |
| another build    | Refused (`BUILD_UNKNOWN`)                               |
| nothing          | Refused, unless `GENOME_ASSUME_BUILD=GRCh38` is set     |

Independently, the reference allele in the report must equal the FASTA base at
that position. A mismatch refuses (`REF_MISMATCH`); a reverse-complement match
refuses as `REF_STRAND_MISMATCH`, because the call file is on the other strand.

## Setup

1. Ark: see [ark.md](ark.md). Ark CLI 0.5.0 needs ArkOS 0.13.1 or newer. After
   the 0.13 update, add the owner's small variants again with
   `ark data upload calls.vcf.gz` (approved on the phone), then
   `ark data fetch --all` for the references and the variant catalog.
   Build the app with `bun run ark:build` (rustup's `cargo` first on `PATH`),
   close the Ark Hub tab, and set

   ```sh
   DATA_MODE=personal
   GENOME_SOURCE=ark
   ARK_DEVICE=alpha-002        # optional locator
   LOCAL_ONLY=true
   LLM_PROVIDER=ollama
   ```

2. Public reference: the UCSC hg38 per-chromosome FASTA. The panel needs
   chr1, chr6, chr10, chr12, chr16 and chr22. If `~/Projects/carbon-x/ref`
   already holds them (its `fetch_refs.sh` downloads the same files), point
   `GENOME_REFERENCE_DIR` there instead of downloading again.

   ```sh
   mkdir -p ~/genome/grch38 && cd ~/genome/grch38
   UCSC=https://hgdownload.soe.ucsc.edu/goldenPath/hg38/chromosomes
   curl -fsSO "$UCSC/md5sum.txt"
   for c in chr1 chr6 chr10 chr12 chr16 chr22; do curl -fsSO "$UCSC/$c.fa.gz"; done
   grep -E ' (chr1|chr6|chr10|chr12|chr16|chr22)\.fa\.gz$' md5sum.txt | md5sum -c -
   # optional, faster reads: gunzip -k chr*.fa.gz
   ```

   Then `GENOME_REFERENCE_DIR=~/genome/grch38` (an absolute path). Plain `.fa`
   files are read at an offset; `.fa.gz` (gzip or bgzip) is decompressed as a
   stream, about a second for a site 100 Mb into chr1.

3. Carbon-X sidecar on this machine, OpenAI-compatible:
   `GET http://127.0.0.1:8090/health` and
   `POST http://127.0.0.1:8090/v1/chat/completions` with `model: "carbon-x"`.
   Set `CARBON_X_URL` only if it listens elsewhere on loopback
   (default `http://127.0.0.1:8090/v1`); `CARBON_X_TIMEOUT_S` defaults to 120.

4. Open Digital Twin and press **Run on Ark**. Approve the export on your phone
   within 5 minutes and switch on the sites you want sent to this computer.
   No report review follows an export. On an older Ark the card switches to
   the app's two steps: approve within 5 minutes, then review and release
   within 10 minutes. The table shows each site's gene, star
   allele, position, reference and genotype. A granted site without a called
   allele is `no call`; an ungranted site is `not granted`. It is stored, so a
   reload does not ask the Ark again. **Run again** asks for fresh approval.

5. In chat, `/genome` summarises the report and asks Carbon-X about each called
   site. The `Released Ark report and Carbon-X` source can be turned off at
   `/start`.

## Code

| Part                         | Where                                                         |
| ---------------------------- | ------------------------------------------------------------- |
| Panel and report parsers     | `packages/ark-adapter/rsid-genotypes.ts`, `rsid-fhir.ts`      |
| Run and stored report routes | `features/digital-twin/genome-run.ts`, `app/api/genome/*`     |
| Dashboard card               | `features/digital-twin/genome-report.tsx`                     |
| Stored report                | `GenomeReport` model, `infrastructure/genome-report-store.ts` |
| Synthetic reports (testing)  | `scripts/genome-synth/`, `docs/genome-synthetic.md`           |
| Reference windows and build  | `packages/genome-reference/`                                  |
| Carbon-X client and prompt   | `packages/carbon-x/`                                          |
| Chat tools                   | `features/chat/genome-tools.ts`                               |
| Policy                       | `permitGenomeRequest`, `infrastructure/genome-gate.ts`        |
| Thread rule (#151)           | `infrastructure/genome-thread-policy.ts`, `start-answer.ts`   |
| Skill                        | `skills/genome/`                                              |

Tests need no hardware and no GPU: the Ark CLI is replaced through the
adapter's spawn hook and fixture JSON, the report through the app's goldens,
the reference through a 200-base synthetic `chr10.fa`, and Carbon-X through a
fake server on `127.0.0.1` (`packages/carbon-x/fake-carbon-x.ts`).
