/** Export contracts use synthetic resources and audit only counts. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcess } from "node:child_process";

import { appRun, exportFhir, status } from "./client";
import { setArkAdapterTestHooks } from "./hooks";
import {
  hostTimeoutMsForExport,
  isAllowedArkCommand,
  setArkNodeSpawnForTests,
} from "./spawn";
import { arkExportDocumentSchema } from "./schemas";
import fixture from "./fixtures/export-synthetic.json";

const ctx = { actor: "synthetic-test", sessionId: "export-test" };
const input = {
  paths: ["v1/genome/datasets/small-variants"],
  optional: ["v1/genome/rsids/rs4244285"],
  timeout: 30,
};
let io = { exitCode: 0, stdout: JSON.stringify(fixture), stderr: "" };
let argv: readonly string[] = [];
const audits: unknown[] = [];

beforeEach(() => {
  io = { exitCode: 0, stdout: JSON.stringify(fixture), stderr: "" };
  argv = [];
  audits.length = 0;
  setArkAdapterTestHooks({
    env: { GENOME_SOURCE: "ark" },
    audit: async (_ctx, tool, args, result) => {
      audits.push({ tool, args, result });
    },
  });
  setArkNodeSpawnForTests((command, args, options) => {
    expect(options.shell).toBe(false);
    argv = [command, ...args];
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => {
      child.stdout.end(io.stdout);
      child.stderr.end(io.stderr);
      child.emit("close", io.exitCode, null);
    });
    return child as ChildProcess;
  });
});

afterEach(() => {
  setArkAdapterTestHooks({ env: null, audit: null });
  setArkNodeSpawnForTests(null);
});

test("export uses fixed argv, one approval allowance and counts-only audit inputs", async () => {
  const result = await exportFhir(ctx, input);
  expect(result).toEqual({ status: "ok", data: fixture });
  expect(argv).toEqual([
    "ark",
    "export",
    "v1/genome/datasets/small-variants",
    "--optional",
    "v1/genome/rsids/rs4244285",
    "--timeout",
    "30",
    "--json",
  ]);
  expect(isAllowedArkCommand(["export"])).toBe(true);
  expect(hostTimeoutMsForExport(30)).toBe(420_000);
  expect(hostTimeoutMsForExport()).toBe(450_000);
  expect(audits).toEqual([
    {
      tool: "ark.export",
      args: { paths_requested: 2 },
      result: { paths_exported: 11, entry_count: 22, bundle_bytes: fixture.bundle_bytes },
    },
  ]);
});

test("export auditing ignores extra content, including content disguised as metadata", async () => {
  io.stdout = JSON.stringify({
    ...fixture,
    diagnostic: "G/A",
    hash: "hash-of-a-genotype",
    bundle: { ...fixture.bundle, personal: "G/A" },
  });
  await exportFhir(ctx, input);
  expect(audits).toEqual([
    {
      tool: "ark.export",
      args: { paths_requested: 2 },
      result: { paths_exported: 11, entry_count: 22, bundle_bytes: fixture.bundle_bytes },
    },
  ]);
});

test("a disabled genome source does not spawn", async () => {
  setArkAdapterTestHooks({ env: { GENOME_SOURCE: "none" } });
  const result = await exportFhir(ctx, input);
  expect(result.status).toBe("error");
  expect(argv).toEqual([]);
  expect(audits).toEqual([
    {
      tool: "ark.export",
      args: { paths_requested: 2 },
      result: { paths_exported: 0, entry_count: 0, bundle_bytes: 0 },
    },
  ]);
});

test("schema accepts additive fields and refuses partial or malformed exports", () => {
  expect(arkExportDocumentSchema.parse({ ...fixture, future: 1 }).future).toBe(1);
  for (const change of [
    { task: null },
    { paths: null },
    { bundle: null },
    { bundle: "content" },
    { media: "text/markdown" },
    { bundle_bytes: -1 },
    { bundle_bytes: 16777217 },
    { duration_seconds: -1 },
    { bundle: { resourceType: "Bundle", type: "document" } },
  ])
    expect(arkExportDocumentSchema.safeParse({ ...fixture, ...change }).success).toBe(
      false,
    );
});

test("all named outcomes map without auditing provider text or partial output", async () => {
  for (const [exitCode, code, status] of [
    [6, "approval-denied", "refused"],
    [6, "approval-timeout", "awaiting_approval"],
    [4, "approval-undelivered", "undelivered"],
    [5, "firmware-outdated", "outdated"],
    [5, "unknown", "outdated"],
    [5, "ark", "rejected"],
    [5, "export-limit", "rejected"],
    [5, "export-path-unknown", "rejected"],
    [5, "export-path-not-exportable", "rejected"],
    [5, "locked", "locked"],
    [5, "not-paired", "unpaired"],
    [3, "device-busy", "busy"],
  ] as const) {
    audits.length = 0;
    io = {
      exitCode,
      stdout: JSON.stringify({ task: "3", bundle: null }),
      stderr: JSON.stringify({
        event: "error",
        error: {
          code,
          message: "private content G/A",
          remote: { message: "private content" },
        },
      }),
    };
    expect((await exportFhir(ctx, input)).status).toBe(status);
    expect(audits).toEqual([
      {
        tool: "ark.export",
        args: { paths_requested: 2 },
        result: { paths_exported: 0, entry_count: 0, bundle_bytes: 0 },
      },
    ]);
  }
});

test("bare exits and an invalid success remain failures with content-free audit rows", async () => {
  for (const exitCode of [0, 1, 2, 3, 4, 5, 6, 7, 8, 130, 143]) {
    audits.length = 0;
    io = { exitCode, stdout: '{"bundle":"G/A"}', stderr: "" };
    expect((await exportFhir(ctx, input)).status).toBe(
      exitCode === 8 ? "app_failed" : "error",
    );
    expect(audits).toEqual([
      {
        tool: "ark.export",
        args: { paths_requested: 2 },
        result: { paths_exported: 0, entry_count: 0, bundle_bytes: 0 },
      },
    ]);
  }
});

test("unknown means outdated only for export", async () => {
  io = {
    exitCode: 5,
    stdout: "",
    stderr: JSON.stringify({
      event: "error",
      error: { code: "unknown", message: "unknown request" },
    }),
  };
  expect((await exportFhir(ctx, input)).status).toBe("outdated");
  expect((await appRun(ctx, { app: "rsid-genotypes.wasm", grants: [] })).status).toBe(
    "error",
  );
  expect((await status(ctx)).status).toBe("error");
});
