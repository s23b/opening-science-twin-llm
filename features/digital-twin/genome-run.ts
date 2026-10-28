import "server-only";

import { access } from "node:fs/promises";
import { join } from "node:path";

import { resolveActorId } from "@/infrastructure/auth-actor";
import { ensureAppUser } from "@/infrastructure/current-user";
import type { GenomePermitDecision } from "@/infrastructure/data-mode-policy";
import { database } from "@/infrastructure/database";
import { genomeEnv } from "@/infrastructure/env";
import { genomeRunPermit } from "@/infrastructure/genome-gate";
import {
  latestGenomeReport,
  saveGenomeReport,
  type NewGenomeReport,
  type StoredGenomeReport,
} from "@/infrastructure/genome-report-store";
import { append, type AppendInput } from "@/packages/audit/append";
import {
  appRun,
  dataList,
  exportFhir,
  isArkOk,
  type ArkAppRunData,
  type ArkAppRunInput,
  type ArkAuditContext,
  type ArkDataListDocument,
  type ArkExportDocument,
  type ArkExportInput,
  type ArkResult,
} from "@/packages/ark-adapter";
import {
  parseRsidGenotypesReport,
  RSID_GENOTYPES_APP,
  RSID_GENOTYPES_GRANTS,
  RSID_GENOTYPES_REQUIRED,
  type GenomeReportSource,
} from "@/packages/ark-adapter/rsid-genotypes";
import { parseRsidFhir } from "@/packages/ark-adapter/rsid-fhir";
import { buildsAgree } from "@/packages/genome-reference/build";
import { GENOME_RUN_AUDIT_TOOL } from "@/packages/carbon-x/constants";

import {
  type GenomeReportPayload,
  type GenomeRunPayload,
  runFailure,
  toReportView,
} from "./genome-report-view";

/**
 * The genome dashboard's two routes.
 *
 * GET shows the stored report. POST exports the panel after one phone decision,
 * falling back to rsid-genotypes when exports are unavailable. The result is
 * parsed strictly and stored as a personal record. Every Ark call is audited
 * by the adapter; the store is audited here with counts only, never a
 * genotype or a hash of one.
 */

/** Machine and network waits for one run; phone approval is on top (docs/ark.md). */
export const RUN_TIMEOUT_S = 30;

/** Where `bun run ark:build` writes the module, relative to the app's working directory. */
export const defaultRsidWasm = (): string =>
  join(process.cwd(), "apps/ark/rsid-genotypes/build/rsid-genotypes.wasm");

export type GenomeRunPorts = Readonly<{
  resolveActorId: () => Promise<string | null>;
  permit: () => GenomePermitDecision;
  assumeBuild: () => "GRCh38" | null;
  wasmPath: () => string;
  wasmExists: (path: string) => Promise<boolean>;
  dataList: (ctx: ArkAuditContext) => Promise<ArkResult<ArkDataListDocument>>;
  exportFhir: (
    ctx: ArkAuditContext,
    input: ArkExportInput,
  ) => Promise<ArkResult<ArkExportDocument>>;
  appRun: (
    ctx: ArkAuditContext,
    input: ArkAppRunInput,
  ) => Promise<ArkResult<ArkAppRunData>>;
  ensureUserId: (actor: string) => Promise<string>;
  latest: (actor: string) => Promise<StoredGenomeReport | null>;
  save: (input: NewGenomeReport) => Promise<StoredGenomeReport>;
  audit: (input: AppendInput) => Promise<unknown>;
  sessionId: () => string;
}>;

const defaultPorts = (): GenomeRunPorts => ({
  resolveActorId,
  permit: genomeRunPermit,
  assumeBuild: () => genomeEnv().assumeBuild,
  wasmPath: () => genomeEnv().rsidGenotypesWasm ?? defaultRsidWasm(),
  wasmExists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  dataList,
  exportFhir,
  appRun,
  ensureUserId: async (actor) => (await ensureAppUser(actor)).id,
  latest: latestGenomeReport,
  save: saveGenomeReport,
  audit: (input) => append(database(), input),
  sessionId: () => crypto.randomUUID(),
});

/**
 * The build `ark data list` names for the small-variants slot (CLI 0.5.0,
 * e.g. GRCh38 or GRCh38.p14), else for the reference genome. Stored with the
 * report, so the GRCh38 check reads the Ark's word and GENOME_ASSUME_BUILD is
 * only a fallback for an Ark that names none. `snp-indel-calls` is the
 * CLI 0.3.5 name of the same slot.
 */
export const arkBuildOf = (listed: ArkDataListDocument): string | null => {
  const named = (slot: string) => {
    const build = listed.slots.find(
      (row) => String(row.slot) === slot || row.name === slot,
    )?.build;
    return typeof build === "string" && build.trim() !== "" ? build.trim() : null;
  };
  return named("small-variants") ?? named("snp-indel-calls") ?? named("reference-genome");
};

export const getGenomeReportResponse = async (
  overrides: Partial<GenomeRunPorts> = {},
): Promise<Response> => {
  const ports = { ...defaultPorts(), ...overrides };
  const actor = await ports.resolveActorId();
  if (!actor)
    return Response.json(
      { error: "Sign in to view the genome report." },
      { status: 401 },
    );
  if (!ports.permit().ok) {
    return Response.json({ enabled: false } satisfies GenomeReportPayload);
  }
  const stored = await ports.latest(actor);
  return Response.json({
    enabled: true,
    report: stored === null ? null : toReportView(stored, ports.assumeBuild()),
  } satisfies GenomeReportPayload);
};

const failed = (
  code: string,
  status = 200,
  source: GenomeReportSource = "ark-export",
): Response =>
  Response.json(runFailure(code, source) satisfies GenomeRunPayload, { status });

export const postGenomeRunResponse = async (
  overrides: Partial<GenomeRunPorts> = {},
  onSource: (source: GenomeReportSource) => void = () => undefined,
): Promise<Response> => {
  const ports = { ...defaultPorts(), ...overrides };
  const actor = await ports.resolveActorId();
  if (!actor) return failed("sign-in", 401);
  if (!ports.permit().ok) return failed("not-permitted", 403);

  const ctx: ArkAuditContext = { actor, sessionId: ports.sessionId() };
  let source: GenomeReportSource = "ark-export";
  onSource(source);
  const exported = await ports.exportFhir(ctx, {
    paths: [RSID_GENOTYPES_REQUIRED],
    optional: RSID_GENOTYPES_GRANTS,
    timeout: RUN_TIMEOUT_S,
  });
  if (!isArkOk(exported) && exported.status !== "outdated")
    return failed(exported.status);
  let report: string;
  let arkBuild: string | null;
  let parsed;
  if (isArkOk(exported)) {
    parsed = parseRsidFhir(exported.data.bundle, exported.data.paths);
    report = JSON.stringify(exported.data.bundle);
    arkBuild = parsed.ok ? parsed.arkBuild : null;
    if (parsed.ok) {
      const listed = await ports.dataList(ctx);
      if (!isArkOk(listed)) return failed(listed.status);
      const inventoryBuild = arkBuildOf(listed.data);
      if (
        arkBuild !== null &&
        inventoryBuild !== null &&
        !buildsAgree(arkBuild, inventoryBuild)
      ) {
        parsed = { ok: false as const, issue: "BUILD_MISMATCH" };
      }
    }
  } else {
    source = "ark-app";
    onSource(source);
    const wasm = ports.wasmPath();
    if (!(await ports.wasmExists(wasm))) return failed("app-not-built", 409, source);
    const listed = await ports.dataList(ctx);
    if (!isArkOk(listed)) return failed(listed.status, 200, source);
    const run = await ports.appRun(ctx, {
      app: wasm,
      grants: RSID_GENOTYPES_GRANTS,
      timeout: RUN_TIMEOUT_S,
    });
    if (!isArkOk(run)) return failed(run.status, 200, source);
    parsed = parseRsidGenotypesReport(run.data.report);
    report = run.data.report;
    arkBuild = arkBuildOf(listed.data);
  }
  const auditBase = {
    actor,
    sessionId: ctx.sessionId,
    subjectRef: null,
    tool: GENOME_RUN_AUDIT_TOOL,
    args: {
      source,
      ...(source === "ark-app" ? { app: RSID_GENOTYPES_APP } : {}),
      grants: RSID_GENOTYPES_GRANTS.length,
    },
  } as const;
  if (!parsed.ok) {
    console.error("[genome] released report did not parse:", parsed.issue);
    await ports.audit({ ...auditBase, result: { stored: false }, rowCount: 0 });
    return failed(
      parsed.issue === "BUILD_MISMATCH" || parsed.issue === "BUILD_UNKNOWN"
        ? parsed.issue
        : "report-unreadable",
      502,
      source,
    );
  }

  const stored = await ports.save({
    userId: await ports.ensureUserId(actor),
    arkBuild,
    source,
    rows: parsed.rows,
    report,
  });
  await ports.audit({
    ...auditBase,
    result: {
      stored: true,
      report_id: stored.id,
      rows: parsed.rows.length,
      calls: parsed.rows.filter((row) => row.genotype !== null).length,
      build_named: arkBuild !== null,
    },
    rowCount: parsed.rows.length,
  });
  return Response.json({
    ok: true,
    report: toReportView(stored, ports.assumeBuild()),
  } satisfies GenomeRunPayload);
};

/** Streams only the chosen flow and the final result, without polling an approval. */
export const streamGenomeRunResponse = (
  overrides: Partial<GenomeRunPorts> = {},
): Response => {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      try {
        const response = await postGenomeRunResponse(overrides, (source) =>
          send({ source }),
        );
        send(await response.json());
      } catch {
        send(runFailure("error"));
      } finally {
        if (!closed) controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
};
